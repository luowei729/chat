/**
 * ============================================================
 * WebSocket 网关
 * ------------------------------------------------------------
 * 职责：
 * 1. 连接管理：同一用户可多端在线（手机 + 桌面），按设备分别维护；
 * 2. 鉴权：连接后必须先发 auth 消息，验证 access token；
 * 3. 心跳：客户端 25s 发 ping，服务端 60s 无消息判定掉线；
 * 4. 消息路由：把业务事件精准推给会话成员，而不是全站广播；
 * 5. 通话信令：P2P offer/answer/ice 按 to 字段定向转发。
 *
 * 为什么不用 socket.io：
 * 原生 ws 协议更轻（2 核服务器省内存），且 Lynx 客户端用标准
 * WebSocket API 即可，不需要额外 SDK。
 * ============================================================
 */

import {
  ErrorCode,
  WsCloseCode,
  type WsClientMessage,
  type WsServerMessage,
} from '@chat/shared';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { AppError } from '../lib/app-error.js';
import { moduleLogger } from '../lib/logger.js';
import { verifyAccessToken } from '../lib/tokens.js';
import * as callService from '../modules/call/service.js';
import * as conversationService from '../modules/conversation/service.js';
import * as messageService from '../modules/message/service.js';
import { pushToOfflineUsers } from '../modules/push/service.js';

const log = moduleLogger('ws');

/* ------------------------------------------------------------------ */
/* 连接注册表                                                           */
/* ------------------------------------------------------------------ */

/** 单条连接的状态 */
export interface WsClient {
  socket: WebSocket;
  /** 已鉴权的用户 id；鉴权前为空 */
  userId: string | null;
  deviceId: string;
  platform: string;
  /** 订阅的会话 id 集合，用于减少无关推送 */
  subscriptions: Set<string>;
  /** 最后收到消息的时间，用于心跳超时判断 */
  lastActiveAt: number;
  /** 是否已鉴权 */
  authed: boolean;
}

/** userId → 该用户的所有连接（多端） */
const userConnections = new Map<string, Set<WsClient>>();
/** socket → 连接状态 */
const clientBySocket = new WeakMap<WebSocket, WsClient>();

/** 心跳检测定时器 */
let heartbeatTimer: NodeJS.Timeout | null = null;

/* ------------------------------------------------------------------ */
/* 发送与广播                                                           */
/* ------------------------------------------------------------------ */

/** 安全发送：连接已关闭时静默忽略，避免抛错影响业务 */
function send(client: WsClient, msg: WsServerMessage): void {
  if (client.socket.readyState !== 1 /* OPEN */) return;
  try {
    client.socket.send(JSON.stringify(msg));
  } catch (e) {
    log.warn({ err: e }, 'WS 发送失败');
  }
}

/** 发给指定用户的所有在线设备 */
export function sendToUser(userId: string, msg: WsServerMessage): number {
  const conns = userConnections.get(userId);
  if (!conns || conns.size === 0) return 0;
  let count = 0;
  for (const c of conns) {
    if (c.authed) {
      send(c, msg);
      count += 1;
    }
  }
  return count;
}

/** 发给多个用户，返回「在线送达人数」 */
export function sendToUsers(userIds: string[], msg: WsServerMessage): number {
  let count = 0;
  const seen = new Set<string>();
  for (const uid of userIds) {
    if (seen.has(uid)) continue;
    seen.add(uid);
    count += sendToUser(uid, msg);
  }
  return count;
}

/** 判断用户是否在线（任一设备在线即算） */
export function isOnline(userId: string): boolean {
  const conns = userConnections.get(userId);
  if (!conns) return false;
  for (const c of conns) if (c.authed) return true;
  return false;
}

/** 当前在线连接总数（健康检查用） */
export function onlineClientCount(): number {
  let n = 0;
  for (const conns of userConnections.values()) n += conns.size;
  return n;
}

/* ------------------------------------------------------------------ */
/* 注册表维护                                                           */
/* ------------------------------------------------------------------ */

function registerClient(client: WsClient): void {
  if (!client.userId) return;
  let set = userConnections.get(client.userId);
  if (!set) {
    set = new Set();
    userConnections.set(client.userId, set);
  }
  set.add(client);
}

