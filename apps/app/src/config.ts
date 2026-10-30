/**
 * ============================================================
 * 运行环境配置
 * ------------------------------------------------------------
 * 为什么集中在这里：
 * 1. 域名只有一个（chat.lkz.pub），所有接口都走 443，客户端无需配置端口；
 * 2. 不同平台（Android/iOS/Harmony/Web）的 API 基址完全一致，
 *    避免各处硬编码导致切换环境时漏改；
 * 3. 开发时可改成局域网 IP 便于真机调试。
 * ============================================================
 */

import { getLynx } from './platform/globals.js';

/** 源站（不带 /api）：媒体地址、下载链接都基于它拼 */
export const ORIGIN = 'https://chat.lkz.pub';

/** 服务端基址：所有 REST 接口的前缀 */
export const API_BASE = `${ORIGIN}/api`;

/**
 * 把服务端返回的媒体相对路径转成可直接渲染的绝对地址
 * ------------------------------------------------------------
 * 服务端下发的是 `/api/media/xxx?e=..&s=..`（省流量、便于换域名），
 * 但 Lynx 的 <image> 与原生播放器都要求绝对 URL，
 * 相对路径会静默加载失败（表现为蓝色空气泡，不报错）。
 *
 * 已经是 http(s) 的原样返回，便于将来切 CDN。
 */
export function mediaUrl(path: string | null | undefined): string {
  if (!path) return '';
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  if (path.startsWith('//')) return `https:${path}`;
  return path.startsWith('/') ? `${ORIGIN}${path}` : `${ORIGIN}/${path}`;
}

/** WebSocket 地址：实时消息与通话信令 */
export const WS_URL = 'wss://chat.lkz.pub/ws';

/**
 * 应用版本号
 * 说明：与服务端上报设备信息时使用，便于排查版本兼容问题。
 */
export const APP_VERSION = '2.0.0';

/**
 * 客户端平台标识
 * 说明：Lynx 在原生端可通过 NativeModules 获取，
 *      这里先用编译期注入的方式区分（构建时由 Rspeedy 替换）。
 */
export const PLATFORM = (() => {
  // 注意：lynx 是 Lynx 注入的**裸全局**，不在 globalThis 上，
  // 必须经 getLynx() 取；用 globalThis.lynx 会恒为 undefined，
  // 导致平台判定永远落到 'web'。
  const os = (getLynx()?.['os'] as string | undefined)?.toLowerCase();
  if (os === 'android') return 'android' as const;
  if (os === 'ios') return 'ios' as const;
  if (os === 'harmony' || os === 'ohos') return 'harmony' as const;
  if (os === 'windows') return 'windows' as const;
  if (os === 'macos' || os === 'darwin') return 'macos' as const;
  return 'web' as const;
})();

/** 请求超时（毫秒）：移动网络下 15 秒足够 */
export const REQUEST_TIMEOUT_MS = 15_000;

/** 上传超时（毫秒）：大文件需要更久 */
export const UPLOAD_TIMEOUT_MS = 180_000;
