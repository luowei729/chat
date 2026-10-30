/**
 * ============================================================
 * 会话服务
 * ------------------------------------------------------------
 * 负责：会话列表、创建私聊/群聊、成员管理、已读水位。
 *
 * 关键设计：
 * 1. 私聊用 directKey 唯一索引去重，A→B 与 B→A 得到同一会话；
 * 2. 会话列表的 title/avatar 由服务端按「当前用户视角」计算
 *    （私聊显示对方昵称，群聊显示群名），客户端不做推导；
 * 3. 未读数 = lastSeq - lastReadSeq，一次查询算出，不做 count(*)；
 * 4. 成员软删除（leftAt），保留历史消息可读。
 * ============================================================
 */

import {
  CONVERSATION_TYPES,
  ErrorCode,
  GROUP_MAX_MEMBERS,
  MESSAGE_PAGE_SIZE,
  messageSummary,
  type ConversationDetail,
  type ConversationMember,
  type ConversationSummary,
  type GroupMemberItem,
  type GroupRole,
  type MemberRole,
  type MessagePreview,
} from '@chat/shared';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  attachments,
  contactRemarks,
  conversationMembers,
  conversations,
  messages,
  users,
} from '../../db/schema.js';
import { AppError } from '../../lib/app-error.js';
import { directKeyOf, newId } from '../../lib/ids.js';

/* ------------------------------------------------------------------ */
/* 内部查询辅助                                                         */
/* ------------------------------------------------------------------ */

/** 确认用户是会话成员，返回角色；不是成员则抛错 */
export async function requireMember(
  conversationId: string,
  userId: string,
): Promise<{ role: MemberRole; lastReadSeq: number }> {
  const rows = await db
    .select({ role: conversationMembers.role, lastReadSeq: conversationMembers.lastReadSeq })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
        isNull(conversationMembers.leftAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) throw new AppError(ErrorCode.NOT_A_MEMBER);
  return { role: row.role as MemberRole, lastReadSeq: row.lastReadSeq };
}

/** 批量取会话成员（含用户资料），用于列表页标题计算 */
async function loadMembers(conversationIds: string[]) {
  if (conversationIds.length === 0) return [];
  return db
    .select({
      conversationId: conversationMembers.conversationId,
      userId: conversationMembers.userId,
      role: conversationMembers.role,
      lastReadSeq: conversationMembers.lastReadSeq,
      nickname: users.nickname,
      avatarUrl: users.avatarUrl,
    })
    .from(conversationMembers)
    .innerJoin(users, eq(users.id, conversationMembers.userId))
    .where(
      and(
        inArray(conversationMembers.conversationId, conversationIds),
        isNull(conversationMembers.leftAt),
      ),
    );
}

