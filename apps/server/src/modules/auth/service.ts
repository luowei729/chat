/**
 * ============================================================
 * 认证服务
 * ------------------------------------------------------------
 * 覆盖：发送邮箱验证码 → 注册（含邀请码）→ 登录 → 刷新 → 登出 → 重置密码
 *
 * 安全设计：
 * 1. 验证码只存 HMAC，且一次性消费、最多尝试 5 次；
 * 2. 登录失败计数按「邮箱」维度限流，防撞库；
 * 3. 刷新令牌轮换（rotate）：每次刷新都作废旧令牌，被盗用可被检测；
 * 4. 注册强制校验邀请码，且邀请码消耗用原子 UPDATE 防并发超发；
 * 5. 重置密码后吊销该用户全部刷新令牌，强制所有设备重新登录。
 * ============================================================
 */

import {
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_TTL_MINUTES,
  ErrorCode,
  INVITE_CODE_LENGTH,
  type AuthResult,
  type Platform,
} from '@chat/shared';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { ResultSetHeader } from 'mysql2';
import { db, pool } from '../../db/index.js';
import { emailCodes, inviteCodes, inviteUsages, refreshTokens, users } from '../../db/schema.js';
import { config } from '../../config.js';
import { AppError } from '../../lib/app-error.js';
import {
  hashPassword,
  hmacEmailCode,
  newRefreshToken,
  refreshTokenId,
  safeEqual,
  sha256Hex,
  verifyPassword,
} from '../../lib/crypto.js';
import { newEmailCode, newId } from '../../lib/ids.js';
import { moduleLogger } from '../../lib/logger.js';
import {
  emailCodeDailyLimiter,
  emailCodeIpLimiter,
  emailCodeLimiter,
  loginFailLimiter,
} from '../../lib/rate-limit.js';
import { signAccessToken } from '../../lib/tokens.js';
import { sendVerificationCode } from '../../mail/index.js';
import { toAuthUser } from '../user/mapper.js';

const log = moduleLogger('auth');

/* ------------------------------------------------------------------ */
/* 发送验证码                                                           */
/* ------------------------------------------------------------------ */

export async function sendEmailCode(params: {
  email: string;
  purpose: 'register' | 'reset' | 'rebind';
  ip: string;
}): Promise<{ delivered: boolean; devCode?: string; cooldownSeconds: number }> {
  const { email, purpose, ip } = params;

  // ---------- 频控：三层限流，分别防「刷同一邮箱」「刷同一 IP」「长期滥用」 ----------
  const perEmail = emailCodeLimiter.consume(`code:${email}`);
  if (!perEmail.allowed) {
    throw new AppError(ErrorCode.RATE_LIMITED, `请 ${perEmail.retryAfterSeconds} 秒后再试`, {
      meta: { retryAfterSeconds: perEmail.retryAfterSeconds },
    });
  }

  const perIp = emailCodeIpLimiter.consume(`code-ip:${ip}`);
  if (!perIp.allowed) {
    throw new AppError(ErrorCode.RATE_LIMITED, '请求过于频繁，请稍后再试', {
      meta: { retryAfterSeconds: perIp.retryAfterSeconds },
    });
  }

  const daily = emailCodeDailyLimiter.consume(`code-day:${email}`);
  if (!daily.allowed) {
    throw new AppError(ErrorCode.RATE_LIMITED, '今日获取验证码次数已达上限，请明天再试', {
      meta: { retryAfterSeconds: daily.retryAfterSeconds },
    });
  }

  // ---------- 业务前置校验 ----------
  const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);

  if (purpose === 'register' && existing.length > 0) {
    throw new AppError(ErrorCode.EMAIL_ALREADY_REGISTERED);
  }
  // 注意：reset / rebind 即使邮箱不存在也返回成功，避免被用来枚举已注册邮箱

  const code = newEmailCode();
  const now = Date.now();
  const expiresAt = now + EMAIL_CODE_TTL_MINUTES * 60 * 1000;

  // 同一邮箱同用途的旧验证码全部作废，避免多个验证码同时有效
  await db
    .update(emailCodes)
    .set({ consumedAt: now })
    .where(and(eq(emailCodes.email, email), eq(emailCodes.purpose, purpose), isNull(emailCodes.consumedAt)));

  await db.insert(emailCodes).values({
    id: newId(),
    email,
    purpose,
    codeHash: hmacEmailCode(email, purpose, code),
    attempts: 0,
    consumedAt: null,
    expiresAt,
    createdAt: now,
    ip,
  });

  // 邮箱不存在时（reset 场景）不真正发信，但仍返回成功，防止枚举
  if (purpose !== 'register' && existing.length === 0) {
    log.warn({ email, purpose }, '邮箱未注册，静默返回成功以防枚举');
    return { delivered: false, cooldownSeconds: 60 };
  }

  const result = await sendVerificationCode(email, code, purpose);
  return { delivered: result.delivered, devCode: result.devCode, cooldownSeconds: 60 };
}

