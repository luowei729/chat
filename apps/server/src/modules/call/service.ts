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
import { and, eq, inArray } from 'drizzle-orm';
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
  /**
   * 参与者昵称缓存：userId → 昵称
   * ------------------------------------------------------------
   * 只发 userId 时，客户端只能显示 id 尾号（如 MDH2），
   * 通话界面认不出是谁。发起时一次性查好，后续广播直接带出去，
   * 避免每次状态变更都回查数据库（2C 机器扛不住）。
   */
  names: Map<string, string>;
  createdAt: number;
  /** 振铃超时定时器 */
  ringTimer: NodeJS.Timeout | null;
  /** 来电展示信息：重连补发 incoming 时复用，避免重查库 */
  caller: { id: string; nickname: string; avatarUrl: string | null };
  conversationTitle: string;
  expiresAt: number;
  /** 最后活跃时间（客户端心跳刷新），无心跳的已接通通话会被回收 */
  lastSeenAt: number;
}

/** 进行中的通话：callId → 状态 */
const activeCalls = new Map<string, CallState>();
/** 用户当前所在通话：userId → callId，用于忙线检测 */
const userCallIndex = new Map<string, string>();

/* ------------------------------------------------------------------ */
/* 残留通话清理                                                          */
/* ------------------------------------------------------------------ */

/**
 * 在线检查钩子
 * ------------------------------------------------------------
 * service 不能反向 import gateway（会循环依赖），
 * 由网关启动时注入。默认 true：没注入时保守认为在线，避免误杀。
 */
let isUserOnline: (userId: string) => boolean = () => true;

/** 通话参与者是否已经全员离线（= 这通电话不可能还活着） */
function isAbandoned(call: CallState): boolean {
  for (const uid of call.participants.keys()) {
    if (isUserOnline(uid)) return false;
  }
  return true;
}

/**
 * 回收某个用户身上残留的死通话
 * 在发起新通话前调用：如果旧通话全员离线，直接结束掉，
 * 否则用户会永远被「你已在通话中」拦住。
 */
async function releaseAbandoned(userId: string): Promise<void> {
  const id = userCallIndex.get(userId);
  if (!id) return;
  const call = activeCalls.get(id);
  if (!call) {
    userCallIndex.delete(userId);
    return;
  }
  if (!isAbandoned(call)) return;

  log.info({ callId: id, userId }, '清理无人在线的残留通话');
  try {
    await finalize(call, 'ended', 'error');
  } catch {
    // 清理失败不影响新通话
  }
}

let reaper: ReturnType<typeof setInterval> | null = null;

/** 启动后台回收器（幂等） */
function startReaper(): void {
  if (reaper) return;
  reaper = setInterval(() => {
    const now = Date.now();
    for (const call of [...activeCalls.values()]) {
      // 已接通但 90 秒没有任何客户端信令：App 已退出/崩溃，回收
      if (call.status === 'active' && now - call.lastSeenAt > 90_000) {
        log.info({ callId: call.id, idleMs: now - call.lastSeenAt }, '回收无心跳的通话');
        void finalize(call, 'ended', 'error').catch(() => undefined);
        continue;
      }

      // 至少存活 1 分钟再考虑按在线状态回收，避免接通过程中被误判
      if (now - call.createdAt < 60_000) continue;
      if (!isAbandoned(call)) continue;
      log.info({ callId: call.id }, '回收无人在线的残留通话');
      void finalize(call, 'ended', 'error').catch(() => undefined);
    }
  }, 30_000);
  reaper.unref?.();
}

/** 刷新通话的「最后活跃时间」（任何客户端信令都算） */
export function touch(callId: string, userId: string): void {
  const call = activeCalls.get(callId);
  if (!call) return;
  if (!call.participants.has(userId)) return;
  call.lastSeenAt = Date.now();
}

/** 注入在线检查器（WS 网关启动时调用） */
export function setOnlineChecker(fn: (userId: string) => boolean): void {
  isUserOnline = fn;
  startReaper();
}

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

/**
 * 取参与者昵称表（供 WS 广播携带）
 * 返回普通对象而不是 Map：WS 帧统一用 JSON，Map 序列化会变 {}。
 */
