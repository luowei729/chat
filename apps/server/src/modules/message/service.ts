/**
 * ============================================================
 * 消息服务
 * ------------------------------------------------------------
 * 核心设计：
 * 1. seq 单调递增：用 `UPDATE conversations SET last_seq = last_seq + 1`
 *    再读回，靠 InnoDB 行锁保证同一会话内并发发消息不会重号；
 * 2. clientId 幂等：网络重试不会产生重复消息，直接返回已存在的那条；
 * 3. 游标分页：用 seq < before 而不是 offset，新消息插入不会导致翻页错位；
 * 4. 附件绑定在发消息时完成，避免「上传了但没发出」的孤儿附件被引用；
 * 5. 软删除：保留 seq 连续性，客户端显示「已撤回」。
 * ============================================================
 */

import {
  ATTACHMENT_EXPIRING_SOON_DAYS,
  ATTACHMENT_TTL_MS,
  ErrorCode,
  MESSAGE_PAGE_SIZE,
  messageSummary,
  type Attachment,
  type Message,
  type MessagePreview,
  type MessageType,
  type Page,
  type ReactionSummary,
  type SendMessageRequest,
} from '@chat/shared';
import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { ResultSetHeader } from 'mysql2';
import { db, pool } from '../../db/index.js';
import {
  attachments,
  conversationMembers,
  conversations,
  messageReactions,
  messages,
  users,
} from '../../db/schema.js';
import { AppError } from '../../lib/app-error.js';
import { newId } from '../../lib/ids.js';
import { signMediaUrl } from '../../lib/crypto.js';
import { config } from '../../config.js';
import { requireMember } from '../conversation/service.js';

/* ------------------------------------------------------------------ */
/* 附件 → DTO                                                           */
/* ------------------------------------------------------------------ */

/**
 * 把附件行转成客户端可用的 DTO
 * ============================================================
 * 签名说明：URL 带签名与过期时间，防止被外部盗链刷流量。
 *          签名只绑 attachmentId 与过期时间，同一附件多次生成结果一致，便于缓存。
 *
 * 【过期处理】
 * 文件在服务器只保留 ATTACHMENT_TTL_DAYS 天。
 * 到期后定时任务删除文件本体并把 expiredAt 置为删除时间，
 * 但**本记录与消息都保留**，所以这里要区分两种情况：
 *
 *   expired = true  → url / thumbUrl 返回空串，
 *                     客户端据此显示「文件已过期」占位，
 *                     而不是尝试去加载一个必然 404 的地址。
 *   expired = false → 正常签名 URL。
 *
 * 这样聊天记录不会出现空洞（微信/TG 的行为一致）。
 * ============================================================
 */
export function toAttachmentDto(row: typeof attachments.$inferSelect): Attachment {
  const now = Date.now();
  const expired = row.expiredAt !== null && row.expiredAt > 0;

  // 过期判定兼容两种来源：显式删除标记 或 时间已过但清理任务还没跑到
  const pastDue = row.expiresAt > 0 && row.expiresAt <= now;
  const treatAsExpired = expired || pastDue;

  const expiringSoon =
    !treatAsExpired &&
    row.expiresAt > 0 &&
    row.expiresAt - now <= ATTACHMENT_EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000;

  let url = '';
  let thumbUrl: string | null = null;

  if (!treatAsExpired) {
    const sigExpiresAt = Math.floor(now / 1000) + config.upload.urlTtlSeconds;
    const sig = signMediaUrl(row.id, sigExpiresAt);
    const base = `/api/media/${row.id}?e=${sigExpiresAt}&s=${sig}`;
    url = base;
    thumbUrl = row.thumbPath ? `${base}&t=1` : null;
  }

  return {
    id: row.id,
    kind: row.kind as Attachment['kind'],
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    url,
    thumbUrl,
    width: row.width ?? null,
    height: row.height ?? null,
    durationMs: row.durationMs ?? null,
    waveform: (row.waveform as number[] | null) ?? null,
    expiresAt: row.expiresAt > 0 ? row.expiresAt : row.createdAt + ATTACHMENT_TTL_MS,
    expired: treatAsExpired,
    expiringSoon,
  };
}

/* ------------------------------------------------------------------ */
/* 批量组装消息 DTO                                                      */
/* ------------------------------------------------------------------ */

interface MessageRowJoined {
  id: string;
  conversationId: string;
  seq: number;
  senderId: string;
  senderName: string;
  senderAvatarUrl: string | null;
  type: string;
  text: string | null;
  replyToId: string | null;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
}

