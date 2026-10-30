/**
 * ============================================================
 * 增量同步路由
 * ------------------------------------------------------------
 * GET /api/sync?since=<毫秒时间戳>
 *
 * 客户端首次同步传 since=0（会返回全部会话），
 * 之后传上次响应的 serverTime，只拿增量。
 *
 * 首次同步的会话数量可能很大，这里限制最多返回 100 个会话，
 * 避免一次性把主线程撑爆（本布局不能滚动，列表靠分页展示）。
 * ============================================================
 */

import type { FastifyInstance } from 'fastify';
import { ok } from '../../lib/http.js';
import * as service from './service.js';

/**
 * 无服务端缓存的全量会话上限
 * 说明：超出部分由客户端的会话列表分页逻辑处理。
 */
const MAX_SYNC_CONVERSATIONS = 100;

export default async function syncRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { since?: string } }>(
    '/sync',
    { preHandler: [app.requireAuth] },
    async (req, reply) => {
      const raw = req.query.since;
      const since = raw ? Number(raw) : 0;

      // 非法游标一律当作首次同步，避免客户端传错导致拉不到数据
      const safeSince = Number.isFinite(since) && since > 0 ? since : 0;

      const result = await service.syncSince(req.userId, safeSince);

      // 首次同步（since=0）时截断，防止响应过大
      if (safeSince === 0 && result.conversations.length > MAX_SYNC_CONVERSATIONS) {
        result.conversations = result.conversations.slice(0, MAX_SYNC_CONVERSATIONS);
      }

      return ok(reply, result);
    },
  );
}
