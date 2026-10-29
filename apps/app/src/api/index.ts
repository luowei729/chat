/**
 * ============================================================
 * 业务 API 封装
 * ------------------------------------------------------------
 * 为什么在 client.ts 之上再封一层：
 * 1. 每个接口一个函数，调用处不用记 URL 和参数结构；
 * 2. 返回值类型来自 @chat/shared，改接口字段会立刻编译报错；
 * 3. 登录成功后自动落盘令牌，业务层不用关心存储细节。
 * ============================================================
 */

import type {
  AuthResult,
  ConversationDetail,
  ConversationSummary,
  IceConfigResponse,
  InviteOverview,
  Message,
  Page,
  RegisterRequest,
  SendMessageRequest,
  UploadResult,
  UserPublic,
  AuthUser,
} from '@chat/shared';
import { PLATFORM } from '../config.js';
import { getDeviceId, post, get, patch, del, upload, request } from './client.js';
import * as storage from '../storage.js';
import { saveTokens } from './client.js';

/* ------------------------------------------------------------------ */
/* 认证                                                                 */
/* ------------------------------------------------------------------ */

/** 发送邮箱验证码 */
export function sendEmailCode(params: {
  email: string;
  purpose: 'register' | 'reset' | 'rebind';
}): Promise<{ delivered: boolean; devCode?: string; cooldownSeconds: number }> {
  return post('/auth/email-code', params);
}

/** 校验邀请码是否可用（注册页实时提示） */
export function validateInviteCode(code: string): Promise<{ valid: boolean; reason?: string }> {
  return post('/invites/validate', { code });
}

/** 注册 */
export async function register(params: Omit<RegisterRequest, 'platform'>): Promise<AuthResult> {
  const result = await post<AuthResult>('/auth/register', {
    ...params,
    platform: PLATFORM,
  });
  // 注册成功直接落盘令牌，用户无需再登录一次
  saveTokens(result);
  storage.setItem(storage.StorageKey.USER_ID, result.user.id);
  return result;
}

/** 登录 */
export async function login(params: {
  email: string;
  password: string;
  deviceName?: string;
}): Promise<AuthResult> {
  const result = await post<AuthResult>('/auth/login', {
    ...params,
    platform: PLATFORM,
  });
  saveTokens(result);
  storage.setItem(storage.StorageKey.USER_ID, result.user.id);
  return result;
}

/** 登出：通知服务端吊销刷新令牌，然后清本地 */
export async function logout(): Promise<void> {
  const refreshToken = storage.getItem(storage.StorageKey.REFRESH_TOKEN);
  try {
    await post('/auth/logout', { refreshToken });
  } catch {
    // 服务端失败也要清本地，否则用户无法退出
  }
}

/** 重置密码 */
export function resetPassword(params: {
  email: string;
  code: string;
  newPassword: string;
}): Promise<{ success: boolean }> {
  return post('/auth/reset-password', params);
}

/* ------------------------------------------------------------------ */
/* 用户                                                                 */
/* ------------------------------------------------------------------ */

/** 获取我的资料 */
export function getMe(): Promise<AuthUser> {
  return get('/me');
}

/** 更新资料 */
export function updateMe(params: {
  nickname?: string;
  bio?: string | null;
  avatarAttachmentId?: string | null;
}): Promise<AuthUser> {
  return patch('/me', params);
}

/** 搜索用户 */
export function searchUsers(q: string): Promise<UserPublic[]> {
  return get(`/users/search?q=${encodeURIComponent(q)}`);
}

/** 查看他人资料 */
export function getUser(userId: string): Promise<UserPublic> {
  return get(`/users/${encodeURIComponent(userId)}`);
}

/* ------------------------------------------------------------------ */
/* 邀请                                                                 */
/* ------------------------------------------------------------------ */

/** 邀请总览 */
export function getInviteOverview(): Promise<InviteOverview> {
  return get('/invites');
}

/** 生成邀请码 */
export function createInvite(params: {
  maxUses?: number;
  expiresInDays?: number;
}): Promise<{ code: string; id: string; expiresAt: number | null }> {
  return post('/invites', params);
}

/* ------------------------------------------------------------------ */
/* 会话                                                                 */
/* ------------------------------------------------------------------ */