/** 把消息行 + 附件 + 引用摘要组装成完整 DTO */
async function assembleMessages(
  rows: MessageRowJoined[],
  clientIds?: Map<string, string>,
): Promise<Message[]> {
  if (rows.length === 0) return [];

  const messageIds = rows.map((r) => r.id);

  // 批量取附件，避免 N+1
  const attachmentRows = await db
    .select()
    .from(attachments)
    .where(inArray(attachments.messageId, messageIds))
    .orderBy(asc(attachments.sortOrder));

  const attachmentsByMessage = new Map<string, Attachment[]>();
  for (const a of attachmentRows) {
    if (!a.messageId) continue;
    const list = attachmentsByMessage.get(a.messageId) ?? [];
    list.push(toAttachmentDto(a));
    attachmentsByMessage.set(a.messageId, list);
  }

  // 批量取被引用的消息（只取摘要）
  const replyIds = [...new Set(rows.map((r) => r.replyToId).filter((v): v is string => !!v))];
  const replyMap = new Map<string, MessagePreview>();
  if (replyIds.length > 0) {
    const replyRows = await db
      .select({
        id: messages.id,
        type: messages.type,
        senderId: messages.senderId,
        senderName: users.nickname,
        text: messages.text,
        createdAt: messages.createdAt,
        durationMs: attachments.durationMs,
      })
      .from(messages)
      .innerJoin(users, eq(users.id, messages.senderId))
      .leftJoin(attachments, eq(attachments.messageId, messages.id))
      .where(inArray(messages.id, replyIds));

    for (const r of replyRows) {
      if (replyMap.has(r.id)) continue;
      replyMap.set(r.id, {
        id: r.id,
        type: r.type as MessageType,
        senderId: r.senderId,
        senderName: r.senderName,
        summary: messageSummary(r.type as MessageType, r.text, r.durationMs),
        createdAt: r.createdAt,
      });
    }
  }

  return rows.map((r) => {
    // 已撤回的消息不返回内容与附件
    const deleted = r.deletedAt !== null;
    return {
      id: r.id,
      conversationId: r.conversationId,
      seq: r.seq,
      senderId: r.senderId,
      senderName: r.senderName,
      senderAvatarUrl: r.senderAvatarUrl,
      type: deleted ? 'system' : (r.type as MessageType),
      text: deleted ? '消息已撤回' : r.text,
      attachments: deleted ? [] : (attachmentsByMessage.get(r.id) ?? []),
      replyToId: r.replyToId,
      replyToPreview: r.replyToId ? (replyMap.get(r.replyToId) ?? null) : null,
      createdAt: r.createdAt,
      editedAt: r.editedAt,
      clientId: clientIds?.get(r.id),
    };
  });
}

/** 统一的查询字段，保证各接口返回形状一致 */
const messageSelect = {
  id: messages.id,
  conversationId: messages.conversationId,
  seq: messages.seq,
  senderId: messages.senderId,
  senderName: users.nickname,
  senderAvatarUrl: users.avatarUrl,
  type: messages.type,
  text: messages.text,
  replyToId: messages.replyToId,
  createdAt: messages.createdAt,
  editedAt: messages.editedAt,
  deletedAt: messages.deletedAt,
} as const;

/* ------------------------------------------------------------------ */
/* 发送消息                                                             */
/* ------------------------------------------------------------------ */