export function participantNamesOf(callId: string): Record<string, string> {
  const call = activeCalls.get(callId);
  if (!call) return {};
  return Object.fromEntries(call.names);
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

  // 发起者自己不能已在通话中（先回收全员离线的残留通话）
  await releaseAbandoned(initiatorId);
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
    // 被邀请者的旧通话若已全员离线，先回收，避免误判忙线
    await releaseAbandoned(uid);
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

  const callerRows = await db
    .select({ id: users.id, nickname: users.nickname, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, initiatorId))
    .limit(1);
  const callerInfo = callerRows[0] ?? { id: initiatorId, nickname: '未知用户', avatarUrl: null };
  const convTitleRows = await db
    .select({ title: users.nickname })
    .from(users)
    .where(eq(users.id, initiatorId))
    .limit(1);

  /**
   * 参与者昵称：一次 IN 查询全部取回
   * 发起时就固定下来，接通/挂断广播复用，避免重复查库。
   */
  const nameRows = await db
    .select({ id: users.id, nickname: users.nickname })
    .from(users)
    .where(inArray(users.id, [initiatorId, ...targets]));
  const names = new Map<string, string>();
  for (const row of nameRows) names.set(row.id, row.nickname);
  // 兜底：查不到的（理论上不会发生）用「用户」占位，避免前端显示 id 尾号
  for (const uid of [initiatorId, ...targets]) {
    if (!names.has(uid)) names.set(uid, '用户');
  }

  const call: CallState = {
    id: callId,
    conversationId,
    mode,
    status: 'ringing',
    initiatorId,
    participants,
    names,
    createdAt: now,
    ringTimer: null,
    caller: callerInfo,
    conversationTitle: convTitleRows[0]?.title ?? '通话',
    expiresAt: now + config.call.ringTimeoutMs,
    lastSeenAt: now,
  };

  activeCalls.set(callId, call);
  userCallIndex.set(initiatorId, callId);
  for (const uid of reachable) userCallIndex.set(uid, callId);

  // ---------- 振铃超时：45 秒无人接听自动结束 ----------
  call.ringTimer = setTimeout(() => {
    void handleRingTimeout(callId);
  }, config.call.ringTimeoutMs);
  call.ringTimer.unref?.();

  // ---------- 落库（仅记录，不用于实时状态） ----------
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

  log.info({ callId, conversationId, initiatorId, targets: reachable.length, busy: busy.length }, '发起通话');

  return {
    call,
    inviteeIds: reachable,
    caller: call.caller,
    conversationTitle: call.conversationTitle,
    expiresAt: call.expiresAt,
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

  // 没人了则结束；已接通后只剩 1 人也没有通话意义，直接结束
  // （否则对方会停在「1 人通话中」，计时继续，以为没挂断）
  if (remaining.length === 0 || (call.status === 'active' && remaining.length <= 1)) {
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

/**
 * 重连补发来电
 * ------------------------------------------------------------
 * 场景：被叫 App 在振铃期间被系统杀掉（低内存常见），
 * 重连时只收到 call.state（active 参与者快照），
 * 但 call.incoming 丢了 → 来电界面永远弹不出来。
 * 这里在鉴权成功后判断：如果用户在一通 ringing 的通话里
 * 且自己还没接听，就把 incoming 原样再推一次，
 * 客户端收到后正常弹出来电页，不超过振铃期就还能接。
 */
export function incomingFor(userId: string): {
  callId: string;
  conversationId: string;
  mode: CallMode;
  caller: { id: string; nickname: string; avatarUrl: string | null };
  conversationTitle: string;
  expiresAt: number;
} | null {
  const callId = userCallIndex.get(userId);
  if (!callId) return null;
  const call = activeCalls.get(callId);
  if (!call || call.status !== 'ringing') return null;
  if (call.participants.get(userId)?.state !== 'invited') return null;
  if (call.expiresAt <= Date.now()) return null;
  return {
    callId: call.id,
    conversationId: call.conversationId,
    mode: call.mode,
    caller: call.caller,
    conversationTitle: call.conversationTitle,
    expiresAt: call.expiresAt,
  };
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
