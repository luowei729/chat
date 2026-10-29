/**
 * ============================================================
 * API 契约类型（DTO）
 * ------------------------------------------------------------
 * 为什么所有接口都手写 DTO 而不用 ORM 模型直出：
 * 1. 数据库字段会演进（比如以后加软删除标记），但接口契约要保持稳定；
 * 2. 防止把 password_hash 这类敏感字段误传给客户端；
 * 3. 前端可以完全不关心数据库结构，只依赖这里的形状。
 * ============================================================
 */

import type {
  AttachmentKind,
  CallMode,
  CallStatus,
  ConversationType,
  MemberRole,
  MessageType,
  Platform,
} from './constants.js';

/* ------------------------------------------------------------------ */
/* 通用响应包装                                                         */
/* ------------------------------------------------------------------ */

/**
 * 统一响应结构
 * 说明：HTTP 状态码 + 业务码分离。HTTP 层表达传输结果，
 *      code 表达业务结果（0 = 成功），前端只需判断 code。
 */
export interface ApiOk<T> {
  code: 0;
  data: T;
  /** 服务端时间戳（毫秒），客户端用于校准本地时钟偏差 */
  serverTime: number;
}

export interface ApiErr {
  code: number;
  message: string;
  /** 字段级错误，用于表单逐项高亮 */
  fields?: Record<string, string>;
  serverTime: number;
}

export type ApiResponse<T> = ApiOk<T> | ApiErr;

/** 游标分页返回结构：统一用 id 游标，避免 offset 分页在插入时的漂移 */
export interface Page<T> {
  items: T[];
  /** 下一页游标；null 表示没有更多 */
  nextCursor: string | null;
  hasMore: boolean;
}

/* ------------------------------------------------------------------ */
/* 用户                                                                 */
/* ------------------------------------------------------------------ */

export interface UserPublic {
  id: string;
  /** 脱敏后的邮箱，例如 ab***@gmail.com；本人可见完整邮箱 */
  email: string;
  nickname: string;
  avatarUrl: string | null;
  /** 个性签名 */
  bio: string | null;
  /** 最近在线时间（毫秒时间戳），用于「最后上线」展示 */
  lastSeenAt: number | null;
  createdAt: number;
}

/** 登录/刷新令牌后返回的完整身份信息 */
export interface AuthUser extends UserPublic {
  /** 本人可见完整邮箱 */
  emailFull: string;
  /** 剩余可邀请名额 */
  inviteQuota: number;
  /** 邮箱是否已验证（注册流程强制验证，此处用于兜底提示） */
  emailVerified: boolean;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** 访问令牌过期时间（毫秒时间戳），客户端提前 60s 刷新 */
  accessTokenExpiresAt: number;
}

export interface AuthResult extends AuthTokens {
  user: AuthUser;
}

/* ------------------------------------------------------------------ */
/* 认证请求体                                                           */
/* ------------------------------------------------------------------ */

export interface SendEmailCodeRequest {
  email: string;
  purpose: 'register' | 'reset' | 'rebind';
}

export interface RegisterRequest {
  email: string;
  code: string;
  password: string;
  nickname: string;
  /** 邀请码：注册必填，用于控制增长与追溯来源 */
  inviteCode: string;
  platform: Platform;
  deviceName?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
  platform: Platform;
  deviceName?: string;
}

export interface RefreshRequest {
  refreshToken: string;
  platform: Platform;
}

export interface ResetPasswordRequest {
  email: string;
  code: string;
  newPassword: string;
}

/* ------------------------------------------------------------------ */
/* 邀请                                                                 */
/* ------------------------------------------------------------------ */

export interface InviteCodeInfo {
  id: string;
  code: string;
  /** 剩余可用次数 */
  remainingUses: number;
  /** 已使用次数 */
  usedCount: number;
  maxUses: number;
  /** 过期时间；null 表示永久有效 */
  expiresAt: number | null;
  createdAt: number;
}

export interface InviteeInfo {
  userId: string;
  nickname: string;
  avatarUrl: string | null;
  joinedAt: number;
}

export interface InviteOverview {
  /** 剩余可创建邀请码的名额 */
  quota: number;
  /** 已发出的邀请码 */
  codes: InviteCodeInfo[];
  /** 通过我邀请注册的用户 */
  invitees: InviteeInfo[];
}

/* ------------------------------------------------------------------ */
/* 会话                                                                 */
/* ------------------------------------------------------------------ */

export interface ConversationMember {
  userId: string;
  nickname: string;
  avatarUrl: string | null;
  role: MemberRole;
  /** 会话内最后已读序号，用于未读数计算 */
  lastReadSeq: number;
}

