/**
 * ============================================================
 * HTTP 客户端
 * ------------------------------------------------------------
 * 核心能力：
 * 1. 自动带 Authorization 头；
 * 2. access token 过期前 60 秒自动用 refresh token 换新（无感刷新）；
 * 3. 并发请求同时遇到 401 时只刷新一次（避免刷新风暴）；
 * 4. 统一错误处理：业务码转成 ApiError 抛出，UI 层直接 catch 拿 message；
 * 5. 401 且刷新失败 → 清除令牌并通知上层跳登录页。
 *
 * 为什么不用 axios：
 * Lynx 的 fetch 是官方内置模块（`js_libraries/lynx-core/src/modules/fetch`），
 * 直接用它体积最小、兼容性最好，axios 的适配层反而会引入平台差异。
 * ============================================================
 */

import type { ApiResponse } from '@chat/shared';
import { ErrorCode, ErrorMessage } from '@chat/shared';
import { API_BASE, APP_VERSION, PLATFORM, REQUEST_TIMEOUT_MS } from '../config.js';
import * as storage from '../storage.js';

/** 业务异常：UI 层 catch 后可拿 code 做差异化处理 */
export class ApiError extends Error {
  readonly code: number;
  readonly fields?: Record<string, string>;
  readonly httpStatus: number;

  constructor(code: number, message: string, httpStatus = 0, fields?: Record<string, string>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.fields = fields;
  }
}

/* ------------------------------------------------------------------ */
/* 令牌管理                                                             */
/* ------------------------------------------------------------------ */

/** 登录态变化回调：由 App 层注册，用于跳转登录页 */
type AuthStateHandler = (loggedIn: boolean) => void;
let authStateHandler: AuthStateHandler | null = null;

export function onAuthStateChange(handler: AuthStateHandler): void {
  authStateHandler = handler;
}

export function getAccessToken(): string | null {
  return storage.getItem(storage.StorageKey.ACCESS_TOKEN);
}

export function getRefreshToken(): string | null {
  return storage.getItem(storage.StorageKey.REFRESH_TOKEN);
}

/** 保存登录态 */
export function saveTokens(params: {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
}): void {
  storage.setItem(storage.StorageKey.ACCESS_TOKEN, params.accessToken);
  storage.setItem(storage.StorageKey.REFRESH_TOKEN, params.refreshToken);
  storage.setNumber(storage.StorageKey.ACCESS_EXPIRES_AT, params.accessTokenExpiresAt);
}

/** 清除登录态（退出登录或刷新失败时） */
export function clearTokens(): void {
  storage.removeItem(storage.StorageKey.ACCESS_TOKEN);
  storage.removeItem(storage.StorageKey.REFRESH_TOKEN);
  storage.removeItem(storage.StorageKey.ACCESS_EXPIRES_AT);
  storage.removeItem(storage.StorageKey.USER_ID);
  authStateHandler?.(false);
}

