/**
 * ============================================================
 * 好友体系服务层
 * ------------------------------------------------------------
 * 数据模型见 schema.ts 的 friendships / contactRemarks。
 *
 * 【核心不变量】
 * 1. 好友关系双写：A→B 与 B→A 两条记录必须同时在、同时改。
 *    因此所有写操作都在事务里成对执行。
 * 2. 单向拉黑：userId 把自己的那条改成 blocked，
 *    对方那条保持不变（他仍以为你们是好友，但发不出消息）。
 * 3. 备注名独立于好友关系：删好友不清备注，重新加回来备注还在。
 * ============================================================
 */

import { and, desc, eq, or, sql } from 'drizzle-orm';
import {
  ErrorCode,
  type FriendItem,
  type FriendRequestItem,
  type FriendRequests,
  type RelationState,
  type UserProfileView,
} from '@chat/shared';
import { db } from '../../db/index.js';
import {
  contactRemarks,
  conversationMembers,
  conversations,
  friendships,
  users,
} from '../../db/schema.js';
import { AppError } from '../../lib/app-error.js';
import { newId } from '../../lib/ids.js';

/* ------------------------------------------------------------------ */
/* 内部工具                                                             */
/* ------------------------------------------------------------------ */

/** 私聊去重键：两个 userId 排序后拼接，与 conversation 模块保持一致 */
function directKeyOf(a: string, b: string): string {
  return [a, b].sort().join(':');
}

/** 查出我与某人的关系状态 */
export async function relationWith(meId: string, otherId: string): Promise<RelationState> {
  if (meId === otherId) return 'self';

  const [mine] = await db
    .select()
    .from(friendships)
    .where(and(eq(friendships.userId, meId), eq(friendships.friendId, otherId)))
    .limit(1);

  if (!mine) {
    // 我这边没记录，但对方可能已经拉黑我
    const [theirs] = await db
      .select()
      .from(friendships)
      .where(
        and(
          eq(friendships.userId, otherId),
          eq(friendships.friendId, meId),
          eq(friendships.status, 'blocked'),
        ),
      )
      .limit(1);
    return theirs ? 'blocked' : 'none';
  }

  if (mine.status === 'accepted') return 'friend';
  if (mine.status === 'blocked') return 'blocked';
  // pending：根据 requesterId 判断方向
  return mine.requesterId === meId ? 'request-sent' : 'request-received';
}

/** 是否互为好友（发消息前的前置校验） */
export async function areFriends(a: string, b: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: friendships.userId })
    .from(friendships)
    .where(
      and(
        eq(friendships.userId, a),
        eq(friendships.friendId, b),
        eq(friendships.status, 'accepted'),
      ),
    )
    .limit(1);
  return !!row;
}

/** 是否被对方拉黑 */
export async function isBlockedBy(blockerId: string, blockedId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: friendships.userId })
    .from(friendships)
    .where(
      and(
        eq(friendships.userId, blockerId),
        eq(friendships.friendId, blockedId),
        eq(friendships.status, 'blocked'),
      ),
    )
    .limit(1);
  return !!row;
}

/* ------------------------------------------------------------------ */
/* 查询                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 好友列表
 * 一次性 join 出用户信息、备注名、私聊会话 id，避免 N+1 查询。
 */
export async function listFriends(meId: string): Promise<FriendItem[]> {
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      nickname: users.nickname,
      avatarUrl: users.avatarUrl,
      bio: users.bio,
      lastSeenAt: users.lastSeenAt,
      remark: contactRemarks.remark,
      conversationId: conversations.id,
    })
    .from(friendships)
    .innerJoin(users, eq(users.id, friendships.friendId))
    .leftJoin(
      contactRemarks,
      and(eq(contactRemarks.ownerId, meId), eq(contactRemarks.targetId, friendships.friendId)),
    )
    .leftJoin(
      conversations,
      and(
        eq(conversations.type, 'direct'),
        eq(
          conversations.directKey,
          // 直接用 SQL 拼接，避免为每条记录算两次
          sql`LEAST(CONCAT(${meId}, ':', ${friendships.friendId}), CONCAT(${friendships.friendId}, ':', ${meId}))`,
        ),
      ),
    )
    .where(and(eq(friendships.userId, meId), eq(friendships.status, 'accepted')))
    .orderBy(desc(friendships.acceptedAt));

  return rows.map((r) => ({
    userId: r.userId,
    email: maskEmail(r.email),
    nickname: r.nickname,
    avatarUrl: r.avatarUrl,
    bio: r.bio,
    remark: r.remark ?? null,
    displayName: r.remark?.trim() ? r.remark : r.nickname,
    lastSeenAt: r.lastSeenAt,
    conversationId: r.conversationId,
  }));
}

