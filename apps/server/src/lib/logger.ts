/**
 * ============================================================
 * 日志
 * ------------------------------------------------------------
 * 为什么用 pino：
 * 1. 结构化 JSON 日志，方便后续接 Loki/ELK；
 * 2. 极低开销（异步写入），2 核服务器上不会成为瓶颈；
 * 3. 开发环境用 pino-pretty 输出可读格式。
 * 安全要求：绝不记录密码、验证码、令牌明文，敏感字段统一脱敏。
 * ============================================================
 */

import pino from 'pino';
import { config } from '../config.js';

export const logger = pino({
  level: config.log.level,
  // 生产环境输出 JSON；开发环境用 pretty 便于阅读
  transport: config.log.pretty
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  // 全局脱敏：即使调用方误传，也不会把密钥写进日志
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'newPassword',
      'code',
      'token',
      'refreshToken',
      'accessToken',
      '*.password',
      '*.token',
    ],
    censor: '[REDACTED]',
  },
  // 服务标识，便于多服务日志聚合时区分
  base: { service: 'chat-server' },
});

/** 子日志器：按模块划分，日志里自动带 module 字段 */
export function moduleLogger(name: string) {
  return logger.child({ module: name });
}
