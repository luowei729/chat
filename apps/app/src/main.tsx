/**
 * ============================================================
 * 应用入口
 * ------------------------------------------------------------
 * ReactLynx 与 React 的差异：
 * 1. 根节点用官方导出的 `root.render()`，不是 createRoot；
 * 2. 没有 document/window，样式全部走 style 对象或 className；
 * 3. 元素是小写标签（view/text/image/scroll-view 等 Lynx 内置组件）；
 * 4. 事件用 bindtap / bindinput / bindconfirm，不是 onClick / onChange。
 * ============================================================
 */

import { root } from '@lynx-js/react';
import { App } from './App.js';

root.render(<App />);
