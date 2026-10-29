/**
 * ============================================================
 * WebSocket 协议定义
 * ------------------------------------------------------------
 * 为什么单独定义 WS 协议：
 * 1. 聊天是长连接场景，HTTP 只负责「拉历史/发消息」，
 *    推送（新消息、已读、输入中、在线状态、通话信令）全部走 WS；
 * 2. 服务端与 Lynx 客户端必须使用同一份消息形状，否则线上排查极难；
 * 3. 用可辨识联合（discriminated union）让 TS 在 switch 时自动收窄类型。
 * ============================================================
 */

import type { CallMode, CallStatus, MessageType } from './constants.js';
import type { Message, MessagePreview, UserPublic } from './types.js';

/* ------------------------------------------------------------------ */
/* 客户端 → 服务端                                                      */
/* ------------------------------------------------------------------ */

/** 连接建立后的第一条消息：用 access token 完成鉴权 */
export interface WsAuthMessage {
  type: 'auth';
  token: string;
  /** 客户端平台，用于在线状态与推送决策 */
  platform: string;
  /** 设备标识，用于多端在线管理 */
  deviceId: string;
}

/** 心跳：客户端每 25s 发一次，服务端 60s 收不到即判定掉线 */
export interface WsPingMessage {
  type: 'ping';
  /** 客户端时间戳，服务端原样回传，用于计算 RTT */
  ts: number;
}

/** 订阅会话：进入聊天页时订阅，离开时退订，减少无关推送 */
export interface WsSubscribeMessage {
  type: 'subscribe';
  conversationIds: string[];
}

/** 退订会话 */
export interface WsUnsubscribeMessage {
  type: 'unsubscribe';
  conversationIds: string[];
}

/** 输入中提示（不落库，纯内存转发，节流由客户端负责） */
export interface WsTypingMessage {
  type: 'typing';
  conversationId: string;
}

/** 已读回执：把会话内已读位置推进到 seq */
export interface WsReadMessage {
  type: 'read';
  conversationId: string;
  seq: number;
}

/* ---------- 通话信令（与 SFU 交互） ---------- */

/** 发起通话 */
export interface WsCallInviteMessage {
  type: 'call.invite';
  conversationId: string;
  mode: CallMode;
  /** 被邀请者；群聊时为空表示邀请全部成员 */
  inviteeIds?: string[];
}

/** 接听 */
export interface WsCallAcceptMessage {
  type: 'call.accept';
  callId: string;
}

/** 拒接 */
export interface WsCallRejectMessage {
  type: 'call.reject';
  callId: string;
}

/** 挂断 */
export interface WsCallHangupMessage {
  type: 'call.hangup';
  callId: string;
}

/**
 * P2P 媒体协商（语音通话核心）
 * ------------------------------------------------------------
 * 为什么用 P2P Mesh 而不是 SFU：
 * 1. 语音单路仅 ~40kbps，8 人时每端上行约 280kbps，普通 4G 完全够用；
 * 2. 服务器只转发 JSON 信令，**零媒体转发**，现有 2C1.8G 无需升级；
 * 3. 无需部署 mediasoup/LiveKit，运维复杂度与内存占用都大幅下降。
 *
 * 工作流程（以 A 邀请 B 为例）：
 *   A: call.invite          → 服务器创建通话，向 B 推 call.incoming
 *   B: call.accept          → 服务器推 call.state(active)，并通知 A「B 已加入」
 *   A: call.p2p(offer)      → 服务器转发给 B
 *   B: call.p2p(answer)     → 服务器转发给 A
 *   双方: call.p2p(ice)     → 服务器转发，直到 ICE 连通
 *   媒体流：A ⟷ B 直连（coturn 兜底中转）
 */
export interface WsCallP2pMessage {
  type: 'call.p2p';
  callId: string;
  /**
   * 信令类型
   * - offer/answer：SDP 交换
   * - ice：ICE 候选
   * - renegotiate：重新协商（静音切换、新增成员时）
   */
  kind: 'offer' | 'answer' | 'ice' | 'renegotiate';
  /** 目标用户 id；Mesh 中每个 Peer 单独一条连接，必须指明目标 */
  to: string;
  /** SDP 或 ICE 候选，客户端原样透传 */
  payload: string;
}

/**
 * 媒体状态同步（静音/说话中）
 * 说明：语音通话没有视频画面，参与者状态（是否静音、谁在说话）
 *      是唯一能体现「对方存在」的信息，必须实时同步。
 */
export interface WsCallMediaStateMessage {
  type: 'call.media-state';
  callId: string;
  /** 麦克风是否静音 */
  muted: boolean;
  /** 是否正在说话（客户端用音量检测，用于高亮头像边框） */
  speaking: boolean;
}

export type WsClientMessage =
  | WsAuthMessage
  | WsPingMessage
  | WsSubscribeMessage
  | WsUnsubscribeMessage
  | WsTypingMessage
  | WsReadMessage
  | WsCallInviteMessage
  | WsCallAcceptMessage
  | WsCallRejectMessage
  | WsCallHangupMessage
  | WsCallP2pMessage
  | WsCallMediaStateMessage;

/* ------------------------------------------------------------------ */
/* 服务端 → 客户端                                                      */
/* ------------------------------------------------------------------ */

/** 鉴权成功 */
export interface WsReadyMessage {
  type: 'ready';
  userId: string;
  /** 服务端当前时间，客户端据此校准时钟偏差 */
  serverTime: number;
  /** 该用户所有在线设备数 */
  onlineDevices: number;
}