/** 待处理的好友请求（收到的 + 发出的） */
export async function listRequests(meId: string): Promise<FriendRequests> {
  const rows = await db
    .select({
      otherId: friendships.friendId,
      requesterId: friendships.requesterId,
      createdAt: friendships.createdAt,
      email: users.email,
      nickname: users.nickname,
      avatarUrl: users.avatarUrl,
    })
    .from(friendships)
    .innerJoin(users, eq(users.id, friendships.friendId))
    .where(and(eq(friendships.userId, meId), eq(friendships.status, 'pending')))
    .orderBy(desc(friendships.createdAt));

  const incoming: FriendRequestItem[] = [];
  const outgoing: FriendRequestItem[] = [];

  for (const r of rows) {
    const item: FriendRequestItem = {
      userId: r.otherId,
      email: maskEmail(r.email),
      nickname: r.nickname,
      avatarUrl: r.avatarUrl,
      incoming: r.requesterId !== meId,
      createdAt: r.createdAt,
    };
    if (item.incoming) incoming.push(item);
    else outgoing.push(item);
  }

  return { incoming, outgoing };
}

/** 他人资料页视图 */
export async function profileOf(meId: string, targetId: string): Promise<UserProfileView> {
  const [u] = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
  if (!u) throw new AppError(ErrorCode.NOT_FOUND);

  const relation = await relationWith(meId, targetId);

  let remark: string | null = null;
  if (relation !== 'self') {
    const [r] = await db
      .select()
      .from(contactRemarks)
      .where(and(eq(contactRemarks.ownerId, meId), eq(contactRemarks.targetId, targetId)))
      .limit(1);
    remark = r?.remark ?? null;
  }

  let conversationId: string | null = null;
  if (relation === 'friend') {
    const [c] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(eq(conversations.type, 'direct'), eq(conversations.directKey, directKeyOf(meId, targetId))),
      )
      .limit(1);
    conversationId = c?.id ?? null;
  }

  return {
    id: u.id,
    email: maskEmail(u.email),
    nickname: u.nickname,
    avatarUrl: u.avatarUrl,
    bio: u.bio,
    lastSeenAt: u.lastSeenAt,
    createdAt: u.createdAt,
    relation,
    remark,
    conversationId,
  };
}

/* ------------------------------------------------------------------ */
/* 好友请求流程                                                         */
/* ------------------------------------------------------------------ */

export interface FriendRequestResult {
  /** 是否直接成为好友（对方之前已发过请求时自动接受） */
  autoAccepted: boolean;
  conversationId: string | null;
}

/**
 * 发起好友请求
 * ============================================================
 * 特殊处理：如果对方已经给我发过请求，直接视为接受，
 * 避免出现「双方互相请求但谁也不同意」的死锁体验。
 * ============================================================
 */
export async function requestFriend(meId: string, targetId: string): Promise<FriendRequestResult> {
  if (meId === targetId) throw new AppError(ErrorCode.FRIEND_SELF);

  const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, targetId)).limit(1);
  if (!target) throw new AppError(ErrorCode.NOT_FOUND);

  const [mine] = await db
    .select()
    .from(friendships)
    .where(and(eq(friendships.userId, meId), eq(friendships.friendId, targetId)))
    .limit(1);

  if (mine) {
    if (mine.status === 'accepted') throw new AppError(ErrorCode.FRIEND_ALREADY);
    if (mine.status === 'blocked') throw new AppError(ErrorCode.FRIEND_BLOCKED_BY_SELF);
    // pending
    if (mine.requesterId === meId) throw new AppError(ErrorCode.FRIEND_REQUEST_PENDING_OUTGOING);
    // 对方先请求的 → 直接接受
    return acceptFriend(meId, targetId);
  }

  if (await isBlockedBy(targetId, meId)) throw new AppError(ErrorCode.FRIEND_BLOCKED_BY_PEER);

  const now = Date.now();
  await db.transaction(async (tx) => {
    await tx.insert(friendships).values({
      userId: meId,
      friendId: targetId,
      status: 'pending',
      requesterId: meId,
      createdAt: now,
    });
    await tx.insert(friendships).values({
      userId: targetId,
      friendId: meId,
      status: 'pending',
      requesterId: meId,
      createdAt: now,
    });
  });

  return { autoAccepted: false, conversationId: null };
}