/* ------------------------------------------------------------------ */
/* 校验验证码（内部复用）                                                */
/* ------------------------------------------------------------------ */

async function consumeEmailCode(
  email: string,
  purpose: 'register' | 'reset' | 'rebind',
  code: string,
): Promise<void> {
  const now = Date.now();

  const rows = await db
    .select()
    .from(emailCodes)
    .where(
      and(
        eq(emailCodes.email, email),
        eq(emailCodes.purpose, purpose),
        isNull(emailCodes.consumedAt),
        gt(emailCodes.expiresAt, now),
      ),
    )
    .orderBy(desc(emailCodes.createdAt))
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw new AppError(ErrorCode.EMAIL_CODE_EXPIRED);
  }

  if (row.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
    // 超限直接作废，强制重新获取
    await db.update(emailCodes).set({ consumedAt: now }).where(eq(emailCodes.id, row.id));
    throw new AppError(ErrorCode.EMAIL_CODE_TOO_MANY_ATTEMPTS);
  }

  const expected = hmacEmailCode(email, purpose, code);
  if (!safeEqual(expected, row.codeHash)) {
    // 失败次数 +1：用原子自增，避免并发下计数丢失
    await db
      .update(emailCodes)
      .set({ attempts: sql`${emailCodes.attempts} + 1` })
      .where(eq(emailCodes.id, row.id));
    throw new AppError(ErrorCode.EMAIL_CODE_INVALID);
  }

  // 消费验证码：带 consumedAt IS NULL 条件，防止并发重复使用
  const [result] = await pool.execute<ResultSetHeader>(
    'UPDATE email_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL',
    [now, row.id],
  );
  if (result.affectedRows === 0) {
    throw new AppError(ErrorCode.EMAIL_CODE_INVALID);
  }
}

/* ------------------------------------------------------------------ */
/* 邀请码消费（原子）                                                    */
/* ------------------------------------------------------------------ */

interface InviteConsumption {
  inviteCodeId: string;
  inviterId: string;
}

/**
 * 原子消费一次邀请码
 * 为什么用裸 SQL：需要 `WHERE used_count < max_uses` 的条件更新，
 * 只有让数据库保证原子性，才能防止并发注册把邀请码用超。
 */
async function consumeInviteCode(code: string): Promise<InviteConsumption> {
  const now = Date.now();

  const rows = await db
    .select()
    .from(inviteCodes)
    .where(eq(inviteCodes.code, code))
    .limit(1);

  const row = rows[0];
  if (!row) throw new AppError(ErrorCode.INVITE_CODE_NOT_FOUND);
  if (row.expiresAt !== null && row.expiresAt <= now) {
    throw new AppError(ErrorCode.INVITE_CODE_EXPIRED);
  }

  const [result] = await pool.execute<ResultSetHeader>(
    'UPDATE invite_codes SET used_count = used_count + 1 WHERE id = ? AND used_count < max_uses',
    [row.id],
  );

  if (result.affectedRows === 0) {
    throw new AppError(ErrorCode.INVITE_CODE_EXHAUSTED);
  }

  return { inviteCodeId: row.id, inviterId: row.creatorId };
}

/* ------------------------------------------------------------------ */
/* 注册                                                                 */
/* ------------------------------------------------------------------ */