/** 批量取每个会话的最后一条消息摘要 */
async function loadLastMessages(conversationIds: string[]): Promise<Map<string, MessagePreview>> {
  const result = new Map<string, MessagePreview>();
  if (conversationIds.length === 0) return result;

  // 用窗口函数一次查出每个会话的最新一条，避免 N+1 查询
  const rows = await db
    .select({
      conversationId: messages.conversationId,
      id: messages.id,
      type: messages.type,
      senderId: messages.senderId,
      senderName: users.nickname,
      text: messages.text,
      createdAt: messages.createdAt,
      durationMs: attachments.durationMs,
      seq: messages.seq,
    })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.senderId))
    .leftJoin(attachments, eq(attachments.messageId, messages.id))
    .where(
      and(
        inArray(messages.conversationId, conversationIds),
        isNull(messages.deletedAt),
        sql`${messages.seq} = (SELECT MAX(m2.seq) FROM messages m2 WHERE m2.conversation_id = ${messages.conversationId} AND m2.deleted_at IS NULL)`,
      ),
    );

  for (const row of rows) {
    // 同一条消息可能有多个附件，只取第一条用于摘要
    if (result.has(row.conversationId)) continue;
    result.set(row.conversationId, {
      id: row.id,
      type: row.type as MessagePreview['type'],
      senderId: row.senderId,
      senderName: row.senderName,
      summary: messageSummary(row.type as MessagePreview['type'], row.text, row.durationMs),
      createdAt: row.createdAt,
    });
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 会话列表                                                             */
/* ------------------------------------------------------------------ */

export async function listConversations(userId: string): Promise<ConversationSummary[]> {
  // 1. 取我参与的全部会话（按最后消息时间倒序）
  const myMemberships = await db
    .select({
      conversationId: conversationMembers.conversationId,
      lastReadSeq: conversationMembers.lastReadSeq,
      pinned: conversationMembers.pinned,
      muted: conversationMembers.muted,
    })
    .from(conversationMembers)
    .where(and(eq(conversationMembers.userId, userId), isNull(conversationMembers.leftAt)));

  if (myMemberships.length === 0) return [];

  const conversationIds = myMemberships.map((m) => m.conversationId);

  const convRows = await db
    .select()
    .from(conversations)
    .where(inArray(conversations.id, conversationIds))
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.createdAt));

  // 2. 批量取成员与最后消息，避免 N+1
  const memberRows = await loadMembers(conversationIds);
  const lastMessages = await loadLastMessages(conversationIds);

  const membersByConv = new Map<string, typeof memberRows>();
  for (const m of memberRows) {
    const list = membersByConv.get(m.conversationId) ?? [];
    list.push(m);
    membersByConv.set(m.conversationId, list);
  }

  const myMeta = new Map(myMemberships.map((m) => [m.conversationId, m]));

  // 3. 组装成客户端视角的摘要
  const summaries: ConversationSummary[] = [];
  for (const conv of convRows) {
    const members = membersByConv.get(conv.id) ?? [];
    const meta = myMeta.get(conv.id);
    if (!meta) continue;

    let title = conv.title ?? '';
    let avatarUrl = conv.avatarUrl ?? null;
    let peerId: string | null = null;

    if (conv.type === 'direct') {
      // 私聊：标题与头像取对方资料
      const peer = members.find((m) => m.userId !== userId);
      if (!peer) continue;
      title = peer.nickname;
      avatarUrl = peer.avatarUrl ?? null;
      peerId = peer.userId;
    } else if (!title) {
      // 群聊未命名时用成员昵称拼接
      title = members
        .filter((m) => m.userId !== userId)
        .slice(0, 3)
        .map((m) => m.nickname)
        .join('、');
    }

    const lastMessage = lastMessages.get(conv.id) ?? null;
    const lastSeq = conv.lastSeq;

    summaries.push({
      id: conv.id,
      type: conv.type as ConversationSummary['type'],
      title,
      avatarUrl,
      peerId,
      memberCount: members.length,
      lastMessage,
      lastMessageAt: conv.lastMessageAt ?? null,
      // 未读数：会话水位 - 我的已读水位，负值归零
      unreadCount: Math.max(0, lastSeq - meta.lastReadSeq),
      pinned: meta.pinned,
      muted: meta.muted,
      createdAt: conv.createdAt,
    });
  }

  // 置顶优先，其次按最后消息时间
  summaries.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt);
  });

  return summaries;
}

/* ------------------------------------------------------------------ */
/* 会话详情                                                             */
/* ------------------------------------------------------------------ */

export async function getConversationDetail(
  conversationId: string,
  userId: string,
): Promise<ConversationDetail> {
  const { role } = await requireMember(conversationId, userId);

  const convRows = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  const conv = convRows[0];
  if (!conv) throw new AppError(ErrorCode.CONVERSATION_NOT_FOUND);

  const memberRows = await loadMembers([conversationId]);
  const members: ConversationMember[] = memberRows.map((m) => ({
    userId: m.userId,
    nickname: m.nickname,
    avatarUrl: m.avatarUrl ?? null,
    role: m.role as MemberRole,
    lastReadSeq: m.lastReadSeq,
  }));

  const myMembership = await db
    .select({ pinned: conversationMembers.pinned, muted: conversationMembers.muted })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
      ),
    )
    .limit(1);

  let title = conv.title ?? '';
  let avatarUrl = conv.avatarUrl ?? null;
  if (conv.type === 'direct') {
    const peer = members.find((m) => m.userId !== userId);
    title = peer?.nickname ?? '';
    avatarUrl = peer?.avatarUrl ?? null;
  }

  return {
    id: conv.id,
    type: conv.type as ConversationDetail['type'],
    title,
    avatarUrl,
    ownerId: conv.ownerId ?? null,
    members,
    myRole: role,
    pinned: myMembership[0]?.pinned ?? false,
    muted: myMembership[0]?.muted ?? false,
    createdAt: conv.createdAt,
  };
}

/* ------------------------------------------------------------------ */
/* 创建私聊                                                             */
/* ------------------------------------------------------------------ */

