/**
 * ============================================================
 * WebRTC 引擎（P2P Mesh 语音通话）
 * ------------------------------------------------------------
 * 这是「服务器零媒体转发」的核心实现。
 *
 * Mesh 拓扑：N 个参与者，每人维持 N-1 条 PeerConnection。
 *   8 人时每端 7 条连接，每条 Opus 约 40kbps → 上行 ~280kbps。
 *
 * 避免 glare（双方同时发 offer）的规则：
 *   **已在通话中的人，主动向新加入的人发 offer。**
 *   新加入者只负责 answer，不主动发 offer。
 *
 * ICE 降级路径（P2P 不通时自动生效，无需业务代码处理）：
 *   host（同局域网）→ srflx（NAT 打洞）→ relay（TURN 中继）
 *
 * 平台适配：
 *   Web/Electron 直接用浏览器原生 RTCPeerConnection；
 *   Android/iOS/Harmony 由 Lynx 原生模块注入同名实现（见 platform/）。
 * ============================================================
 */

import type { IceServerConfig } from '@chat/shared';
import { CALL_AUDIO_CONSTRAINTS } from '@chat/shared';
import * as ws from '../api/ws.js';
import { currentUserId } from '../store/auth.js';
import { getGlobalEventEmitter, getNativeModule } from '../platform/globals.js';

/* ------------------------------------------------------------------ */
/* 类型声明（Lynx 原生模块与浏览器共用同一套形状）                        */
/* ------------------------------------------------------------------ */

/** 媒体流：浏览器为 MediaStream，原生模块提供等价对象 */
export interface MediaStreamLike {
  getAudioTracks: () => MediaStreamTrackLike[];
  getTracks: () => MediaStreamTrackLike[];
}

export interface MediaStreamTrackLike {
  enabled: boolean;
  stop: () => void;
}

/** PeerConnection 的最小接口：只需要我们用到的方法 */
export interface PeerConnectionLike {
  createOffer: (options?: unknown) => Promise<{ type: string; sdp: string }>;
  createAnswer: () => Promise<{ type: string; sdp: string }>;
  setLocalDescription: (desc: unknown) => Promise<void>;
  setRemoteDescription: (desc: unknown) => Promise<void>;
  addIceCandidate: (candidate: unknown) => Promise<void>;
  addTrack: (track: MediaStreamTrackLike, stream: MediaStreamLike) => unknown;
  close: () => void;
  connectionState: string;
  onicecandidate: ((event: { candidate: unknown | null }) => void) | null;
  ontrack: ((event: { streams: MediaStreamLike[] }) => void) | null;
  onconnectionstatechange: (() => void) | null;
}

/** 运行时能力提供者：由平台层注册 */
export interface RtcProvider {
  /** 获取麦克风流 */
  getUserMedia: (constraints: unknown) => Promise<MediaStreamLike>;
  /** 创建 PeerConnection（原生桥可用 config.peerId 建索引） */
  createPeerConnection: (config: { iceServers: unknown[]; peerId?: string }) => PeerConnectionLike;
}

/* ------------------------------------------------------------------ */
/* 平台能力注册                                                         */
/* ------------------------------------------------------------------ */

let rtcProvider: RtcProvider | null = null;

/**
 * 注册 WebRTC 实现
 * 说明：Web/Electron 在启动时注册浏览器实现；
 *      Android/iOS/Harmony 由 Lynx 原生模块在 App 启动时注册。
 */
export function registerRtcProvider(provider: RtcProvider): void {
  rtcProvider = provider;
}

/** 当前平台是否支持通话 */
export function isRtcSupported(): boolean {
  return rtcProvider !== null;
}

/* ------------------------------------------------------------------ */
/* 通话状态                                                             */
/* ------------------------------------------------------------------ */

/** 单个远端成员 */
export interface PeerState {
  userId: string;
  /** 连接状态：new/connecting/connected/disconnected/failed */
  connectionState: string;
  /** 远端是否静音 */
  muted: boolean;
  /** 远端是否在说话 */
  speaking: boolean;
  /** 远端音频流（用于播放） */
  stream: MediaStreamLike | null;
}

