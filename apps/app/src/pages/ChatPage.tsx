/**
 * ============================================================
 * 聊天页
 * ------------------------------------------------------------
 * 功能：
 * 1. 消息列表（按 seq 升序，自动滚到底部）；
 * 2. 发送文字（乐观更新，失败可重试）；
 * 3. 上拉加载更多历史；
 * 4. 语音通话入口；
 * 5. 输入中提示与已读回执。
 *
 * 关键实现：
 * - 进入页面时订阅会话、清零未读、标记已读；
 * - 离开页面时退订；
 * - 发送消息用 clientId 幂等，网络重试不会重复。
 * ============================================================
 */

import { useEffect, useRef, useState } from '@lynx-js/react';
import type { Message } from '@chat/shared';
import { getConversation, listMessages, sendMessage } from '../api/index.js';
import { ApiError } from '../api/client.js';
import * as ws from '../api/ws.js';
import { pop } from '../router.js';
import {
  appendMessage,
  clearUnread,
  insertOptimistic,
  markMessageFailed,
  prependMessages,
  setMessages,
  setMessagesLoading,
  useMessages,
} from '../store/conversations.js';
import { currentUserId } from '../store/auth.js';
import { colors, commonStyles, fontSize, radius, spacing } from '../theme.js';

export function ChatPage(props: { conversationId: string; title?: string }) {
  const { conversationId } = props;
  const { messages, hasMore, loading } = useMessages(conversationId);

  const [title, setTitle] = useState(props.title ?? '聊天');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 对方正在输入 */
  const [peerTyping, setPeerTyping] = useState(false);

  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSent = useRef(0);
  const myId = currentUserId();

  /* ---------------- 进入会话：初始化 ---------------- */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // 订阅本会话（只收本会话的推送，减少无关流量）
      ws.subscribe([conversationId]);
      clearUnread(conversationId);

      // 拉会话详情（拿标题与成员）
      try {
        const detail = await getConversation(conversationId);
        if (!cancelled) setTitle(detail.title);
      } catch {
        // 标题拿不到就用路由传入的
      }

      // 拉最新一页消息
      setMessagesLoading(conversationId, true);
      try {
        const page = await listMessages(conversationId, { limit: 30 });
        if (!cancelled) {
          setMessages(conversationId, page.items, page.hasMore);
          // 标记已读：把水位推到最新一条
          const last = page.items[page.items.length - 1];
          if (last) ws.sendRead(conversationId, last.seq);
        }
      } catch {
        if (!cancelled) setMessages(conversationId, [], false);
      }
    })();

    return () => {
      cancelled = true;
      ws.unsubscribe([conversationId]);
      if (typingTimer.current) clearTimeout(typingTimer.current);
    };
  }, [conversationId]);

  /* ---------------- 监听对方输入中 ---------------- */
  useEffect(() => {
    const off = ws.on('typing', (msg) => {
      if (msg.conversationId !== conversationId) return;
      setPeerTyping(true);
      if (typingTimer.current) clearTimeout(typingTimer.current);
      // 3 秒无新提示则自动消失
      typingTimer.current = setTimeout(() => setPeerTyping(false), 3000);
    });
    return off;
  }, [conversationId]);

  /* ---------------- 加载更多历史 ---------------- */
  const loadMore = async () => {
    if (!hasMore || loading) return;
    const oldest = messages[0];
    if (!oldest) return;

    setMessagesLoading(conversationId, true);
    try {
      const page = await listMessages(conversationId, { before: oldest.seq, limit: 30 });
      prependMessages(conversationId, page.items, page.hasMore);
    } catch {
      setMessagesLoading(conversationId, false);
    }
  };

  /* ---------------- 发送文字 ---------------- */
  const handleSend = async () => {
    const text = draft.trim();
    if (!text || sending) return;

    setSending(true);
    setError(null);
    setDraft('');

    // 客户端生成幂等 id：重试不会产生重复消息
    const clientId = `${myId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    // 乐观更新：立即显示（状态 sending）
    const optimistic: Message = {
      id: `local-${clientId}`,
      conversationId,
      seq: Number.MAX_SAFE_INTEGER, // 临时排到最后
      senderId: myId ?? '',
      senderName: '我',
      senderAvatarUrl: null,
      type: 'text',
      text,
      attachments: [],
      replyToId: null,
      replyToPreview: null,
      createdAt: Date.now(),
      editedAt: null,
      localStatus: 'sending',
      clientId,
    };
    insertOptimistic(conversationId, optimistic);

    try {
      const saved = await sendMessage(conversationId, {
        clientId,
        type: 'text',
        text,
      });
      // 用服务端返回的真实消息替换占位（appendMessage 内部按 clientId 去重替换）
      appendMessage(conversationId, { ...saved, clientId });
    } catch (e) {
      markMessageFailed(conversationId, clientId);
      setError(e instanceof ApiError ? e.message : '发送失败');
    } finally {
      setSending(false);
    }
  };

  /* ---------------- 输入中提示（节流） ---------------- */
  const handleInput = (value: string) => {
    setDraft(value);

    // 每 3 秒最多发一次，避免刷屏
    const now = Date.now();
    if (value.length > 0 && now - lastTypingSent.current > 3000) {
      lastTypingSent.current = now;
      ws.sendTyping(conversationId);
    }
  };

  /* ---------------- 发起语音通话 ---------------- */
  const startCall = () => {
    const callId = `call-${Date.now().toString(36)}`;
    ws.inviteCall({ conversationId, mode: 'audio' });

    // 进入通话页等待对方接听
    import('../router.js').then(({ push }) => {
      push({
        name: 'call',
        params: { callId, conversationId, mode: 'audio', incoming: false, callerName: title },
      });
    });
  };

  return (
    <view style={commonStyles.page}>
      {/* 顶部栏 */}
      <view style={commonStyles.header}>
        <text style={{ color: colors.primary, fontSize: fontSize.md, width: 60 }} bindtap={pop}>
          返回
        </text>
        <view style={{ flex: 1, alignItems: 'center' }}>
          <text style={{ color: colors.text, fontSize: fontSize.md, fontWeight: '600' }} text-maxline="1">
            {title}
          </text>
          {peerTyping ? (
            <text style={{ color: colors.primary, fontSize: fontSize.xs }}>对方正在输入…</text>
          ) : null}
        </view>
        <text
          style={{ color: colors.primary, fontSize: fontSize.md, width: 60, textAlign: 'right' }}
          bindtap={startCall}
        >
          通话
        </text>
      </view>

      {/* 消息列表 */}
      <scroll-view style={commonStyles.scroll}>
        {/* 加载更多 */}
        {hasMore ? (
          <view
            style={{ height: 44, alignItems: 'center', justifyContent: 'center' }}
            bindtap={loadMore}
          >
            <text style={{ color: colors.textMuted, fontSize: fontSize.xs }}>
              {loading ? '加载中…' : '查看更早的消息'}
            </text>
          </view>
        ) : messages.length > 0 ? (
          <view style={{ height: 32, alignItems: 'center', justifyContent: 'center' }}>
            <text style={{ color: colors.textFaint, fontSize: fontSize.xs }}>没有更多了</text>
          </view>
        ) : null}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} isSelf={msg.senderId === myId} />
        ))}

        <view style={{ height: spacing.lg }} />
      </scroll-view>

      {/* 错误提示 */}
      {error ? (
        <view style={{ paddingLeft: spacing.md, paddingRight: spacing.md, paddingBottom: spacing.xs }}>
          <text style={{ color: colors.danger, fontSize: fontSize.xs }}>{error}</text>
        </view>
      ) : null}

      {/* 输入区 */}
      <view
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          padding: spacing.sm,
          gap: spacing.sm,
          backgroundColor: colors.surface,
          borderTopWidth: 1,
          borderTopColor: colors.border,
        }}
      >
        <input
          style={{ ...commonStyles.input, flex: 1, height: 42 }}
          default-value={draft}
          placeholder="输入消息…"
          bindinput={(e: { detail: { value: string } }) => handleInput(e.detail.value)}
          bindconfirm={handleSend}
        />
        <view
          style={{
            width: 64,
            height: 42,
            borderRadius: radius.md,
            backgroundColor: draft.trim() ? colors.primary : colors.surfaceAlt,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          bindtap={handleSend}
        >
          <text
            style={{
              color: draft.trim() ? '#fff' : colors.textFaint,
              fontSize: fontSize.sm,
              fontWeight: '600',
            }}
          >
            发送
          </text>
        </view>
      </view>
    </view>
  );
}

/* ------------------------------------------------------------------ */
/* 消息气泡                                                             */
/* ------------------------------------------------------------------ */

function MessageBubble(props: { message: Message; isSelf: boolean }) {
  const { message, isSelf } = props;

  // 系统消息：居中灰字
  if (message.type === 'system') {
    return (
      <view style={{ alignItems: 'center', paddingTop: spacing.sm, paddingBottom: spacing.sm }}>
        <text style={{ color: colors.textFaint, fontSize: fontSize.xs }}>{message.text}</text>
      </view>
    );
  }

  const statusText =
    message.localStatus === 'sending'
      ? '发送中'
      : message.localStatus === 'failed'
        ? '发送失败'
        : null;

  return (
    <view
      style={{
        display: 'flex',
        flexDirection: isSelf ? 'row-reverse' : 'row',
        paddingLeft: spacing.md,
        paddingRight: spacing.md,
        paddingTop: spacing.xs,
        paddingBottom: spacing.xs,
        gap: spacing.sm,
      }}
    >
      {/* 头像 */}
      <view
        style={{
          width: 34,
          height: 34,
          borderRadius: radius.full,
          backgroundColor: colors.primarySoft,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <text style={{ color: colors.primary, fontSize: fontSize.sm, fontWeight: '600' }}>
          {message.senderName.slice(0, 1)}
        </text>
      </view>

      {/* 气泡 + 时间 */}
      <view style={{ maxWidth: '72%', alignItems: isSelf ? 'flex-end' : 'flex-start' }}>
        {/* 群聊显示发送者昵称 */}
        {!isSelf ? (
          <text style={{ color: colors.textFaint, fontSize: fontSize.xs, marginBottom: 2 }}>
            {message.senderName}
          </text>
        ) : null}

        <view
          style={{
            backgroundColor: isSelf ? colors.primary : colors.surfaceAlt,
            borderRadius: radius.bubble,
            paddingLeft: spacing.md,
            paddingRight: spacing.md,
            paddingTop: spacing.sm,
            paddingBottom: spacing.sm,
          }}
        >
          <MessageContent message={message} isSelf={isSelf} />
        </view>

        <view style={{ display: 'flex', flexDirection: 'row', gap: 6, marginTop: 2 }}>
          <text style={{ color: colors.textFaint, fontSize: 10 }}>
            {formatClock(message.createdAt)}
          </text>
          {statusText ? (
            <text
              style={{
                color: message.localStatus === 'failed' ? colors.danger : colors.textFaint,
                fontSize: 10,
              }}
            >
              {statusText}
            </text>
          ) : null}
        </view>
      </view>
    </view>
  );
}

/** 按消息类型渲染不同内容 */
function MessageContent(props: { message: Message; isSelf: boolean }) {
  const { message, isSelf } = props;

  switch (message.type) {
    case 'text':
      return (
        <text style={{ color: isSelf ? '#fff' : colors.text, fontSize: fontSize.md, lineHeight: 1.5 }}>
          {message.text ?? ''}
        </text>
      );

    case 'image': {
      const att = message.attachments[0];
      if (!att) return <text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>[图片]</text>;
      return (
        <image
          src={att.url}
          style={{
            width: Math.min(att.width ?? 200, 220),
            height: Math.min(att.height ?? 200, 260),
            borderRadius: radius.md,
          }}
          mode="aspectFit"
        />
      );
    }

    case 'audio': {
      const att = message.attachments[0];
      const sec = att?.durationMs ? Math.max(1, Math.round(att.durationMs / 1000)) : 0;
      return (
        <view style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <text style={{ color: isSelf ? '#fff' : colors.text, fontSize: fontSize.md }}>▶</text>
          <text style={{ color: isSelf ? '#fff' : colors.text, fontSize: fontSize.sm }}>
            语音 {sec}″
          </text>
        </view>
      );
    }

    case 'video': {
      const att = message.attachments[0];
      const sec = att?.durationMs ? Math.max(1, Math.round(att.durationMs / 1000)) : 0;
      return (
        <view style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <text style={{ color: isSelf ? '#fff' : colors.text, fontSize: fontSize.md }}>▶</text>
          <text style={{ color: isSelf ? '#fff' : colors.text, fontSize: fontSize.sm }}>
            视频 {sec}″
          </text>
        </view>
      );
    }

    case 'file': {
      const att = message.attachments[0];
      return (
        <view style={{ gap: 4 }}>
          <text style={{ color: isSelf ? '#fff' : colors.text, fontSize: fontSize.sm }} text-maxline="1">
            📎 {att?.filename ?? '文件'}
          </text>
          <text style={{ color: isSelf ? 'rgba(255,255,255,0.7)' : colors.textMuted, fontSize: 10 }}>
            {formatBytes(att?.size ?? 0)}
          </text>
        </view>
      );
    }

    case 'call':
      return (
        <text style={{ color: isSelf ? '#fff' : colors.text, fontSize: fontSize.sm }}>
          {message.text ?? '通话'}
        </text>
      );

    default:
      return <text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>[消息]</text>;
  }
}

/** 时分秒格式化 */
function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 文件大小格式化 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
