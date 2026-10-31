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

import { getLynx, getNativeModule } from './platform/globals.js';

/**
 * 底层存储实现
 * ------------------------------------------------------------
 * Lynx 原生端提供全局 `lynx.getStorageItem` 等同步 API；
 * Web 端退回 localStorage。两者都是同步的，所以业务层可以当同步接口用。
 */
interface ChatStoreNative {
  setItem?: (key: string, value: string) => void;
  removeItem?: (key: string) => void;
  getItem?: (key: string, cb: (v: unknown) => void) => void;
  dump?: (cb: (v: unknown) => void) => void;
}

/**
 * 取原生存储模块
 * 注意：必须经 getNativeModule 走裸标识符 NativeModules，
 * globalThis.NativeModules 在 Lynx 原生端恒为 undefined。
 */
function storeNative(): ChatStoreNative | null {
  return getNativeModule<ChatStoreNative>('ChatStore');
}

/** Lynx 是否自带存储 API（当前版本没有，保留探测以备升级） */
function lynxStorage(): Record<string, unknown> | null {
  const l = getLynx();
  if (l && typeof l['setStorageItem'] === 'function') return l;
  return null;
}

let hydrated = false;

/**
 * 预热：把原生已持久化的键值一次性读进内存
 * 必须在读取令牌之前 await，否则会误判为未登录。
 * 失败不抛异常 —— 最差情况退化成「本次会话内有效」。
 */
export function hydrateStorage(): Promise<void> {
  if (hydrated) return Promise.resolve();
  hydrated = true;

  const native = storeNative();
  if (native?.dump) {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      // 原生没回调时的兜底，避免启动被卡死
      setTimeout(finish, 1500);
      try {
        native.dump!((raw) => {
          /**
           * 原生 dump 回的是 JSON 字符串（见 ChatStoreModule 注释：
           * JavaOnlyMap 嵌套在部分 ROM 上会丢字段，字符串最稳）。
           * 之前这里直接把 raw 当对象用，string 恒不满足
           * `typeof obj === 'object'`，内存缓存永远是空的 ——
           * 表现为「每次重启都要重新登录」。先归一化再灌入。
           */
          let obj: Record<string, unknown> | null = null;
          if (typeof raw === 'string') {
            try {
              obj = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              obj = null;
            }
          } else if (raw && typeof raw === 'object') {
            obj = raw as Record<string, unknown>;
          }
          if (obj) {
            for (const k of Object.keys(obj)) {
              const v = obj[k];
              if (typeof v === 'string' && v !== '') memoryStore.set(k, v);
            }
          }
          finish();
        });
      } catch {
        finish();
      }
    });
  }
  return Promise.resolve();
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
  memoryStore.set(key, value);

  const native = storeNative();
  if (native?.setItem) {
    try {
      native.setItem(key, value);
      return;
    } catch {
      // 忽略，内存里已有
    }
  }

  const l = lynxStorage();
  if (l) {
    try {
      (l['setStorageItem'] as (k: string, v: string) => void)(key, value);
      return;
    } catch {
      // 忽略
    }
  }

  const web = getWebStorage();
  if (web) {
    try {
      web.setItem(key, value);
    } catch {
      // 配额满或隐私模式，内存兜底
    }
  }
}

/** 读取字符串 */
export function getItem(key: string): string | null {
  const cached = memoryStore.get(key);
  if (cached !== undefined) return cached;

  const web = getWebStorage();
  if (web) {
    try {
      const v = web.getItem(key);
      if (v !== null) {
        memoryStore.set(key, v);
        return v;
      }
    } catch {
      // 忽略
    }
  }
  return null;
}

/** 删除 */
export function removeItem(key: string): void {
  memoryStore.delete(key);

  const native = storeNative();
  if (native?.removeItem) {
    try {
      native.removeItem(key);
      return;
    } catch {
      // 忽略
    }
  }

  const l = lynxStorage();
  if (l) {
    try {
      (l['removeStorageItem'] as (k: string) => void)(key);
      return;
    } catch {
      // 忽略
    }
  }

  const web = getWebStorage();
  if (web) {
    try {
      web.removeItem(key);
    } catch {
      // 忽略
    }
  }
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
