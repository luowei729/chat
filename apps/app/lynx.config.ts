/**
 * ============================================================
 * Rspeedy 构建配置（Lynx 官方工具链）
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
 * 产物说明：
 *   dist/main.lynx.bundle  ← Lynx 模板（JSON 格式，App 真正加载的文件）
 *   dist/static/js/*.js    ← 模板引用的 JS 逻辑
 * ============================================================
 */

import { pluginReactLynx } from '@lynx-js/react-rsbuild-plugin';
import { defineConfig } from '@lynx-js/rspeedy';

export default defineConfig({
  // 入口：ReactLynx 应用从 main.tsx 开始
  source: {
    entry: './src/main.tsx',
  },

  plugins: [
    // React JSX → Lynx 元素转换（必需，缺失会黑屏）
    pluginReactLynx(),
  ],

  output: {
    // 产物目录
    distPath: {
      root: 'dist',
    },
    /**
     * bundle 文件名：Lynx 模板文件
     * [platform] 会被替换为 lynx / web，区分不同端的产物
     */
    filename: {
      bundle: 'chat.lynx.bundle',
    },
    /**
     * 图片等资源内联为 data URI
     * 原因：Lynx 运行时不支持通过 URL 加载本地资源，
     *      所有资源必须内联进 bundle 或走网络 URL。
     */
    dataUriLimit: Infinity,
  },

  // 开发服务器：真机通过 LynxView 扫码连接
  dev: {
    hmr: true,
    liveReload: true,
  },

  performance: {
    // 生产构建移除 console.log，减小包体积
    removeConsole: process.env.NODE_ENV === 'production' ? ['log'] : false,
  },
});
