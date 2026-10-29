/**
 * ============================================================
 * 业务异常
 * ------------------------------------------------------------
 * 为什么自定义 AppError：
 * 1. 业务代码里 throw new AppError(ErrorCode.X) 即可，
 *    统一由错误处理中间件转成标准响应，不用每层写 try/catch；
 * 2. 带上 fields 支持表单级错误定位；
 * 3. 区分「可暴露给客户端的信息」与「内部错误」，
 *    避免把数据库错误原文泄露出去。
 * ============================================================
 */

import { ErrorCode, ErrorMessage, httpStatusFor } from '@chat/shared';

export class AppError extends Error {
  readonly code: number;
  readonly httpStatus: number;
  /** 字段级错误：key 为字段名，value 为提示文案 */
  readonly fields?: Record<string, string>;
  /** 附加数据（如剩余冷却秒数），会合并进响应 */
  readonly meta?: Record<string, unknown>;

  constructor(
    code: number,
    message?: string,
    options?: { fields?: Record<string, string>; meta?: Record<string, unknown> },
  ) {
    super(message ?? ErrorMessage[code] ?? '请求失败');
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatusFor(code);
    this.fields = options?.fields;
    this.meta = options?.meta;
  }
}

/** 常用快捷构造，减少重复代码 */
export const err = {
  badRequest: (msg?: string) => new AppError(ErrorCode.BAD_REQUEST, msg),
  unauthorized: (msg?: string) => new AppError(ErrorCode.UNAUTHORIZED, msg),
  forbidden: (msg?: string) => new AppError(ErrorCode.FORBIDDEN, msg),
  notFound: (msg?: string) => new AppError(ErrorCode.NOT_FOUND, msg),
  conflict: (msg?: string) => new AppError(ErrorCode.CONFLICT, msg),
  validation: (fields: Record<string, string>) =>
    new AppError(ErrorCode.VALIDATION_FAILED, '输入内容不合法', { fields }),
  rateLimited: (retryAfterSeconds: number) =>
    new AppError(ErrorCode.RATE_LIMITED, undefined, { meta: { retryAfterSeconds } }),
};