export interface CallEngineState {
  callId: string | null;
  conversationId: string | null;
  /** 是否已接通 */
  active: boolean;
  /** 本地麦克风是否静音 */
  muted: boolean;
  /** 本地是否在说话 */
  speaking: boolean;
  /** 本地音频流 */
  localStream: MediaStreamLike | null;
  /** 远端成员表 */
  peers: Record<string, PeerState>;
  /** 错误信息（用于 UI 提示） */
  error: string | null;
}

/** 引擎内部状态 */
const state: CallEngineState = {
  callId: null,
  conversationId: null,
  active: false,
  muted: false,
  speaking: false,
  localStream: null,
  peers: {},
  error: null,
};

/** PeerConnection 表：userId → 连接 */
const peerConnections = new Map<string, PeerConnectionLike>();

/**
 * 建连时顺带声明 peerId（原生桥需要它建索引）。
 * 浏览器实现忽略该字段，原生实现用它做事件路由。
 */
export interface PeerConnectionConfig {
  iceServers: unknown[];
  peerId?: string;
}

/** 状态变化订阅者 */
const listeners = new Set<(s: CallEngineState) => void>();

/** 订阅引擎状态变化 */
export function subscribeCallState(listener: (s: CallEngineState) => void): () => void {
  listeners.add(listener);
  // 立即推送一次当前状态，避免组件首次渲染拿不到
  listener({ ...state });
  return () => listeners.delete(listener);
}

/** 通知所有订阅者 */
function notify(): void {
  const snapshot = { ...state, peers: { ...state.peers } };
  for (const l of listeners) {
    try {
      l(snapshot);
    } catch {
      // 单个订阅者异常不影响其他
    }
  }
}

/** 取当前状态快照（非组件代码用） */
export function getCallState(): CallEngineState {
  return { ...state, peers: { ...state.peers } };
}

/** 重置状态 */
function resetState(): void {
  state.callId = null;
  state.conversationId = null;
  state.active = false;
  state.muted = false;
  state.speaking = false;
  state.localStream = null;
  state.peers = {};
  state.error = null;
  peerConnections.clear();
  notify();
}

/* ------------------------------------------------------------------ */
/* 音量检测（说话高亮）                                                  */
/* ------------------------------------------------------------------ */

let audioContext: unknown = null;
let speakingTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 启动本地音量检测
 * 说明：语音通话没有画面，「谁在说话」是唯一的存在感反馈，
 *      必须实时同步给其他成员，否则用户不知道对方是否在听。
 */
function startSpeakingDetection(stream: MediaStreamLike): void {
  stopSpeakingDetection();

  const g = globalThis as unknown as {
    AudioContext?: new () => {
      createAnalyser: () => {
        fftSize: number;
        frequencyBinCount: number;
        getByteTimeDomainData: (arr: Uint8Array) => void;
        connect: (dest: unknown) => void;
      };
      createMediaStreamSource: (s: unknown) => { connect: (dest: unknown) => void };
      close: () => void;
    };
  };

  if (!g.AudioContext) return;

  try {
    const ctx = new g.AudioContext();
    audioContext = ctx;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;

    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);

    const buffer = new Uint8Array(analyser.frequencyBinCount);

    speakingTimer = setInterval(() => {
      analyser.getByteTimeDomainData(buffer);

      // 计算 RMS 音量：偏离 128 的幅度即音量
      let sum = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        const v = (buffer[i]! - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buffer.length);

      // 阈值 0.02：低于此视为静音，避免底噪误判
      const speaking = rms > 0.02 && !state.muted;

      if (speaking !== state.speaking) {
        state.speaking = speaking;
        notify();
        // 同步给其他成员
        if (state.callId) {
          ws.sendMediaState({ callId: state.callId, muted: state.muted, speaking });
        }
      }
    }, 300);
  } catch {
    // 无音频分析能力时跳过（不影响通话本身）
  }
}

function stopSpeakingDetection(): void {
  if (speakingTimer) {
    clearInterval(speakingTimer);
    speakingTimer = null;
  }
  const ctx = audioContext as { close?: () => void } | null;
  try {
    ctx?.close?.();
  } catch {
    // 忽略
  }
  audioContext = null;
}

/* ------------------------------------------------------------------ */
/* PeerConnection 管理                                                  */
/* ------------------------------------------------------------------ */

