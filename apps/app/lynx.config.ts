/**
 * ============================================================
 * Rspeedy 构建配置（Lynx 官方工具链）
 * ------------------------------------------------------------
 * 产物说明：
 *   dist/main.lynx.bundle —— Lynx 客户端包（Android/iOS/Harmony 共用）
 *   dist/main.web.bundle  —— Web 端包（配合 @lynx-js/web-core 运行）
 *
 * 为什么用 Rspeedy 而不是自己配 Rspack：
 * 1. 它内置了 Lynx 双线程模型（主线程 + 后台线程）的拆分规则；
 * 2. 自动处理 @lynx-js/react 的编译转换（JSX → Lynx 元素）；
 * 3. 官方维护，Lynx 版本升级时无需自己改配置。
 * ============================================================
 */

import { defineConfig } from '@lynx-js/rspeedy';

export default defineConfig({
  // 入口：ReactLynx 应用从 main.tsx 开始
  source: {
    entry: './src/main.tsx',
  },

  output: {
    // 产物目录
    distPath: {
      root: 'dist',
    },
    // 文件名带 hash：便于区分版本，也方便 CDN 缓存
    filename: {
      bundle: '[name].[contenthash].lynx.bundle',
    },
  },

  // 开发服务器配置：真机通过 LynxView 扫码连接
  dev: {
    hmr: true,
    liveReload: true,
  },

  performance: {
    // 生产构建移除 console.log，减小包体积
    removeConsole: process.env.NODE_ENV === 'production' ? ['log'] : false,
  },
});
