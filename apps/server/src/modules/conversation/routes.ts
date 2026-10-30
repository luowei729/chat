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
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/app-error.js';
import { ok } from '../../lib/http.js';
import * as service from './service.js';
import { notifyNewConversation, notifyGroupMembersChanged } from '../../ws/gateway.js';

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

  /* ---------------- 群成员列表 ---------------- */
  app.get<{ Params: { id: string } }>(
    '/conversations/:id/members',
    { preHandler: [app.requireAuth] },
    async (req, reply) => {
      const members = await service.listGroupMembers(req.params.id, req.userId);
      return ok(reply, members);
    },
  );

  /* ---------------- 邀请成员入群 ---------------- */
  app.post<{ Params: { id: string } }>(
    '/conversations/:id/members',
    { preHandler: [app.requireAuth] },
    async (req, reply) => {
      const input = parseOrThrow<{ userIds: string[] }>(
        z.object({ userIds: z.array(z.string().min(1).max(26)).min(1).max(50) }),
        req.body,
      );
      const result = await service.inviteMembers(req.params.id, req.userId, input.userIds);

      // 通知全体成员（含新入群的）
      const all = await service.activeMemberIds(req.params.id);
      notifyGroupMembersChanged({
        conversationId: req.params.id,
        memberIds: all,
        userIds: result.added,
      });
      notifyNewConversation(result.added, req.params.id);

      return ok(reply, result);
    },
  );

  /* ---------------- 退群 ---------------- */
  app.post<{ Params: { id: string } }>(
    '/conversations/:id/leave',
    { preHandler: [app.requireAuth] },
    async (req, reply) => {
      await service.leaveGroup(req.params.id, req.userId);

      const remaining = await service.activeMemberIds(req.params.id);
      notifyGroupMembersChanged({
        conversationId: req.params.id,
        memberIds: remaining,
        userIds: [req.userId],
      });

      return ok(reply, { success: true });
    },
  );

  /* ---------------- 转让群主 ---------------- */
  app.post<{ Params: { id: string } }>(
    '/conversations/:id/transfer',
    { preHandler: [app.requireAuth] },
    async (req, reply) => {
      const input = parseOrThrow<{ userId: string }>(
        z.object({ userId: z.string().min(1).max(26) }),
        req.body,
      );
      await service.transferOwner(req.params.id, req.userId, input.userId);

      const all = await service.activeMemberIds(req.params.id);
      notifyGroupMembersChanged({
        conversationId: req.params.id,
        memberIds: all,
        userIds: [req.userId, input.userId],
      });

      return ok(reply, { success: true });
    },
  );

  /* ---------------- 修改群资料 ---------------- */
  app.patch<{ Params: { id: string } }>(
    '/conversations/:id/info',
    { preHandler: [app.requireAuth] },
    async (req, reply) => {
      const input = parseOrThrow<{ title?: string; avatarUrl?: string | null }>(
        z.object({
          title: z.string().min(1).max(64).optional(),
          avatarUrl: z.string().max(512).nullable().optional(),
        }),
        req.body,
      );
      await service.updateGroupInfo(req.params.id, req.userId, input);

      const all = await service.activeMemberIds(req.params.id);
      notifyGroupMembersChanged({
        conversationId: req.params.id,
        memberIds: all,
        userIds: [req.userId],
      });

      return ok(reply, { success: true });
    },
  );
}