export async function createDirect(
  userId: string,
  peerId: string,
): Promise<{ conversationId: string; created: boolean }> {
  if (userId === peerId) throw new AppError(ErrorCode.CANNOT_CHAT_WITH_SELF);

  // 校验对方存在且可用
  const peerRows = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.id, peerId))
    .limit(1);
  const peer = peerRows[0];
  if (!peer || peer.status !== 'active') throw new AppError(ErrorCode.NOT_FOUND, '用户不存在');

  const key = directKeyOf(userId, peerId);

  // 已存在则直接返回（幂等）
  const existing = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.directKey, key))
    .limit(1);
  if (existing[0]) {
    return { conversationId: existing[0].id, created: false };
  }

  const now = Date.now();
  const conversationId = newId();

  await db.transaction(async (tx) => {
    await tx.insert(conversations).values({
      id: conversationId,
      type: 'direct',
      title: null,
      avatarUrl: null,
      ownerId: null,
      directKey: key,
      lastSeq: 0,
      lastMessageAt: null,
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(conversationMembers).values([
      { conversationId, userId, role: 'member', lastReadSeq: 0, pinned: false, muted: false, joinedAt: now, updatedAt: now, leftAt: null },
      { conversationId, userId: peerId, role: 'member', lastReadSeq: 0, pinned: false, muted: false, joinedAt: now, updatedAt: now, leftAt: null },
    ]);
  });

  return { conversationId, created: true };
}

/* ------------------------------------------------------------------ */
/* 创建群聊                                                             */
/* ------------------------------------------------------------------ */

export async function createGroup(
  userId: string,
  title: string,
  memberIds: string[],
): Promise<{ conversationId: string }> {
  // 去重并排除自己
  const uniqueMembers = [...new Set(memberIds)].filter((id) => id !== userId);

  if (uniqueMembers.length + 1 > GROUP_MAX_MEMBERS) {
    throw new AppError(ErrorCode.GROUP_MEMBER_LIMIT);
  }

  // 校验所有成员存在
  if (uniqueMembers.length > 0) {
    const found = await db
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.id, uniqueMembers), eq(users.status, 'active')));
    if (found.length !== uniqueMembers.length) {
      throw new AppError(ErrorCode.MEMBER_NOT_FOUND, '部分成员不存在');
    }
  }

  const now = Date.now();
  const conversationId = newId();

  await db.transaction(async (tx) => {
    await tx.insert(conversations).values({
      id: conversationId,
      type: 'group',
      title,
      avatarUrl: null,
      ownerId: userId,
      directKey: null,
      lastSeq: 0,
      lastMessageAt: null,
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(conversationMembers).values([
      {
        conversationId,
        userId,
        role: 'owner',
        lastReadSeq: 0,
        pinned: false,
        muted: false,
        joinedAt: now,
        updatedAt: now,
        leftAt: null,
      },
      ...uniqueMembers.map((id) => ({
        conversationId,
        userId: id,
        role: 'member' as const,
        lastReadSeq: 0,
        pinned: false,
        muted: false,
        joinedAt: now,
        updatedAt: now,
        leftAt: null,
      })),
    ]);
  });

  return { conversationId };
}

/* ------------------------------------------------------------------ */
/* 成员管理                                                             */
/* ------------------------------------------------------------------ */

export async function updateMember(
  conversationId: string,
  operatorId: string,
  targetUserId: string,
  action: 'promote' | 'demote' | 'remove',
): Promise<void> {
  const { role } = await requireMember(conversationId, operatorId);

  // 只有群主能提升/降级管理员；管理员可移除普通成员
  if (action !== 'remove' && role !== 'owner') {
    throw new AppError(ErrorCode.NOT_GROUP_OWNER);
  }
  if (action === 'remove' && role !== 'owner' && role !== 'admin') {
    throw new AppError(ErrorCode.FORBIDDEN);
  }
  if (targetUserId === operatorId) {
    throw new AppError(ErrorCode.BAD_REQUEST, '不能对自己执行该操作');
  }

  const convRows = await db
    .select({ type: conversations.type, ownerId: conversations.ownerId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  const conv = convRows[0];
  if (!conv) throw new AppError(ErrorCode.CONVERSATION_NOT_FOUND);
  if (conv.type !== 'group') throw new AppError(ErrorCode.BAD_REQUEST, '私聊不支持成员管理');
  if (conv.ownerId === targetUserId) {
    throw new AppError(ErrorCode.FORBIDDEN, '不能操作群主');
  }

  if (action === 'remove') {
    // 软删除：保留历史消息，但不再接收新消息
    await db
      .update(conversationMembers)
      .set({ leftAt: Date.now(), updatedAt: Date.now() })
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, targetUserId),
        ),
      );
    return;
  }

  await db
    .update(conversationMembers)
    .set({ role: action === 'promote' ? 'admin' : 'member', updatedAt: Date.now() })
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, targetUserId),
      ),
    );
}