function unregisterClient(client: WsClient): void {
  if (!client.userId) return;
  const set = userConnections.get(client.userId);
  if (!set) return;
  set.delete(client);
  if (set.size === 0) {
    userConnections.delete(client.userId);
    // 最后一个设备下线 → 广播离线状态
    void broadcastPresence(client.userId, false);
  }
}

/** 广播在线状态给「与该用户有共同会话」的人 */
async function broadcastPresence(userId: string, online: boolean): Promise<void> {
  try {
    const peerIds = await conversationService.peersOf(userId);
    const msg: WsServerMessage = {
      type: 'presence',
      userId,
      online,
      lastSeenAt: online ? null : Date.now(),
    };
    sendToUsers(peerIds, msg);
  } catch (e) {
    log.warn({ err: e, userId }, '广播在线状态失败');
  }
}

/* ------------------------------------------------------------------ */
/* 业务消息处理                                                         */
/* ------------------------------------------------------------------ */

async function handleAuth(client: WsClient, msg: { token: string; platform: string; deviceId: string }): Promise<void> {
  try {
    const payload = await verifyAccessToken(msg.token);

    client.userId = payload.sub;
    client.deviceId = msg.deviceId || payload.did || 'unknown';
    client.platform = msg.platform || payload.plt || 'unknown';
    client.authed = true;
    client.lastActiveAt = Date.now();

    registerClient(client);

    send(client, {
      type: 'ready',
      userId: payload.sub,
      serverTime: Date.now(),
      onlineDevices: userConnections.get(payload.sub)?.size ?? 1,
    });

    void broadcastPresence(payload.sub, true);

    // 如果用户有进行中的通话（如 App 被杀后重连），补发状态
    const currentCall = callService.currentCallOf(payload.sub);
    if (currentCall) {
      send(client, {
        type: 'call.state',
        callId: currentCall.id,
        status: currentCall.status,
        participantIds: [...currentCall.participants.values()]
          .filter((p) => p.state === 'joined')
          .map((p) => p.userId),
      });
    }

    log.info({ userId: payload.sub, deviceId: client.deviceId, platform: client.platform }, 'WS 鉴权成功');
  } catch (e) {
    const code = e instanceof AppError ? e.code : ErrorCode.TOKEN_INVALID;
    send(client, { type: 'error', code, message: '鉴权失败，请重新登录' });
    // 4001/4002 让客户端决定是刷新令牌还是跳登录页
    client.socket.close(
      code === ErrorCode.TOKEN_EXPIRED ? WsCloseCode.TOKEN_EXPIRED : WsCloseCode.AUTH_FAILED,
      'auth failed',
    );
  }
}

