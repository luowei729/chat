/**
 * ============================================================
 * Rspeedy 构建配置 —— Web 端（Lynx for Web）
 * ============================================================
 * 产物：dist-web/chat.web.bundle
 * 用法：浏览器页面通过 <lynx-view url="chat.web.bundle"> 加载，
 *      <lynx-view> 由 @lynx-js/web-core/client 注册。
 *
 * 为什么单独一个配置文件：
 * pluginReactLynx 与 Rspeedy 多 environment 模式不兼容
 * （会抛 Invariant failed），拆成单环境最稳。
 * ============================================================
 */

import { pluginReactLynx } from '@lynx-js/react-rsbuild-plugin';
import { defineConfig } from '@lynx-js/rspeedy';

export default defineConfig({
  source: {
    entry: { chat: './src/index.web.tsx' },
  },

  plugins: [pluginReactLynx()],

  output: {
    distPath: {
      root: 'dist-web',
    },
    filename: {
      bundle: 'chat.web.bundle',
    },
    dataUriLimit: Infinity,
  },

  performance: {
    removeConsole: false,
  },
});
