/**
 * ============================================================
 * 通话服务（P2P Mesh 语音）
 * ------------------------------------------------------------
 * 架构：服务端只做「信令中转 + 状态机」，媒体完全在客户端之间直连。
 *
 * 状态机：
 *   ringing ──accept──> active ──hangup──> ended
 *      │                   │
 *      ├──reject──> rejected
 *      └──timeout─> missed
 *
 * Mesh 拓扑维护：
 *   新成员加入时，服务端在 call.state 里带 joinedUserId，
 *   客户端据此决定「谁给谁发 offer」，避免双向同时 offer 造成 glare。
 *   规则：**已在线的人主动向新加入的人发 offer**。
 *
 * 为什么状态放内存而不是数据库：
 *   通话是秒级生命周期的实时状态，写库会成为瓶颈且无必要；
 *   只在通话结束时落一条历史记录（用于通话记录列表）。
 *   代价：服务重启会丢失进行中的通话——对聊天应用可接受。
 * ============================================================
 */

import { CALL_MESH_MAX_PARTICIPANTS, ErrorCode, type CallMode, type CallSessionInfo, type CallStatus } from '@chat/shared';
import { EventEmitter } from 'node:events';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { callParticipants, callSessions, users } from '../../db/schema.js';
import { config } from '../../config.js';
import { AppError } from '../../lib/app-error.js';
import { newId } from '../../lib/ids.js';
import { moduleLogger } from '../../lib/logger.js';
import { activeMemberIds, requireMember } from '../conversation/service.js';

const log = moduleLogger('call');

/**
 * 通话结束事件（供 WS 网关订阅后广播）
 * ------------------------------------------------------------
 * 之前的 bug：振铃超时走 finalize() 只写库、不广播，
 * 主叫永远卡在「正在呼叫…」，被叫的来电页也关不掉。
 * finalize 在 service 层拿不到 gateway（循环依赖），
 * 所以用事件解耦：service 只管 emit，gateway 负责广播。
 */
export interface CallEndedEvent {
  callId: string;
  status: CallStatus;
  reason: 'hangup' | 'reject' | 'timeout' | 'busy' | 'error';
  userIds: string[];
}

export const callEndedEvents = new EventEmitter();

/* ------------------------------------------------------------------ */
/* 内存状态                                                             */
/* ------------------------------------------------------------------ */

interface ParticipantState {
  userId: string;
  /** invited | joined | left | rejected | missed */
  state: 'invited' | 'joined' | 'left' | 'rejected' | 'missed';
  muted: boolean;
  speaking: boolean;
  joinedAt: number | null;
}

interface CallState {
  id: string;
  conversationId: string;
  mode: CallMode;
  status: CallStatus;
  initiatorId: string;
  participants: Map<string, ParticipantState>;
  createdAt: number;
  /** 振铃超时定时器 */
  ringTimer: NodeJS.Timeout | null;
}

/** 进行中的通话：callId → 状态 */
const activeCalls = new Map<string, CallState>();
/** 用户当前所在通话：userId → callId，用于忙线检测 */
const userCallIndex = new Map<string, string>();

/* ------------------------------------------------------------------ */
/* 内部工具                                                             */
/* ------------------------------------------------------------------ */

/** 取通话，不存在则抛错 */
function getCall(callId: string): CallState {
  const call = activeCalls.get(callId);
  if (!call) throw new AppError(ErrorCode.CALL_NOT_FOUND);
  if (call.status === 'ended' || call.status === 'rejected' || call.status === 'missed') {
    throw new AppError(ErrorCode.CALL_ALREADY_ENDED);
  }
  return call;
}

/** 取当前已加入通话的成员 id */
function joinedUserIds(call: CallState): string[] {
  return [...call.participants.values()].filter((p) => p.state === 'joined').map((p) => p.userId);
}

/** 取全部被邀请者（含未接听） */
function allUserIds(call: CallState): string[] {
  return [...call.participants.keys()];
}

/** 清理通话：移出索引、停定时器 */
function disposeCall(call: CallState): void {
  if (call.ringTimer) {
    clearTimeout(call.ringTimer);
    call.ringTimer = null;
  }
  for (const userId of call.participants.keys()) {
    if (userCallIndex.get(userId) === call.id) {
      userCallIndex.delete(userId);
    }
  }
  activeCalls.delete(call.id);
}