/* ------------------------------------------------------------------ */
/* 已读水位与个人设置                                                    */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 群成员管理（扩展）                                                    */
/* ------------------------------------------------------------------ */

/**
 * 群成员列表
 * join 出用户信息与我的备注名，一次查询返回全部展示字段。
 */
export async function listGroupMembers(
  conversationId: string,
  operatorId: string,
): Promise<GroupMemberItem[]> {
  await requireMember(conversationId, operatorId);

  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      nickname: users.nickname,
      avatarUrl: users.avatarUrl,
      lastSeenAt: users.lastSeenAt,
      role: conversationMembers.role,
      remark: contactRemarks.remark,
    })
    .from(conversationMembers)
    .innerJoin(users, eq(users.id, conversationMembers.userId))
    .leftJoin(
      contactRemarks,
      and(
        eq(contactRemarks.ownerId, operatorId),
        eq(contactRemarks.targetId, conversationMembers.userId),
      ),
    )
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        isNull(conversationMembers.leftAt),
      ),
    );

  return rows.map((r) => ({
    userId: r.userId,
    email: maskEmail(r.email),
    nickname: r.nickname,
    avatarUrl: r.avatarUrl,
    remark: r.remark ?? null,
    displayName: r.remark?.trim() ? r.remark : r.nickname,
    role: r.role as GroupRole,
    lastSeenAt: r.lastSeenAt,
  }));
}

/**
 * 邀请成员入群
 * 权限：群主、管理员、普通成员都可邀请（与 Telegram 一致）。
 * 已在群内的人会被跳过而不是报错，避免批量邀请时整批失败。
 */
export async function inviteMembers(
  conversationId: string,
  operatorId: string,
  userIds: string[],
): Promise<{ added: string[]; skipped: string[] }> {
  await requireMember(conversationId, operatorId);

  const [conv] = await db
    .select({ type: conversations.type })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!conv) throw new AppError(ErrorCode.CONVERSATION_NOT_FOUND);
  if (conv.type !== 'group') throw new AppError(ErrorCode.BAD_REQUEST, '私聊不支持邀请成员');

  const current = await db
    .select({ userId: conversationMembers.userId, leftAt: conversationMembers.leftAt })
    .from(conversationMembers)
    .where(eq(conversationMembers.conversationId, conversationId));

  const active = new Set(current.filter((m) => m.leftAt === null).map((m) => m.userId));
  const left = new Set(current.filter((m) => m.leftAt !== null).map((m) => m.userId));

  if (active.size + userIds.length > GROUP_MAX_MEMBERS) {
    throw new AppError(ErrorCode.GROUP_MEMBER_LIMIT_REACHED);
  }

  const now = Date.now();
  const added: string[] = [];
  const skipped: string[] = [];

  for (const uid of userIds) {
    if (active.has(uid)) {
      skipped.push(uid);
      continue;
    }
    if (left.has(uid)) {
      // 曾经的成员：恢复而不是重建，保留已读水位
      await db
        .update(conversationMembers)
        .set({ leftAt: null, joinedAt: now, updatedAt: now })
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, uid),
          ),
        );
    } else {
      await db.insert(conversationMembers).values({
        conversationId,
        userId: uid,
        role: 'member',
        lastReadSeq: 0,
        pinned: false,
        muted: false,
        joinedAt: now,
        updatedAt: now,
      });
    }
    added.push(uid);
  }

  return { added, skipped };
}

/** 退群：群主必须先转让 */
export async function leaveGroup(conversationId: string, userId: string): Promise<void> {
  const { role } = await requireMember(conversationId, userId);

  if (role === 'owner') throw new AppError(ErrorCode.GROUP_OWNER_CANNOT_LEAVE);

  await db
    .update(conversationMembers)
    .set({ leftAt: Date.now(), updatedAt: Date.now() })
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
      ),
    );
}