/**
 * 创建到某个远端用户的连接
 * @param peerId 远端用户 id
 * @param iceServers ICE 配置（含 TURN 临时凭据）
 */
function createPeer(peerId: string, iceServers: IceServerConfig[]): PeerConnectionLike | null {
  if (!rtcProvider) return null;

  const existing = peerConnections.get(peerId);
  if (existing) return existing;

  const pc = rtcProvider.createPeerConnection({ iceServers, peerId });

  // ICE 候选：逐条发给对方
  pc.onicecandidate = (event) => {
    if (!event.candidate || !state.callId) return;
    ws.sendP2pSignal({
      callId: state.callId,
      kind: 'ice',
      to: peerId,
      payload: JSON.stringify(event.candidate),
    });
  };

  // 远端音轨到达：记录流，UI 层负责播放
  pc.ontrack = (event) => {
    const stream = event.streams[0] ?? null;
    const peer = state.peers[peerId];
    if (peer) {
      peer.stream = stream;
    } else {
      state.peers[peerId] = {
        userId: peerId,
        connectionState: 'connected',
        muted: false,
        speaking: false,
        stream,
      };
    }
    notify();
  };

  // 连接状态变化：用于 UI 显示「连接中/已连接/重连中」
  pc.onconnectionstatechange = () => {
    const peer = state.peers[peerId];
    if (peer) {
      peer.connectionState = pc.connectionState;
      notify();
    }
  };

  // 把本地音轨加进去（对方才能听到我）
  if (state.localStream) {
    for (const track of state.localStream.getAudioTracks()) {
      pc.addTrack(track, state.localStream);
    }
  }

  peerConnections.set(peerId, pc);

  state.peers[peerId] = {
    userId: peerId,
    connectionState: 'new',
    muted: false,
    speaking: false,
    stream: null,
  };
  notify();

  return pc;
}

/** 主动向某成员发 offer（已在通话中的人调用） */
async function sendOffer(peerId: string, iceServers: IceServerConfig[]): Promise<void> {
  const pc = createPeer(peerId, iceServers);
  if (!pc || !state.callId) return;

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.sendP2pSignal({
      callId: state.callId,
      kind: 'offer',
      to: peerId,
      payload: JSON.stringify(offer),
    });
  } catch (e) {
    state.error = '建立通话连接失败';
    notify();
  }
}

/* ------------------------------------------------------------------ */
/* 对外操作                                                             */
/* ------------------------------------------------------------------ */

/**
 * 接听通话：获取麦克风 + 建立本地流
 * 说明：必须在用户点击「接听」后调用，
 *      浏览器要求 getUserMedia 必须由用户手势触发。
 */
export async function startLocalAudio(callId: string, conversationId: string): Promise<boolean> {
  if (!rtcProvider) {
    state.error = '当前设备不支持语音通话';
    notify();
    return false;
  }

  state.callId = callId;
  state.conversationId = conversationId;
  state.error = null;
  notify();

  try {
    const stream = await rtcProvider.getUserMedia({
      audio: CALL_AUDIO_CONSTRAINTS,
      video: false,
    });

    state.localStream = stream;
    state.active = true;
    notify();

    startSpeakingDetection(stream);
    return true;
  } catch (e) {
    const name = (e as { name?: string }).name;
    state.error =
      name === 'NotAllowedError'
        ? '麦克风权限被拒绝，请在系统设置中开启'
        : name === 'NotFoundError'
          ? '未找到麦克风设备'
          : '无法启动麦克风';
    notify();
    return false;
  }
}

/**
 * 收到 call.state 且 joinedUserId 是自己以外的人时调用
 * 规则：**已在通话中的人主动发 offer**
 */
export async function connectToNewPeer(
  peerId: string,
  iceServers: IceServerConfig[],
): Promise<void> {
  if (!state.active) return;
  if (peerConnections.has(peerId)) return;
  await sendOffer(peerId, iceServers);
}

/** 处理收到的 offer（新加入者调用） */
export async function handleOffer(params: {
  from: string;
  payload: string;
  iceServers: IceServerConfig[];
}): Promise<void> {
  const { from, payload, iceServers } = params;
  if (!state.callId) return;

  const pc = createPeer(from, iceServers);
  if (!pc) return;

  try {
    const offer = JSON.parse(payload) as unknown;
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    ws.sendP2pSignal({
      callId: state.callId,
      kind: 'answer',
      to: from,
      payload: JSON.stringify(answer),
    });
  } catch {
    state.error = '通话协商失败';
    notify();
  }
}

