/**
 * ============================================================
 * 后端打包脚本
 * ------------------------------------------------------------
 * 为什么用 esbuild 打包成单文件：
 * 1. @chat/shared 是 workspace 包，npm 无法在服务器上解析 workspace:*；
 * 2. 打包后只需部署一个 index.js + 生产依赖，部署更简单；
 * 3. 服务器（2C1.8G）只运行，不做任何编译。
 *
 * 注意：
 * - 第三方依赖保持 external（不打包），由 npm install 安装，
 *   这样原生模块（argon2）才能正常工作；
 * - 只把 workspace 内部包打进产物。
 * ============================================================
 */

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));

// 所有第三方依赖保持 external：原生模块无法被打包
// 但 @chat/shared 要打进去（它是 workspace 包，服务器上没有）
const external = Object.keys(pkg.dependencies || {}).filter(
  (name) => !name.startsWith('@chat/'),
);

/** 共用配置 */
const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external,
  sourcemap: true,
  minify: false,
  logLevel: 'info',
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module';",
      'const require = __cr(import.meta.url);',
    ].join('\n'),
  },
};

await build({ ...shared, entryPoints: ['src/index.ts'], outfile: 'dist/index.js' });
await build({ ...shared, entryPoints: ['src/db/migrate.ts'], outfile: 'dist/migrate.js' });

console.log('后端打包完成');
