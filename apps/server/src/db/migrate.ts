/**
 * ============================================================
 * 迁移执行器
 * ------------------------------------------------------------
 * 为什么不用 drizzle-kit migrate：
 * 1. 部署环境（服务器）不装 devDependencies，只需要运行时依赖；
 * 2. 这里用 drizzle-orm 自带的 migrate 函数，逻辑等价但零额外依赖；
 * 3. 支持幂等执行：重复跑不会报错，适合 CI 每次部署都跑一遍。
 * ============================================================
 */

import { migrate } from 'drizzle-orm/mysql2/migrator';
import { resolve } from 'node:path';
import { closeDatabase, db } from './index.js';

async function main(): Promise<void> {
  const migrationsFolder = resolve(process.cwd(), 'drizzle');
  // eslint-disable-next-line no-console
  console.log(`[migrate] 开始执行迁移，目录：${migrationsFolder}`);

  await migrate(db, { migrationsFolder });

  // eslint-disable-next-line no-console
  console.log('[migrate] 迁移完成');
  await closeDatabase();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[migrate] 迁移失败：', err);
  process.exit(1);
});