/**
 * 接受好友请求
 * 同时创建私聊会话（若尚不存在），这样接受后能立刻开聊。
 */
/**
 * 直接添加联系人（无需对方批准）
 * ============================================================
 * 产品语义（对齐 Telegram）：
 *   聊天不需要先加好友 —— 任何两个用户都能直接开聊；
 *   「加到通讯录」只是本地的归类动作，不产生请求、不等审批。
 *
 * 与 requestFriend 的区别：
 *   requestFriend      → 写 pending，等对方 accept（保留兼容）
 *   addFriendDirectly  → 两步一起做：直接置为 accepted 并建私聊
 *
 * 幂等：已是好友直接返回现有会话；被对方拉黑则报错。
 */
export async function addFriendDirectly(
  meId: string,
  targetId: string,
): Promise<FriendRequestResult> {
  if (meId === targetId) throw new AppError(ErrorCode.FRIEND_SELF);

  const [target] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, targetId))
    .limit(1);
  if (!target) throw new AppError(ErrorCode.NOT_FOUND);

  if (await isBlockedBy(targetId, meId)) {
    throw new AppError(ErrorCode.FRIEND_BLOCKED_BY_PEER);
  }

  const now = Date.now();

  const conversationId = await db.transaction(async (tx) => {
    // 双向都置为 accepted：upsert 语义，已存在就更新
    for (const [a, b, requester] of [
      [meId, targetId, meId],
      [targetId, meId, meId],
    ] as const) {
      const [row] = await tx
        .select({ status: friendships.status })
        .from(friendships)
        .where(and(eq(friendships.userId, a), eq(friendships.friendId, b)))
        .limit(1);

      if (row) {
        // 已被本人拉黑过就保持 blocked，不覆盖
        if (row.status !== 'blocked') {
          await tx
            .update(friendships)
            .set({ status: 'accepted', acceptedAt: now })
            .where(and(eq(friendships.userId, a), eq(friendships.friendId, b)));
        }
      } else {
        await tx.insert(friendships).values({
          userId: a,
          friendId: b,
          status: 'accepted',
          requesterId: requester,
          createdAt: now,
          acceptedAt: now,
        });
      }
    }

    // 建私聊（directKey 唯一索引保证幂等）
    const key = directKeyOf(meId, targetId);
    const [existing] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.type, 'direct'), eq(conversations.directKey, key)))
      .limit(1);
    if (existing) return existing.id;

    const cid = newId();
    await tx.insert(conversations).values({
      id: cid,
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
      {
        conversationId: cid,
        userId: meId,
        role: 'member',
        lastReadSeq: 0,
        pinned: false,
        muted: false,
        joinedAt: now,
        updatedAt: now,
        leftAt: null,
      },
      {
        conversationId: cid,
        userId: targetId,
        role: 'member',
        lastReadSeq: 0,
        pinned: false,
        muted: false,
        joinedAt: now,
        updatedAt: now,
        leftAt: null,
      },
    ]);

    return cid;
  });

  return { autoAccepted: true, conversationId };
}

export async function acceptFriend(meId: string, requesterId: string): Promise<FriendRequestResult> {
  const [mine] = await db
    .select()
    .from(friendships)
    .where(and(eq(friendships.userId, meId), eq(friendships.friendId, requesterId)))
    .limit(1);

  if (!mine || mine.status !== 'pending') throw new AppError(ErrorCode.FRIEND_REQUEST_NOT_FOUND);
  if (mine.requesterId === meId) throw new AppError(ErrorCode.FRIEND_REQUEST_NOT_FOUND);

  const now = Date.now();

  const conversationId = await db.transaction(async (tx) => {
    // 两边同时置为 accepted
    await tx
      .update(friendships)
      .set({ status: 'accepted', acceptedAt: now })
      .where(and(eq(friendships.userId, meId), eq(friendships.friendId, requesterId)));
    await tx
      .update(friendships)
      .set({ status: 'accepted', acceptedAt: now })
      .where(and(eq(friendships.userId, requesterId), eq(friendships.friendId, meId)));

    // 建私聊（幂等：directKey 有唯一索引）
    const key = directKeyOf(meId, requesterId);
    const [existing] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.type, 'direct'), eq(conversations.directKey, key)))
      .limit(1);

    if (existing) return existing.id;

    const cid = newId();
    await tx.insert(conversations).values({
      id: cid,
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
      { conversationId: cid, userId: meId, role: 'member', lastReadSeq: 0, pinned: false, muted: false, joinedAt: now },
      { conversationId: cid, userId: requesterId, role: 'member', lastReadSeq: 0, pinned: false, muted: false, joinedAt: now },
    ]);
    return cid;
  });

  return { autoAccepted: true, conversationId };
}