/** 处理收到的 answer（发 offer 的一方调用） */
export async function handleAnswer(params: { from: string; payload: string }): Promise<void> {
  const pc = peerConnections.get(params.from);
  if (!pc) return;

  try {
    const answer = JSON.parse(params.payload) as unknown;
    await pc.setRemoteDescription(answer);
  } catch {
    // 忽略，连接状态机会反映问题
  }
}

/** 处理收到的 ICE 候选 */
export async function handleIceCandidate(params: {
  from: string;
  payload: string;
}): Promise<void> {
  const pc = peerConnections.get(params.from);
  if (!pc) return;

  try {
    const candidate = JSON.parse(params.payload) as unknown;
    await pc.addIceCandidate(candidate);
  } catch {
    // 候选可能早于 remoteDescription 到达，忽略即可（ICE 会重传）
  }
}

/** 静音 / 取消静音 */
export function setMuted(muted: boolean): void {
  state.muted = muted;

  // 关闭本地轨道发送（比调 volume 更省流量）
  if (state.localStream) {
    for (const track of state.localStream.getAudioTracks()) {
      track.enabled = !muted;
    }
  }

  notify();

  if (state.callId) {
    ws.sendMediaState({ callId: state.callId, muted, speaking: false });
  }
}

/** 更新远端成员静音/说话状态（收到 WS 通知时调用） */
export function updatePeerMediaState(params: {
  userId: string;
  muted: boolean;
  speaking: boolean;
}): void {
  const peer = state.peers[params.userId];
  if (!peer) return;
  peer.muted = params.muted;
  peer.speaking = params.speaking;
  notify();
}

/** 移除远端成员（对方离开） */
export function removePeer(peerId: string): void {
  const pc = peerConnections.get(peerId);
  if (pc) {
    try {
      pc.close();
    } catch {
      // 忽略
    }
    peerConnections.delete(peerId);
  }
  delete state.peers[peerId];
  notify();
}

/** 结束通话：释放所有资源 */
export function stopCall(): void {
  stopSpeakingDetection();

  // 停止本地音轨（必须显式 stop，否则麦克风指示灯不灭）
  if (state.localStream) {
    for (const track of state.localStream.getTracks()) {
      try {
        track.stop();
      } catch {
        // 忽略
      }
    }
  }

  // 关闭所有 PeerConnection
  for (const pc of peerConnections.values()) {
    try {
      pc.close();
    } catch {
      // 忽略
    }
  }

  resetState();
}

/* ------------------------------------------------------------------ */
/* 浏览器实现注册（Web / Electron 启动时调用）                            */
/* ------------------------------------------------------------------ */

/**
 * 注册浏览器原生 WebRTC 实现
 * 说明：Lynx for Web 与 Electron 都运行在 Chromium 中，
 *      直接使用标准 RTCPeerConnection 即可，无需原生模块。
 */
export function registerWebRtc(): boolean {
  const g = globalThis as unknown as {
    RTCPeerConnection?: new (config: unknown) => PeerConnectionLike;
    navigator?: { mediaDevices?: { getUserMedia: (c: unknown) => Promise<MediaStreamLike> } };
  };

  if (!g.RTCPeerConnection || !g.navigator?.mediaDevices) return false;

  registerRtcProvider({
    getUserMedia: (constraints) => g.navigator!.mediaDevices!.getUserMedia(constraints),
    createPeerConnection: (config) => new g.RTCPeerConnection!(config),
  });
  return true;
}

/* ------------------------------------------------------------------ */
/* 原生桥接实现注册（Android / iOS / HarmonyOS 启动时调用）                 */
/* ------------------------------------------------------------------ */

