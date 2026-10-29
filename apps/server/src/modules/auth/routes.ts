/**
 * ============================================================
 * 认证路由
 * ------------------------------------------------------------
 * 接口清单（全部挂在 /api/auth 下）：
 *   POST /email-code      发送邮箱验证码
 *   POST /register        注册（邮箱 + 验证码 + 密码 + 邀请码）
 *   POST /login           密码登录
 *   POST /refresh         刷新访问令牌（轮换刷新令牌）
 *   POST /logout          登出（吊销刷新令牌）
 *   POST /reset-password  重置密码
 * ============================================================
 */

import {
  ErrorCode,
  loginSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  sendEmailCodeSchema,
} from '@chat/shared';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/app-error.js';
import { clientIp, ok } from '../../lib/http.js';
import { generalLimiter, registerIpLimiter } from '../../lib/rate-limit.js';
import * as authService from './service.js';

/** 解析设备标识：优先 X-Device-Id 头，其次用 UA + 平台兜底 */
function resolveDeviceId(headers: Record<string, unknown>, platform: string): string {
  const h = headers['x-device-id'];
  if (typeof h === 'string' && h.trim().length > 0) return h.trim().slice(0, 128);
  const ua = typeof headers['user-agent'] === 'string' ? headers['user-agent'] : 'unknown';
  // 简单哈希：同一设备同一 UA 得到稳定 id，便于「设备列表」展示
  let hash = 0;
  for (let i = 0; i < ua.length; i += 1) {
    hash = (hash * 31 + ua.charCodeAt(i)) | 0;
  }
  return `${platform}-${Math.abs(hash).toString(36)}`;
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------- 发送验证码 ---------------- */
  app.post('/auth/email-code', async (req, reply) => {
    const parsed = sendEmailCodeSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, '输入内容不合法', {
        fields: Object.fromEntries(
          parsed.error.issues.map((i) => [i.path.join('.') || 'form', i.message]),
        ),
      });
    }

    const ip = clientIp(req.headers as Record<string, unknown>, req.ip);
    const result = await authService.sendEmailCode({
      email: parsed.data.email,
      purpose: parsed.data.purpose,
      ip,
    });

    return ok(reply, result);
  });

  /* ---------------- 注册 ---------------- */
  app.post('/auth/register', async (req, reply) => {
    const ip = clientIp(req.headers as Record<string, unknown>, req.ip);

    // IP 维度限流：防批量注册小号
    const gate = registerIpLimiter.consume(`register:${ip}`);
    if (!gate.allowed) {
      throw new AppError(ErrorCode.RATE_LIMITED, '注册过于频繁，请稍后再试', {
        meta: { retryAfterSeconds: gate.retryAfterSeconds },
      });
    }

    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, '输入内容不合法', {
        fields: Object.fromEntries(
          parsed.error.issues.map((i) => [i.path.join('.') || 'form', i.message]),
        ),
      });
    }

    const d = parsed.data;
    const result = await authService.register({
      email: d.email,
      code: d.code,
      password: d.password,
      nickname: d.nickname,
      inviteCode: d.inviteCode,
      platform: d.platform,
      deviceName: d.deviceName,
      deviceId: resolveDeviceId(req.headers as Record<string, unknown>, d.platform),
    });

    return ok(reply, result);
  });

  /* ---------------- 登录 ---------------- */
  app.post('/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, '输入内容不合法', {
        fields: Object.fromEntries(
          parsed.error.issues.map((i) => [i.path.join('.') || 'form', i.message]),
        ),
      });
    }

    const d = parsed.data;
    const result = await authService.login({
      email: d.email,
      password: d.password,
      platform: d.platform,
      deviceName: d.deviceName,
      deviceId: resolveDeviceId(req.headers as Record<string, unknown>, d.platform),
    });

    return ok(reply, result);
  });

  /* ---------------- 刷新令牌 ---------------- */
  app.post('/auth/refresh', async (req, reply) => {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(ErrorCode.TOKEN_INVALID);
    }

    const d = parsed.data;
    const result = await authService.refresh({
      refreshToken: d.refreshToken,
      platform: d.platform,
      deviceId: resolveDeviceId(req.headers as Record<string, unknown>, d.platform),
    });

    return ok(reply, result);
  });

  /* ---------------- 登出 ---------------- */
  app.post('/auth/logout', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = req.body as { refreshToken?: string } | undefined;
    await authService.logout({ userId: req.userId, refreshToken: body?.refreshToken });
    return ok(reply, { success: true });
  });

  /* ---------------- 重置密码 ---------------- */
  app.post('/auth/reset-password', async (req, reply) => {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, '输入内容不合法', {
        fields: Object.fromEntries(
          parsed.error.issues.map((i) => [i.path.join('.') || 'form', i.message]),
        ),
      });
    }

    // 通用限流：防止暴力尝试验证码
    const ip = clientIp(req.headers as Record<string, unknown>, req.ip);
    const gate = generalLimiter.consume(`reset:${ip}`);
    if (!gate.allowed) {
      throw new AppError(ErrorCode.RATE_LIMITED, '操作过于频繁，请稍后再试', {
        meta: { retryAfterSeconds: gate.retryAfterSeconds },
      });
    }

    await authService.resetPassword(parsed.data);
    return ok(reply, { success: true });
  });
}
