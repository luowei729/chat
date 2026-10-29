/**
 * ============================================================
 * 通话路由
 * ------------------------------------------------------------
 * GET  /api/ice-servers    下发 STUN/TURN 配置（含临时凭据）
 * GET  /api/calls/current  我当前所在通话（多端同步）
 * ============================================================
 */

import type { FastifyInstance } from 'fastify';
import { ok } from '../../lib/http.js';
import { buildIceServers } from './ice.js';
import { currentCallOf, toCallSessionInfo } from './service.js';

export default async function callRoutes(app: FastifyInstance): Promise<void> {
  /**
   * ICE 服务器配置
   * 说明：客户端每次发起/接听通话前调用一次，
   *      拿到带 24 小时有效期的 TURN 凭据。
   */
  app.get('/ice-servers', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const config = buildIceServers(req.userId);
    return ok(reply, config);
  });

  /** 当前通话状态：App 重启后恢复界面用 */
  app.get('/calls/current', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const call = currentCallOf(req.userId);
    return ok(reply, call ? toCallSessionInfo(call) : null);
  });
}
