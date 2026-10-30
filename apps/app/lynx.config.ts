/**
 * ============================================================
 * Rspeedy 构建配置 —— 原生端（Android / iOS / Harmony）
 * ============================================================
 * 关键：必须注册 pluginReactLynx()
 * ------------------------------------------------------------
 * Rspeedy 内置了 pluginLynx（生成 .bundle 模板文件），
 * 但**没有内置 pluginReactLynx**（React JSX → Lynx 元素的编译转换）。
 *
 * 缺少 pluginReactLynx 时的症状：
 *   构建"成功"，但产物只是普通 webpack JS，
 *   没有 .bundle 模板文件，App 装上后 Lynx 加载不到模板 → 黑屏。
 *
 * 为什么原生与 Web 分成两个配置文件：
 *   pluginReactLynx 内部依赖「主线程」概念（updateMainThreadInfo），
 *   与 Rspeedy 的多 environment 模式不兼容（会抛 Invariant failed）。
 *   拆成两个单环境配置最稳，构建命令分开跑即可。
 *
 * 产物：dist/chat.lynx.bundle（App 从 assets 加载）
 * ============================================================
 */

import { pluginReactLynx } from '@lynx-js/react-rsbuild-plugin';
import { defineConfig } from '@lynx-js/rspeedy';

export default defineConfig({
  // 入口：ReactLynx 应用从 main.tsx 开始
  source: {
    entry: { chat: './src/main.tsx' },
  },

  plugins: [
    // React JSX → Lynx 元素转换（必需，缺失会黑屏）
    pluginReactLynx(),
  ],

  output: {
    distPath: {
      root: 'dist',
    },
    /**
     * bundle 文件名固定为 chat.lynx.bundle：
     * Android 端 MainActivity 的 BUNDLE_NAME 常量与之一致，
     * CI 无需重命名，减少出错环节。
     */
    filename: {
      bundle: 'chat.lynx.bundle',
    },
    /**
     * 图片等资源内联为 data URI
     * 原因：Lynx 运行时不支持通过 URL 加载本地资源。
     */
    dataUriLimit: Infinity,
  },

  performance: {
    // 生产构建移除 console.log，减小包体积
    removeConsole: process.env.NODE_ENV === 'production' ? ['log'] : false,
  },
});
