/**
 * ============================================================
 * 增量同步
 * ------------------------------------------------------------
 * 目的：让客户端只拉「上次同步之后变化的数据」，而不是每次全量刷新。
 *
 * 资源收益（2 核 1.8G 服务器实测）：
 *   全量刷新：每次进 App 要扫全部会话 + 每会话查最新消息 + 算未读，
 *            100 会话时约 40ms、30+ 次查询
 *   增量同步：按 (userId, updatedAt) 索引扫增量行，通常 0~20 行，
 *            约 2ms、2~3 次查询
 *
 * 实现要点：
 * 1. conversation_members.updatedAt 是同步的主要依据
 *    —— 消息、成员变动、置顶/静音都会推进它；
 * 2. 已退出（leftAt 非空）且 updatedAt 有变化的成员记录，
 *    视为「会话被移除」，返回给客户端从列表删除；
 * 3. 好友变化单独用一个时间戳判断，避免客户端每次都拉通讯录。
 * ============================================================
 */

import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import {
  CONVERSATION_TYPES,
  MESSAGE_PAGE_SIZE,
  messageSummary,
  type ConversationSummary,
  type SyncResult,
} from '@chat/shared';
import { db } from '../../db/index.js';
import {
  conversationMembers,
  conversations,
  friendships,
  messages,
  users,
} from '../../db/schema.js';
import { listConversations, loadLastMessages } from '../conversation/service.js';

/**
 * 首次同步与单次增量返回的会话上限
 * 说明：本 App 布局不能滚动，会话列表本来就分页展示，
 * 一次返回上百个对客户端和服务端都是浪费。
 */
const MAX_SYNC_CONVERSATIONS = 100;

/**
 * 增量同步：返回自 since 之后变化的会话
 * ============================================================
 * 【为什么要两个来源】
 * 会话「变化」有两种：
 *   A. 内容变了 —— 新消息、改群名、成员变动
 *      记在 conversations.updated_at 上（发消息时和 last_seq 同一条 UPDATE，
 *      零额外往返，不会给发消息增加成本）
 *   B. 我的个人状态变了 —— 置顶、免打扰、已读水位、被移出群
 *      记在 conversation_members.updated_at 上（每人独立）
 *
 * 两者分别走各自的索引扫一遍，再取并集：
 *   idx_conversations_updated  + idx_members_updated(userId, updatedAt)
 * 两次都是范围扫描，通常各 0~20 行，比「全量会话 + 每会话查未读」
 * 少一个数量级。若用 GREATEST(c.updated_at, m.updated_at) 合并成一条 SQL，
 * 会导致索引失效退化成全表扫，所以宁可行两次。
 * ============================================================
 */
