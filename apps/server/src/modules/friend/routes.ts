/**
 * ============================================================
 * 好友路由
 * ------------------------------------------------------------
 * GET    /api/friends                        好友列表
 * GET    /api/friends/requests               待处理请求
 * POST   /api/friends/request                发起好友请求
 * POST   /api/friends/accept                 接受请求
 * POST   /api/friends/reject                 拒绝请求
 * DELETE /api/friends/:userId                删除好友
 * POST   /api/friends/block                  拉黑
 * DELETE /api/friends/block/:userId          解除拉黑
 * PUT    /api/friends/:userId/remark         设置备注名
 * GET    /api/users/:id/profile              他人资料（含关系状态）
 * ============================================================
 */

import { z } from 'zod';
import { ErrorCode } from '@chat/shared';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/app-error.js';
import { ok } from '../../lib/http.js';
import {
  notifyFriendAccepted,
  notifyFriendRemoved,
  notifyFriendRequest,
  notifyNewConversation,
} from '../../ws/gateway.js';
import * as service from './service.js';

/** 统一 zod 校验 */
function parseOrThrow<T>(
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { issues: Array<{ path: (string | number)[]; message: string }> } } },
  body: unknown,
): T {
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

const userIdSchema = z.object({ userId: z.string().min(1).max(26) });
const remarkSchema = z.object({ remark: z.string().max(32) });

export default async function friendRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------- 好友列表 ---------------- */
  app.get('/friends', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const list = await service.listFriends(req.userId);
    return ok(reply, list);
  });

  /* ---------------- 待处理请求 ---------------- */
  app.get('/friends/requests', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const data = await service.listRequests(req.userId);
    return ok(reply, data);
  });

  /* ---------------- 直接添加联系人（免审批） ---------------- */
  /**
   * 与 /friends/request 的区别：
   *   这是「加到通讯录」，单向动作，立即生效，不等对方点同意。
   *   前端在聊天页顶部显示「添加到通讯录」，点一下调这个接口。
   */
  app.post('/friends/add', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { userId } = parseOrThrow(userIdSchema, req.body);
    const result = await service.addFriendDirectly(req.userId, userId);

    // 通知对方：已把你加入通讯录（对方无需任何操作）
    notifyFriendAccepted(userId, {
      userId: req.userId,
      nickname: await service.nicknameOf(req.userId),
      avatarUrl: null,
      conversationId: result.conversationId,
    });

    /**
     * 广播新会话
     * ------------------------------------------------------------
     * addFriendDirectly 会顺手建一个私聊。如果只发 friend.accepted，
     * 两端都不会刷新会话列表 —— 用户看到的现象就是
     * 「加了好友，但聊天列表里什么都没有」。
     * 必须和 createDirect 一样发 conversation.new。
     */
    if (result.conversationId) {
      notifyNewConversation([req.userId, userId], result.conversationId);
    }
    return ok(reply, result);
  });

  /* ---------------- 发起好友请求 ---------------- */
  app.post('/friends/request', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { userId } = parseOrThrow(userIdSchema, req.body);
    const result = await service.requestFriend(req.userId, userId);

    if (result.autoAccepted) {
      // 对方之前已请求 → 直接成为好友，双向都需要收到通知
      const myProfile = await service.profileOf(userId, req.userId);
      const peerProfile = await service.profileOf(req.userId, userId);

      notifyFriendAccepted(req.userId, {
        userId,
        nickname: myProfile.nickname,
        avatarUrl: myProfile.avatarUrl,
        conversationId: result.conversationId,
      });
      notifyFriendAccepted(userId, {
        userId: req.userId,
        nickname: peerProfile.nickname,
        avatarUrl: peerProfile.avatarUrl,
        conversationId: result.conversationId,
      });
    } else {
      // 通知对方有新的好友请求
      const myProfile = await service.profileOf(userId, req.userId);
      notifyFriendRequest(userId, {
        userId: req.userId,
        nickname: myProfile.nickname,
        avatarUrl: myProfile.avatarUrl,
        createdAt: Date.now(),
      });
    }

    return ok(reply, result);
  });

  /* ---------------- 接受请求 ---------------- */
  app.post('/friends/accept', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { userId } = parseOrThrow(userIdSchema, req.body);
    const result = await service.acceptFriend(req.userId, userId);

    const peer = await service.profileOf(req.userId, userId);
    const me = await service.profileOf(userId, req.userId);

    // 我接受后，对方要知道成为好友了
    notifyFriendAccepted(userId, {
      userId: req.userId,
      nickname: me.nickname,
      avatarUrl: me.avatarUrl,
      conversationId: result.conversationId,
    });

    return ok(reply, { ...result, peer });
  });

  /* ---------------- 拒绝请求 ---------------- */
  app.post('/friends/reject', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { userId } = parseOrThrow(userIdSchema, req.body);
    await service.rejectFriend(req.userId, userId);
    return ok(reply, { done: true });
  });

  /* ---------------- 删除好友 ---------------- */
  app.delete<{ Params: { userId: string } }>(
    '/friends/:userId',
    { preHandler: [app.requireAuth] },
    async (req, reply) => {
      await service.removeFriend(req.userId, req.params.userId);
      notifyFriendRemoved(req.params.userId, { userId: req.userId, blocked: false });
      return ok(reply, { done: true });
    },
  );

  /* ---------------- 拉黑 ---------------- */
  app.post('/friends/block', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { userId } = parseOrThrow(userIdSchema, req.body);
    await service.blockFriend(req.userId, userId);
    notifyFriendRemoved(userId, { userId: req.userId, blocked: true });
    return ok(reply, { done: true });
  });

  /* ---------------- 解除拉黑 ---------------- */
  app.delete<{ Params: { userId: string } }>(
    '/friends/block/:userId',
    { preHandler: [app.requireAuth] },
    async (req, reply) => {
      await service.unblockFriend(req.userId, req.params.userId);
      return ok(reply, { done: true });
    },
  );

  /* ---------------- 设置备注名 ---------------- */
  app.put<{ Params: { userId: string } }>(
    '/friends/:userId/remark',
    { preHandler: [app.requireAuth] },
    async (req, reply) => {
      const { remark } = parseOrThrow(remarkSchema, req.body);
      await service.setRemark(req.userId, req.params.userId, remark);
      return ok(reply, { done: true });
    },
  );

  /* ---------------- 他人资料 ---------------- */
  app.get<{ Params: { id: string } }>(
    '/users/:id/profile',
    { preHandler: [app.requireAuth] },
    async (req, reply) => {
      const profile = await service.profileOf(req.userId, req.params.id);
      return ok(reply, profile);
    },
  );
}