/** 拒绝好友请求：直接删掉两条 pending 记录 */
export async function rejectFriend(meId: string, requesterId: string): Promise<void> {
  const [mine] = await db
    .select()
    .from(friendships)
    .where(and(eq(friendships.userId, meId), eq(friendships.friendId, requesterId)))
    .limit(1);

  if (!mine || mine.status !== 'pending') throw new AppError(ErrorCode.FRIEND_REQUEST_NOT_FOUND);

  await db.transaction(async (tx) => {
    await tx
      .delete(friendships)
      .where(and(eq(friendships.userId, meId), eq(friendships.friendId, requesterId)));
    await tx
      .delete(friendships)
      .where(and(eq(friendships.userId, requesterId), eq(friendships.friendId, meId)));
  });
}

/** 删除好友：只删双向 accepted 记录，保留备注名 */
export async function removeFriend(meId: string, friendId: string): Promise<void> {
  const [mine] = await db
    .select()
    .from(friendships)
    .where(and(eq(friendships.userId, meId), eq(friendships.friendId, friendId)))
    .limit(1);

  if (!mine || mine.status !== 'accepted') throw new AppError(ErrorCode.FRIEND_NOT_FOUND);

  await db.transaction(async (tx) => {
    await tx
      .delete(friendships)
      .where(and(eq(friendships.userId, meId), eq(friendships.friendId, friendId)));
    await tx
      .delete(friendships)
      .where(and(eq(friendships.userId, friendId), eq(friendships.friendId, meId)));
  });
}

/**
 * 拉黑某人
 * 只改我这条记录为 blocked（单向），对方那条保持不变。
 * 若此前是好友，对方会因为 areFriends 返回 false 而无法发消息。
 */
export async function blockFriend(meId: string, targetId: string): Promise<void> {
  if (meId === targetId) throw new AppError(ErrorCode.FRIEND_SELF);

  const now = Date.now();
  await db
    .insert(friendships)
    .values({
      userId: meId,
      friendId: targetId,
      status: 'blocked',
      requesterId: meId,
      createdAt: now,
    })
    .onDuplicateKeyUpdate({ set: { status: 'blocked' } });
}

/** 解除拉黑：删掉我这条 blocked 记录 */
export async function unblockFriend(meId: string, targetId: string): Promise<void> {
  await db
    .delete(friendships)
    .where(
      and(
        eq(friendships.userId, meId),
        eq(friendships.friendId, targetId),
        eq(friendships.status, 'blocked'),
      ),
    );
}

/* ------------------------------------------------------------------ */
/* 备注名                                                               */
/* ------------------------------------------------------------------ */

export async function setRemark(meId: string, targetId: string, remark: string): Promise<void> {
  if (meId === targetId) throw new AppError(ErrorCode.FRIEND_SELF);

  const trimmed = remark.trim().slice(0, 32);
  const now = Date.now();

  if (!trimmed) {
    await db
      .delete(contactRemarks)
      .where(and(eq(contactRemarks.ownerId, meId), eq(contactRemarks.targetId, targetId)));
    return;
  }

  await db
    .insert(contactRemarks)
    .values({ ownerId: meId, targetId, remark: trimmed, updatedAt: now })
    .onDuplicateKeyUpdate({ set: { remark: trimmed, updatedAt: now } });
}

/* ------------------------------------------------------------------ */
/* 工具                                                                 */
/* ------------------------------------------------------------------ */

/** 邮箱脱敏：仅显示首 2 位与域名 */
function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const name = email.slice(0, at);
  const domain = email.slice(at);
  if (name.length <= 2) return `${name[0] ?? '*'}***${domain}`;
  return `${name.slice(0, 2)}***${domain}`;
}

/** 取昵称（通知里用，避免整份 profile 查询） */
export async function nicknameOf(userId: string): Promise<string> {
  const [u] = await db
    .select({ nickname: users.nickname })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return u?.nickname ?? '';
}