async function handleClientMessage(client: WsClient, msg: WsClientMessage): Promise<void> {
  // 除 auth 外的所有消息都要求已鉴权
  if (msg.type !== 'auth' && !client.authed) {
    send(client, { type: 'error', code: ErrorCode.UNAUTHORIZED, message: '请先鉴权' });
    return;
  }

  client.lastActiveAt = Date.now();
  const userId = client.userId!;

  switch (msg.type) {
    /* ---------------- 鉴权 ---------------- */
    case 'auth': {
      if (client.authed) return;
      await handleAuth(client, msg);
      return;
    }

    /* ---------------- 心跳 ---------------- */
    case 'ping': {
      send(client, { type: 'pong', ts: msg.ts, serverTime: Date.now() });
      return;
    }

    /* ---------------- 订阅 ---------------- */
    case 'subscribe': {
      for (const id of msg.conversationIds) client.subscriptions.add(id);
      return;
    }

    case 'unsubscribe': {
      for (const id of msg.conversationIds) client.subscriptions.delete(id);
      return;
    }

    /* ---------------- 输入中 ---------------- */
    case 'typing': {
      // 校验成员身份，防止向无权限的会话发提示
      try {
        await conversationService.requireMember(msg.conversationId, userId);
      } catch {
        return;
      }
      const peers = await conversationService.activeMemberIds(msg.conversationId);
      const nickname = await conversationService.nicknameOf(userId);
      sendToUsers(
        peers.filter((id) => id !== userId),
        { type: 'typing', conversationId: msg.conversationId, userId, nickname },
      );
      return;
    }

    /* ---------------- 已读回执 ---------------- */
    case 'read': {
      try {
        const newSeq = await conversationService.markRead(msg.conversationId, userId, msg.seq);
        const peers = await conversationService.activeMemberIds(msg.conversationId);
        sendToUsers(
          peers.filter((id) => id !== userId),
          { type: 'read.updated', conversationId: msg.conversationId, userId, seq: newSeq },
        );
      } catch (e) {
        log.debug({ err: e }, '已读回执失败');
      }
      return;
    }

    /* ---------------- 发起通话 ---------------- */
    case 'call.invite': {
      try {
        const result = await callService.invite({
          conversationId: msg.conversationId,
          initiatorId: userId,
          mode: msg.mode,
          inviteeIds: msg.inviteeIds,
        });

        // 给被邀请者推送来电
        const incoming: WsServerMessage = {
          type: 'call.incoming',
          callId: result.call.id,
          conversationId: msg.conversationId,
          mode: msg.mode,
          caller: result.caller,
          conversationTitle: result.conversationTitle,
          expiresAt: result.expiresAt,
        };

        const delivered = sendToUsers(result.inviteeIds, incoming);

        // 离线用户走厂商推送（APNs / HMS / 小米等）
        const offline = result.inviteeIds.filter((id) => !isOnline(id));
        if (offline.length > 0) {
          void pushToOfflineUsers(offline, {
            title: `${result.caller.nickname} 邀请你语音通话`,
            body: result.conversationTitle,
            callId: result.call.id,
            conversationId: msg.conversationId,
          });
        }

        log.info({ callId: result.call.id, delivered, offline: offline.length }, '来电已推送');

        // 给发起者回执：知道谁收到了
        send(client, {
          type: 'call.state',
          callId: result.call.id,
          status: 'ringing',
          participantIds: [userId],
        });
      } catch (e) {
        const code = e instanceof AppError ? e.code : ErrorCode.INTERNAL_ERROR;
        const message = e instanceof AppError ? e.message : '发起通话失败';
        send(client, { type: 'error', code, message });
      }
      return;
    }

    /* ---------------- 接听 ---------------- */
    case 'call.accept': {
      try {
        const result = await callService.accept(msg.callId, userId);
        const all = result.allUserIds;

        // 广播状态：带上 joinedUserId，让「已在通话中的人」主动向新人发 offer
        sendToUsers(all, {
          type: 'call.state',
          callId: msg.callId,
          status: 'active',
          participantIds: [...result.call.participants.values()]
            .filter((p) => p.state === 'joined')
            .map((p) => p.userId),
          joinedUserId: userId,
        });
      } catch (e) {
        const code = e instanceof AppError ? e.code : ErrorCode.INTERNAL_ERROR;
        send(client, { type: 'error', code, message: e instanceof AppError ? e.message : '接听失败' });
      }
      return;
    }

    /* ---------------- 拒接 ---------------- */
    case 'call.reject': {
      try {
        const result = await callService.reject(msg.callId, userId);
        const all = [...result.call.participants.keys()];

        sendToUsers(all, {
          type: 'call.state',
          callId: msg.callId,
          status: result.shouldEnd ? 'rejected' : result.call.status,
          participantIds: [...result.call.participants.values()]
            .filter((p) => p.state === 'joined')
            .map((p) => p.userId),
          leftUserId: userId,
          reason: 'reject',
        });
      } catch (e) {
        log.debug({ err: e }, '拒接失败');
      }
      return;
    }

    /* ---------------- 挂断 ---------------- */
    case 'call.hangup': {
      try {
        const result = await callService.hangup(msg.callId, userId);
        const all = [...result.call.participants.keys()];

        sendToUsers(all, {
          type: 'call.state',
          callId: msg.callId,
          status: result.shouldEnd ? 'ended' : result.call.status,
          participantIds: [...result.call.participants.values()]
            .filter((p) => p.state === 'joined')
            .map((p) => p.userId),
          leftUserId: userId,
          reason: 'hangup',
        });
      } catch (e) {
        log.debug({ err: e }, '挂断失败');
      }
      return;
    }

    /* ---------------- P2P 信令转发（核心） ---------------- */
    case 'call.p2p': {
      const call = callService.getCallState(msg.callId);
      if (!call) {
        send(client, { type: 'error', code: ErrorCode.CALL_NOT_FOUND, message: '通话已结束' });
        return;
      }

      // 只有通话参与者能转发信令，防止被用来做任意消息投递
      try {
        callService.assertParticipant(call, userId);
      } catch {
        send(client, { type: 'error', code: ErrorCode.FORBIDDEN, message: '你不在该通话中' });
        return;
      }

      // 目标必须在同一通话中
      if (!call.participants.has(msg.to)) {
        send(client, { type: 'error', code: ErrorCode.BAD_REQUEST, message: '目标用户不在通话中' });
        return;
      }

      // 原样转发，服务端不解析 SDP/ICE 内容
      sendToUser(msg.to, {
        type: 'call.p2p',
        callId: msg.callId,
        kind: msg.kind,
        from: userId,
        payload: msg.payload,
      });
      return;
    }

    /* ---------------- 静音/说话状态 ---------------- */
    case 'call.media-state': {
      try {
        const call = callService.updateMediaState(msg.callId, userId, {
          muted: msg.muted,
          speaking: msg.speaking,
        });
        sendToUsers(
          [...call.participants.keys()].filter((id) => id !== userId),
          {
            type: 'call.media-state',
            callId: msg.callId,
            userId,
            muted: msg.muted,
            speaking: msg.speaking,
          },
        );
      } catch {
        // 通话已结束，忽略
      }
      return;
    }

    default: {
      // 未知消息类型：记录但不报错，便于客户端版本兼容
      log.debug({ type: (msg as { type: string }).type }, '未知 WS 消息类型');
      return;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 插件注册                                                             */
/* ------------------------------------------------------------------ */

export default async function wsPlugin(app: FastifyInstance): Promise<void> {
  /**
   * 振铃超时广播
   * ------------------------------------------------------------
   * callService.finalize() 只写库，超时路径（无人接听/全员拒接后）
   * 必须有人把 missed/rejected 推给所有参与者，否则两端界面卡死。
   * 放插件注册时订阅一次（进程单例，不会重复）。
   */
  callService.callEndedEvents.removeAllListeners('ended');
  callService.callEndedEvents.on('ended', (e: callService.CallEndedEvent) => {
    sendToUsers(e.userIds, {
      type: 'call.state',
      callId: e.callId,
      status: e.status,
      participantIds: [],
      reason: e.reason,
    });
    log.info({ callId: e.callId, status: e.status }, '通话结束已广播');
  });

  app.get('/ws', { websocket: true }, (socket, req) => {
    const client: WsClient = {
      socket,
      userId: null,
      deviceId: '',
      platform: '',
      subscriptions: new Set(),
      lastActiveAt: Date.now(),
      authed: false,
    };

    clientBySocket.set(socket, client);

    // 鉴权超时：10 秒内未发 auth 直接断开，防止空连接占资源
    const authTimer = setTimeout(() => {
      if (!client.authed) {
        socket.close(WsCloseCode.AUTH_FAILED, 'auth timeout');
      }
    }, 10_000);
    authTimer.unref?.();

    socket.on('message', (raw: Buffer) => {
      let msg: WsClientMessage;
      try {
        msg = JSON.parse(raw.toString('utf8')) as WsClientMessage;
      } catch {
        send(client, { type: 'error', code: ErrorCode.BAD_REQUEST, message: '消息格式错误' });
        return;
      }

      void handleClientMessage(client, msg).catch((e) => {
        log.error({ err: e }, 'WS 消息处理异常');
        send(client, { type: 'error', code: ErrorCode.INTERNAL_ERROR, message: '服务器处理失败' });
      });
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      unregisterClient(client);
      log.debug({ userId: client.userId, deviceId: client.deviceId }, 'WS 断开');
    });

    socket.on('error', (e) => {
      log.warn({ err: e, userId: client.userId }, 'WS 错误');
    });

    log.debug({ ip: req.ip }, 'WS 新连接');
  });

  // ---------- 全局心跳清理：60 秒无任何消息的连接直接断开 ----------
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const conns of userConnections.values()) {
      for (const c of conns) {
        if (now - c.lastActiveAt > 60_000) {
          try {
            c.socket.close(WsCloseCode.IDLE_TIMEOUT, 'idle timeout');
          } catch {
            // 忽略
          }
        }
      }
    }
  }, 20_000);
  heartbeatTimer.unref?.();

  app.addHook('onClose', async () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    for (const conns of userConnections.values()) {
      for (const c of conns) {
        try {
          c.socket.close(WsCloseCode.SERVER_RESTART, 'server restart');
        } catch {
          // 忽略
        }
      }
    }
  });
}

