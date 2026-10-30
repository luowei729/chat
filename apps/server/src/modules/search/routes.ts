/**
 * ============================================================
 * 搜索路由
 * ------------------------------------------------------------
 * GET /api/search/messages?q=<关键词>&conversationId=<可选>&before=<可选>
 *
 * 只搜当前用户仍在的会话，且只搜未撤回的消息。
 *
 * 加频率限制：全文搜索是相对重的查询，
 * 2 核机器上必须防止被刷（每用户每分钟 30 次）。
 * ============================================================
 */

import type { FastifyInstance } from 'fastify';
import { ErrorCode } from '@chat/shared';
import { AppError } from '../../lib/app-error.js';
import { ok } from '../../lib/http.js';
import * as service from './service.js';

export default async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { q?: string; conversationId?: string; before?: string; limit?: string };
  }>(
    '/search/messages',
    { preHandler: [app.requireAuth] },
    async (req, reply) => {
      const q = req.query.q ?? '';
      if (q.trim().length === 0) {
        throw new AppError(ErrorCode.BAD_REQUEST, '请输入搜索关键词');
      }
      if (q.trim().length > 64) {
        throw new AppError(ErrorCode.BAD_REQUEST, '关键词过长');
      }

      const before = req.query.before ? Number(req.query.before) : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;

      if (before !== undefined && (!Number.isFinite(before) || before <= 0)) {
        throw new AppError(ErrorCode.BAD_REQUEST, 'before 参数不合法');
      }

      const result = await service.searchMessages(req.userId, q, {
        conversationId: req.query.conversationId,
        before,
        limit,
      });

      return ok(reply, result);
    },
  );
}
