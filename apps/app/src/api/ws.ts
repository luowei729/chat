/**
 * ============================================================
 * WebSocket 客户端
 * ------------------------------------------------------------
 * 为什么需要这一层而不是直接用 WebSocket：
 * 1. 自动重连：移动网络切换、App 切后台都会断线，必须无感重连；
 * 2. 心跳保活：25 秒发一次 ping，防止 NAT 超时断开；
 * 3. 消息队列：断线期间待发消息暂存，重连后自动补发；
 * 4. 鉴权流程：连接后必须先发 auth 消息，收到 ready 才算可用；
 * 5. 事件订阅：业务层用 on('message.new', handler) 注册，不用写 switch。
 *
 * 重连策略：指数退避（1s → 2s → 4s → 8s → 15s 封顶），
 * 避免服务端重启时全体客户端同时重连造成雪崩。
 * ============================================================
 */

import type { WsClientMessage, WsServerMessage } from '@chat/shared';
import { WS_HEARTBEAT_INTERVAL_MS } from '@chat/shared';
import { PLATFORM, WS_URL } from '../config.js';
import { getAccessToken, getDeviceId } from './client.js';
import { openSocket } from '../platform/socket.js';

/* ------------------------------------------------------------------ */
/* 事件订阅                                                             */
/* ------------------------------------------------------------------ */

/** 服务端消息类型 → 处理函数列表 */
type Handler<T extends WsServerMessage = WsServerMessage> = (msg: T) => void;

/** 连接状态 */
export type ConnectionState = 'idle' | 'connecting' | 'authenticating' | 'ready' | 'closed';

/** 状态变化回调 */
type StateHandler = (state: ConnectionState) => void;

const handlers = new Map<string, Set<Handler>>();
const stateHandlers = new Set<StateHandler>();

/** 订阅某类服务端消息 */
export function on<T extends WsServerMessage['type']>(
  type: T,
  handler: Handler<Extract<WsServerMessage, { type: T }>>,
): () => void {
  let set = handlers.get(type);
  if (!set) {
    set = new Set();
    handlers.set(type, set);
  }
  set.add(handler as Handler);

  // 返回取消订阅函数，组件卸载时调用
  return () => {
    set?.delete(handler as Handler);
  };
}

/** 订阅连接状态变化 */
export function onState(handler: StateHandler): () => void {
  stateHandlers.add(handler);
  return () => stateHandlers.delete(handler);
}

function emit(msg: WsServerMessage): void {
  const set = handlers.get(msg.type);
  if (!set) return;
  for (const h of set) {
    try {
      h(msg);
    } catch {
      // 单个处理器异常不影响其他订阅者
    }
  }
}

function emitState(state: ConnectionState): void {
  for (const h of stateHandlers) {
    try {
      h(state);
    } catch {
      // 忽略
    }
  }
}

/* ------------------------------------------------------------------ */
/* 连接管理                                                             */
/* ------------------------------------------------------------------ */

let socket: import('../platform/socket.js').SocketLike | null = null;
let state: ConnectionState = 'idle';
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
/** 重连次数：用于计算退避时间 */
let reconnectAttempts = 0;
/** 是否用户主动关闭（主动关闭不重连） */
let manualClose = false;
/** 待发送队列：断线期间暂存 */
const outbox: WsClientMessage[] = [];
/** 订阅的会话 id，重连后需要重新订阅 */
const subscriptions = new Set<string>();

/** 当前连接状态 */
export function getState(): ConnectionState {
  return state;
}

function setState(next: ConnectionState): void {
  if (state === next) return;
  state = next;
  emitState(next);
}

/** 发送原始消息（未连接时入队） */
function rawSend(msg: WsClientMessage): boolean {
  /**
   * 判断是否可发
   * 不再检查 readyState：原生通道没有这个字段，
   * 这里用自身维护的 state === 'ready' 作为唯一依据
   * （它只在收到 ready 事件后置位，语义更准确）。
   */
  if (socket && state === 'ready') {
    try {
      socket.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }
  // 入队，重连后补发（心跳与鉴权消息不入队）
  if (msg.type !== 'ping' && msg.type !== 'auth') {
    outbox.push(msg);
    // 队列上限：防止长时间离线导致内存暴涨
    if (outbox.length > 200) outbox.shift();
  }
  return false;
}

/** 启动心跳 */
function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    rawSend({ type: 'ping', ts: Date.now() });
  }, WS_HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/** 清空重连定时器 */
function stopReconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

/** 计算退避时间：1s, 2s, 4s, 8s, 15s 封顶 */
function backoffMs(): number {
  const base = Math.min(1000 * 2 ** reconnectAttempts, 15_000);
  // 加 ±20% 抖动，避免大量客户端同时重连
  const jitter = base * (0.8 + Math.random() * 0.4);
  return Math.round(jitter);
}

