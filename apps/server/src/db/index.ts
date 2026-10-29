/**
 * ============================================================
 * 数据库连接
 * ------------------------------------------------------------
 * 为什么用 mysql2/promise 连接池 + Drizzle：
 * 1. 2 核服务器上连接池不能开太大（默认 10 足够），
 *    否则 MySQL 侧线程切换开销反而拖慢响应；
 * 2. Drizzle 不做运行时反射，内存占用比 Prisma 小得多；
 * 3. 统一在这里设置时区与字符集，避免中文乱码与时间偏移。
 * ============================================================
 */

import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { config } from '../config.js';
import * as schema from './schema.js';

/** 全局连接池：整个进程共享 */
export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  connectionLimit: config.db.connectionLimit,
  // 等待连接的最长时间，避免请求无限挂起
  waitForConnections: true,
  queueLimit: 0,
  // 允许一次执行多条语句（迁移脚本需要）
  multipleStatements: false,
  // 统一 UTF-8，防止 emoji 与中文截断
  charset: 'utf8mb4',
  // 时间统一用毫秒时间戳存 bigint，这里不影响，但保持 UTC 避免隐式转换
  timezone: 'Z',
  // 大整数以字符串返回会破坏我们的 number 约定，这里开启支持
  supportBigNumbers: true,
  bigNumberStrings: false,
});

export const db = drizzle(pool, { schema, mode: 'default' });

/** 健康检查：用于 /api/health */
export async function pingDatabase(): Promise<boolean> {
  try {
    const conn = await pool.getConnection();
    try {
      await conn.query('SELECT 1');
      return true;
    } finally {
      conn.release();
    }
  } catch {
    return false;
  }
}

/** 优雅关闭：进程退出前释放连接，避免 MySQL 侧残留 */
export async function closeDatabase(): Promise<void> {
  await pool.end();
}

export { schema };