/** 心跳回应 */
export interface WsPongMessage {
  type: 'pong';
  /** 原样回传客户端时间戳 */
  ts: number;
  serverTime: number;
}

/** 新消息推送 */
export interface WsMessageNewMessage {
  type: 'message.new';
  conversationId: string;
  message: Message;
}

/** 消息更新（编辑/撤回） */
export interface WsMessageUpdatedMessage {
  type: 'message.updated';
  conversationId: string;
  message: Message;
}

/** 消息删除 */
export interface WsMessageDeletedMessage {
  type: 'message.deleted';
  conversationId: string;
  messageId: string;
  /** 会话内序号，客户端据此移除 */
  seq: number;
}

/** 已读状态推进 */
export interface WsReadUpdatedMessage {
  type: 'read.updated';
  conversationId: string;
  userId: string;
  seq: number;
}

/** 对方正在输入 */
export interface WsTypingNotifyMessage {
  type: 'typing';
  conversationId: string;
  userId: string;
  nickname: string;
}

/** 在线状态变化 */
export interface WsPresenceMessage {
  type: 'presence';
  userId: string;
  online: boolean;
  lastSeenAt: number | null;
}

/** 新会话（别人拉我进群 / 有人首次私聊我） */
export interface WsConversationNewMessage {
  type: 'conversation.new';
  conversationId: string;
}

/** 会话摘要变化（新消息、成员变动），客户端据此刷新列表项 */
export interface WsConversationUpdatedMessage {
  type: 'conversation.updated';
  conversationId: string;
  lastMessage: MessagePreview | null;
  lastMessageAt: number | null;
  unreadCount: number;
}

/* ---------- 通话事件 ---------- */

/** 来电振铃（被邀请者收到） */
export interface WsCallIncomingMessage {
  type: 'call.incoming';
  callId: string;
  conversationId: string;
  mode: CallMode;
  /** 发起者信息，用于来电界面展示 */
  caller: Pick<UserPublic, 'id' | 'nickname' | 'avatarUrl'>;
  /** 群聊时带上会话标题 */
  conversationTitle: string;
  /** 过期时间戳：超时未接自动取消 */
  expiresAt: number;
}

/** 通话状态变化（所有人收到） */
export interface WsCallStateMessage {
  type: 'call.state';
  callId: string;
  status: CallStatus;
  /** 当前参与者列表 */
  participantIds: string[];
  /** 新加入的成员，客户端据此主动向其发起 offer（Mesh 拓扑维护） */
  joinedUserId?: string;
  /** 离开的成员，客户端应关闭对应 PeerConnection */
  leftUserId?: string;
  /** 结束原因 */
  reason?: 'hangup' | 'reject' | 'timeout' | 'busy' | 'error';
}

/**
 * 服务端转发的 P2P 信令
 * 说明：服务端不解析 SDP/ICE 内容，只按 to 字段路由，
 *      这样服务端保持无状态，媒体完全在端之间传输。
 */
export interface WsCallP2pRelayMessage {
  type: 'call.p2p';
  callId: string;
  kind: 'offer' | 'answer' | 'ice' | 'renegotiate';
  /** 发送者 id，客户端据此关联到具体 Peer */
  from: string;
  /** SDP 或 ICE 候选 */
  payload: string;
}

/** 成员静音/说话状态广播 */
export interface WsCallMediaStateNotifyMessage {
  type: 'call.media-state';
  callId: string;
  userId: string;
  muted: boolean;
  speaking: boolean;
}

/** 通用错误 */
export interface WsErrorMessage {
  type: 'error';
  code: number;
  message: string;
  /** 如果是某个请求失败，带回请求标识 */
  requestId?: string;
}

export type WsServerMessage =
  | WsReadyMessage
  | WsPongMessage
  | WsMessageNewMessage
  | WsMessageUpdatedMessage
  | WsMessageDeletedMessage
  | WsReadUpdatedMessage
  | WsTypingNotifyMessage
  | WsPresenceMessage
  | WsConversationNewMessage
  | WsConversationUpdatedMessage
  | WsCallIncomingMessage
  | WsCallStateMessage
  | WsCallP2pRelayMessage
  | WsCallMediaStateNotifyMessage
  | WsErrorMessage;

/** WS 关闭码：客户端据此决定是否重连、是否刷新 token */
export const WsCloseCode = {
  /** 正常关闭 */
  NORMAL: 1000,
  /** 鉴权失败，需要重新登录 */
  AUTH_FAILED: 4001,
  /** access token 过期，需要用 refresh token 换新后重连 */
  TOKEN_EXPIRED: 4002,
  /** 同一设备重复登录被踢下线 */
  KICKED: 4003,
  /** 服务端重启，客户端应退避重连 */
  SERVER_RESTART: 4004,
  /** 心跳超时 */
  IDLE_TIMEOUT: 4005,
} as const;

export type WsCloseCodeValue = (typeof WsCloseCode)[keyof typeof WsCloseCode];

/** 消息类型 → 列表摘要文案（服务端与客户端共用，保证一致） */
export function messageSummary(type: MessageType, text: string | null, durationMs?: number | null): string {
  switch (type) {
    case 'text':
      return (text ?? '').slice(0, 80);
    case 'image':
      return '[图片]';
    case 'video':
      return '[视频]';
    case 'audio': {
      const sec = durationMs ? Math.max(1, Math.round(durationMs / 1000)) : 0;
      return sec > 0 ? `[语音] ${sec}″` : '[语音]';
    }
    case 'file':
      return '[文件]';
    case 'system':
      return text ?? '';
    case 'call':
      return text ?? '[通话]';
    default:
      return '[消息]';
  }
}
