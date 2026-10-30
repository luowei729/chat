/**
 * ============================================================
 * 上传与媒体路由
 * ------------------------------------------------------------
 * POST /api/media                上传文件（multipart）
 * GET  /api/media/:id            读取媒体（签名校验 + X-Accel-Redirect）
 *
 * 为什么媒体读取走 X-Accel-Redirect：
 * Node 只做签名校验，实际文件由 OpenResty 直接发送，
 * 这样 200MB 的视频不会占用 Node 的事件循环与内存，
 * 且 OpenResty 原生支持 Range 请求（视频拖动进度条）。
 * ============================================================
 */

import { ErrorCode, registerPushSchema } from '@chat/shared';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/app-error.js';
import { clientIp, ok } from '../../lib/http.js';
import { verifyMediaSignature } from '../../lib/crypto.js';
import { uploadLimiter } from '../../lib/rate-limit.js';
import * as uploadService from './service.js';
import * as pushService from '../push/service.js';

export default async function uploadRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------- 上传 ---------------- */
  app.post('/media', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const gate = uploadLimiter.consume(`upload:${req.userId}`);
    if (!gate.allowed) {
      throw new AppError(ErrorCode.RATE_LIMITED, '上传太频繁，请稍后再试', {
        meta: { retryAfterSeconds: gate.retryAfterSeconds },
      });
    }

    const file = await req.file();
    if (!file) throw new AppError(ErrorCode.BAD_REQUEST, '缺少文件');

    // 客户端可随文件带上宽高/时长/波形，避免服务端解码图片视频
    const fields = file.fields as Record<string, { value?: unknown } | undefined>;
    const num = (key: string): number | undefined => {
      const v = fields[key]?.value;
      if (v === undefined || v === null) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };

    let waveform: number[] | undefined;
    const waveRaw = fields['waveform']?.value;
    if (typeof waveRaw === 'string') {
      try {
        const parsed = JSON.parse(waveRaw) as unknown;
        if (Array.isArray(parsed)) {
          waveform = parsed
            .map((x) => Number(x))
            .filter((x) => Number.isFinite(x))
            .slice(0, 100)
            .map((x) => Math.max(0, Math.min(100, Math.round(x))));
        }
      } catch {
        // 波形格式错误不影响上传
      }
    }

    const kindRaw = fields['kind']?.value;
    const result = await uploadService.saveUpload({
      uploaderId: req.userId,
      file,
      meta: {
        width: num('width'),
        height: num('height'),
        durationMs: num('durationMs'),
        waveform,
        kind: typeof kindRaw === 'string' ? kindRaw : undefined,
      },
    });

    return ok(reply, result);
  });

  /* ---------------- 读取媒体 ---------------- */
  app.get<{ Params: { id: string }; Querystring: { e?: string; s?: string } }>(
    '/media/:id',
    async (req, reply) => {
      const expiresAt = Number(req.query.e ?? 0);
      const sig = req.query.s ?? '';

      // 签名校验：防止 URL 被外链盗用刷流量
      if (!verifyMediaSignature(req.params.id, expiresAt, sig)) {
        throw new AppError(ErrorCode.FORBIDDEN, '链接已失效，请刷新页面');
      }

      const media = await uploadService.findAttachment(req.params.id);

      /**
       * 过期文件：返回 410 Gone。
       * 用 410 而不是 404，是为了让客户端能区分
       * 「文件超过保留期被清理」与「链接写错了」，
       * 前者应显示「文件已过期」提示，后者才是异常。
       */
      if (media.expired) {
        return reply
          .status(410)
          .header('Cache-Control', 'no-store')
          .send({
            code: 15006,
            message: '文件已过期（聊天文件仅保留 30 天）',
            serverTime: Date.now(),
          });
      }

      /**
       * X-Accel-Redirect：让 OpenResty 直接发送文件。
       * 对应 nginx 配置里的 location /_internal_media/ { internal; alias ... }
       * 注意：这个 location 是 internal 的，外部无法直接访问，
       *      只有本响应头能触发，因此不存在绕过签名的问题。
       */
      reply
        .header('X-Accel-Redirect', `/_internal_media/${media.storagePath}`)
        .header('Content-Type', media.mime)
        .header('Accept-Ranges', 'bytes')
        .header(
          'Content-Disposition',
          // inline 让图片视频可直接预览；下载时客户端自行处理
          `inline; filename*=UTF-8''${encodeURIComponent(media.filename)}`,
        )
        .header('Cache-Control', 'private, max-age=3600')
        .send();

      return reply;
    },
  );

  /* ---------------- 注册推送令牌 ---------------- */
  app.post('/push/register', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const parsed = registerPushSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, '输入内容不合法', {
        fields: Object.fromEntries(
          parsed.error.issues.map((i) => [i.path.join('.') || 'form', i.message]),
        ),
      });
    }

    const d = parsed.data;
    await pushService.upsertPushToken({
      userId: req.userId,
      platform: d.platform,
      provider: d.provider,
      deviceId: d.deviceId,
      token: d.token,
      appVersion: d.appVersion,
    });

    return ok(reply, { success: true });
  });

  /* ---------------- 注销推送令牌（退出登录时调用） ---------------- */
  app.delete('/push/register', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = req.body as { deviceId?: string } | undefined;
    if (body?.deviceId) {
      await pushService.removePushToken(req.userId, body.deviceId);
    }
    return ok(reply, { success: true });
  });

  // 保留 clientIp 导入供后续风控使用（避免 tree-shaking 警告）
  void clientIp;
}
