/**
 * ============================================================
 * 请求参数校验（zod）
 * ------------------------------------------------------------
 * 为什么把校验放在 shared：
 * 1. 服务端用它做入参校验（防止脏数据入库）；
 * 2. Lynx 客户端用它做提交前预校验（即时提示，减少一次网络往返）；
 * 3. 同一份规则，不会出现「前端允许 8 位、后端要求 10 位」的错位。
 * ============================================================
 */

import { z } from 'zod';
import {
  EMAIL_CODE_PURPOSES,
  INVITE_CODE_LENGTH,
  NICKNAME_MAX_LENGTH,
  NICKNAME_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PLATFORMS,
} from './constants.js';

/** 邮箱：只做基础格式校验，最终以「能否收到验证码」为准 */
export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .email('邮箱格式不正确')
  .transform((v) => v.toLowerCase());

/** 密码：长度优先（argon2 下长度比复杂度更有效），禁止首尾空格 */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `密码至少 ${PASSWORD_MIN_LENGTH} 位`)
  .max(PASSWORD_MAX_LENGTH, `密码最多 ${PASSWORD_MAX_LENGTH} 位`)
  .refine((v) => v === v.trim(), '密码首尾不能有空格');

/** 昵称：1-24 字，禁止控制字符 */
export const nicknameSchema = z
  .string()
  .trim()
  .min(NICKNAME_MIN_LENGTH, '请输入昵称')
  .max(NICKNAME_MAX_LENGTH, `昵称最多 ${NICKNAME_MAX_LENGTH} 字`)
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), '昵称包含非法字符');

/** 6 位数字验证码 */
export const emailCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, '验证码为 6 位数字');

/** 邀请码：大写字母 + 数字，长度固定，排除易混淆字符 */
export const inviteCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(INVITE_CODE_LENGTH, '邀请码格式不正确')
  .regex(/^[A-Z0-9]+$/, '邀请码格式不正确');

/** 平台标识 */
export const platformSchema = z.enum(PLATFORMS);

/* ------------------------------------------------------------------ */
/* 各接口的请求体                                                       */
/* ------------------------------------------------------------------ */

export const sendEmailCodeSchema = z.object({
  email: emailSchema,
  purpose: z.enum(EMAIL_CODE_PURPOSES),
});

export const registerSchema = z.object({
  email: emailSchema,
  code: emailCodeSchema,
  password: passwordSchema,
  nickname: nicknameSchema,
  inviteCode: inviteCodeSchema,
  platform: platformSchema,
  deviceName: z.string().trim().max(64).optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  platform: platformSchema,
  deviceName: z.string().trim().max(64).optional(),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(20),
  platform: platformSchema,
});

export const resetPasswordSchema = z.object({
  email: emailSchema,
  code: emailCodeSchema,
  newPassword: passwordSchema,
});

/** 更新个人资料 */
export const updateProfileSchema = z.object({
  nickname: nicknameSchema.optional(),
  bio: z.string().trim().max(120).nullish(),
  avatarAttachmentId: z.string().nullish(),
});

/* ------------------------------------------------------------------ */
/* 会话                                                                 */
/* ------------------------------------------------------------------ */

export const createDirectSchema = z.object({
  peerId: z.string().min(1),
});

export const createGroupSchema = z.object({
  title: z.string().trim().min(1, '请输入群名称').max(40, '群名称最多 40 字'),
  memberIds: z.array(z.string().min(1)).max(200).default([]),
});

export const conversationIdSchema = z.object({
  conversationId: z.string().min(1),
});

export const updateMemberSchema = z.object({
  userId: z.string().min(1),
  /** 设为管理员 / 移出群聊 */
  action: z.enum(['promote', 'demote', 'remove']),
});

/* ------------------------------------------------------------------ */
/* 消息                                                                 */
/* ------------------------------------------------------------------ */

export const sendMessageSchema = z
  .object({
    /**
     * 客户端生成的幂等 id，用于去重
     * 上限 64：给各端留足空间（iOS/鸿蒙可能拼更长前缀），
     * 只要保证唯一即可，长度本身不是安全边界。
     */
    clientId: z.string().min(8).max(64),
    type: z.enum(['text', 'image', 'video', 'audio', 'file', 'system', 'call']),
    text: z.string().max(8000, '消息最多 8000 字').optional(),
    attachmentIds: z.array(z.string().min(1)).max(10).optional(),
    replyToId: z.string().min(1).optional(),
  })
  .refine(
    (v) => {
      // 文本消息必须有内容；媒体消息必须有附件
      if (v.type === 'text') return !!v.text && v.text.trim().length > 0;
      if (v.type === 'system' || v.type === 'call') return true;
      return !!v.attachmentIds && v.attachmentIds.length > 0;
    },
    { message: '消息内容不能为空', path: ['text'] },
  );

export const messagePageSchema = z.object({
  /** 游标：上一页最后一条消息的 seq；不传表示最新一页 */
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/* ------------------------------------------------------------------ */
/* 邀请                                                                 */
/* ------------------------------------------------------------------ */

export const createInviteSchema = z.object({
  /** 每个邀请码可用次数，默认 1 */
  maxUses: z.number().int().min(1).max(50).default(1),
  /** 有效期天数；不传表示永久 */
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

/* ------------------------------------------------------------------ */
/* 推送令牌                                                             */
/* ------------------------------------------------------------------ */

export const registerPushSchema = z.object({
  platform: platformSchema,
  deviceId: z.string().min(1).max(128),
  /** 厂商推送 token / APNs token / Harmony push token */
  token: z.string().min(1).max(512),
  /** 厂商标识：hms / xiaomi / oppo / vivo / apns / harmony */
  provider: z.enum(['hms', 'xiaomi', 'oppo', 'vivo', 'apns', 'harmony']),
  appVersion: z.string().max(32).optional(),
});

/* ------------------------------------------------------------------ */
/* 通话                                                                 */
/* ------------------------------------------------------------------ */

export const callInviteSchema = z.object({
  conversationId: z.string().min(1),
  mode: z.enum(['audio', 'video']),
  inviteeIds: z.array(z.string().min(1)).optional(),
});

/** 类型导出：服务端路由直接复用 */
export type SendEmailCodeInput = z.infer<typeof sendEmailCodeSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type CreateInviteInput = z.infer<typeof createInviteSchema>;
export type RegisterPushInput = z.infer<typeof registerPushSchema>;
export type CallInviteInput = z.infer<typeof callInviteSchema>;
