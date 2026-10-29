/**
 * ============================================================
 * HTTP 响应辅助
 * ------------------------------------------------------------
 * 统一响应格式（与 @chat/shared 的 ApiOk/ApiErr 对齐）：
 *   成功：{ code: 0, data, serverTime }
 *   失败：{ code, message, fields?, serverTime }
 * 好处：客户端只需判断 code，不用同时处理 HTTP 状态码与业务码。
 * ============================================================
 */

import type { ApiErr, ApiOk } from '@chat/shared';
import type { FastifyReply } from 'fastify';

/** 成功响应 */
export function ok<T>(reply: FastifyReply, data: T, status = 200): FastifyReply {
  const body: ApiOk<T> = { code: 0, data, serverTime: Date.now() };
  return reply.status(status).send(body);
}

/** 失败响应（通常由全局错误处理器调用，业务代码不必直接用） */
export function fail(
  reply: FastifyReply,
  status: number,
  code: number,
  message: string,
  fields?: Record<string, string>,
  meta?: Record<string, unknown>,
): FastifyReply {
  const body: ApiErr & Record<string, unknown> = {
    code,
    message,
    serverTime: Date.now(),
    ...(fields ? { fields } : {}),
    ...(meta ?? {}),
  };
  return reply.status(status).send(body);
}

/**
 * 获取客户端真实 IP
 * 说明：服务由 OpenResty 反代，必须信任 X-Forwarded-For 的第一跳。
 *      限流与风控都依赖这个 IP，取错会导致「全站共用一个 IP」而误封。
 */
export function clientIp(headers: Record<string, unknown>, socketIp: string | undefined): string {
  const xff = headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = headers['x-real-ip'];
  if (typeof real === 'string' && real.length > 0) return real;
  return socketIp ?? '0.0.0.0';
}
