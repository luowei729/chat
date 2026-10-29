/**
 * ============================================================
 * 令牌签发与校验
 * ------------------------------------------------------------
 * 双令牌策略：
 * - access token：15 分钟，HS256 JWT，无状态校验，不进数据库；
 * - refresh token：30 天，随机串，哈希后存库，可主动吊销。
 *
 * 为什么这样设计：
 * 1. 短 access 降低泄露窗口；
 * 2. refresh 可吊销，支持「退出登录/踢下线/改密码强制重登」；
 * 3. access 无状态，WS 与 HTTP 每次鉴权都不查库，2 核服务器扛得住。
 * ============================================================
 */

import { ACCESS_TOKEN_TTL_SECONDS } from '@chat/shared';
import { jwtVerify, SignJWT } from 'jose';
import { config } from '../config.js';
import { AppError } from './app-error.js';
import { ErrorCode } from '@chat/shared';

const secretKey = new TextEncoder().encode(config.jwt.secret);

/** access token 载荷 */
export interface AccessTokenPayload {
  /** 用户 id */
  sub: string;
  /** 设备标识，用于多端在线与推送路由 */
  did: string;
  /** 平台 */
  plt: string;
  /** 刷新令牌 id，便于按设备吊销 */
  rid: string;
}

/** 签发 access token */
export async function signAccessToken(payload: AccessTokenPayload): Promise<{
  token: string;
  expiresAt: number;
}> {
  const expiresAt = Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000;
  const token = await new SignJWT({ did: payload.did, plt: payload.plt, rid: payload.rid })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(payload.sub)
    .setIssuer(config.jwt.issuer)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt / 1000))
    .sign(secretKey);
  return { token, expiresAt };
}

/**
 * 校验 access token
 * 注意：区分「过期」与「非法」，客户端据此决定是刷新还是重新登录。
 */
export async function verifyAccessToken(token: string): Promise<AccessTokenPayload> {
  try {
    const { payload } = await jwtVerify(token, secretKey, {
      issuer: config.jwt.issuer,
      algorithms: ['HS256'],
    });
    if (!payload.sub) {
      throw new AppError(ErrorCode.TOKEN_INVALID);
    }
    return {
      sub: payload.sub,
      did: String(payload.did ?? ''),
      plt: String(payload.plt ?? 'unknown'),
      rid: String(payload.rid ?? ''),
    };
  } catch (e) {
    // jose 在过期时抛出 code = ERR_JWT_EXPIRED
    const code = (e as { code?: string }).code;
    if (code === 'ERR_JWT_EXPIRED') {
      throw new AppError(ErrorCode.TOKEN_EXPIRED);
    }
    throw new AppError(ErrorCode.TOKEN_INVALID);
  }
}

/** 从 Authorization 头里提取 Bearer token */
export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1]?.trim() ?? null;
}
