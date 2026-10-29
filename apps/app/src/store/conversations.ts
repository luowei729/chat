/**
 * ============================================================
 * 会话与消息状态
 * ------------------------------------------------------------
 * 设计要点：
 * 1. 会话列表按「最后消息时间」倒序，置顶优先；
 * 2. 消息按会话分组存储，避免切换会话时重新拉取；
 * 3. 本地乐观更新：发送消息立即插入 UI（状态 sending），
 *    服务端确认后替换为真实消息（状态 sent），失败标 failed；
 * 4. 未读数在本地累加，打开会话时清零。
 * ============================================================
 */

import type { ConversationSummary, Message, MessagePreview } from '@chat/shared';
import { createStore, useStore } from './base.js';

/* ------------------------------------------------------------------ */
/* 会话列表                                                             */
/* ------------------------------------------------------------------ */

export interface ConversationsState {
  /** 会话摘要列表（已排序） */
  list: ConversationSummary[];
  /** 是否已加载过（区分「加载中」与「真的没有会话」） */
  loaded: boolean;
  /** 正在加载 */
  loading: boolean;
}

export const conversationsStore = createStore<ConversationsState>({
  list: [],
  loaded: false,
  loading: false,
});

export function useConversations(): ConversationsState {
  return useStore(conversationsStore);
}

/** 整体替换列表（首次加载/下拉刷新） */
export function setConversations(list: ConversationSummary[]): void {
  conversationsStore.set({ list: sortConversations(list), loaded: true, loading: false });
}

/** 设置加载状态 */
export function setConversationsLoading(loading: boolean): void {
  conversationsStore.set((prev) => ({ ...prev, loading }));
}

/** 排序规则：置顶优先，其次按最后消息时间倒序 */
function sortConversations(list: ConversationSummary[]): ConversationSummary[] {
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt);
  });
}

/**
 * 收到新消息：更新对应会话的摘要与未读数
 * @param activeConversationId 当前打开的会话 id（该会话不累加未读数）
 */
export function applyNewMessage(
  conversationId: string,
  message: Message,
  activeConversationId: string | null,
): void {
  conversationsStore.set((prev) => {
    const idx = prev.list.findIndex((c) => c.id === conversationId);
    if (idx < 0) {
      // 未知会话：说明是别人新建的会话，需要重新拉列表
      return prev;
    }

    const target = prev.list[idx]!;
    const preview: MessagePreview = {
      id: message.id,
      type: message.type,
      senderId: message.senderId,
      senderName: message.senderName,
      summary: buildSummary(message),
      createdAt: message.createdAt,
    };

    const updated: ConversationSummary = {
      ...target,
      lastMessage: preview,
      lastMessageAt: message.createdAt,
      // 当前打开的会话不增加未读
      unreadCount:
        conversationId === activeConversationId
          ? target.unreadCount
          : target.unreadCount + 1,
    };

    const list = [...prev.list];
    list[idx] = updated;
    return { ...prev, list: sortConversations(list) };
  });
}

/** 生成消息摘要文案（与服务端规则保持一致） */
function buildSummary(message: Message): string {
  switch (message.type) {
    case 'text':
      return (message.text ?? '').slice(0, 80);
    case 'image':
      return '[图片]';
    case 'video':
      return '[视频]';
    case 'audio': {
      const ms = message.attachments[0]?.durationMs ?? 0;
      const sec = ms > 0 ? Math.max(1, Math.round(ms / 1000)) : 0;
      return sec > 0 ? `[语音] ${sec}″` : '[语音]';
    }
    case 'file':
      return '[文件]';
    case 'call':
      return message.text ?? '[通话]';
    case 'system':
      return message.text ?? '';
    default:
      return '[消息]';
  }
}

/** 清零某会话未读数（进入会话时调用） */
export function clearUnread(conversationId: string): void {
  conversationsStore.set((prev) => {
    const idx = prev.list.findIndex((c) => c.id === conversationId);
    if (idx < 0) return prev;
    const target = prev.list[idx]!;
    if (target.unreadCount === 0) return prev;
    const list = [...prev.list];
    list[idx] = { ...target, unreadCount: 0 };
    return { ...prev, list };
  });
}

/** 更新会话个人设置（置顶/免打扰） */
export function updateConversationPrefs(
  conversationId: string,
  prefs: { pinned?: boolean; muted?: boolean },
): void {
  conversationsStore.set((prev) => {
    const idx = prev.list.findIndex((c) => c.id === conversationId);
    if (idx < 0) return prev;
    const list = [...prev.list];
    list[idx] = { ...prev.list[idx]!, ...prefs };
    return { ...prev, list: sortConversations(list) };
  });
}

/** 新增会话（收到 conversation.new 时触发列表刷新前的占位） */
export function upsertConversation(summary: ConversationSummary): void {
  conversationsStore.set((prev) => {
    const idx = prev.list.findIndex((c) => c.id === summary.id);
    const list = [...prev.list];
    if (idx >= 0) list[idx] = summary;
    else list.push(summary);
    return { ...prev, list: sortConversations(list) };
  });
}