/**
 * 注册原生通话桥（ChatRtc）
 * ============================================================
 * 为什么必须有它：
 * Lynx 原生端没有 RTCPeerConnection（globalThis 里没有），
 * registerWebRtc() 在真机上永远返回 false，
 * rtcProvider 恒为 null → 接听直接报「当前设备不支持语音通话」。
 * 原生 ChatRtcModule 把麦克风 + PeerConnection 桥出来，
 * 这里包一层实现 RtcProvider，上层通话逻辑零改动。
 *
 * 事件映射：
 *   原生全局事件 'chatRtc'：
 *     {event:'ice', peerId, sdp, sdpMLineIndex, sdpMid}
 *     {event:'conn', peerId, state}
 *   翻译成 PeerConnectionLike 的 onicecandidate / ontrack /
 *   onconnectionstatechange 三个回调，与浏览器语义对齐。
 *
 * 参数约定（与 ChatMedia 同哲学）：
 *   复杂结构走 JSON 字符串，回调回 {ok:true,...} 对象。
 */
interface ChatRtcNative {
  ensureAudio?: (cb: (r: unknown) => void) => void;
  createPeer?: (peerId: string, iceJson: string, cb: (r: unknown) => void) => void;
  createOffer?: (peerId: string, cb: (r: unknown) => void) => void;
  setLocal?: (peerId: string, descJson: string, cb: (r: unknown) => void) => void;
  setRemote?: (peerId: string, descJson: string, cb: (r: unknown) => void) => void;
  createAnswer?: (peerId: string, cb: (r: unknown) => void) => void;
  addIce?: (peerId: string, candJson: string, cb: (r: unknown) => void) => void;
  setMuted?: (muted: boolean, cb: (r: unknown) => void) => void;
  disposePeer?: (peerId: string, cb: (r: unknown) => void) => void;
  disposeAll?: (cb: (r: unknown) => void) => void;
}

interface NativePeerEntry {
  onicecandidate: ((e: { candidate: unknown | null }) => void) | null;
  ontrack: ((e: { streams: MediaStreamLike[] }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  connectionState: string;
}

/** peerId → 该连接的事件回调（建连时注册，挂断时注销） */
const nativePeerHandlers = new Map<string, NativePeerEntry>();

let nativeRtcSubscribed = false;

function normalizeRtcResult(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { ok: false, message: '原生返回格式异常' };
    }
  }
  return (raw ?? {}) as Record<string, unknown>;
}

/** 原生调用转 Promise（8 秒兜底，避免无限挂起） */
function callRtc<T = Record<string, unknown>>(
  mod: ChatRtcNative,
  method: keyof ChatRtcNative,
  args: unknown[],
): Promise<T> {
  const fn = mod[method] as ((...a: unknown[]) => void) | undefined;
  if (typeof fn !== 'function') {
    return Promise.reject(new Error('当前版本不支持语音通话，请更新 App'));
  }
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('通话组件响应超时，请重试'));
    }, 8000);
    try {
      fn(...args, (raw: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const r = normalizeRtcResult(raw);
        if (r['ok'] === true) resolve(r as unknown as T);
        else reject(new Error(typeof r['message'] === 'string' ? r['message'] : '通话操作失败'));
      });
    } catch (e) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error('通话操作失败'));
    }
  });
}

/** 订阅原生 'chatRtc' 全局事件（模块级单例） */
function ensureNativeRtcSubscribed(): void {
  if (nativeRtcSubscribed) return;
  const emitter = getGlobalEventEmitter();
  if (!emitter) return;
  nativeRtcSubscribed = true;
  try {
    emitter.addListener('chatRtc', (...args: unknown[]) => {
      const p = args[0] as Record<string, unknown> | undefined;
      if (!p) return;
      const peerId = typeof p['peerId'] === 'string' ? (p['peerId'] as string) : '';
      const h = nativePeerHandlers.get(peerId);
      if (!h) return;
      if (p['event'] === 'ice') {
        h.onicecandidate?.({
          candidate: { sdp: p['sdp'], sdpMLineIndex: p['sdpMLineIndex'], sdpMid: p['sdpMid'] },
        });
      } else if (p['event'] === 'conn') {
        const st = typeof p['state'] === 'string' ? (p['state'] as string) : '';
        // 'track' 表示远端音频到达，等价于已连接（原生音频自动播放）
        h.connectionState = st === 'track' ? 'connected' : st;
        h.onconnectionstatechange?.();
        if (st === 'track') h.ontrack?.({ streams: [] });
      }
    });
  } catch {
    nativeRtcSubscribed = false;
  }
}

/**
 * 注册原生通话实现
 * @returns true=已接管（Android/iOS/鸿蒙），false=本端没有 ChatRtc（走浏览器兜底）
 */
