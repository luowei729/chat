/**
 * ============================================================
 * 认证插件（Fastify）
 * ------------------------------------------------------------
 * 提供：
 * - request.auth：鉴权中间件，把 access token 解析成用户上下文；
 * - request.optionalAuth：可选鉴权（如健康检查、公开接口）；
 * - request.userId 快捷取值。
 *
 * 为什么用装饰器而不是每个路由手写解析：
 * 1. 避免遗漏鉴权（漏写就是越权漏洞）；
 * 2. 统一把「令牌过期」映射成 401 + TOKEN_EXPIRED，客户端可精准触发刷新；
 * 3. 后续加「封号检查」「设备校验」只改一处。
 * ============================================================
 */

import { ErrorCode } from '@chat/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { AppError } from '../lib/app-error.js';
import { extractBearer, verifyAccessToken, type AccessTokenPayload } from '../lib/tokens.js';

/** 鉴权上下文：挂在 request 上供业务使用 */
export interface AuthContext extends AccessTokenPayload {
  userId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** 已登录用户上下文；未登录时为 undefined */
    auth?: AuthContext;
    /** 已登录用户 id（业务代码用这个，少写一层解构） */
    userId: string;
  }
  interface FastifyInstance {
    /** 强制鉴权：未登录直接 401 */
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** 可选鉴权：有 token 就解析，没有也放行 */
    optionalAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/** 解析 Authorization 头并校验令牌 */
async function resolveAuth(req: FastifyRequest): Promise<AuthContext | null> {
  const token = extractBearer(req.headers.authorization);
  if (!token) return null;

  const payload = await verifyAccessToken(token);

  // 校验账号状态：被封禁的账号即使 token 未过期也要拒绝
  const rows = await db
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, payload.sub))
    .limit(1);
  const row = rows[0];
  if (!row) throw new AppError(ErrorCode.TOKEN_INVALID);
  if (row.status !== 'active') throw new AppError(ErrorCode.ACCOUNT_DISABLED);

  return { ...payload, userId: payload.sub };
}

export default fp(async function authPlugin(app) {
  // 初始化默认值，避免业务代码访问 undefined 报错
  app.decorateRequest('auth', undefined);
  app.decorateRequest('userId', '');

  app.decorate('requireAuth', async (req: FastifyRequest) => {
    const auth = await resolveAuth(req);
    if (!auth) throw new AppError(ErrorCode.UNAUTHORIZED);
    req.auth = auth;
    req.userId = auth.userId;
  });

  app.decorate('optionalAuth', async (req: FastifyRequest) => {
    const auth = await resolveAuth(req);
    if (auth) {
      req.auth = auth;
      req.userId = auth.userId;
    }
  });
});
