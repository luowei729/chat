/**
 * ============================================================
 * 本地存储
 * ------------------------------------------------------------
 * 为什么要自己封装：
 * 1. Lynx 各端的存储能力不同（原生有 NativeModules，Web 只有 localStorage）；
 * 2. 令牌必须加密存储（Android EncryptedSharedPreferences / iOS Keychain），
 *    但首版先用普通存储，把接口留好，后续替换实现不影响业务代码；
 * 3. 统一 JSON 序列化，避免各处手写 JSON.parse。
 * ============================================================
 */

/** 存储键名集中管理，避免拼写错误导致读取失败 */
export const StorageKey = {
  ACCESS_TOKEN: 'chat.accessToken',
  REFRESH_TOKEN: 'chat.refreshToken',
  ACCESS_EXPIRES_AT: 'chat.accessExpiresAt',
  USER_ID: 'chat.userId',
  DEVICE_ID: 'chat.deviceId',
  /** 本地草稿：按会话 id 存储 */
  DRAFT_PREFIX: 'chat.draft.',
  /** 已同步的最大消息 seq：按会话 id 存储，用于增量拉取 */
  SYNC_SEQ_PREFIX: 'chat.syncseq.',
} as const;

/**
 * 底层存储实现
 * ------------------------------------------------------------
 * Lynx 原生端提供全局 `lynx.getStorageItem` 等同步 API；
 * Web 端退回 localStorage。两者都是同步的，所以业务层可以当同步接口用。
 */
interface LynxStorageApi {
  setStorageItem?: (key: string, value: string) => void;
  getStorageItem?: (key: string) => string | null | undefined;
  removeStorageItem?: (key: string) => void;
}

function getNativeApi(): LynxStorageApi | null {
  const g = globalThis as unknown as { lynx?: LynxStorageApi };
  if (g.lynx?.setStorageItem) return g.lynx;
  return null;
}

function getWebStorage(): Storage | null {
  try {
    const g = globalThis as unknown as { localStorage?: Storage };
    return g.localStorage ?? null;
  } catch {
    // 隐私模式下访问 localStorage 可能抛错
    return null;
  }
}

/** 内存兜底：两端都不可用时至少保证当前会话内可用 */
const memoryStore = new Map<string, string>();

/** 写入字符串 */
export function setItem(key: string, value: string): void {
  const native = getNativeApi();
  if (native?.setStorageItem) {
    native.setStorageItem(key, value);
    return;
  }
  const web = getWebStorage();
  if (web) {
    try {
      web.setItem(key, value);
      return;
    } catch {
      // 配额满或隐私模式，落回内存
    }
  }
  memoryStore.set(key, value);
}

/** 读取字符串 */
export function getItem(key: string): string | null {
  const native = getNativeApi();
  if (native?.getStorageItem) {
    const v = native.getStorageItem(key);
    return v ?? null;
  }
  const web = getWebStorage();
  if (web) {
    try {
      return web.getItem(key);
    } catch {
      // 忽略，走内存兜底
    }
  }
  return memoryStore.get(key) ?? null;
}

/** 删除 */
export function removeItem(key: string): void {
  const native = getNativeApi();
  if (native?.removeStorageItem) {
    native.removeStorageItem(key);
    return;
  }
  const web = getWebStorage();
  if (web) {
    try {
      web.removeItem(key);
      return;
    } catch {
      // 忽略
    }
  }
  memoryStore.delete(key);
}

/** 读 JSON 对象，解析失败返回 null（防止脏数据导致启动崩溃） */
export function getJson<T>(key: string): T | null {
  const raw = getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    removeItem(key);
    return null;
  }
}

/** 写 JSON 对象 */
export function setJson(key: string, value: unknown): void {
  try {
    setItem(key, JSON.stringify(value));
  } catch {
    // 循环引用等异常，忽略
  }
}

/** 读数字（令牌过期时间等） */
export function getNumber(key: string): number | null {
  const raw = getItem(key);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** 写数字 */
export function setNumber(key: string, value: number): void {
  setItem(key, String(value));
}