/* ------------------------------------------------------------------ */
/* 发起通话                                                             */
/* ------------------------------------------------------------------ */

export interface InviteResult {
  call: CallState;
  /** 需要收到来电通知的用户 id */
  inviteeIds: string[];
  /** 来电展示需要的发起者信息 */
  caller: { id: string; nickname: string; avatarUrl: string | null };
  conversationTitle: string;
  expiresAt: number;
}

export async function invite(params: {
  conversationId: string;
  initiatorId: string;
  mode: CallMode;
  inviteeIds?: string[];
}): Promise<InviteResult> {
  const { conversationId, initiatorId, mode, inviteeIds } = params;

  // 视频首版不开放
  if (mode === 'video' && !config.call.videoEnabled) {
    throw new AppError(ErrorCode.CALL_STATE_INVALID, '视频通话暂未开放，敬请期待');
  }

  // 必须是会话成员
  await requireMember(conversationId, initiatorId);

  // 发起者自己不能已在通话中
  const existingCallId = userCallIndex.get(initiatorId);
  if (existingCallId) {
    throw new AppError(ErrorCode.CALL_STATE_INVALID, '你已在通话中');
  }

  // 确定被邀请者：显式指定则用之，否则邀请会话内全部其他成员
  const memberIds = await activeMemberIds(conversationId);
  let targets = (inviteeIds && inviteeIds.length > 0 ? inviteeIds : memberIds)
    .filter((id) => id !== initiatorId)
    // 只允许邀请会话内成员
    .filter((id) => memberIds.includes(id));

  targets = [...new Set(targets)];

  if (targets.length === 0) {
    throw new AppError(ErrorCode.BAD_REQUEST, '没有可邀请的成员');
  }

  if (targets.length + 1 > CALL_MESH_MAX_PARTICIPANTS) {
    throw new AppError(ErrorCode.CALL_PARTICIPANT_LIMIT, `语音通话最多 ${CALL_MESH_MAX_PARTICIPANTS} 人`);
  }

  // ---------- 忙线检测：被邀请者若已在通话中，标记为 busy ----------
  const now = Date.now();
  const callId = newId();

  const participants = new Map<string, ParticipantState>();
  participants.set(initiatorId, {
    userId: initiatorId,
    state: 'joined',
    muted: false,
    speaking: false,
    joinedAt: now,
  });

  const reachable: string[] = [];
  const busy: string[] = [];

  for (const uid of targets) {
    if (userCallIndex.has(uid)) {
      busy.push(uid);
      participants.set(uid, {
        userId: uid,
        state: 'rejected',
        muted: false,
        speaking: false,
        joinedAt: null,
      });
    } else {
      reachable.push(uid);
      participants.set(uid, {
        userId: uid,
        state: 'invited',
        muted: false,
        speaking: false,
        joinedAt: null,
      });
    }
  }

  if (reachable.length === 0) {
    throw new AppError(ErrorCode.CALL_STATE_INVALID, '对方正在通话中');
  }

  const call: CallState = {
    id: callId,
    conversationId,
    mode,
    status: 'ringing',
    initiatorId,
    participants,
    createdAt: now,
    ringTimer: null,
  };

  activeCalls.set(callId, call);
  userCallIndex.set(initiatorId, callId);
  for (const uid of reachable) userCallIndex.set(uid, callId);

  // ---------- 振铃超时：45 秒无人接听自动结束 ----------
  const expiresAt = now + config.call.ringTimeoutMs;
  call.ringTimer = setTimeout(() => {
    void handleRingTimeout(callId);
  }, config.call.ringTimeoutMs);
  call.ringTimer.unref?.();

  // ---------- 落库（仅记录，不用于实时状态） ----------
  const convRows = await db
    .select({ title: users.nickname })
    .from(users)
    .where(eq(users.id, initiatorId))
    .limit(1);

  await db.insert(callSessions).values({
    id: callId,
    conversationId,
    mode,
    status: 'ringing',
    initiatorId,
    routerId: null,
    startedAt: now,
    answeredAt: null,
    endedAt: null,
    endReason: null,
  });

  await db.insert(callParticipants).values(
    [...participants.values()].map((p) => ({
      callId,
      userId: p.userId,
      state: p.state,
      joinedAt: p.joinedAt,
      leftAt: null,
    })),
  );

  const callerRows = await db
    .select({ id: users.id, nickname: users.nickname, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, initiatorId))
    .limit(1);
  const caller = callerRows[0] ?? { id: initiatorId, nickname: '未知用户', avatarUrl: null };

  log.info({ callId, conversationId, initiatorId, targets: reachable.length, busy: busy.length }, '发起通话');

  return {
    call,
    inviteeIds: reachable,
    caller,
    conversationTitle: convRows[0]?.title ?? '通话',
    expiresAt,
  };
}