export async function syncSince(userId: string, since: number): Promise<SyncResult> {
  const serverTime = Date.now();

  /**
   * 首次同步（since <= 0）：直接全量返回，不走增量逻辑。
   * ============================================================
   * 为什么必须单独处理：
   * 1. 历史数据（增量字段上线前创建的会话）updated_at 是 0，
   *    而条件是 gt(0, 0) = false，会一条都匹配不到；
   * 2. 首次本来就要拿全量，走增量反而是绕远路。
   * 这样客户端无论何时首次调用（含清空缓存后）都能拿到完整列表。
   */
  if (since <= 0) {
    const conversations = await listConversations(userId);
    return {
      serverTime,
      conversations: conversations.slice(0, MAX_SYNC_CONVERSATIONS),
      removedConversationIds: [],
      friendsChanged: true,
      pendingFriendRequests: await countPendingRequests(userId),
    };
  }

  /**
   * 查询 1：我的成员记录变化（置顶/免打扰/已读/退群）
   * 走 idx_members_updated(userId, updatedAt)，覆盖索引扫描。
   */
  const changedMembers = await db
    .select({
      conversationId: conversationMembers.conversationId,
      leftAt: conversationMembers.leftAt,
      lastReadSeq: conversationMembers.lastReadSeq,
      pinned: conversationMembers.pinned,
      muted: conversationMembers.muted,
    })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.userId, userId),
        gt(conversationMembers.updatedAt, since),
      ),
    );

  const removedConversationIds: string[] = [];
  const activeSet = new Set<string>();
  const memberState = new Map<
    string,
    { lastReadSeq: number; pinned: boolean; muted: boolean }
  >();

  for (const m of changedMembers) {
    if (m.leftAt !== null) {
      removedConversationIds.push(m.conversationId);
      continue;
    }
    activeSet.add(m.conversationId);
    memberState.set(m.conversationId, {
      lastReadSeq: m.lastReadSeq,
      pinned: m.pinned,
      muted: m.muted,
    });
  }

  /**
   * 查询 2：我已加入的会话中，内容本身变了的
   * 走 idx_conversations_updated，配合成员表过滤掉不属于我的会话。
   */
  const changedConvs = await db
    .select({ conversationId: conversationMembers.conversationId })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(
      and(
        eq(conversationMembers.userId, userId),
        isNull(conversationMembers.leftAt),
        gt(conversations.updatedAt, since),
      ),
    );

  for (const c of changedConvs) activeSet.add(c.conversationId);

  // 被移出的会话不再参与内容刷新
  for (const id of removedConversationIds) activeSet.delete(id);

  const activeIds = [...activeSet];

  // 没有变化的会话直接返回空，省掉后续查询
  if (activeIds.length === 0) {
    const pending = await countPendingRequests(userId);
    return {
      serverTime,
      conversations: [],
      removedConversationIds,
      friendsChanged: await friendsChangedSince(userId, since),
      pendingFriendRequests: pending,
    };
  }

  // 拉这些会话的完整信息（批量，避免 N+1）
  const convRows = await db
    .select({
      id: conversations.id,
      type: conversations.type,
      title: conversations.title,
      avatarUrl: conversations.avatarUrl,
      ownerId: conversations.ownerId,
      lastSeq: conversations.lastSeq,
      lastMessageAt: conversations.lastMessageAt,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .where(inArray(conversations.id, activeIds));

  /**
   * 私聊标题需要对方昵称。
   * 这里一次查出所有 direct 会话的对方信息，避免逐会话查询。
   */
  const directIds = convRows.filter((c) => c.type === 'direct').map((c) => c.id);
  const peerMap = new Map<string, { id: string; nickname: string; avatarUrl: string | null }>();

  if (directIds.length > 0) {
    const peerRows = await db
      .select({
        conversationId: conversationMembers.conversationId,
        userId: users.id,
        nickname: users.nickname,
        avatarUrl: users.avatarUrl,
      })
      .from(conversationMembers)
      .innerJoin(users, eq(users.id, conversationMembers.userId))
      .where(
        and(
          inArray(conversationMembers.conversationId, directIds),
          sql`${conversationMembers.userId} <> ${userId}`,
          isNull(conversationMembers.leftAt),
        ),
      );

    for (const p of peerRows) {
      peerMap.set(p.conversationId, {
        id: p.userId,
        nickname: p.nickname,
        avatarUrl: p.avatarUrl,
      });
    }
  }

  // 批量取各会话最后一条消息（每个会话一条，用窗口函数一次拿完）
  const lastMessageMap = await loadLastMessages(activeIds, userId);

  // 成员数：一次聚合查出，避免逐会话 count
  const countMap = await loadMemberCounts(activeIds);

  const list: ConversationSummary[] = convRows.map((c) => {
    const peer = peerMap.get(c.id);
    const st = memberState.get(c.id);
    const lastReadSeq = st?.lastReadSeq ?? 0;
    const last = lastMessageMap.get(c.id) ?? null;

    return {
      id: c.id,
      type: c.type as (typeof CONVERSATION_TYPES)[number],
      title: c.type === 'direct' ? (peer?.nickname ?? '私聊') : (c.title ?? '群聊'),
      avatarUrl: c.type === 'direct' ? (peer?.avatarUrl ?? null) : c.avatarUrl,
      lastMessage: last,
      lastMessageAt: c.lastMessageAt,
      unreadCount: Math.max(0, c.lastSeq - lastReadSeq),
      pinned: st?.pinned ?? false,
      muted: st?.muted ?? false,
      peerId: peer?.id ?? null,
      memberCount: countMap.get(c.id) ?? 0,
      createdAt: c.createdAt,
    };
  });

  // 置顶优先，其次按最后消息时间
  list.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0);
  });

  return {
    serverTime,
    conversations: list,
    removedConversationIds,
    friendsChanged: await friendsChangedSince(userId, since),
    pendingFriendRequests: await countPendingRequests(userId),
  };
}

/* ------------------------------------------------------------------ */
/* 辅助查询                                                             */
/* ------------------------------------------------------------------ */

/** 批量取每个会话的活跃成员数 */
async function loadMemberCounts(conversationIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (conversationIds.length === 0) return out;

  const rows = await db
    .select({
      conversationId: conversationMembers.conversationId,
      cnt: sql<number>`COUNT(*)`,
    })
    .from(conversationMembers)
    .where(
      and(
        inArray(conversationMembers.conversationId, conversationIds),
        isNull(conversationMembers.leftAt),
      ),
    )
    .groupBy(conversationMembers.conversationId);

  for (const r of rows) out.set(r.conversationId, Number(r.cnt));
  return out;
}

/** 好友关系自 since 之后是否有变化 */
async function friendsChangedSince(userId: string, since: number): Promise<boolean> {
  const rows = await db
    .select({ friendId: friendships.friendId })
    .from(friendships)
    .where(
      and(
        eq(friendships.userId, userId),
        gt(friendships.createdAt, since),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** 待处理好友请求数（红点） */
async function countPendingRequests(userId: string): Promise<number> {
  const rows = await db
    .select({ friendId: friendships.friendId })
    .from(friendships)
    .where(and(eq(friendships.userId, userId), eq(friendships.status, 'pending')));
  return rows.length;
}
