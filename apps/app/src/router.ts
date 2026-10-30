/**
 * ============================================================
 * 极简路由
 * ------------------------------------------------------------
 * 为什么不引入 react-router：
 * 1. Lynx 没有 DOM History API，react-router 的浏览器适配无法直接用；
 * 2. 聊天 App 的页面结构简单（登录 → 列表 → 聊天 → 通话），
 *    用栈式导航（push/pop）即可覆盖，且返回键行为可控；
 * 3. 自研 40 行比适配第三方库更省事、包体积更小。
 *
 * 路由状态：一个栈，栈顶即当前页面。
 * 返回：pop 一层。
 * ============================================================
 */

import { createStore, useStore } from './store/base.js';

/** 页面定义：name 决定渲染哪个组件，params 是页面参数 */
export interface Route {
  name:
    | 'login'
    | 'register'
    | 'reset-password'
    | 'conversations'
    | 'chat'
    | 'call'
    | 'invite'
    | 'profile'
    | 'new-chat'
    /** 通讯录 */
    | 'contacts'
    /** 新的朋友（好友请求） */
    | 'friend-requests'
    /** 他人资料页 */
    | 'user-profile'
    /** 群信息 / 成员管理 */
    | 'group-info'
    /** 设置 */
    | 'settings'
    /** 媒体查看器（图片/视频全屏预览） */
    | 'media-viewer'
    /** 消息全文搜索 */
    | 'search-messages';
  params?: Record<string, unknown>;
}

interface RouterState {
  stack: Route[];
}

const routerStore = createStore<RouterState>({
  // 初始为空，由 App 根据登录态决定首页
  stack: [],
});

/** 当前路由（栈顶） */
export function useCurrentRoute(): Route {
  const state = useStore(routerStore);
  return state.stack[state.stack.length - 1] ?? { name: 'conversations' };
}

/** 当前栈深度（用于判断能否返回） */
export function useCanGoBack(): boolean {
  const state = useStore(routerStore);
  return state.stack.length > 1;
}

/** 跳转到新页面（入栈） */
export function push(route: Route): void {
  routerStore.set((prev) => ({ stack: [...prev.stack, route] }));
}

/** 返回上一页 */
export function pop(): void {
  routerStore.set((prev) => {
    if (prev.stack.length <= 1) return prev;
    return { stack: prev.stack.slice(0, -1) };
  });
}

/** 替换当前页（不增加栈深度） */
export function replace(route: Route): void {
  routerStore.set((prev) => {
    const stack = [...prev.stack];
    stack[stack.length - 1] = route;
    return { stack };
  });
}

/**
 * 重置栈
 * 用途：登录成功 → 直接进入会话列表，此时不应能返回到登录页。
 */
export function reset(route: Route): void {
  routerStore.set({ stack: [route] });
}

/** 返回到指定页面（找不到则重置） */
export function popTo(name: Route['name']): void {
  routerStore.set((prev) => {
    for (let i = prev.stack.length - 1; i >= 0; i -= 1) {
      if (prev.stack[i]!.name === name) {
        return { stack: prev.stack.slice(0, i + 1) };
      }
    }
    return prev;
  });
}

/**
 * 切换底部标签
 * ============================================================
 * 【为什么不能用 push / pop】
 * 三个标签是**平级**的，不是层级关系。之前各页写成
 *   chats → push(settings) → push(contacts)
 * 栈就变成 [chats, settings, contacts]，此时点「聊天」执行 pop()，
 * 只是退一层，落在 **settings**… 再点还是退，最后落在 contacts。
 * 用户看到的现象就是「点聊天却跳到联系人」。
 *
 * 正确语义：切标签 = 重置栈到该标签的根页面，
 * 丢弃之前标签页留下的历史（详情页也一并丢弃，符合 Telegram 行为）。
 *
 * 标签根页面之间的往返不产生历史记录，
 * 因此在任意标签根页面按返回键都是「最小化 App」。
 */
export function switchTab(tab: 'chats' | 'contacts' | 'settings'): void {
  const target: Route =
    tab === 'chats'
      ? { name: 'conversations' }
      : tab === 'contacts'
        ? { name: 'contacts' }
        : { name: 'settings' };

  const stack = routerStore.get().stack;
  const top = stack[stack.length - 1];

  // 已经在目标标签根页面时不动，避免无意义的重渲染
  if (stack.length === 1 && top?.name === target.name) return;

  reset(target);
}

/** 当前是否还有上一页（根页面返回 false） */
export function canGoBack(): boolean {
  return routerStore.get().stack.length > 1;
}

/** 订阅路由变化（用于同步「能否返回」给原生） */
export function subscribeRoute(listener: () => void): () => void {
  return routerStore.subscribe(listener);
}
