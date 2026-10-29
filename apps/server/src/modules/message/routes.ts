/**
 * ============================================================
 * 消息路由
 * ------------------------------------------------------------
 * GET    /api/conversations/:id/messages    历史消息（游标分页）
 * POST   /api/conversations/:id/messages    发送消息
 * DELETE /api/messages/:id                  撤回消息
 * ============================================================
 */

import {
  ErrorCode,
  sendMessageSchema,
  type SendMessageRequest,
} from '@chat/shared';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/app-error.js';
import { ok } from '../../lib/http.js';
import { generalLimiter } from '../../lib/rate-limit.js';
import * as service from './service.js';
import { broadcastMessageDeleted, broadcastNewMessage } from '../../ws/gateway.js';

export default async function messageRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------- 拉取历史 ---------------- */
  app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>(
    '/conversations/:id/messages',
    { preHandler: [app.requireAuth] },
    async (req, reply) => {
      const before = req.query.before ? Number(req.query.before) : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;

      if (before !== undefined && (!Number.isFinite(before) || before <= 0)) {
        throw new AppError(ErrorCode.BAD_REQUEST, 'before 参数不合法');
      }
      if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
        throw new AppError(ErrorCode.BAD_REQUEST, 'limit 参数不合法');
      }

      const page = await service.listMessages(req.params.id, req.userId, { before, limit });
      return ok(reply, page);
    },
  );

  /* ---------------- 发送消息 ---------------- */
  app.post<{ Params: { id: string } }>(
    '/conversations/:id/messages',
    { preHandler: [app.requireAuth] },
    async (req, reply) => {
      // 发送限流：防刷屏
      const gate = generalLimiter.consume(`send:${req.userId}`);
      if (!gate.allowed) {
        throw new AppError(ErrorCode.RATE_LIMITED, '发送太频繁，请稍后再试', {
          meta: { retryAfterSeconds: gate.retryAfterSeconds },
        });
      }

      const parsed = sendMessageSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, '输入内容不合法', {
          fields: Object.fromEntries(
            parsed.error.issues.map((i) => [i.path.join('.') || 'form', i.message]),
          ),
        });
      }

      const input = parsed.data as SendMessageRequest;
      const result = await service.sendMessage(req.params.id, req.userId, input);

      /**
       * 实时推送：只推 message.new 一条。
       * 为什么不再单独推 conversation.updated：
       * 客户端收到 message.new 后即可自行更新列表摘要与未读数（本地 +1），
       * 这样服务端无需为每个成员各算一次未读数（省掉 N 次查询），
       * 对 2 核服务器是实打实的性能收益。
       */
      broadcastNewMessage({
        conversationId: req.params.id,
        memberIds: result.memberIds,
        message: result.message,
      });

      return ok(reply, result.message);
    },
  );

  /* ---------------- 撤回消息 ---------------- */
  app.delete<{ Params: { id: string } }>(
    '/messages/:id',
    { preHandler: [app.requireAuth] },
    async (req, reply) => {
      const body = req.body as { conversationId?: string } | undefined;
      if (!body?.conversationId) {
        throw new AppError(ErrorCode.BAD_REQUEST, '缺少 conversationId');
      }

      const result = await service.deleteMessage(body.conversationId, req.params.id, req.userId);

      broadcastMessageDeleted({
        memberIds: result.memberIds,
        conversationId: body.conversationId,
        messageId: req.params.id,
        seq: result.seq,
      });

      return ok(reply, { success: true, seq: result.seq });
    },
  );
}