/**
 * 供 HTTP 路由复用：消息落库后推送给会话成员
 * 说明：写接口成功后立刻通过 WS 推送，客户端无需轮询。
 */
export function broadcastNewMessage(params: {
  conversationId: string;
  memberIds: string[];
  message: unknown;
}): void {
  const { conversationId, memberIds, message } = params;
  sendToUsers(memberIds, {
    type: 'message.new',
    conversationId,
    message: message as never,
  });
}

/** 供 HTTP 路由复用：会话摘要变化推送 */
export function broadcastConversationUpdated(params: {
  userIds: string[];
  conversationId: string;
  lastMessage: unknown;
  lastMessageAt: number | null;
  unreadCount?: number;
}): void {
  sendToUsers(params.userIds, {
    type: 'conversation.updated',
    conversationId: params.conversationId,
    lastMessage: params.lastMessage as never,
    lastMessageAt: params.lastMessageAt,
    unreadCount: params.unreadCount ?? 0,
  });
}

/** 供 HTTP 路由复用：撤回消息推送 */
export function broadcastMessageDeleted(params: {
  memberIds: string[];
  conversationId: string;
  messageId: string;
  seq: number;
}): void {
  sendToUsers(params.memberIds, {
    type: 'message.deleted',
    conversationId: params.conversationId,
    messageId: params.messageId,
    seq: params.seq,
  });
}