/**
 * 建立连接
 * ------------------------------------------------------------
 * 【为什么不再直接用 globalThis.WebSocket】
 * Lynx 引擎没有可用的 WebSocket 实现：new WebSocket() 不报错，
 * 但 onopen 永远不触发，也没有任何错误日志。结果是消息不推送、
 * 通话收不到，且完全无法排查。
 * 现在统一走 platform/socket.ts：
 *   原生（Android/iOS/鸿蒙）→ ChatSocket 模块（OkHttp WebSocket）
 *   Web / 桌面端          → 浏览器原生 WebSocket
 */
export function connect(): void {
  if (state === 'connecting' || state === 'authenticating' || state === 'ready') return;

  const token = getAccessToken();
  if (!token) {
    // 未登录不连接
    return;
  }

  manualClose = false;
  setState('connecting');

  socket = openSocket(WS_URL, {}, {
    onOpen: () => {
      // 连接建立后先鉴权
      setState('authenticating');
      socket?.send(
        JSON.stringify({
          type: 'auth',
          token: getAccessToken() ?? '',
          platform: PLATFORM,
          deviceId: getDeviceId(),
        } satisfies WsClientMessage),
      );
    },

    onMessage: (data: string) => {
      let msg: WsServerMessage;
      try {
        msg = JSON.parse(data) as WsServerMessage;
      } catch {
        return;
      }

      // 鉴权成功：切到 ready，启动心跳，补发队列与订阅
      if (msg.type === 'ready') {
        setState('ready');
        reconnectAttempts = 0;
        startHeartbeat();

        // 重新订阅所有会话
        if (subscriptions.size > 0) {
          rawSend({ type: 'subscribe', conversationIds: [...subscriptions] });
        }

        // 补发断线期间的消息
        while (outbox.length > 0) {
          const pending = outbox.shift();
          if (pending) rawSend(pending);
        }
      }

      emit(msg);
    },

    onError: () => {
      // 具体错误通过 onClose 统一处理重连
    },

    onClose: (code: number) => {
      stopHeartbeat();
      setState('closed');
      socket = null;

      if (manualClose) return;

      // 鉴权失败（4001/4002）不重连，交给上层跳登录页
      if (code === 4001 || code === 4002) {
        return;
      }

      scheduleReconnect();
    },
  });
}

/** 安排重连 */
function scheduleReconnect(): void {
  stopReconnect();
  const delay = backoffMs();
  reconnectAttempts += 1;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

/** 主动断开（退出登录时调用） */
export function disconnect(): void {
  manualClose = true;
  stopHeartbeat();
  stopReconnect();
  outbox.length = 0;
  subscriptions.clear();

  if (socket) {
    try {
      socket.close();
    } catch {
      // 忽略
    }
    socket = null;
  }
  setState('idle');
}

/* ------------------------------------------------------------------ */
/* 业务方法                                                             */
/* ------------------------------------------------------------------ */

/** 订阅会话（进入聊天页时调用） */
export function subscribe(conversationIds: string[]): void {
  for (const id of conversationIds) subscriptions.add(id);
  rawSend({ type: 'subscribe', conversationIds });
}

/** 退订会话（离开聊天页时调用） */
export function unsubscribe(conversationIds: string[]): void {
  for (const id of conversationIds) subscriptions.delete(id);
  rawSend({ type: 'unsubscribe', conversationIds });
}

/** 发送「正在输入」提示 */
export function sendTyping(conversationId: string): void {
  rawSend({ type: 'typing', conversationId });
}

/** 发送已读回执 */
export function sendRead(conversationId: string, seq: number): void {
  rawSend({ type: 'read', conversationId, seq });
}

/* ---------------- 通话信令 ---------------- */

/** 发起通话 */
export function inviteCall(params: {
  conversationId: string;
  mode: 'audio' | 'video';
  inviteeIds?: string[];
}): void {
  rawSend({ type: 'call.invite', ...params });
}

/** 接听 */
export function acceptCall(callId: string): void {
  rawSend({ type: 'call.accept', callId });
}

/** 拒接 */
export function rejectCall(callId: string): void {
  rawSend({ type: 'call.reject', callId });
}

/** 挂断 */
export function hangupCall(callId: string): void {
  rawSend({ type: 'call.hangup', callId });
}

/**
 * 转发 P2P 信令（offer/answer/ice）
 * 说明：Mesh 拓扑中每个 Peer 单独一条连接，必须指定 to。
 */
export function sendP2pSignal(params: {
  callId: string;
  kind: 'offer' | 'answer' | 'ice' | 'renegotiate';
  to: string;
  payload: string;
}): void {
  rawSend({ type: 'call.p2p', ...params });
}

/** 同步静音/说话状态 */
export function sendMediaState(params: {
  callId: string;
  muted: boolean;
  speaking: boolean;
}): void {
  rawSend({ type: 'call.media-state', ...params });
}