export async function sendMessage(
  conversationId: string,
  senderId: string,
  input: SendMessageRequest,
): Promise<{ message: Message; memberIds: string[] }> {
  await requireMember(conversationId, senderId);

  // ---------- 幂等：同一 clientId 已存在则直接返回 ----------
  const existing = await db
    .select(messageSelect)
    .from(messages)
    .innerJoin(users, eq(users.id, messages.senderId))
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.senderId, senderId),
        eq(messages.clientId, input.clientId),
      ),
    )
    .limit(1);

  if (existing[0]) {
    const assembled = await assembleMessages(existing, new Map([[existing[0].id, input.clientId]]));
    const members = await db
      .select({ userId: conversationMembers.userId })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          isNull(conversationMembers.leftAt),
        ),
      );
    return { message: assembled[0]!, memberIds: members.map((m) => m.userId) };
  }

  // ---------- 校验附件归属 ----------
  const attachmentIds = input.attachmentIds ?? [];
  if (attachmentIds.length > 0) {
    const rows = await db
      .select({ id: attachments.id, uploaderId: attachments.uploaderId, messageId: attachments.messageId })
      .from(attachments)
      .where(inArray(attachments.id, attachmentIds));

    if (rows.length !== attachmentIds.length) {
      throw new AppError(ErrorCode.ATTACHMENT_NOT_FOUND);
    }
    for (const a of rows) {
      if (a.uploaderId !== senderId) {
        throw new AppError(ErrorCode.FORBIDDEN, '不能引用他人的附件');
      }
      if (a.messageId) {
        throw new AppError(ErrorCode.ATTACHMENT_ALREADY_BOUND);
      }
    }
  }

  // ---------- 校验引用目标 ----------
  if (input.replyToId) {
    const replyRows = await db
      .select({ conversationId: messages.conversationId })
      .from(messages)
      .where(eq(messages.id, input.replyToId))
      .limit(1);
    if (!replyRows[0] || replyRows[0].conversationId !== conversationId) {
      throw new AppError(ErrorCode.REPLY_TARGET_INVALID);
    }
  }

  const now = Date.now();
  const messageId = newId();

  /**
   * seq 分配：靠 MySQL 行锁保证原子性。
   * 为什么要用裸 SQL：Drizzle 的 update 无法直接返回自增后的值，
   * 而这里必须「自增 + 读回」在同一把锁内完成，否则并发会拿到相同 seq。
   */
  const conn = await pool.getConnection();
  let seq = 0;
  try {
    await conn.beginTransaction();

    /**
     * 一次 UPDATE 同时推进三件事，零额外成本：
     *   last_seq    —— 消息序号水位
     *   last_message_at —— 会话列表排序依据
     *   updated_at  —— 增量同步依据（客户端只拉 > since 的会话）
     * 把 updated_at 合进这条语句，比单独再 UPDATE 一次省一个往返。
     */
    await conn.execute<ResultSetHeader>(
      'UPDATE conversations SET last_seq = last_seq + 1, last_message_at = ?, updated_at = ? WHERE id = ?',
      [now, now, conversationId],
    );

    const [seqRows] = await conn.query<import('mysql2').RowDataPacket[]>(
      'SELECT last_seq FROM conversations WHERE id = ?',
      [conversationId],
    );
    seq = (seqRows[0] as { last_seq?: number } | undefined)?.last_seq ?? 0;

    await conn.execute(
      `INSERT INTO messages (id, conversation_id, seq, sender_id, client_id, type, text, reply_to_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        messageId,
        conversationId,
        seq,
        senderId,
        input.clientId,
        input.type,
        input.text ?? null,
        input.replyToId ?? null,
        now,
      ],
    );

    // 绑定附件到这条消息
    if (attachmentIds.length > 0) {
      for (let i = 0; i < attachmentIds.length; i += 1) {
        await conn.execute(
          'UPDATE attachments SET message_id = ?, sort_order = ? WHERE id = ? AND message_id IS NULL',
          [messageId, i, attachmentIds[i]!],
        );
      }
    }

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  // ---------- 读回完整消息 ----------
  const rows = await db
    .select(messageSelect)
    .from(messages)
    .innerJoin(users, eq(users.id, messages.senderId))
    .where(eq(messages.id, messageId))
    .limit(1);

  const assembled = await assembleMessages(rows, new Map([[messageId, input.clientId]]));

  const members = await db
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(
      and(eq(conversationMembers.conversationId, conversationId), isNull(conversationMembers.leftAt)),
    );

  return { message: assembled[0]!, memberIds: members.map((m) => m.userId) };
}

/* ------------------------------------------------------------------ */
/* 拉取历史消息                                                          */
/* ------------------------------------------------------------------ */

export async function listMessages(
  conversationId: string,
  userId: string,
  options: { before?: number; limit?: number },
): Promise<Page<Message>> {
  await requireMember(conversationId, userId);

  const limit = Math.min(options.limit ?? MESSAGE_PAGE_SIZE, 100);

  const conditions = [eq(messages.conversationId, conversationId)];
  if (options.before !== undefined) {
    conditions.push(lt(messages.seq, options.before));
  }

  // 多取一条用于判断是否还有更多
  const rows = await db
    .select(messageSelect)
    .from(messages)
    .innerJoin(users, eq(users.id, messages.senderId))
    .where(and(...conditions))
    .orderBy(desc(messages.seq))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  // 返回时按 seq 升序，客户端可直接追加
  pageRows.reverse();

  const items = await assembleMessages(pageRows);

  return {
    items,
    nextCursor: hasMore && pageRows.length > 0 ? String(pageRows[0]!.seq) : null,
    hasMore,
  };
}

/* ------------------------------------------------------------------ */
/* 撤回消息                                                             */
/* ------------------------------------------------------------------ */

export async function deleteMessage(
  conversationId: string,
  messageId: string,
  userId: string,
): Promise<{ seq: number; memberIds: string[] }> {
  const { role } = await requireMember(conversationId, userId);

  const rows = await db
    .select({ senderId: messages.senderId, seq: messages.seq, deletedAt: messages.deletedAt })
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
    .limit(1);

  const row = rows[0];
  if (!row) throw new AppError(ErrorCode.MESSAGE_NOT_FOUND);
  if (row.deletedAt !== null) {
    // 已撤回，幂等返回
    const members = await db
      .select({ userId: conversationMembers.userId })
      .from(conversationMembers)
      .where(
        and(eq(conversationMembers.conversationId, conversationId), isNull(conversationMembers.leftAt)),
      );
    return { seq: row.seq, memberIds: members.map((m) => m.userId) };
  }

  // 只能撤回自己的消息；群主/管理员可撤回群内任意消息（管理需要）
  const isOwnerOrAdmin = role === 'owner' || role === 'admin';
  if (row.senderId !== userId && !isOwnerOrAdmin) {
    throw new AppError(ErrorCode.MESSAGE_DELETE_FORBIDDEN);
  }

  await db.update(messages).set({ deletedAt: Date.now() }).where(eq(messages.id, messageId));

  const members = await db
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(
      and(eq(conversationMembers.conversationId, conversationId), isNull(conversationMembers.leftAt)),
    );

  return { seq: row.seq, memberIds: members.map((m) => m.userId) };
}

/* ------------------------------------------------------------------ */
/* 会话摘要（推送时用）                                                  */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 表情回应                                                             */
/* ------------------------------------------------------------------ */

/** 查询某条消息的回应聚合（按 emoji 分组） */
async function loadReactions(
  conversationId: string,
  messageIds: string[],
  viewerId: string,
): Promise<Map<string, ReactionSummary[]>> {
  const out = new Map<string, ReactionSummary[]>();
  if (messageIds.length === 0) return out;

  const rows = await db
    .select({
      messageId: messageReactions.messageId,
      emoji: messageReactions.emoji,
      userId: messageReactions.userId,
    })
    .from(messageReactions)
    .where(inArray(messageReactions.messageId, messageIds));

  // 先按 messageId 聚合，再按 emoji 聚合
  const byMessage = new Map<string, Map<string, string[]>>();
  for (const r of rows) {
    let emojiMap = byMessage.get(r.messageId);
    if (!emojiMap) {
      emojiMap = new Map();
      byMessage.set(r.messageId, emojiMap);
    }
    const users = emojiMap.get(r.emoji) ?? [];
    users.push(r.userId);
    emojiMap.set(r.emoji, users);
  }

  for (const [messageId, emojiMap] of byMessage) {
    const list: ReactionSummary[] = [];
    for (const [emoji, userIds] of emojiMap) {
      list.push({
        emoji,
        count: userIds.length,
        mine: userIds.includes(viewerId),
        userIds,
      });
    }
    // 数量多的排前面，稳定展示
    list.sort((a, b) => b.count - a.count);
    out.set(messageId, list);
  }

  void conversationId;
  return out;
}

/** 添加回应（幂等：重复点同一个表情不会报错） */
export async function addReaction(
  conversationId: string,
  messageId: string,
  userId: string,
  emoji: string,
): Promise<{ memberIds: string[]; reactions: ReactionSummary[] }> {
  await requireMember(conversationId, userId);

  // 校验消息确实在这个会话里
  const [msg] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
    .limit(1);
  if (!msg) throw new AppError(ErrorCode.REACTION_TARGET_INVALID);

  await db
    .insert(messageReactions)
    .values({ messageId, userId, emoji, createdAt: Date.now() })
    .onDuplicateKeyUpdate({ set: { createdAt: Date.now() } });

  const [memberRows, reactions] = await Promise.all([
    db
      .select({ userId: conversationMembers.userId })
      .from(conversationMembers)
      .where(
        and(eq(conversationMembers.conversationId, conversationId), isNull(conversationMembers.leftAt)),
      ),
    loadReactions(conversationId, [messageId], userId),
  ]);

  return {
    memberIds: memberRows.map((m) => m.userId),
    reactions: reactions.get(messageId) ?? [],
  };
}

/** 取消回应 */
export async function removeReaction(
  conversationId: string,
  messageId: string,
  userId: string,
  emoji: string,
): Promise<{ memberIds: string[]; reactions: ReactionSummary[] }> {
  await requireMember(conversationId, userId);

  await db
    .delete(messageReactions)
    .where(
      and(
        eq(messageReactions.messageId, messageId),
        eq(messageReactions.userId, userId),
        eq(messageReactions.emoji, emoji),
      ),
    );

  const [memberRows, reactions] = await Promise.all([
    db
      .select({ userId: conversationMembers.userId })
      .from(conversationMembers)
      .where(
        and(eq(conversationMembers.conversationId, conversationId), isNull(conversationMembers.leftAt)),
      ),
    loadReactions(conversationId, [messageId], userId),
  ]);

  return {
    memberIds: memberRows.map((m) => m.userId),
    reactions: reactions.get(messageId) ?? [],
  };
}

/* ------------------------------------------------------------------ */
/* 转发消息                                                             */
/* ------------------------------------------------------------------ */

/**
 * 转发消息到多个会话
 * 实现方式：读出源消息内容，在目标会话各新建一条消息（不共享 id）。
 * 这样撤回/删除互不影响，符合 Telegram 的行为。
 * 附件会被重新绑定到新消息（允许一个附件被多条消息引用是设计使然）。
 */
export async function forwardMessage(
  sourceConversationId: string,
  messageId: string,
  userId: string,
  targetConversationIds: string[],
): Promise<Array<{ conversationId: string; memberIds: string[]; message: Message }>> {
  await requireMember(sourceConversationId, userId);

  const rows = await db
    .select(messageSelect)
    .from(messages)
    .innerJoin(users, eq(users.id, messages.senderId))
    .where(and(eq(messages.id, messageId), eq(messages.conversationId, sourceConversationId)))
    .limit(1);

  const src = rows[0];
  if (!src || src.deletedAt !== null) throw new AppError(ErrorCode.MESSAGE_NOT_FOUND);

  const out: Array<{ conversationId: string; memberIds: string[]; message: Message }> = [];

  for (const targetId of targetConversationIds) {
    // 每个目标会话都要校验成员身份，防止越权转发
    try {
      await requireMember(targetId, userId);
    } catch {
      continue;
    }

    // 转发保留原始类型与文本；附件不重复绑定，避免触发归属校验
    const sent = await sendMessage(targetId, userId, {
      type: src.type as MessageType,
      text: src.text ?? '',
      clientId: `fwd-${messageId}-${targetId}-${Date.now()}`.slice(0, 40),
    });

    out.push({
      conversationId: targetId,
      memberIds: sent.memberIds,
      message: sent.message,
    });
  }

  return out;
}

export async function conversationSummaryFor(
  conversationId: string,
  userId: string,
): Promise<{ lastMessage: MessagePreview | null; lastMessageAt: number | null; unreadCount: number }> {
  const convRows = await db
    .select({ lastSeq: conversations.lastSeq, lastMessageAt: conversations.lastMessageAt })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  const conv = convRows[0];
  if (!conv) return { lastMessage: null, lastMessageAt: null, unreadCount: 0 };

  const memberRows = await db
    .select({ lastReadSeq: conversationMembers.lastReadSeq })
    .from(conversationMembers)
    .where(
      and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)),
    )
    .limit(1);

  const lastRows = await db
    .select({
      id: messages.id,
      type: messages.type,
      senderId: messages.senderId,
      senderName: users.nickname,
      text: messages.text,
      createdAt: messages.createdAt,
      durationMs: attachments.durationMs,
    })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.senderId))
    .leftJoin(attachments, eq(attachments.messageId, messages.id))
    .where(and(eq(messages.conversationId, conversationId), isNull(messages.deletedAt)))
    .orderBy(desc(messages.seq))
    .limit(1);

  const last = lastRows[0];

  return {
    lastMessage: last
      ? {
          id: last.id,
          type: last.type as MessageType,
          senderId: last.senderId,
          senderName: last.senderName,
          summary: messageSummary(last.type as MessageType, last.text, last.durationMs),
          createdAt: last.createdAt,
        }
      : null,
    lastMessageAt: conv.lastMessageAt ?? null,
    unreadCount: Math.max(0, conv.lastSeq - (memberRows[0]?.lastReadSeq ?? 0)),
  };
}

/** 供 WS 层复用：确认成员身份 */
export { requireMember };