/** 振铃超时处理 */
async function handleRingTimeout(callId: string): Promise<void> {
  const call = activeCalls.get(callId);
  if (!call || call.status !== 'ringing') return;

  log.info({ callId }, '振铃超时');
  // finalize 会清掉内存索引，先把要通知的人记下来
  const userIds = [...call.participants.keys()];
  await finalize(call, 'missed', 'timeout');
  callEndedEvents.emit('ended', {
    callId,
    status: 'missed',
    reason: 'timeout',
    userIds,
  } satisfies CallEndedEvent);
}

/* ------------------------------------------------------------------ */
/* 接听                                                                 */
/* ------------------------------------------------------------------ */

export interface AcceptResult {
  call: CallState;
  /** 已在通话中的其他人（需要给他们发「新人加入」通知） */
  existingUserIds: string[];
  /** 全部参与人（用于广播状态） */
  allUserIds: string[];
}

export async function accept(callId: string, userId: string): Promise<AcceptResult> {
  const call = getCall(callId);
  const p = call.participants.get(userId);

  if (!p) throw new AppError(ErrorCode.FORBIDDEN, '你不在该通话中');
  if (p.state === 'joined') {
    // 幂等：已接听则直接返回当前状态
    return {
      call,
      existingUserIds: joinedUserIds(call).filter((id) => id !== userId),
      allUserIds: allUserIds(call),
    };
  }
  if (p.state !== 'invited') {
    throw new AppError(ErrorCode.CALL_STATE_INVALID, '通话已结束');
  }

  const now = Date.now();
  p.state = 'joined';
  p.joinedAt = now;

  // 第一个接听者触发状态从 ringing → active
  if (call.status === 'ringing') {
    call.status = 'active';
    if (call.ringTimer) {
      clearTimeout(call.ringTimer);
      call.ringTimer = null;
    }
    await db
      .update(callSessions)
      .set({ status: 'active', answeredAt: now })
      .where(eq(callSessions.id, callId));
  }

  await db
    .update(callParticipants)
    .set({ state: 'joined', joinedAt: now })
    .where(and(eq(callParticipants.callId, callId), eq(callParticipants.userId, userId)));

  const existing = joinedUserIds(call).filter((id) => id !== userId);

  log.info({ callId, userId, participants: existing.length + 1 }, '接听通话');

  return { call, existingUserIds: existing, allUserIds: allUserIds(call) };
}

/* ------------------------------------------------------------------ */
/* 拒绝                                                                 */
/* ------------------------------------------------------------------ */

export async function reject(callId: string, userId: string): Promise<{ call: CallState; shouldEnd: boolean }> {
  const call = getCall(callId);
  const p = call.participants.get(userId);
  if (!p) throw new AppError(ErrorCode.FORBIDDEN, '你不在该通话中');

  p.state = 'rejected';
  userCallIndex.delete(userId);

  await db
    .update(callParticipants)
    .set({ state: 'rejected' })
    .where(and(eq(callParticipants.callId, callId), eq(callParticipants.userId, userId)));

  // 如果没人接听且所有被邀请者都拒绝了，直接结束
  const stillRinging = [...call.participants.values()].some((x) => x.state === 'invited');
  const anyJoined = [...call.participants.values()].some((x) => x.state === 'joined');

  if (!stillRinging && !anyJoined) {
    await finalize(call, 'rejected', 'reject');
    return { call, shouldEnd: true };
  }

  // 群里其他人还在振铃，继续等待
  return { call, shouldEnd: false };
}

/* ------------------------------------------------------------------ */
/* 挂断                                                                 */
/* ------------------------------------------------------------------ */

