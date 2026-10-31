/**
 * ============================================================
 * WebSocket 跨平台封装
 * ============================================================
 * 【核心事实】Lynx 引擎没有可用的 WebSocket
 * ------------------------------------------------------------
 * 实测（Android / Lynx 4.2.0）：
 *   · lynx-service-http 的 aar 只有 4 个 class，全是 HTTP，
 *     没有任何 socket 实现；
 *   · 前端 `new WebSocket(url)` 不抛异常、不报错，
 *     但 onopen 永远不触发 —— 连不上也不告诉你，最难查。
 *
 * 直接后果（这些症状其实是同一个根因）：
 *   · 对方发消息，自己端不刷新       →「消息没有立即推送」
 *   · 点语音通话，对方毫无反应       →「打电话没反应」
 *   · 未读红点不实时增加
 *
 * 【方案】能力探测 + 原生优先 + Web 兜底
 *   原生（Android/iOS/鸿蒙）→ ChatSocket 模块，底层 OkHttp/系统 API
 *   Web / 桌面端          → 浏览器原生 WebSocket
 * 两条路对上层暴露完全相同的接口，ws.ts 不需要知道跑在哪。
 *
 * 【事件映射】
 *   原生通过全局事件 'chatSocket' 推送：
 *     {event:'open'} / {event:'message', data} /
 *     {event:'closed', code, reason} / {event:'failure', message}
 *   这里翻译成 onOpen / onMessage / onClose / onError 四个回调，
 *   与浏览器 WebSocket 的语义对齐。
 * ============================================================
 */

import { getGlobalEventEmitter, getNativeModule } from './globals.js';

interface ChatSocketNative {
  connect?: (optsJson: string, cb: (r: unknown) => void) => void;
  send?: (text: string, cb: (r: unknown) => void) => void;
  close?: (cb: (r: unknown) => void) => void;
  isConnected?: (cb: (v: unknown) => void) => void;
}

function nativeSocket(): ChatSocketNative | null {
  return getNativeModule<ChatSocketNative>('ChatSocket');
}

/** 统一接口：与浏览器 WebSocket 的最小子集对齐 */
export interface SocketLike {
  send: (text: string) => void;
  close: () => void;
  readonly kind: 'native' | 'web';
}

export interface SocketHandlers {
  onOpen: () => void;
  onMessage: (data: string) => void;
  onClose: (code: number, reason: string) => void;
  onError: (message: string) => void;
}

/* ------------------------------------------------------------------ */
/* 原生事件订阅（模块级单例）                                            */
/* ------------------------------------------------------------------ */

let subscribed = false;
let activeHandlers: SocketHandlers | null = null;

function ensureSubscribed(): void {
  if (subscribed) return;
  const emitter = getGlobalEventEmitter();
  if (!emitter) return;
  subscribed = true;

  try {
    emitter.addListener('chatSocket', (...args: unknown[]) => {
      const payload = args[0] as Record<string, unknown> | undefined;
      if (!payload) return;
      const h = activeHandlers;
      if (!h) return;

      switch (payload['event']) {
        case 'open':
          h.onOpen();
          break;
        case 'message':
          h.onMessage(typeof payload['data'] === 'string' ? payload['data'] : '');
          break;
        case 'closed':
          h.onClose(
            typeof payload['code'] === 'number' ? payload['code'] : 1000,
            typeof payload['reason'] === 'string' ? payload['reason'] : '',
          );
          break;
        case 'failure':
          h.onError(
            typeof payload['message'] === 'string' ? payload['message'] : '连接失败',
          );
          break;
        default:
          break;
      }
    });
  } catch {
    subscribed = false;
  }
}

/* ------------------------------------------------------------------ */
/* 连接                                                                */
/* ------------------------------------------------------------------ */

/**
 * 建立 WebSocket 连接
 * @param url wss://... 或 ws://...
 * @param headers 额外请求头（原生端支持，浏览器端忽略）
 * @param handlers 事件回调
 */
export function openSocket(
  url: string,
  headers: Record<string, string>,
  handlers: SocketHandlers,
): SocketLike {
  const n = nativeSocket();

  if (n?.connect) {
    ensureSubscribed();
    activeHandlers = handlers;

    n.connect(
      JSON.stringify({ url, headers }),
      (raw) => {
        const r = (raw ?? {}) as Record<string, unknown>;
        if (r['ok'] !== true) {
          handlers.onError(
            typeof r['message'] === 'string' ? r['message'] : '连接失败',
          );
        }
        // 成功时不要手动触发 onOpen —— 等原生的 'open' 事件，
        // 否则会在真正握手上完成前就发 auth 帧。
      },
    );

    return {
      kind: 'native',
      send: (text: string) => {
        try {
          n.send?.(text, () => undefined);
        } catch {
          // 忽略
        }
      },
      close: () => {
        activeHandlers = null;
        try {
          n.close?.(() => undefined);
        } catch {
          // 忽略
        }
      },
    };
  }

  // ---- Web / 桌面端兜底 ----
  const g = globalThis as unknown as {
    WebSocket?: new (url: string) => {
      send: (t: string) => void;
      close: () => void;
      onopen: (() => void) | null;
      onmessage: ((e: { data: unknown }) => void) | null;
      onclose: ((e: { code: number; reason: string }) => void) | null;
      onerror: (() => void) | null;
    };
  };

  if (typeof g.WebSocket !== 'function') {
    handlers.onError('当前平台不支持实时连接');
    return { kind: 'web', send: () => undefined, close: () => undefined };
  }

  const ws = new g.WebSocket(url);
  ws.onopen = () => handlers.onOpen();
  ws.onmessage = (e) => handlers.onMessage(String(e.data));
  ws.onclose = (e) => handlers.onClose(e.code, e.reason ?? '');
  ws.onerror = () => handlers.onError('连接出错');

  return {
    kind: 'web',
    send: (text: string) => {
      try {
        ws.send(text);
      } catch {
        // 忽略
      }
    },
    close: () => {
      try {
        ws.close();
      } catch {
        // 忽略
      }
    },
  };
}

/** 该端是否具备可用的实时连接能力（UI 可据此提示「仅支持前台接收」） */
export function hasSocketSupport(): boolean {
  if (nativeSocket()?.connect) return true;
  const g = globalThis as unknown as { WebSocket?: unknown };
  return typeof g.WebSocket === 'function';
}
