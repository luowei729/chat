/**
 * ============================================================
 * 已读水位（用于消息后的勾选状态）
 * ------------------------------------------------------------
 * 数据来源两处：
 *   1. 进入会话时 `getConversation()` 返回的 members[].lastReadSeq
 *      —— 解决「历史消息」的已读状态；
 *   2. WS `read.updated` 事件 —— 解决「实时」的已读状态。
 *
 * 为什么按成员存而不是只存一个数：
 *   群聊里「两条勾」的语义是 **所有人都已读**，单个数字无法
 *   判断是不是所有成员都过了水位。存成 userId → seq 的映射后，
 *   读态 = min(其他成员的水位) >= 消息 seq。
 *
 * 排序/比较全部用数字，不涉及日期解析，避免各端时区差异。
 * ============================================================
 */

import { createStore, useStore } from './base.js';

export interface ReadsState {
  /** conversationId → (userId → 已读到的最大 seq) */
  byConversation: Record<string, Record<string, number>>;
}

export const readsStore = createStore<ReadsState>({ byConversation: {} });

/** 订阅某个会话的成员已读水位 */
export function useConversationReads(conversationId: string): Record<string, number> {
  const state = useStore(readsStore);
  return state.byConversation[conversationId] ?? EMPTY;
}

const EMPTY: Record<string, number> = {};

/**
 * 批量写入（进入会话时用服务端快照覆盖）
 * 注意：不用 Math.max 合并，因为调用方拿到的是权威快照；
 *      但为了不让后到的 WS 事件被打回旧值，这里仍然取 max。
 */
export function setMembersRead(
  conversationId: string,
  members: Array<{ userId: string; lastReadSeq: number }>,
): void {
  if (members.length === 0) return;
  readsStore.set((prev) => {
    const current = prev.byConversation[conversationId] ?? {};
    const next: Record<string, number> = { ...current };
    let changed = false;
    for (const m of members) {
      const seq = m.lastReadSeq ?? 0;
      if ((next[m.userId] ?? 0) < seq) {
        next[m.userId] = seq;
        changed = true;
      }
    }
    if (!changed) return prev;
    return { byConversation: { ...prev.byConversation, [conversationId]: next } };
  });
}

/** 单个成员的已读推进（WS read.updated） */
export function setMemberRead(conversationId: string, userId: string, seq: number): void {
  readsStore.set((prev) => {
    const current = prev.byConversation[conversationId] ?? {};
    if ((current[userId] ?? 0) >= seq) return prev; // 水位只增不减
    return {
      byConversation: {
        ...prev.byConversation,
        [conversationId]: { ...current, [userId]: seq },
      },
    };
  });
}

/**
 * 计算「对方已读水位」：其他成员里最小的那个
 * - 私聊：就是对方的水位；
 * - 群聊：最落后成员的水位（全读到才算全读）；
 * - 没有其他成员：返回 0，永远显示单勾。
 *
 * 注意这里用「最小」而不是「最大」：
 * 双勾在群里表达的是「所有人都看到了」，取最小才符合直觉。
 */
export function peerReadSeq(
  reads: Record<string, number>,
  myUserId: string | null,
): number {
  let min = Number.MAX_SAFE_INTEGER;
  let found = false;
  for (const uid of Object.keys(reads)) {
    if (uid === myUserId) continue;
    found = true;
    const seq = reads[uid] ?? 0;
    if (seq < min) min = seq;
  }
  return found ? min : 0;
}
