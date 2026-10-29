/**
 * ============================================================
 * 业务枚举与常量
 * ------------------------------------------------------------
 * 为什么单独抽出来：
 * 1. 数据库存的是数字/短字符串，前端要显示中文，两端必须用同一份映射；
 * 2. 新增消息类型时只改这里，编译期就能发现哪些 switch 没覆盖；
 * 3. 避免前后端各写一套字符串常量导致拼写不一致（历史项目的真实痛点）。
 * ============================================================
 */

/** 消息类型：决定客户端用哪种气泡渲染 */
export const MESSAGE_TYPES = [
  'text',   // 纯文本
  'image',  // 图片（含缩略图）
  'video',  // 视频（含封面与时长）
  'audio',  // 语音条（含波形与时长）
  'file',   // 普通文件
  'system', // 系统提示（入群、改名等），居中灰字
  'call',   // 通话记录（未接/已接/时长）
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** 会话类型：1:1 私聊 或 群聊 */
export const CONVERSATION_TYPES = ['direct', 'group'] as const;
export type ConversationType = (typeof CONVERSATION_TYPES)[number];

/** 成员角色：群主可解散/踢人，管理员可踢人，普通成员只能发言 */
export const MEMBER_ROLES = ['owner', 'admin', 'member'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** 附件类型：与消息类型解耦，因为一条消息可带多个附件 */
export const ATTACHMENT_KINDS = ['image', 'video', 'audio', 'file'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/**
 * 客户端平台标识
 * 用途：1) 刷新令牌记录设备；2) 推送通道选择；3) 通话能力降级判断
 */
export const PLATFORMS = ['android', 'ios', 'harmony', 'windows', 'macos', 'web'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** 邮件验证码用途：注册 / 重置密码 / 换绑邮箱 */
export const EMAIL_CODE_PURPOSES = ['register', 'reset', 'rebind'] as const;
export type EmailCodePurpose = (typeof EMAIL_CODE_PURPOSES)[number];

/** 通话模式：语音 / 视频 */
export const CALL_MODES = ['audio', 'video'] as const;
export type CallMode = (typeof CALL_MODES)[number];

/** 通话状态机：ringing → active → ended；未接/拒接为终态 */
export const CALL_STATUSES = ['ringing', 'active', 'ended', 'missed', 'rejected'] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* 业务规则常量（前后端共用，避免前端写死导致与服务端不一致）              */
/* ------------------------------------------------------------------ */

/** 验证码有效期（分钟） */
export const EMAIL_CODE_TTL_MINUTES = 10;
/** 同一邮箱发送验证码的最小间隔（秒） */
export const EMAIL_CODE_COOLDOWN_SECONDS = 60;
/** 同一邮箱每日最多发送次数 */
export const EMAIL_CODE_DAILY_LIMIT = 10;
/** 验证码最大尝试次数，超过即作废（防暴力枚举） */
export const EMAIL_CODE_MAX_ATTEMPTS = 5;

/** 单文件最大字节数：200MB */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
/** 图片压缩后最大边长（客户端压缩用） */
export const IMAGE_MAX_EDGE = 1920;
/** 语音消息最长时长（毫秒）：5 分钟 */
export const AUDIO_MAX_DURATION_MS = 5 * 60 * 1000;
/** 视频消息最长时长（毫秒）：5 分钟 */
export const VIDEO_MAX_DURATION_MS = 5 * 60 * 1000;

/** 新用户默认可邀请人数（邀请码机制的核心配额） */
export const DEFAULT_INVITE_QUOTA = 5;
/** 群聊默认最大成员数（2C 服务器保护性限制） */
export const GROUP_MAX_MEMBERS = 200;

/**
 * 语音通话最大人数（P2P Mesh 全网状）
 * ------------------------------------------------------------
 * 为什么是 8 人：
 * 每路 Opus 语音约 40kbps，8 人时每端上行 7×40≈280kbps、下行同样 280kbps，
 * 普通 4G/家庭宽带都能承载；超过 8 条 PeerConnection 后移动端 CPU 与耗电明显上升，
 * 且上行带宽成为瓶颈。超过此人数需要 SFU（视频阶段再引入）。
 */
export const CALL_MESH_MAX_PARTICIPANTS = 8;

/**
 * 语音通话音频参数
 * 说明：单声道 + 48kHz 是 Opus 的原生采样率，避免重采样开销；
 *      DTX（不连续传输）与 FEC（前向纠错）能显著降低弱网丢包影响。
 */
export const CALL_AUDIO_CONSTRAINTS = {
  /** 回声消除，必须开启，否则免提时对方会听到自己的声音 */
  echoCancellation: true,
  /** 噪声抑制，过滤键盘声与风扇声 */
  noiseSuppression: true,
  /** 自动增益，避免说话声音忽大忽小 */
  autoGainControl: true,
  /** 单声道：语音无需立体声，省一半带宽 */
  channelCount: 1,
  /** 48kHz：Opus 原生采样率 */
  sampleRate: 48_000,
} as const;

/** 消息分页默认条数 */
export const MESSAGE_PAGE_SIZE = 30;
/** 消息分页上限 */
export const MESSAGE_PAGE_SIZE_MAX = 100;

/** 访问令牌有效期（秒）：15 分钟，短有效期降低泄露风险 */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
/** 刷新令牌有效期（秒）：30 天，可主动吊销 */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** WebSocket 心跳间隔（毫秒）：25s，比多数 NAT 超时短 */
export const WS_HEARTBEAT_INTERVAL_MS = 25_000;
/** WebSocket 判定掉线的静默时长（毫秒）：60s 无心跳即断开 */
export const WS_IDLE_TIMEOUT_MS = 60_000;

/** 昵称长度限制 */
export const NICKNAME_MIN_LENGTH = 1;
export const NICKNAME_MAX_LENGTH = 24;
/** 密码长度限制（服务端用 argon2 哈希，长度比复杂度更有效） */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;
/** 邀请码长度 */
export const INVITE_CODE_LENGTH = 8;