/** 供 HTTP 路由复用：新会话通知 */
export function notifyNewConversation(userIds: string[], conversationId: string): void {
  sendToUsers(userIds, { type: 'conversation.new', conversationId });
}

/* ------------------------------------------------------------------ */
/* 好友事件通知                                                         */
/* ------------------------------------------------------------------ */

/** 有人向我发起好友请求 */
export function notifyFriendRequest(
  targetUserId: string,
  payload: { userId: string; nickname: string; avatarUrl: string | null; createdAt: number },
): void {
  sendToUsers([targetUserId], { type: 'friend.request', ...payload });
}

/** 好友请求被接受 */
export function notifyFriendAccepted(
  targetUserId: string,
  payload: {
    userId: string;
    nickname: string;
    avatarUrl: string | null;
    conversationId: string | null;
  },
): void {
  sendToUsers([targetUserId], { type: 'friend.accepted', ...payload });
}

/** 好友被删除 / 被拉黑 */
export function notifyFriendRemoved(
  targetUserId: string,
  payload: { userId: string; blocked: boolean },
): void {
  sendToUsers([targetUserId], { type: 'friend.removed', ...payload });
}

/* ------------------------------------------------------------------ */
/* 消息回应与群成员变动通知                                             */
/* ------------------------------------------------------------------ */

/** 表情回应变化：推给会话内除操作者外的成员 */
export function notifyReactionUpdated(params: {
  conversationId: string;
  memberIds: string[];
  actorId: string;
  messageId: string;
  emoji: string;
  added: boolean;
}): void {
  const targets = params.memberIds.filter((id) => id !== params.actorId);
  if (targets.length === 0) return;
  sendToUsers(targets, {
    type: 'reaction.updated',
    conversationId: params.conversationId,
    messageId: params.messageId,
    userId: params.actorId,
    emoji: params.emoji,
    added: params.added,
  });
}

/** 群成员变动 */
export function notifyGroupMembersChanged(params: {
  conversationId: string;
  memberIds: string[];
  userIds: string[];
}): void {
  if (params.memberIds.length === 0) return;
  sendToUsers(params.memberIds, {
    type: 'group.members-changed',
    conversationId: params.conversationId,
    userIds: params.userIds,
  });
}

export { messageService };
