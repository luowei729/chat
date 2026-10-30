/**
 * ============================================================
 * 服务入口
 * ------------------------------------------------------------
 * 启动顺序：
 *   1. 校验配置 → 2. 连接数据库 → 3. 注册插件与路由 → 4. 监听端口
 *
 * 为什么只监听 127.0.0.1：
 * 前面有 OpenResty 做 TLS 终止与反代，Node 不直接对外，
 * 既省掉 Node 侧的 TLS 开销（2 核服务器很关键），
 * 也避免端口暴露被直接攻击。
 * ============================================================
 */

import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { MAX_UPLOAD_BYTES } from '@chat/shared';
import { config, validateConfig } from './config.js';
import { closeDatabase, pingDatabase } from './db/index.js';
import { AppError } from './lib/app-error.js';
import { clientIp, fail } from './lib/http.js';
import { logger, moduleLogger } from './lib/logger.js';
import { ErrorCode, ErrorMessage, httpStatusFor } from '@chat/shared';
import authPlugin from './plugins/auth.js';
import authRoutes from './modules/auth/routes.js';
import callRoutes from './modules/call/routes.js';
import conversationRoutes from './modules/conversation/routes.js';
import friendRoutes from './modules/friend/routes.js';
import inviteRoutes from './modules/invite/routes.js';
import messageRoutes from './modules/message/routes.js';
import searchRoutes from './modules/search/routes.js';
import syncRoutes from './modules/sync/routes.js';
import uploadRoutes from './modules/upload/routes.js';
import userRoutes from './modules/user/routes.js';
import wsPlugin, { onlineClientCount } from './ws/gateway.js';
import { cleanupExpiredAttachments, cleanupOrphanAttachments } from './modules/upload/service.js';
import { cleanupStaleCalls } from './modules/call/service.js';
import { verifySmtp } from './mail/index.js';

const log = moduleLogger('server');

