/**
 * ============================================================
 * 用户路由
 * ------------------------------------------------------------
 * GET   /api/me              我的资料
 * PATCH /api/me              更新资料（昵称/签名/头像）
 * GET   /api/users/:id       查看他人资料
 * GET   /api/users/search    按邮箱/昵称搜索用户（用于发起聊天）
 * ============================================================
 */

import { ErrorCode, updateProfileSchema } from '@chat/shared';
import type { FastifyInstance } from 'fastify';
import { and, eq, like, ne, or } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { attachments, users } from '../../db/schema.js';
import { AppError } from '../../lib/app-error.js';
import { ok } from '../../lib/http.js';
import { signMediaUrl } from '../../lib/crypto.js';
import { config } from '../../config.js';
import { toAuthUser, toUserPublic } from './mapper.js';

export default async function userRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------- 我的资料 ---------------- */
  app.get('/me', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const rows = await db.select().from(users).where(eq(users.id, req.userId)).limit(1);
    const row = rows[0];
    if (!row) throw new AppError(ErrorCode.UNAUTHORIZED);
    return ok(reply, toAuthUser(row));
  });

  /* ---------------- 更新资料 ---------------- */
  app.patch('/me', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const parsed = updateProfileSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, '输入内容不合法', {
        fields: Object.fromEntries(
          parsed.error.issues.map((i) => [i.path.join('.') || 'form', i.message]),
        ),
      });
    }

    const { nickname, bio, avatarAttachmentId } = parsed.data;

    // 头像必须是本人上传的图片附件
    let avatarUrl: string | null | undefined;
    if (avatarAttachmentId !== undefined) {
      if (avatarAttachmentId === null) {
        avatarUrl = null;
      } else {
        const rows = await db
          .select({ id: attachments.id, kind: attachments.kind, uploaderId: attachments.uploaderId })
          .from(attachments)
          .where(eq(attachments.id, avatarAttachmentId))
          .limit(1);

        const att = rows[0];
        if (!att) throw new AppError(ErrorCode.ATTACHMENT_NOT_FOUND);
        if (att.uploaderId !== req.userId) throw new AppError(ErrorCode.FORBIDDEN, '不能使用他人的附件');
        if (att.kind !== 'image') throw new AppError(ErrorCode.BAD_REQUEST, '头像必须是图片');

        const expiresAt = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
        const sig = signMediaUrl(att.id, expiresAt);
        avatarUrl = `/api/media/${att.id}?e=${expiresAt}&s=${sig}`;
      }
    }

    await db
      .update(users)
      .set({
        ...(nickname !== undefined ? { nickname } : {}),
        ...(bio !== undefined ? { bio: bio ?? null } : {}),
        ...(avatarUrl !== undefined ? { avatarUrl } : {}),
      })
      .where(eq(users.id, req.userId));

    const rows = await db.select().from(users).where(eq(users.id, req.userId)).limit(1);
    return ok(reply, toAuthUser(rows[0]!));
  });

  /* ---------------- 查看他人资料 ---------------- */
  app.get<{ Params: { id: string } }>(
    '/users/:id',
    { preHandler: [app.requireAuth] },
    async (req, reply) => {
      const rows = await db.select().from(users).where(eq(users.id, req.params.id)).limit(1);
      const row = rows[0];
      if (!row) throw new AppError(ErrorCode.NOT_FOUND, '用户不存在');
      return ok(reply, toUserPublic(row));
    },
  );

  /* ---------------- 搜索用户 ---------------- */
  app.get<{ Querystring: { q?: string } }>(
    '/users/search',
    { preHandler: [app.requireAuth] },
    async (req, reply) => {
      const q = (req.query.q ?? '').trim();
      // 至少 2 个字符才搜索，避免全表扫描
      if (q.length < 2) return ok(reply, []);

      // 邮箱精确匹配 + 昵称模糊匹配
      const rows = await db
        .select({
          id: users.id,
          email: users.email,
          nickname: users.nickname,
          avatarUrl: users.avatarUrl,
          bio: users.bio,
          lastSeenAt: users.lastSeenAt,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(
          and(
            ne(users.id, req.userId),
            eq(users.status, 'active'),
            or(eq(users.email, q.toLowerCase()), like(users.nickname, `%${q}%`)),
          ),
        )
        .limit(20);

      return ok(
        reply,
        rows.map((r) => ({
          ...toUserPublic({ ...r, emailVerified: true, passwordHash: '', inviteQuota: 0, invitedBy: null, status: 'active' } as never),
        })),
      );
    },
  );

  // 保留配置引用，避免未使用告警
  void config;
}
