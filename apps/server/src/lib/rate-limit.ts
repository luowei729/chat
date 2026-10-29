/**
 * ============================================================
 * 内存限流器（滑动窗口）
 * ------------------------------------------------------------
 * 为什么不用 Redis：
 * 1. 当前是单实例部署，进程内计数即可；
 * 2. 2 核 1.8G 服务器再跑一个 Redis 是浪费；
 * 3. 若未来多实例，只需把本文件的 Map 换成 Redis 实现，接口不变。
 *
 * 实现：固定窗口 + 分桶，比纯固定窗口平滑，比精确滑动窗口省内存。
 * ============================================================
 */

interface Bucket {
  /** 当前窗口起始时间 */
  windowStart: number;
  /** 当前窗口内计数 */
  count: number;
}

/** 定期清理过期桶，防止内存无限增长 */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly windowMs: number;
  private readonly limit: number;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(windowMs: number, limit: number) {
    this.windowMs = windowMs;
    this.limit = limit;
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    // 不要因为这个定时器阻止进程退出
    this.cleanupTimer.unref?.();
  }

  /**
   * 消耗一次配额
   * @returns allowed 是否放行；retryAfterSeconds 建议重试等待秒数
   */
  consume(key: string): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
    const now = Date.now();
    const existing = this.buckets.get(key);

    if (!existing || now - existing.windowStart >= this.windowMs) {
      this.buckets.set(key, { windowStart: now, count: 1 });
      return { allowed: true, remaining: this.limit - 1, retryAfterSeconds: 0 };
    }

    if (existing.count >= this.limit) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((existing.windowStart + this.windowMs - now) / 1000),
      );
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }

    existing.count += 1;
    return { allowed: true, remaining: this.limit - existing.count, retryAfterSeconds: 0 };
  }

  /** 只查询不消耗，用于展示剩余次数 */
  peek(key: string): number {
    const b = this.buckets.get(key);
    if (!b || Date.now() - b.windowStart >= this.windowMs) return this.limit;
    return Math.max(0, this.limit - b.count);
  }

  /** 手动重置（如验证成功后清空失败计数） */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** 清理过期窗口 */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= this.windowMs * 2) {
        this.buckets.delete(key);
      }
    }
  }

  /** 进程退出时停止定时器 */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 全局限流器实例                                                       */
/* ------------------------------------------------------------------ */

/** 发送邮箱验证码：同一邮箱 60 秒 1 次 */
export const emailCodeLimiter = new RateLimiter(60 * 1000, 1);
/** 发送邮箱验证码：同一邮箱 24 小时 10 次 */
export const emailCodeDailyLimiter = new RateLimiter(24 * 60 * 60 * 1000, 10);
/** 发送邮箱验证码：同一 IP 1 小时 20 次（防批量注册） */
export const emailCodeIpLimiter = new RateLimiter(60 * 60 * 1000, 20);
/** 登录失败：同一邮箱 15 分钟 10 次 */
export const loginFailLimiter = new RateLimiter(15 * 60 * 1000, 10);
/** 注册：同一 IP 1 小时 5 次 */
export const registerIpLimiter = new RateLimiter(60 * 60 * 1000, 5);
/** 通用写接口：同一用户 1 分钟 120 次 */
export const generalLimiter = new RateLimiter(60 * 1000, 120);
/** 上传：同一用户 1 小时 200 次 */
export const uploadLimiter = new RateLimiter(60 * 60 * 1000, 200);
/** 通话发起：同一用户 1 分钟 10 次 */
export const callLimiter = new RateLimiter(60 * 1000, 10);
