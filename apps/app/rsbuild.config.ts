/**
 * ============================================================
 * Rsbuild 构建配置 —— 原生端（完全照搬官方 hello-world 结构）
 * ============================================================
 * 为什么从 Rspeedy 换成 Rsbuild：
 * Rspeedy 是 Rsbuild 的上层封装，会自动决定部分插件顺序与配置；
 * 但对于 ReactLynx 这种需要精确控制「主线程模板生成」的场景，
 * 上层封装会隐式改动 entry / environment，导致
 * main-thread-script 里缺少 UI 模板 → App 装上后纯黑屏。
 *
 * 官方 lynx-examples/hello-world 使用的就是这套 Rsbuild 配置：
 *   plugins: [pluginLynx(...), pluginQRCode(), pluginReactLynx(), pluginTypeCheck()]
 *
 * 产物：dist/chat.lynx.bundle（App 从 assets 加载）
 * ============================================================
 */

import { pluginLynx } from '@lynx-js/rsbuild-plugin';
import { pluginReactLynx } from '@lynx-js/react-rsbuild-plugin';
import { defineConfig } from '@rsbuild/core';

export default defineConfig({
  source: {
    // 官方写法：entry 是对象，键名决定 bundle 名
    entry: {
      chat: './src/main.tsx',
    },
  },

  // 官方示例必需：声明 lynx environment，
  // 否则 Lynx 引擎的 CSS 提取等默认配置不会应用到构建上
  environments: {
    lynx: {},
  },

  plugins: [
    // 生成 Lynx 模板（main-thread + background-thread 双线程产物）
    pluginLynx({
      output: {
        filename: {
          // 固定名称，与 Android 端 BUNDLE_NAME 常量一致
          bundle: 'chat.lynx.bundle',
        },
      },
    }),
    // React JSX → Lynx 元素（缺少会黑屏）
    pluginReactLynx(),
  ],

  output: {
    distPath: {
      root: 'dist',
    },
    /**
     * 资源内联为 data URI：
     * Lynx 运行时不支持通过 URL 加载本地资源（图片/字体会加载失败）。
     */
    dataUriLimit: Infinity,
  },

  performance: {
    removeConsole: process.env.NODE_ENV === 'production' ? ['log'] : false,
  },
});
