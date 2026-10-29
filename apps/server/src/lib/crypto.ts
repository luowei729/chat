/**
 * ============================================================
 * 密码学工具
 * ------------------------------------------------------------
 * 关键决策：
 * 1. 密码用 argon2id：内存硬（memory-hard），GPU 爆破成本远高于 bcrypt；
 *    参数按 OWASP 2024 推荐（19MiB / 2 次迭代），2 核服务器单次约 40ms；
 * 2. 验证码与令牌只存哈希，不存明文；
 * 3. 验证码是 6 位数字，必须加 HMAC 服务端密钥，否则离线爆破秒破；
 * 4. 所有比较用 timingSafeEqual，避免时序侧信道。
 * ============================================================
 */

import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/** argon2id 参数：平衡安全性与 2 核服务器上的响应时间 */
const ARGON_OPTIONS = {
  // 19 MiB 内存
  memoryCost: 19456,
  // 2 次迭代
  timeCost: 2,
  // 单线程（服务器只有 2 核，多线程会抢占）
  parallelism: 1,
  // 输出 32 字节
  outputLen: 32,
} as const;

/** 生成密码哈希 */
export async function hashPassword(plain: string): Promise<string> {
  return argonHash(plain, ARGON_OPTIONS);
}

/** 校验密码；哈希损坏时返回 false 而不是抛错，避免登录接口 500 */
export async function verifyPassword(plain: string, hashed: string): Promise<boolean> {
  try {
    return await argonVerify(hashed, plain);
  } catch {
    return false;
  }
}

/** SHA-256 十六进制摘要（文件完整性、令牌哈希） */
export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * 验证码 HMAC
 * 说明：把 6 位验证码与「邮箱 + 用途 + 服务端密钥」一起做 HMAC，
 *      即使数据库泄露，攻击者也无法反推验证码。
 */
export function hmacEmailCode(email: string, purpose: string, code: string): string {
  return createHmac('sha256', config.jwt.secret)
    .update(`${email}|${purpose}|${code}`)
    .digest('hex');
}

/** 常量时间比较字符串，避免时序攻击 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * 生成刷新令牌
 * 格式：<id>.<随机串>
 * 为什么把 id 放在前面：查库时可直接用 id 主键定位，
 * 避免对全表做 token_hash 扫描（虽然建了唯一索引，但主键更快）。
 */
export function newRefreshToken(): { id: string; token: string; hash: string } {
  const id = randomBytes(12).toString('base64url');
  const secret = randomBytes(32).toString('base64url');
  const token = `${id}.${secret}`;
  return { id, token, hash: sha256Hex(token) };
}

/** 从刷新令牌里解析出 id（不校验，只用于查库） */
export function refreshTokenId(token: string): string | null {
  const idx = token.indexOf('.');
  if (idx <= 0) return null;
  return token.slice(0, idx);
}

/** 计算媒体访问签名：URL 带过期时间与签名，防止被外链盗用 */
export function signMediaUrl(attachmentId: string, expiresAt: number): string {
  return createHmac('sha256', config.jwt.secret)
    .update(`media|${attachmentId}|${expiresAt}`)
    .digest('base64url')
    .slice(0, 32);
}

/** 校验媒体签名 */
export function verifyMediaSignature(attachmentId: string, expiresAt: number, sig: string): boolean {
  if (!Number.isFinite(expiresAt) || expiresAt * 1000 < Date.now()) return false;
  return safeEqual(signMediaUrl(attachmentId, expiresAt), sig);
}