export interface ConversationSummary {
  id: string;
  type: ConversationType;
  /** 私聊时为对方昵称；群聊为群名。由服务端根据当前用户计算好，客户端不推导 */
  title: string;
  /** 私聊时为对方头像；群聊为群头像 */
  avatarUrl: string | null;
  /** 私聊时为对方 userId，群聊为 null */
  peerId: string | null;
  memberCount: number;
  lastMessage: MessagePreview | null;
  lastMessageAt: number | null;
  unreadCount: number;
  /** 是否置顶 */
  pinned: boolean;
  /** 是否免打扰 */
  muted: boolean;
  createdAt: number;
}

/** 会话列表里的消息摘要（只保留渲染一行所需字段，减小列表接口体积） */
export interface MessagePreview {
  id: string;
  type: MessageType;
  senderId: string;
  senderName: string;
  /** 已按类型截断的文本，例如「[图片]」「[语音] 12″」 */
  summary: string;
  createdAt: number;
}

export interface ConversationDetail {
  id: string;
  type: ConversationType;
  title: string;
  avatarUrl: string | null;
  ownerId: string | null;
  members: ConversationMember[];
  /** 当前用户在该会话中的角色 */
  myRole: MemberRole;
  pinned: boolean;
  muted: boolean;
  createdAt: number;
}

/* ------------------------------------------------------------------ */
/* 消息与附件                                                           */
/* ------------------------------------------------------------------ */

export interface Attachment {
  id: string;
  kind: AttachmentKind;
  filename: string;
  mime: string;
  size: number;
  /** 访问地址：服务端返回带签名的相对路径，例如 /api/media/xxx?sig=... */
  url: string;
  /** 图片/视频封面缩略图地址 */
  thumbUrl: string | null;
  width: number | null;
  height: number | null;
  /** 音视频时长（毫秒） */
  durationMs: number | null;
  /** 语音波形（0-100 的整数数组，用于气泡绘制） */
  waveform: number[] | null;
}

export interface Message {
  id: string;
  conversationId: string;
  /** 会话内递增序号，客户端用它做排序与增量拉取游标 */
  seq: number;
  senderId: string;
  senderName: string;
  senderAvatarUrl: string | null;
  type: MessageType;
  /** 文本内容；非文本类型时为 null */
  text: string | null;
  attachments: Attachment[];
  /** 引用回复的消息 id */
  replyToId: string | null;
  /** 引用回复的摘要（服务端预生成，避免客户端再查一次） */
  replyToPreview: MessagePreview | null;
  createdAt: number;
  editedAt: number | null;
  /** 本地发送状态：仅客户端使用，服务端返回的消息恒为 sent */
  localStatus?: 'sending' | 'sent' | 'failed';
  /** 客户端生成的幂等 id，用于重发去重与本地乐观更新匹配 */
  clientId?: string;
}

/* ------------------------------------------------------------------ */
/* 发送消息请求                                                         */
/* ------------------------------------------------------------------ */

export interface SendMessageRequest {
  /** 客户端生成的 ULID，服务端据此去重（网络重试不会产生重复消息） */
  clientId: string;
  type: MessageType;
  text?: string;
  /** 已上传完成的附件 id 列表 */
  attachmentIds?: string[];
  replyToId?: string;
}

/* ------------------------------------------------------------------ */
/* 媒体上传                                                             */
/* ------------------------------------------------------------------ */

export interface UploadResult {
  attachment: Attachment;
  /** 去重标记：同一 sha256 已存在时直接复用，不重复落盘 */
  deduplicated: boolean;
}

/* ------------------------------------------------------------------ */
/* 通话                                                                 */
/* ------------------------------------------------------------------ */

export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface IceConfigResponse {
  iceServers: IceServerConfig[];
  /** Mesh 模式下服务端允许的最大参与人数 */
  maxParticipants: number;
  /**
   * 是否启用 SFU（服务端媒体转发）
   * 说明：首版语音走 P2P Mesh，此值为 false；
   *      后续加视频时切到 mediasoup，客户端据此决定用哪套媒体通道。
   */
  sfuEnabled: boolean;
  /** 当前服务端支持的通话模式：首版仅 audio */
  supportedModes: CallMode[];
}

export interface CallSessionInfo {
  id: string;
  conversationId: string;
  mode: CallMode;
  status: CallStatus;
  initiatorId: string;
  participantIds: string[];
  startedAt: number;
  endedAt: number | null;
}

/* ------------------------------------------------------------------ */
/* 服务端健康检查                                                       */
/* ------------------------------------------------------------------ */

export interface HealthResponse {
  ok: boolean;
  version: string;
  uptimeSeconds: number;
  db: 'up' | 'down';
  wsClients: number;
}