async function buildServer() {
  const app = Fastify({
    loggerInstance: logger,
    // 反代后必须信任 X-Forwarded-For，否则限流会把所有人当成同一个 IP
    trustProxy: true,
    // 单请求体上限：上传走 multipart 单独限制，这里只防普通 JSON 攻击
    bodyLimit: 2 * 1024 * 1024,
    disableRequestLogging: true,
  });

  /* ---------------- 插件 ---------------- */
  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    // 全局兜底限流，业务级细粒度限流在各路由里做
    keyGenerator: (req) => clientIp(req.headers as Record<string, unknown>, req.ip),
    errorResponseBuilder: () => ({
      code: ErrorCode.TOO_MANY_REQUESTS,
      message: ErrorMessage[ErrorCode.TOO_MANY_REQUESTS],
      serverTime: Date.now(),
    }),
  });

  await app.register(multipart, {
    limits: {
      // 单文件上限：与 shared 常量保持一致
      fileSize: MAX_UPLOAD_BYTES,
      // 单请求只允许一个文件，简化客户端逻辑
      files: 1,
      // 文本字段数量（宽高、波形等）
      fields: 10,
    },
  });

  await app.register(websocket, {
    options: {
      // 消息上限 1MB：信令都是小 JSON，SDP 也不会超过这个量级
      maxPayload: 1024 * 1024,
      // 关闭压缩：信令体积小，压缩反而增加 CPU
      perMessageDeflate: false,
    },
  });

  await app.register(authPlugin);

  /* ---------------- 全局错误处理 ---------------- */
  app.setErrorHandler((error, req, reply) => {
    // 业务异常：按错误码返回
    if (error instanceof AppError) {
      if (error.code === ErrorCode.INTERNAL_ERROR) {
        log.error({ err: error, url: req.url }, '业务内部错误');
      }
      return fail(reply, error.httpStatus, error.code, error.message, error.fields, error.meta);
    }

    // Fastify 校验错误
    if ((error as { validation?: unknown }).validation) {
      return fail(reply, 400, ErrorCode.VALIDATION_FAILED, '输入内容不合法');
    }

    // 文件过大
    const code = (error as { code?: string }).code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') {
      return fail(reply, 413, ErrorCode.FILE_TOO_LARGE, ErrorMessage[ErrorCode.FILE_TOO_LARGE] ?? '文件过大');
    }
    if (code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') {
      return fail(reply, 400, ErrorCode.BAD_REQUEST, '上传格式不正确');
    }

    // 其他未知错误：不泄露堆栈，只记日志
    log.error({ err: error, url: req.url, method: req.method }, '未处理异常');
    return fail(reply, 500, ErrorCode.INTERNAL_ERROR, ErrorMessage[ErrorCode.INTERNAL_ERROR] ?? '服务器内部错误');
  });

  app.setNotFoundHandler((req, reply) => {
    return fail(reply, 404, ErrorCode.NOT_FOUND, `接口不存在: ${req.method} ${req.url}`);
  });

  /* ---------------- 健康检查 ---------------- */
  app.get('/api/health', async (_req, reply) => {
    const dbUp = await pingDatabase();
    return reply.send({
      code: 0,
      data: {
        ok: dbUp,
        version: '2.0.0',
        uptimeSeconds: Math.floor(process.uptime()),
        db: dbUp ? 'up' : 'down',
        wsClients: onlineClientCount(),
      },
      serverTime: Date.now(),
    });
  });

  /* ---------------- 业务路由 ---------------- */
  await app.register(authRoutes, { prefix: '/api' });
  await app.register(userRoutes, { prefix: '/api' });
  await app.register(inviteRoutes, { prefix: '/api' });
  await app.register(conversationRoutes, { prefix: '/api' });
  await app.register(friendRoutes, { prefix: '/api' });
  await app.register(messageRoutes, { prefix: '/api' });
  await app.register(searchRoutes, { prefix: '/api' });
  await app.register(syncRoutes, { prefix: '/api' });
  await app.register(uploadRoutes, { prefix: '/api' });
  await app.register(callRoutes, { prefix: '/api' });

  /* ---------------- WebSocket ---------------- */
  await app.register(wsPlugin);

  return app;
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  // 配置自检：把容易配错的项提前打印出来
  const warnings = validateConfig();
  for (const w of warnings) log.warn(w);

  if (!(await pingDatabase())) {
    log.error('数据库连接失败，请检查 DB_HOST / DB_USER / DB_PASSWORD 配置');
    process.exit(1);
  }
  log.info('数据库连接成功');

  const app = await buildServer();

  // 后台任务：清理孤儿附件、过期聊天文件与陈旧通话记录（启动时先跑一次）
  void cleanupOrphanAttachments().catch((e) => log.warn({ err: e }, '清理孤儿附件失败'));
  void cleanupExpiredAttachments().catch((e) => log.warn({ err: e }, '清理过期附件失败'));
  void cleanupStaleCalls().catch((e) => log.warn({ err: e }, '清理陈旧通话失败'));
  void verifySmtp();

  /**
   * 过期聊天文件清理：每小时一轮，每轮最多 200 条
   * ------------------------------------------------------------
   * 为什么用「每小时 + 小批量」而不是「每天 + 全量」：
   * 服务器只有 2 核，一次性 unlink 上千个文件会瞬时打满 IO，
   * 影响正在进行的聊天请求。小批量可以把压力摊平。
   */
  const expiredTimer = setInterval(
    () => {
      void cleanupExpiredAttachments().catch(() => undefined);
    },
    60 * 60 * 1000,
  );
  expiredTimer.unref?.();

  // 每小时清理一次孤儿附件
  const cleanupTimer = setInterval(
    () => {
      void cleanupOrphanAttachments().catch(() => undefined);
    },
    60 * 60 * 1000,
  );
  cleanupTimer.unref?.();

  await app.listen({ host: config.host, port: config.port });
  log.info(
    { host: config.host, port: config.port, env: config.env },
    `chat server 已启动 → http://${config.host}:${config.port}`,
  );

  /* ---------------- 优雅退出 ---------------- */
  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, '收到退出信号，开始优雅关闭');
    try {
      await app.close();
      await closeDatabase();
      log.info('已优雅退出');
      process.exit(0);
    } catch (e) {
      log.error({ err: e }, '退出时发生错误');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // 未捕获异常：记录后退出，交给 systemd/pm2 重启
  process.on('uncaughtException', (e) => {
    log.fatal({ err: e }, '未捕获异常');
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => {
    log.error({ err: e }, '未处理的 Promise 拒绝');
  });
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('启动失败：', e);
  process.exit(1);
});

// 保留 httpStatusFor 引用（供未来中间件使用）
void httpStatusFor;
