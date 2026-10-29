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

/** 服务端基址：所有 REST 接口的前缀 */
export const API_BASE = 'https://chat.lkz.pub/api';

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
  // Lynx 运行时注入的全局对象，存在说明在原生 LynxView 中
  const g = globalThis as unknown as { lynx?: { os?: string } };
  const os = g.lynx?.os?.toLowerCase();
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
