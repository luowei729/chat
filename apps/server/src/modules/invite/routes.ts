/**
 * ============================================================
 * 邀请码路由
 * ------------------------------------------------------------
 * GET  /api/invites            我的邀请总览（配额/已发码/已邀请人）
 * POST /api/invites            生成新邀请码
 * POST /api/invites/validate   校验邀请码是否可用（注册页实时提示）
 * ============================================================
 */

import { ErrorCode, createInviteSchema, inviteCodeSchema } from '@chat/shared';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/app-error.js';
import { ok } from '../../lib/http.js';
import { generalLimiter } from '../../lib/rate-limit.js';
import * as service from './service.js';

export default async function inviteRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------- 总览 ---------------- */
  app.get('/invites', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const overview = await service.getOverview(req.userId);
    return ok(reply, overview);
  });

  /* ---------------- 生成邀请码 ---------------- */
  app.post('/invites', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const gate = generalLimiter.consume(`invite:${req.userId}`);
    if (!gate.allowed) {
      throw new AppError(ErrorCode.RATE_LIMITED, '操作太频繁，请稍后再试', {
        meta: { retryAfterSeconds: gate.retryAfterSeconds },
      });
    }

    const parsed = createInviteSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, '输入内容不合法', {
        fields: Object.fromEntries(
          parsed.error.issues.map((i) => [i.path.join('.') || 'form', i.message]),
        ),
      });
    }

    const result = await service.createInvite({
      creatorId: req.userId,
      maxUses: parsed.data.maxUses,
      expiresInDays: parsed.data.expiresInDays,
    });

    return ok(reply, result);
  });

  /* ---------------- 校验邀请码 ---------------- */
  app.post('/invites/validate', async (req, reply) => {
    const body = req.body as { code?: string } | undefined;
    const parsed = inviteCodeSchema.safeParse(body?.code ?? '');
    if (!parsed.success) {
      return ok(reply, { valid: false, reason: '邀请码格式不正确' });
    }

    const result = await service.validateInviteCode(parsed.data);
    return ok(reply, result);
  });
}