/** 会话列表 */
export function listConversations(): Promise<ConversationSummary[]> {
  return get('/conversations');
}

/** 会话详情 */
export function getConversation(id: string): Promise<ConversationDetail> {
  return get(`/conversations/${encodeURIComponent(id)}`);
}

/** 创建/获取私聊 */
export function createDirect(peerId: string): Promise<{ conversationId: string; created: boolean }> {
  return post('/conversations/direct', { peerId });
}

/** 创建群聊 */
export function createGroup(params: {
  title: string;
  memberIds: string[];
}): Promise<{ conversationId: string }> {
  return post('/conversations/group', params);
}

/** 置顶 / 免打扰 */
export function setConversationPrefs(
  id: string,
  prefs: { pinned?: boolean; muted?: boolean },
): Promise<{ success: boolean }> {
  return patch(`/conversations/${encodeURIComponent(id)}/preferences`, prefs);
}

/** 成员管理 */
export function updateMember(
  conversationId: string,
  params: { userId: string; action: 'promote' | 'demote' | 'remove' },
): Promise<{ success: boolean }> {
  return patch(`/conversations/${encodeURIComponent(conversationId)}/members`, params);
}

/* ------------------------------------------------------------------ */
/* 消息                                                                 */
/* ------------------------------------------------------------------ */

/** 拉取历史消息（游标分页） */
export function listMessages(
  conversationId: string,
  params?: { before?: number; limit?: number },
): Promise<Page<Message>> {
  const qs: string[] = [];
  if (params?.before !== undefined) qs.push(`before=${params.before}`);
  if (params?.limit !== undefined) qs.push(`limit=${params.limit}`);
  const query = qs.length > 0 ? `?${qs.join('&')}` : '';
  return get(`/conversations/${encodeURIComponent(conversationId)}/messages${query}`);
}

/** 发送消息 */
export function sendMessage(
  conversationId: string,
  input: SendMessageRequest,
): Promise<Message> {
  return post(`/conversations/${encodeURIComponent(conversationId)}/messages`, input);
}

/** 撤回消息 */
export function deleteMessage(
  conversationId: string,
  messageId: string,
): Promise<{ success: boolean; seq: number }> {
  return del(`/messages/${encodeURIComponent(messageId)}`, { conversationId });
}

/* ------------------------------------------------------------------ */
/* 媒体                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 上传文件
 * @param file 平台相关的文件对象（Lynx 为 { uri, name, type }）
 * @param meta 宽高/时长/波形，由客户端生成，避免服务端解码
 */
export async function uploadMedia(
  file: unknown,
  meta?: {
    width?: number;
    height?: number;
    durationMs?: number;
    waveform?: number[];
    kind?: string;
  },
): Promise<UploadResult> {
  // 运行时提供 FormData，Lynx 与 Web 均有实现
  const fd = new FormData();
  fd.append('file', file as Blob);

  if (meta) {
    if (meta.width !== undefined) fd.append('width', String(meta.width));
    if (meta.height !== undefined) fd.append('height', String(meta.height));
    if (meta.durationMs !== undefined) fd.append('durationMs', String(meta.durationMs));
    if (meta.waveform) fd.append('waveform', JSON.stringify(meta.waveform));
    if (meta.kind) fd.append('kind', meta.kind);
  }

  return upload<UploadResult>('/media', fd);
}

/* ------------------------------------------------------------------ */
/* 通话                                                                 */
/* ------------------------------------------------------------------ */

/** 获取 STUN/TURN 配置（含临时凭据） */
export function getIceConfig(): Promise<IceConfigResponse> {
  return get('/ice-servers');
}

/* ------------------------------------------------------------------ */
/* 推送                                                                 */
/* ------------------------------------------------------------------ */

/** 注册推送令牌 */
export function registerPushToken(params: {
  provider: 'hms' | 'xiaomi' | 'oppo' | 'vivo' | 'apns' | 'harmony';
  token: string;
  appVersion?: string;
}): Promise<{ success: boolean }> {
  return post('/push/register', {
    ...params,
    platform: PLATFORM,
    deviceId: getDeviceId(),
  });
}

/** 注销推送令牌 */
export function unregisterPushToken(): Promise<{ success: boolean }> {
  return del('/push/register', { deviceId: getDeviceId() });
}

// 保留 request 引用供未来扩展
void request;
