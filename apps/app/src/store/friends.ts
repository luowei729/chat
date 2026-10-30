/**
 * ============================================================
 * 好友状态
 * ------------------------------------------------------------
 * 全站共享的好友列表与待处理请求数，避免每个页面各自拉一遍。
 *
 * 刷新时机：
 * 1. 登录后 / 进入通讯录时主动拉；
 * 2. 收到 WS 的 friend.* 事件时增量刷新；
 * 3. 加/删好友等操作后由调用方手动触发 refresh。
 * ============================================================
 */

import type { FriendItem, FriendRequests } from '@chat/shared';
import { listFriends, listFriendRequests } from '../api/index.js';
import { createStore, useStore } from './base.js';

export interface FriendState {
  /** 好友列表 */
  friends: FriendItem[];
  /** 待处理请求 */
  requests: FriendRequests;
  /** 是否已加载过（用于区分「空列表」与「还没拉」） */
  loaded: boolean;
  loading: boolean;
}

export const friendStore = createStore<FriendState>({
  friends: [],
  requests: { incoming: [], outgoing: [] },
  loaded: false,
  loading: false,
});

/** 组件中订阅 */
export function useFriends(): FriendState {
  return useStore(friendStore);
}

/** 收到的待处理请求数（红点用） */
export function incomingRequestCount(): number {
  return friendStore.get().requests.incoming.length;
}

/** 重新拉取好友与请求 */
export async function refreshFriends(): Promise<void> {
  friendStore.set((prev) => ({ ...prev, loading: true }));
  try {
    const [friends, requests] = await Promise.all([listFriends(), listFriendRequests()]);
    friendStore.set({ friends, requests, loaded: true, loading: false });
  } catch {
    // 失败保留旧数据，静默（下次进入页面会重试）
    friendStore.set((prev) => ({ ...prev, loading: false }));
  }
}

/** 清空（登出时调用） */
export function clearFriends(): void {
  friendStore.set({
    friends: [],
    requests: { incoming: [], outgoing: [] },
    loaded: false,
    loading: false,
  });
}

/** 按 userId 查好友（会话/群成员处用来取备注名） */
export function findFriend(userId: string): FriendItem | undefined {
  return friendStore.get().friends.find((f) => f.userId === userId);
}

/**
 * 取展示名：优先备注名，其次昵称
 * 找不到好友记录时返回 fallback（通常是服务端给的 nickname）。
 */
export function displayNameOf(userId: string, fallback: string): string {
  const f = findFriend(userId);
  return f?.remark?.trim() ? f.remark : (f?.nickname ?? fallback);
}