/** 转让群主：原群主自动降为管理员 */
export async function transferOwner(
  conversationId: string,
  operatorId: string,
  targetUserId: string,
): Promise<void> {
  const { role } = await requireMember(conversationId, operatorId);
  if (role !== 'owner') throw new AppError(ErrorCode.NOT_GROUP_OWNER);
  if (targetUserId === operatorId) throw new AppError(ErrorCode.GROUP_OPERATION_ON_SELF);

  await requireMember(conversationId, targetUserId);

  await db.transaction(async (tx) => {
    await tx
      .update(conversations)
      .set({ ownerId: targetUserId })
      .where(eq(conversations.id, conversationId));

    await tx
      .update(conversationMembers)
      .set({ role: 'owner', updatedAt: Date.now() })
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, targetUserId),
        ),
      );

    await tx
      .update(conversationMembers)
      .set({ role: 'admin', updatedAt: Date.now() })
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, operatorId),
        ),
      );
  });
}

/** 修改群资料（群名 / 头像） */
export async function updateGroupInfo(
  conversationId: string,
  operatorId: string,
  patch: { title?: string; avatarUrl?: string | null },
): Promise<void> {
  const { role } = await requireMember(conversationId, operatorId);

  const [conv] = await db
    .select({ type: conversations.type })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!conv) throw new AppError(ErrorCode.CONVERSATION_NOT_FOUND);
  if (conv.type !== 'group') throw new AppError(ErrorCode.BAD_REQUEST, '私聊不支持修改群资料');

  // 群主和 admin 都能改
  if (role !== 'owner' && role !== 'admin') throw new AppError(ErrorCode.GROUP_PERMISSION_DENIED);

  const set: { title?: string; avatarUrl?: string | null } = {};
  if (typeof patch.title === 'string') set.title = patch.title.trim().slice(0, 64);
  if (patch.avatarUrl !== undefined) set.avatarUrl = patch.avatarUrl;

  if (Object.keys(set).length === 0) return;

  await db.update(conversations).set(set).where(eq(conversations.id, conversationId));
}

/** 邮箱脱敏：与 friend 模块保持一致 */
function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const name = email.slice(0, at);
  const domain = email.slice(at);
  if (name.length <= 2) return `${name[0] ?? '*'}***${domain}`;
  return `${name.slice(0, 2)}***${domain}`;
}

export async function markRead(conversationId: string, userId: string, seq: number): Promise<number> {
  await requireMember(conversationId, userId);

  // 只增不减：防止客户端乱传导致未读数回退
  await db
    .update(conversationMembers)
    .set({ lastReadSeq: sql`GREATEST(${conversationMembers.lastReadSeq}, ${seq})` })
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
      ),
    );

  const rows = await db
    .select({ lastReadSeq: conversationMembers.lastReadSeq })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
      ),
    )
    .limit(1);

  return rows[0]?.lastReadSeq ?? seq;
}

export async function setPreferences(
  conversationId: string,
  userId: string,
  prefs: { pinned?: boolean; muted?: boolean },
): Promise<void> {
  await requireMember(conversationId, userId);
  await db
    .update(conversationMembers)
    .set({
      ...(prefs.pinned !== undefined ? { pinned: prefs.pinned } : {}),
      ...(prefs.muted !== undefined ? { muted: prefs.muted } : {}),
    })
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
      ),
    );
}

/** 取会话内所有活跃成员 id（用于 WS 推送路由） */
export async function activeMemberIds(conversationId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        isNull(conversationMembers.leftAt),
      ),
    );
  return rows.map((r) => r.userId);
}

/** 会话类型枚举校验（供路由层复用） */
export function isValidConversationType(t: string): t is (typeof CONVERSATION_TYPES)[number] {
  return (CONVERSATION_TYPES as readonly string[]).includes(t);
}

/**
 * 取与某用户有共同会话的所有其他用户 id
 * 用途：广播在线状态时只通知「可能关心」的人，而不是全站广播。
 */
export async function peersOf(userId: string): Promise<string[]> {
  const myConvs = await db
    .select({ conversationId: conversationMembers.conversationId })
    .from(conversationMembers)
    .where(and(eq(conversationMembers.userId, userId), isNull(conversationMembers.leftAt)));

  if (myConvs.length === 0) return [];

  const rows = await db
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(
      and(
        inArray(
          conversationMembers.conversationId,
          myConvs.map((c) => c.conversationId),
        ),
        isNull(conversationMembers.leftAt),
      ),
    );

  return [...new Set(rows.map((r) => r.userId))].filter((id) => id !== userId);
}

/** 取用户昵称（WS 输入中提示等场景用） */
export async function nicknameOf(userId: string): Promise<string> {
  const rows = await db.select({ nickname: users.nickname }).from(users).where(eq(users.id, userId)).limit(1);
  return rows[0]?.nickname ?? '用户';
}

/** 消息分页默认值导出，避免路由层重复引入 */
export { MESSAGE_PAGE_SIZE };
