/**
 * ============================================================
 * ID 生成
 * ------------------------------------------------------------
 * 为什么用 ULID 而不是 UUIDv4 / 自增：
 * 1. ULID 前 10 位是时间戳，天然按时间有序 → B+ 树索引写入不随机，
 *    消息表在 MySQL 上插入性能明显好于 UUIDv4；
 * 2. 26 位 Crockford Base32，比 UUID 短，URL 里更干净；
 * 3. 不暴露业务量（自增 ID 会泄露注册用户数）。
 * ============================================================
 */

import { ulid } from 'ulid';

/** 生成业务主键 */
export function newId(): string {
  return ulid();
}

/**
 * 邀请码字符集
 * 排除 0/O/1/I/L 等易混淆字符，避免用户手抄出错。
 */
const INVITE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/**
 * 生成邀请码
 * 为什么不用 Math.random：可预测性太强，容易被枚举。
 * 这里用 crypto 强随机源，8 位字符空间约 31^8 ≈ 8.5e11，足够。
 */
export function newInviteCode(length = 8): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += INVITE_ALPHABET[bytes[i]! % INVITE_ALPHABET.length];
  }
  return out;
}

/** 生成 6 位数字验证码（使用强随机源，不用 Math.random） */
export function newEmailCode(): string {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return String(buf[0]! % 1_000_000).padStart(6, '0');
}

/** 生成高熵随机令牌（刷新令牌、媒体签名等） */
export function newRandomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Buffer.from(buf).toString('base64url');
}

/**
 * 私聊去重键
 * 说明：两个用户 id 排序后拼接，保证 A→B 与 B→A 得到同一个键，
 *      配合唯一索引即可保证不会建出两个私聊会话。
 */
export function directKeyOf(userA: string, userB: string): string {
  return [userA, userB].sort().join(':');
}