export function registerNativeRtc(): boolean {
  let mod: ChatRtcNative | null = null;
  try {
    mod = getNativeModule<ChatRtcNative>('ChatRtc');
  } catch {
    mod = null;
  }
  if (!mod?.ensureAudio) return false;
  ensureNativeRtcSubscribed();
  const m = mod;

  registerRtcProvider({
    getUserMedia: async () => {
      await callRtc(m, 'ensureAudio', []);
      // 原生音频轨道没有 JS 可操作的 MediaStream，返回等价占位。
      // engine.ts 的 setMuted() 会写 track.enabled，这里用访问器
      // 透传给原生；stop() 释放整通电话的原生资源。
      let mutedState = false;
      const track: MediaStreamTrackLike = {
        get enabled() {
          return !mutedState;
        },
        set enabled(v: boolean) {
          mutedState = !v;
          m.setMuted?.(!v, () => undefined);
        },
        stop: () => {
          m.disposeAll?.(() => undefined);
        },
      };
      const stream: MediaStreamLike = {
        getAudioTracks: () => [track],
        getTracks: () => [track],
      };
      return stream;
    },
    createPeerConnection: (config) => {
      const cfg = config as { iceServers?: unknown; peerId?: string };
      const peerId =
        typeof cfg.peerId === 'string' && cfg.peerId.length > 0
          ? cfg.peerId
          : `peer-${Date.now().toString(36)}`;
      const iceJson = JSON.stringify({ iceServers: cfg.iceServers ?? [] });
      // 原生建连是异步的，但底层是单线程串行队列，
      // 后续的 offer/answer/set/add 操作一定排在 create 之后执行，
      // 所以这里不需要等 create 完成。
      // 失败只记录：上层 offer 失败会走 error 提示。
      void callRtc(m, 'createPeer', [peerId, iceJson]).catch(() => undefined);

      const entry: NativePeerEntry = {
        onicecandidate: null,
        ontrack: null,
        onconnectionstatechange: null,
        connectionState: 'new',
      };
      nativePeerHandlers.set(peerId, entry);

      const pc: PeerConnectionLike = {
        get connectionState() {
          return entry.connectionState;
        },
        set connectionState(_v: string) {
          // 只读：状态由原生事件驱动
        },
        get onicecandidate() {
          return entry.onicecandidate;
        },
        set onicecandidate(v) {
          entry.onicecandidate = v;
        },
        get ontrack() {
          return entry.ontrack;
        },
        set ontrack(v) {
          entry.ontrack = v;
        },
        get onconnectionstatechange() {
          return entry.onconnectionstatechange;
        },
        set onconnectionstatechange(v) {
          entry.onconnectionstatechange = v;
        },
        createOffer: async () => {
          const r = await callRtc<{ type: string; sdp: string }>(m, 'createOffer', [peerId]);
          return { type: r.type, sdp: r.sdp };
        },
        createAnswer: async () => {
          const r = await callRtc<{ type: string; sdp: string }>(m, 'createAnswer', [peerId]);
          return { type: r.type, sdp: r.sdp };
        },
        setLocalDescription: async (desc: unknown) => {
          const d = desc as { type: string; sdp: string };
          await callRtc(m, 'setLocal', [peerId, JSON.stringify({ type: d.type, sdp: d.sdp })]);
        },
        setRemoteDescription: async (desc: unknown) => {
          const d = desc as { type: string; sdp: string };
          await callRtc(m, 'setRemote', [peerId, JSON.stringify({ type: d.type, sdp: d.sdp })]);
        },
        addIceCandidate: async (candidate: unknown) => {
          const c = candidate as { sdp?: string; sdpMLineIndex?: number; sdpMid?: string };
          await callRtc(m, 'addIce', [peerId, JSON.stringify(c)]);
        },
        addTrack: () => {
          // 原生在 createPeer 时已把本地轨道加进连接，无需重复添加
          return {};
        },
        close: () => {
          nativePeerHandlers.delete(peerId);
          m.disposePeer?.(peerId, () => undefined);
        },
      };
      return pc;
    },
  });
  return true;
}

/** 当前用户 id（供 UI 区分「自己」与「他人」） */
export { currentUserId };
