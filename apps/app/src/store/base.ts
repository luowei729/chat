/**
 * ============================================================
 * 全局状态（轻量实现）
 * ------------------------------------------------------------
 * 为什么不用 Redux/Zustand：
 * 1. Lynx 运行时对第三方状态库的兼容性未验证，自己写 60 行更稳；
 * 2. 需求简单：登录态 + 会话列表 + 消息 + 通话状态，四块足够；
 * 3. 用 React 的 useSyncExternalStore 语义（订阅 + 快照），
 *    避免不必要的重渲染。
 *
 * 设计：每个 store 是独立的「值 + 订阅集合」，
 *      更新时通知所有订阅者，组件用 useStore 拿最新值。
 * ============================================================
 */

import { useCallback, useSyncExternalStore } from '@lynx-js/react';

/* ------------------------------------------------------------------ */
/* 通用 Store 实现                                                      */
/* ------------------------------------------------------------------ */

export interface Store<T> {
  /** 读取当前值（同步，供非组件代码使用） */
  get: () => T;
  /** 设置值：支持直接赋值或函数式更新 */
  set: (next: T | ((prev: T) => T)) => void;
  /** 订阅变化，返回取消订阅函数 */
  subscribe: (listener: () => void) => () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();

  return {
    get: () => value,
    set: (next) => {
      const resolved = typeof next === 'function' ? (next as (prev: T) => T)(value) : next;
      // 引用相等则不通知，避免无意义重渲染
      if (resolved === value) return;
      value = resolved;
      for (const l of listeners) l();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * 组件中订阅 store
 * 说明：useSyncExternalStore 是 React 官方推荐的外部状态订阅方式，
 *      能正确处理并发渲染与撕裂问题。
 */
export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/**
 * 组件中订阅 store 的派生值
 * 注意：selector 必须返回稳定引用（或原始值），
 *      否则每次渲染都会认为是新值导致无限循环。
 */
export function useStoreSelector<T, S>(store: Store<T>, selector: (value: T) => S): S {
  const getSnapshot = useCallback(() => selector(store.get()), [store, selector]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