/** 设备 id：首次启动生成并持久化，用于多端登录管理 */
export function getDeviceId(): string {
  const existing = storage.getItem(storage.StorageKey.DEVICE_ID);
  if (existing) return existing;
  // 用时间戳 + 随机数生成，不追求全局唯一，只要本机稳定即可
  const id = `${PLATFORM}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  storage.setItem(storage.StorageKey.DEVICE_ID, id);
  return id;
}

/* ------------------------------------------------------------------ */
/* 令牌刷新（单飞模式）                                                  */
/* ------------------------------------------------------------------ */

/** 正在进行的刷新请求：并发请求共享同一个 Promise，避免刷新风暴 */
let refreshPromise: Promise<boolean> | null = null;

/**
 * 用 refresh token 换新的 access token
 * @returns 是否刷新成功
 */
async function doRefresh(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;

  try {
    const res = await rawFetch('/auth/refresh', {
      method: 'POST',
      body: {
        refreshToken,
        platform: PLATFORM,
      },
      // 刷新请求本身不需要带旧 access token
      skipAuth: true,
      skipRefresh: true,
    });

    if (res.code !== 0) return false;

    // 收窄类型：code === 0 时一定是 ApiOk
    if (!('data' in res)) return false;
    const data = res.data as {
      accessToken: string;
      refreshToken: string;
      accessTokenExpiresAt: number;
      user: { id: string };
    };

    saveTokens({
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      accessTokenExpiresAt: data.accessTokenExpiresAt,
    });
    storage.setItem(storage.StorageKey.USER_ID, data.user.id);

    return true;
  } catch {
    return false;
  }
}

/** 单飞刷新：同一时刻只有一个刷新请求在飞 */
async function refreshOnce(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = doRefresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

/**
 * 检查并提前刷新
 * 说明：access token 有效期 15 分钟，提前 60 秒刷新，
 *      避免请求发出时刚好过期导致一次失败。
 */
async function ensureFreshToken(): Promise<void> {
  const expiresAt = storage.getNumber(storage.StorageKey.ACCESS_EXPIRES_AT);
  if (!expiresAt) return;
  if (expiresAt - Date.now() > 60_000) return;

  const ok = await refreshOnce();
  if (!ok) {
    clearTokens();
  }
}

/* ------------------------------------------------------------------ */
/* 底层请求                                                             */
/* ------------------------------------------------------------------ */

interface RawFetchOptions {
  method?: string;
  body?: unknown;
  /** 表单上传时直接传 FormData */
  formData?: unknown;
  /** 跳过 Authorization 头 */
  skipAuth?: boolean;
  /** 跳过 401 自动刷新（刷新接口自身用） */
  skipRefresh?: boolean;
  /** 自定义超时 */
  timeoutMs?: number;
}

/** 不带重试逻辑的原始请求 */
async function rawFetch<T = unknown>(
  path: string,
  options: RawFetchOptions = {},
): Promise<ApiResponse<T>> {
  const {
    method = 'GET',
    body,
    formData,
    skipAuth = false,
    timeoutMs = REQUEST_TIMEOUT_MS,
  } = options;

  const headers: Record<string, string> = {
    'X-Device-Id': getDeviceId(),
    'X-App-Version': APP_VERSION,
    'X-Platform': PLATFORM,
  };

  if (!skipAuth) {
    const token = getAccessToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  let payload: unknown;
  if (formData !== undefined) {
    // 上传：不设 Content-Type，让运行时自动带 boundary
    payload = formData;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  /**
   * 超时控制：Lynx 的 fetch 支持 AbortController，
   * 用 setTimeout + abort 实现（不用 Promise.race，避免请求泄漏）。
   */
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: payload as BodyInit | undefined,
      ...(controller ? { signal: controller.signal } : {}),
    });

    const httpStatus = response.status;

    // 204 / 空响应
    if (httpStatus === 204) {
      return { code: 0, data: undefined as T, serverTime: Date.now() };
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ApiError(ErrorCode.INTERNAL_ERROR, '服务器返回格式异常', httpStatus);
    }

    const parsed = json as ApiResponse<T>;
    // 服务端始终返回统一结构，这里直接透传
    if (typeof parsed?.code === 'number') return parsed;

    throw new ApiError(ErrorCode.INTERNAL_ERROR, '服务器返回格式异常', httpStatus);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    // 超时或网络错误
    const isAbort = (e as { name?: string }).name === 'AbortError';
    throw new ApiError(
      isAbort ? ErrorCode.TOO_MANY_REQUESTS : ErrorCode.INTERNAL_ERROR,
      isAbort ? '请求超时，请检查网络' : '网络连接失败，请稍后重试',
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* 对外请求方法                                                         */
/* ------------------------------------------------------------------ */

/**
 * 发起请求（自动处理令牌刷新与错误抛出）
 * @throws ApiError 业务失败时抛出，UI 层 catch 后展示 message
 */
export async function request<T = unknown>(
  path: string,
  options: RawFetchOptions = {},
): Promise<T> {
  // 先确保令牌新鲜（除刷新接口外）
  if (!options.skipRefresh) {
    await ensureFreshToken();
  }

  let res = await rawFetch<T>(path, options);

  // 401：尝试刷新一次后重试
  if (res.code === ErrorCode.TOKEN_EXPIRED || res.code === ErrorCode.UNAUTHORIZED) {
    if (!options.skipRefresh) {
      const ok = await refreshOnce();
      if (ok) {
        res = await rawFetch<T>(path, options);
      } else {
        clearTokens();
      }
    }
  }

  if (res.code !== 0) {
    // 收窄类型：code !== 0 时一定是 ApiErr
    const errMsg = 'message' in res ? res.message : '';
    const errFields = 'fields' in res ? (res.fields as Record<string, string>) : undefined;
    throw new ApiError(
      res.code,
      errMsg || ErrorMessage[res.code] || '请求失败',
      0,
      errFields,
    );
  }

  if (!('data' in res)) {
    throw new ApiError(ErrorCode.INTERNAL_ERROR, '服务器返回格式异常');
  }
  return res.data;
}

/** GET 快捷方法 */
export function get<T>(path: string, options?: Omit<RawFetchOptions, 'method' | 'body'>): Promise<T> {
  return request<T>(path, { ...options, method: 'GET' });
}

/** POST 快捷方法 */
export function post<T>(path: string, body?: unknown, options?: Omit<RawFetchOptions, 'method'>): Promise<T> {
  return request<T>(path, { ...options, method: 'POST', body });
}

/** PATCH 快捷方法 */
export function patch<T>(path: string, body?: unknown, options?: Omit<RawFetchOptions, 'method'>): Promise<T> {
  return request<T>(path, { ...options, method: 'PATCH', body });
}

/** DELETE 快捷方法 */
export function del<T>(path: string, body?: unknown, options?: Omit<RawFetchOptions, 'method'>): Promise<T> {
  return request<T>(path, { ...options, method: 'DELETE', body });
}

/** 表单上传（文件） */
export function upload<T>(path: string, formData: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', formData, timeoutMs: 180_000 });
}
