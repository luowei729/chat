/**
 * ============================================================
 * Drizzle Kit 配置
 * ------------------------------------------------------------
 * 用途：`pnpm db:generate` 依据 schema.ts 生成 SQL 迁移文件，
 *      `pnpm db:migrate` 在部署时执行（CI 或服务器启动前）。
 * 注意：迁移文件必须提交到仓库，否则部署时无法建表。
 * ============================================================
 */

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'mysql',
  dbCredentials: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'chat2',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'chat2',
  },
  // 迁移时输出详细日志，方便排查
  verbose: true,
  strict: false,
});