export async function hangup(callId: string, userId: string): Promise<{ call: CallState; shouldEnd: boolean }> {
  const call = getCall(callId);
  const p = call.participants.get(userId);
  if (!p) throw new AppError(ErrorCode.FORBIDDEN, '你不在该通话中');

  const now = Date.now();
  p.state = 'left';
  userCallIndex.delete(userId);

  await db
    .update(callParticipants)
    .set({ state: 'left', leftAt: now })
    .where(and(eq(callParticipants.callId, callId), eq(callParticipants.userId, userId)));

  const remaining = joinedUserIds(call);

  // 发起者在振铃阶段挂断 = 取消通话
  if (call.status === 'ringing' && userId === call.initiatorId) {
    await finalize(call, 'ended', 'hangup');
    return { call, shouldEnd: true };
  }

  // 没人了则结束
  if (remaining.length === 0) {
    await finalize(call, 'ended', 'hangup');
    return { call, shouldEnd: true };
  }

  log.info({ callId, userId, remaining: remaining.length }, '成员离开通话');
  return { call, shouldEnd: false };
}

/* ------------------------------------------------------------------ */
/* 结束通话（统一出口）                                                  */
/* ------------------------------------------------------------------ */

export async function finalize(
  call: CallState,
  status: CallStatus,
  reason: 'hangup' | 'reject' | 'timeout' | 'busy' | 'error',
): Promise<void> {
  const now = Date.now();
  call.status = status;

  await db
    .update(callSessions)
    .set({ status, endedAt: now, endReason: reason })
    .where(eq(callSessions.id, call.id));

  // 未接听者标记为 missed
  for (const p of call.participants.values()) {
    if (p.state === 'invited') {
      p.state = 'missed';
      await db
        .update(callParticipants)
        .set({ state: 'missed' })
        .where(and(eq(callParticipants.callId, call.id), eq(callParticipants.userId, p.userId)));
    }
  }

  log.info({ callId: call.id, status, reason, durationMs: now - call.createdAt }, '通话结束');
  disposeCall(call);
}

/* ------------------------------------------------------------------ */
/* 查询                                                                 */
/* ------------------------------------------------------------------ */

/** 取用户当前所在通话（用于多端同步与忙线判断） */
export function currentCallOf(userId: string): CallState | null {
  const callId = userCallIndex.get(userId);
  if (!callId) return null;
  return activeCalls.get(callId) ?? null;
}

/** 取通话状态（信令转发前校验用） */
export function getCallState(callId: string): CallState | null {
  return activeCalls.get(callId) ?? null;
}

/** 校验通话参与者身份 */
export function assertParticipant(call: CallState, userId: string): void {
  const p = call.participants.get(userId);
  if (!p || p.state !== 'joined') {
    throw new AppError(ErrorCode.FORBIDDEN, '你不在该通话中');
  }
}

/** 更新静音/说话状态 */
export function updateMediaState(
  callId: string,
  userId: string,
  state: { muted?: boolean; speaking?: boolean },
): CallState {
  const call = getCall(callId);
  const p = call.participants.get(userId);
  if (!p) throw new AppError(ErrorCode.FORBIDDEN);
  if (state.muted !== undefined) p.muted = state.muted;
  if (state.speaking !== undefined) p.speaking = state.speaking;
  return call;
}

/** 对外暴露的会话信息（不含内部字段） */
export function toCallSessionInfo(call: CallState): CallSessionInfo {
  return {
    id: call.id,
    conversationId: call.conversationId,
    mode: call.mode,
    status: call.status,
    initiatorId: call.initiatorId,
    participantIds: joinedUserIds(call),
    startedAt: call.createdAt,
    endedAt: call.status === 'ended' ? Date.now() : null,
  };
}

/** 进程启动时清理上次未结束的通话记录（服务重启会丢失内存状态） */
export async function cleanupStaleCalls(): Promise<void> {
  await db
    .update(callSessions)
    .set({ status: 'ended', endReason: 'error', endedAt: Date.now() })
    .where(eq(callSessions.status, 'ringing'));

  await db
    .update(callSessions)
    .set({ status: 'ended', endReason: 'error', endedAt: Date.now() })
    .where(eq(callSessions.status, 'active'));
}
