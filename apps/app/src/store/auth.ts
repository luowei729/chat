/**
 * ============================================================
 * 认证状态
 * ------------------------------------------------------------
 * 保存：当前登录用户、登录态。
 * 说明：令牌本身存在 storage 层（client.ts 管理），
 *      这里只保存「内存中的用户信息」，避免每次渲染都读存储。
 * ============================================================
 */

import type { AuthUser } from '@chat/shared';
import { createStore, useStore } from './base.js';
import * as storage from '../storage.js';
import { getAccessToken } from '../api/client.js';

export interface AuthState {
  /** 当前用户；null 表示未登录 */
  user: AuthUser | null;
  /** 是否已完成启动时的登录态恢复 */
  bootstrapped: boolean;
}

export const authStore = createStore<AuthState>({
  user: null,
  bootstrapped: false,
});

/** 组件中读取认证状态 */
export function useAuth(): AuthState {
  return useStore(authStore);
}

/** 设置当前用户 */
export function setUser(user: AuthUser | null): void {
  authStore.set((prev) => ({ ...prev, user }));
}

/** 标记启动恢复完成 */
export function setBootstrapped(): void {
  authStore.set((prev) => ({ ...prev, bootstrapped: true }));
}

/** 是否已登录（非组件代码用） */
export function isLoggedIn(): boolean {
  return !!getAccessToken() && !!authStore.get().user;
}

/** 取当前用户 id（非组件代码用） */
export function currentUserId(): string | null {
  return authStore.get().user?.id ?? storage.getItem(storage.StorageKey.USER_ID);
}