export async function register(params: {
  email: string;
  code: string;
  password: string;
  nickname: string;
  inviteCode: string;
  platform: Platform;
  deviceName?: string;
  deviceId: string;
}): Promise<AuthResult> {
  const { email, code, password, nickname, inviteCode, platform, deviceName, deviceId } = params;

  // ---------- 前置：邮箱唯一性 ----------
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing.length > 0) {
    throw new AppError(ErrorCode.EMAIL_ALREADY_REGISTERED);
  }

  // ---------- 邀请码：先校验存在性，避免用户填错还去消耗验证码 ----------
  if (config.registration.requireInvite) {
    if (!inviteCode || inviteCode.length !== INVITE_CODE_LENGTH) {
      throw new AppError(ErrorCode.INVITE_REQUIRED);
    }
    const invite = await db
      .select({ id: inviteCodes.id, usedCount: inviteCodes.usedCount, maxUses: inviteCodes.maxUses, expiresAt: inviteCodes.expiresAt })
      .from(inviteCodes)
      .where(eq(inviteCodes.code, inviteCode))
      .limit(1);
    const inv = invite[0];
    if (!inv) throw new AppError(ErrorCode.INVITE_CODE_NOT_FOUND);
    if (inv.expiresAt !== null && inv.expiresAt <= Date.now()) {
      throw new AppError(ErrorCode.INVITE_CODE_EXPIRED);
    }
    if (inv.usedCount >= inv.maxUses) {
      throw new AppError(ErrorCode.INVITE_CODE_EXHAUSTED);
    }
  }

  // ---------- 验证邮箱验证码 ----------
  await consumeEmailCode(email, 'register', code);

  // ---------- 创建用户 + 记录邀请关系（同一事务） ----------
  const now = Date.now();
  const userId = newId();
  const passwordHash = await hashPassword(password);

  // 邀请码消费必须用「条件更新」保证原子性（防并发超发），
  // 因此在事务外先完成消费；若后续插入失败，邀请码名额会被浪费一次，
  // 这是可接受的取舍（相比超发导致邀请机制失效，浪费一次更安全）。
  const consumption: InviteConsumption | null = config.registration.requireInvite
    ? await consumeInviteCode(inviteCode)
    : null;

  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id: userId,
      email,
      emailVerified: true,
      passwordHash,
      nickname,
      avatarUrl: null,
      bio: null,
      inviteQuota: config.registration.defaultInviteQuota,
      invitedBy: consumption?.inviterId ?? null,
      status: 'active',
      createdAt: now,
      lastSeenAt: now,
    });

    if (consumption) {
      await tx.insert(inviteUsages).values({
        id: newId(),
        inviteCodeId: consumption.inviteCodeId,
        inviteeId: userId,
        inviterId: consumption.inviterId,
        createdAt: now,
      });
    }
  });

  log.info({ userId, invitedBy: consumption?.inviterId ?? null }, '用户注册成功');

  // ---------- 签发令牌 ----------
  return issueTokens({ userId, platform, deviceId, deviceName });
}

/* ------------------------------------------------------------------ */
/* 登录                                                                 */
/* ------------------------------------------------------------------ */

export async function login(params: {
  email: string;
  password: string;
  platform: Platform;
  deviceName?: string;
  deviceId: string;
}): Promise<AuthResult> {
  const { email, password, platform, deviceName, deviceId } = params;

  // 按邮箱维度限流：防止撞库
  const gate = loginFailLimiter.consume(`login:${email}`);
  if (!gate.allowed) {
    throw new AppError(ErrorCode.RATE_LIMITED, '登录尝试过于频繁，请稍后再试', {
      meta: { retryAfterSeconds: gate.retryAfterSeconds },
    });
  }

  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const user = rows[0];

  // 统一返回「邮箱或密码不正确」，不泄露邮箱是否存在
  if (!user) {
    throw new AppError(ErrorCode.CREDENTIALS_INVALID);
  }
  if (user.status !== 'active') {
    throw new AppError(ErrorCode.ACCOUNT_DISABLED);
  }

  const passwordOk = await verifyPassword(password, user.passwordHash);
  if (!passwordOk) {
    throw new AppError(ErrorCode.CREDENTIALS_INVALID);
  }

  // 登录成功清空失败计数
  loginFailLimiter.reset(`login:${email}`);

  await db.update(users).set({ lastSeenAt: Date.now() }).where(eq(users.id, user.id));

  return issueTokens({ userId: user.id, platform, deviceId, deviceName });
}

/* ------------------------------------------------------------------ */
/* 签发令牌                                                             */
/* ------------------------------------------------------------------ */

