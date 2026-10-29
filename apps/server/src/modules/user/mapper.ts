/**
 * ============================================================
 * 用户数据映射
 * ------------------------------------------------------------
 * 为什么需要映射层：
 * 1. 数据库行包含 password_hash 等敏感字段，绝不能直接返回给客户端；
 * 2. 数据库字段是 snake_case，接口契约是 camelCase，集中转换避免各处手写；
 * 3. 邮箱脱敏规则只写一次（列表里给别人看的是 ab***@gmail.com）。
 * ============================================================
 */

import type { AuthUser, UserPublic } from '@chat/shared';
import type { UserRow } from '../../db/schema.js';

/**
 * 邮箱脱敏
 * 规则：保留前 2 位与域名，中间用 *** 代替。
 * 例：abcdef@gmail.com → ab***@gmail.com
 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const name = email.slice(0, at);
  const domain = email.slice(at);
  if (name.length <= 2) return `${name[0] ?? '*'}***${domain}`;
  return `${name.slice(0, 2)}***${domain}`;
}

/** 数据库行 → 对外公开的用户信息（给其他用户看） */
export function toUserPublic(row: UserRow): UserPublic {
  return {
    id: row.id,
    email: maskEmail(row.email),
    nickname: row.nickname,
    avatarUrl: row.avatarUrl ?? null,
    bio: row.bio ?? null,
    lastSeenAt: row.lastSeenAt ?? null,
    createdAt: row.createdAt,
  };
}

/** 数据库行 → 本人身份信息（含完整邮箱与邀请配额） */
export function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: maskEmail(row.email),
    emailFull: row.email,
    nickname: row.nickname,
    avatarUrl: row.avatarUrl ?? null,
    bio: row.bio ?? null,
    lastSeenAt: row.lastSeenAt ?? null,
    createdAt: row.createdAt,
    inviteQuota: row.inviteQuota,
    emailVerified: row.emailVerified,
  };
}