/* ------------------------------------------------------------------ */
/* 消息（按会话分组）                                                    */
/* ------------------------------------------------------------------ */

export interface MessagesState {
  /** conversationId → 消息列表（按 seq 升序） */
  byConversation: Record<string, Message[]>;
  /** conversationId → 是否还有更多历史 */
  hasMore: Record<string, boolean>;
  /** conversationId → 是否正在加载 */
  loading: Record<string, boolean>;
}

export const messagesStore = createStore<MessagesState>({
  byConversation: {},
  hasMore: {},
  loading: {},
});

export function useMessages(conversationId: string): {
  messages: Message[];
  hasMore: boolean;
  loading: boolean;
} {
  const state = useStore(messagesStore);
  return {
    messages: state.byConversation[conversationId] ?? [],
    hasMore: state.hasMore[conversationId] ?? false,
    loading: state.loading[conversationId] ?? false,
  };
}

/** 设置某会话的消息列表（首次加载） */
export function setMessages(
  conversationId: string,
  messages: Message[],
  hasMore: boolean,
): void {
  messagesStore.set((prev) => ({
    ...prev,
    byConversation: { ...prev.byConversation, [conversationId]: sortMessages(messages) },
    hasMore: { ...prev.hasMore, [conversationId]: hasMore },
    loading: { ...prev.loading, [conversationId]: false },
  }));
}

/** 前插历史消息（上拉加载更多） */
export function prependMessages(
  conversationId: string,
  older: Message[],
  hasMore: boolean,
): void {
  messagesStore.set((prev) => {
    const existing = prev.byConversation[conversationId] ?? [];
    // 去重：避免重复拉取同一页
    const existingIds = new Set(existing.map((m) => m.id));
    const fresh = older.filter((m) => !existingIds.has(m.id));
    return {
      ...prev,
      byConversation: {
        ...prev.byConversation,
        [conversationId]: sortMessages([...fresh, ...existing]),
      },
      hasMore: { ...prev.hasMore, [conversationId]: hasMore },
      loading: { ...prev.loading, [conversationId]: false },
    };
  });
}

/** 设置加载状态 */
export function setMessagesLoading(conversationId: string, loading: boolean): void {
  messagesStore.set((prev) => ({
    ...prev,
    loading: { ...prev.loading, [conversationId]: loading },
  }));
}

/** 按 seq 升序排序 */
function sortMessages(list: Message[]): Message[] {
  return [...list].sort((a, b) => a.seq - b.seq);
}

/** 追加一条新消息（收到推送或发送成功） */
export function appendMessage(conversationId: string, message: Message): void {
  messagesStore.set((prev) => {
    const existing = prev.byConversation[conversationId] ?? [];

    // 幂等：同 id 或同 clientId 的消息不重复插入
    const dupIndex = existing.findIndex(
      (m) =>
        m.id === message.id ||
        (message.clientId && m.clientId === message.clientId),
    );

    if (dupIndex >= 0) {
      // 已存在（乐观更新占位）→ 用服务端数据替换
      const list = [...existing];
      list[dupIndex] = message;
      return {
        ...prev,
        byConversation: { ...prev.byConversation, [conversationId]: list },
      };
    }

    return {
      ...prev,
      byConversation: {
        ...prev.byConversation,
        [conversationId]: sortMessages([...existing, message]),
      },
    };
  });
}

/** 插入本地乐观消息（发送中） */
export function insertOptimistic(conversationId: string, message: Message): void {
  messagesStore.set((prev) => {
    const existing = prev.byConversation[conversationId] ?? [];
    return {
      ...prev,
      byConversation: {
        ...prev.byConversation,
        [conversationId]: [...existing, message],
      },
    };
  });
}

/** 标记消息发送失败 */
export function markMessageFailed(conversationId: string, clientId: string): void {
  messagesStore.set((prev) => {
    const existing = prev.byConversation[conversationId];
    if (!existing) return prev;
    const list = existing.map((m) =>
      m.clientId === clientId ? { ...m, localStatus: 'failed' as const } : m,
    );
    return { ...prev, byConversation: { ...prev.byConversation, [conversationId]: list } };
  });
}

/** 移除消息（撤回） */
export function removeMessage(conversationId: string, messageId: string): void {
  messagesStore.set((prev) => {
    const existing = prev.byConversation[conversationId];
    if (!existing) return prev;
    return {
      ...prev,
      byConversation: {
        ...prev.byConversation,
        [conversationId]: existing.filter((m) => m.id !== messageId),
      },
    };
  });
}

/** 清空所有消息缓存（退出登录） */
export function clearMessages(): void {
  messagesStore.set({ byConversation: {}, hasMore: {}, loading: {} });
}
