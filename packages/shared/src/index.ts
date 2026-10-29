/**
 * ============================================================
 * @chat/shared 统一出口
 * ------------------------------------------------------------
 * 使用方式：
 *   import { ErrorCode, messageSummary, type Message } from '@chat/shared'
 * 注意：这里全部是纯类型/纯函数，不含任何 Node 或浏览器专有 API，
 *      因此可以同时被服务端、Lynx 客户端、Electron 主进程引用。
 * ============================================================
 */

export * from './constants.js';
export * from './types.js';
export * from './errors.js';
export * from './ws.js';
export * from './validation.js';