async function issueTokens(params: {
  userId: string;
  platform: Platform;
  deviceId: string;
  deviceName?: string;
}): Promise<AuthResult> {
  const { userId, platform, deviceId, deviceName } = params;

  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = rows[0];
  if (!user) throw new AppError(ErrorCode.UNAUTHORIZED);

  const { id: refreshId, token: refreshToken, hash } = newRefreshToken();
  const now = Date.now();
  const refreshExpiresAt = now + 30 * 24 * 60 * 60 * 1000;

  // 同一设备只保留最新一条刷新令牌，避免设备列表无限膨胀
  await db
    .update(refreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(refreshTokens.userId, userId), eq(refreshTokens.deviceId, deviceId), isNull(refreshTokens.revokedAt)));

  await db.insert(refreshTokens).values({
    id: refreshId,
    userId,
    tokenHash: hash,
    deviceId,
    platform,
    deviceName: deviceName ?? null,
    expiresAt: refreshExpiresAt,
    revokedAt: null,
    createdAt: now,
    lastUsedAt: now,
  });

  const access = await signAccessToken({ sub: userId, did: deviceId, plt: platform, rid: refreshId });

  return {
    accessToken: access.token,
    refreshToken,
    accessTokenExpiresAt: access.expiresAt,
    user: toAuthUser(user),
  };
}

/* ------------------------------------------------------------------ */
/* 刷新令牌（轮换）                                                      */
/* ------------------------------------------------------------------ */

export async function refresh(params: { refreshToken: string; platform: Platform; deviceId: string }): Promise<AuthResult> {
  const { refreshToken, platform, deviceId } = params;

  const id = refreshTokenId(refreshToken);
  if (!id) throw new AppError(ErrorCode.REFRESH_TOKEN_REVOKED);

  const rows = await db.select().from(refreshTokens).where(eq(refreshTokens.id, id)).limit(1);
  const row = rows[0];

  if (!row) throw new AppError(ErrorCode.REFRESH_TOKEN_REVOKED);
  if (row.revokedAt !== null) throw new AppError(ErrorCode.REFRESH_TOKEN_REVOKED);
  if (row.expiresAt <= Date.now()) throw new AppError(ErrorCode.REFRESH_TOKEN_REVOKED);

  // 校验哈希，防止伪造
  if (sha256Hex(refreshToken) !== row.tokenHash) {
    // 哈希不匹配说明令牌被篡改，直接吊销该设备所有令牌（可能是令牌泄露）
    await db.update(refreshTokens).set({ revokedAt: Date.now() }).where(eq(refreshTokens.userId, row.userId));
    log.warn({ userId: row.userId, deviceId: row.deviceId }, '刷新令牌哈希不匹配，已吊销全部令牌');
    throw new AppError(ErrorCode.REFRESH_TOKEN_REVOKED);
  }

  // 轮换：作废旧令牌
  await db.update(refreshTokens).set({ revokedAt: Date.now() }).where(eq(refreshTokens.id, row.id));

  return issueTokens({ userId: row.userId, platform, deviceId, deviceName: row.deviceName ?? undefined });
}

/* ------------------------------------------------------------------ */
/* 登出                                                                 */
/* ------------------------------------------------------------------ */

export async function logout(params: { userId: string; refreshToken?: string }): Promise<void> {
  const now = Date.now();
  if (params.refreshToken) {
    const id = refreshTokenId(params.refreshToken);
    if (id) {
      await db.update(refreshTokens).set({ revokedAt: now }).where(eq(refreshTokens.id, id));
    }
    return;
  }
  // 未指定设备则吊销全部
  await db.update(refreshTokens).set({ revokedAt: now }).where(eq(refreshTokens.userId, params.userId));
}

/* ------------------------------------------------------------------ */
/* 重置密码                                                             */
/* ------------------------------------------------------------------ */

export async function resetPassword(params: {
  email: string;
  code: string;
  newPassword: string;
}): Promise<void> {
  const { email, code, newPassword } = params;

  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const user = rows[0];
  if (!user) throw new AppError(ErrorCode.CREDENTIALS_INVALID);

  await consumeEmailCode(email, 'reset', code);

  const passwordHash = await hashPassword(newPassword);
  await db.update(users).set({ passwordHash }).where(eq(users.id, user.id));

  // 强制所有设备重新登录
  await db.update(refreshTokens).set({ revokedAt: Date.now() }).where(eq(refreshTokens.userId, user.id));

  log.info({ userId: user.id }, '密码已重置，全部会话已吊销');
}
