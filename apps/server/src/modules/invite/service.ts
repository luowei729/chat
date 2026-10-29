/**
 * ============================================================
 * 邀请码服务
 * ------------------------------------------------------------
 * 邀请机制的商业逻辑：
 * 1. 每个用户注册后获得固定配额（默认 5 个名额）；
 * 2. 每生成一个邀请码消耗 1 个配额，邀请码被使用后不可回收；
 * 3. 邀请码可设置可用次数与有效期（默认 1 次、永久）；
 * 4. 记录邀请关系，用于追溯增长来源与后续激励。
 *
 * 安全设计：
 * 邀请码使用强随机源生成，排除易混淆字符（0/O/1/I/L），
 * 8 位字符空间约 8.5e11，无法被枚举。
 * ============================================================
 */

import { ErrorCode, INVITE_CODE_LENGTH, type InviteOverview } from '@chat/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { inviteCodes, inviteUsages, users } from '../../db/schema.js';
import { AppError } from '../../lib/app-error.js';
import { newId, newInviteCode } from '../../lib/ids.js';
import { moduleLogger } from '../../lib/logger.js';

const log = moduleLogger('invite');

/* ------------------------------------------------------------------ */
/* 生成邀请码                                                           */
/* ------------------------------------------------------------------ */

export async function createInvite(params: {
  creatorId: string;
  maxUses: number;
  expiresInDays?: number;
}): Promise<{ code: string; id: string; expiresAt: number | null }> {
  const { creatorId, maxUses, expiresInDays } = params;

  // 检查配额
  const rows = await db
    .select({ inviteQuota: users.inviteQuota })
    .from(users)
    .where(eq(users.id, creatorId))
    .limit(1);

  const user = rows[0];
  if (!user) throw new AppError(ErrorCode.UNAUTHORIZED);
  if (user.inviteQuota <= 0) {
    throw new AppError(ErrorCode.INVITE_QUOTA_EXCEEDED, '可邀请名额已用完');
  }

  // 生成不重复的码：理论上碰撞概率极低，但仍做一次唯一性检查
  let code = newInviteCode(INVITE_CODE_LENGTH);
  for (let i = 0; i < 5; i += 1) {
    const dup = await db
      .select({ id: inviteCodes.id })
      .from(inviteCodes)
      .where(eq(inviteCodes.code, code))
      .limit(1);
    if (dup.length === 0) break;
    code = newInviteCode(INVITE_CODE_LENGTH);
  }

  const now = Date.now();
  const expiresAt = expiresInDays ? now + expiresInDays * 24 * 60 * 60 * 1000 : null;
  const id = newId();

  /**
   * 扣减配额与插入邀请码必须原子：
   * 用 `WHERE invite_quota > 0` 条件更新，靠 MySQL 行锁防并发超发；
   * 若影响行数为 0 说明配额已被别的请求扣光，直接抛错回滚。
   */
  await db.transaction(async (tx) => {
    const [result] = await tx
      .update(users)
      .set({ inviteQuota: sql`${users.inviteQuota} - 1` })
      .where(and(eq(users.id, creatorId), sql`${users.inviteQuota} > 0`));

    const affected = (result as unknown as { affectedRows?: number }).affectedRows ?? 1;
    if (affected === 0) {
      throw new AppError(ErrorCode.INVITE_QUOTA_EXCEEDED, '可邀请名额已用完');
    }

    await tx.insert(inviteCodes).values({
      id,
      code,
      creatorId,
      maxUses,
      usedCount: 0,
      expiresAt,
      createdAt: now,
    });
  });

  log.info({ creatorId, code, maxUses, expiresAt }, '生成邀请码');
  return { code, id, expiresAt };
}

/* ------------------------------------------------------------------ */
/* 邀请总览                                                             */
/* ------------------------------------------------------------------ */

export async function getOverview(userId: string): Promise<InviteOverview> {
  const userRows = await db
    .select({ inviteQuota: users.inviteQuota })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const quota = userRows[0]?.inviteQuota ?? 0;

  const codeRows = await db
    .select()
    .from(inviteCodes)
    .where(eq(inviteCodes.creatorId, userId))
    .orderBy(desc(inviteCodes.createdAt))
    .limit(50);

  const usageRows = await db
    .select({
      userId: users.id,
      nickname: users.nickname,
      avatarUrl: users.avatarUrl,
      joinedAt: inviteUsages.createdAt,
    })
    .from(inviteUsages)
    .innerJoin(users, eq(users.id, inviteUsages.inviteeId))
    .where(eq(inviteUsages.inviterId, userId))
    .orderBy(desc(inviteUsages.createdAt))
    .limit(100);

  return {
    quota,
    codes: codeRows.map((c) => ({
      id: c.id,
      code: c.code,
      remainingUses: Math.max(0, c.maxUses - c.usedCount),
      usedCount: c.usedCount,
      maxUses: c.maxUses,
      expiresAt: c.expiresAt ?? null,
      createdAt: c.createdAt,
    })),
    invitees: usageRows.map((u) => ({
      userId: u.userId,
      nickname: u.nickname,
      avatarUrl: u.avatarUrl ?? null,
      joinedAt: u.joinedAt,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* 校验邀请码（注册时预检，不消费）                                       */
/* ------------------------------------------------------------------ */

export async function validateInviteCode(code: string): Promise<{ valid: boolean; reason?: string }> {
  const rows = await db
    .select()
    .from(inviteCodes)
    .where(eq(inviteCodes.code, code))
    .limit(1);

  const row = rows[0];
  if (!row) return { valid: false, reason: '邀请码不存在' };
  if (row.expiresAt !== null && row.expiresAt <= Date.now()) {
    return { valid: false, reason: '邀请码已过期' };
  }
  if (row.usedCount >= row.maxUses) {
    return { valid: false, reason: '邀请码已用完' };
  }
  return { valid: true };
}

/** 统计用户的邀请人数（用于「我的邀请」页展示） */
export async function countInvitees(userId: string): Promise<number> {
  const rows = await db
    .select({ id: inviteUsages.id })
    .from(inviteUsages)
    .where(eq(inviteUsages.inviterId, userId));

  return rows.length;
}
