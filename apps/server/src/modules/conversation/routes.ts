/**
 * ============================================================
 * 会话路由
 * ------------------------------------------------------------
 * GET    /api/conversations                会话列表
 * GET    /api/conversations/:id            会话详情
 * POST   /api/conversations/direct         创建/获取私聊
 * POST   /api/conversations/group          创建群聊
 * PATCH  /api/conversations/:id/preferences 置顶/免打扰
 * PATCH  /api/conversations/:id/members    成员管理
 * ============================================================
 */

import {
  ErrorCode,
  createDirectSchema,
  createGroupSchema,
  updateMemberSchema,
} from '@chat/shared';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/app-error.js';
import { ok } from '../../lib/http.js';
import * as service from './service.js';
import { notifyNewConversation } from '../../ws/gateway.js';

/** 统一处理 zod 校验失败 */
function parseOrThrow<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { issues: Array<{ path: (string | number)[]; message: string }> } } }, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, '输入内容不合法', {
      fields: Object.fromEntries(
        (r.error?.issues ?? []).map((i) => [i.path.join('.') || 'form', i.message]),
      ),
    });
  }
  return r.data as T;
}

export default async function conversationRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------- 会话列表 ---------------- */
  app.get('/conversations', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const list = await service.listConversations(req.userId);
    return ok(reply, list);
  });

  /* ---------------- 会话详情 ---------------- */
  app.get<{ Params: { id: string } }>(
    '/conversations/:id',
    { preHandler: [app.requireAuth] },
    async (req, reply) => {
      const detail = await service.getConversationDetail(req.params.id, req.userId);
      return ok(reply, detail);
    },
  );

  /* ---------------- 创建私聊 ---------------- */
  app.post('/conversations/direct', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const input = parseOrThrow<{ peerId: string }>(createDirectSchema, req.body);
    const result = await service.createDirect(req.userId, input.peerId);

    // 新建会话时通知双方刷新列表
    if (result.created) {
      const members = await service.activeMemberIds(result.conversationId);
      notifyNewConversation(members, result.conversationId);
    }

    return ok(reply, result);
  });

  /* ---------------- 创建群聊 ---------------- */
  app.post('/conversations/group', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const input = parseOrThrow<{ title: string; memberIds: string[] }>(createGroupSchema, req.body);
    const result = await service.createGroup(req.userId, input.title, input.memberIds);

    const members = await service.activeMemberIds(result.conversationId);
    notifyNewConversation(members, result.conversationId);

    return ok(reply, result);
  });

  /* ---------------- 置顶 / 免打扰 ---------------- */
  app.patch<{ Params: { id: string }; Body: { pinned?: boolean; muted?: boolean } }>(
    '/conversations/:id/preferences',
    { preHandler: [app.requireAuth] },
    async (req, reply) => {
      const body = req.body ?? {};
      await service.setPreferences(req.params.id, req.userId, {
        pinned: typeof body.pinned === 'boolean' ? body.pinned : undefined,
        muted: typeof body.muted === 'boolean' ? body.muted : undefined,
      });
      return ok(reply, { success: true });
    },
  );

  /* ---------------- 成员管理 ---------------- */
  app.patch<{ Params: { id: string } }>(
    '/conversations/:id/members',
    { preHandler: [app.requireAuth] },
    async (req, reply) => {
      const input = parseOrThrow<{ userId: string; action: 'promote' | 'demote' | 'remove' }>(
        updateMemberSchema,
        req.body,
      );
      await service.updateMember(req.params.id, req.userId, input.userId, input.action);
      return ok(reply, { success: true });
    },
  );
}
