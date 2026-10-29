/**
 * ============================================================
 * 会话列表页（首页）
 * ------------------------------------------------------------
 * 功能：
 * 1. 展示所有会话（置顶优先，按最后消息时间排序）；
 * 2. 未读数红点；
 * 3. 下拉刷新；
 * 4. 右上角入口：新建会话 / 我的邀请 / 我的资料。
 * ============================================================
 */

import { useState } from '@lynx-js/react';
import type { ConversationSummary } from '@chat/shared';
import { listConversations } from '../api/index.js';
import { push } from '../router.js';
import { setConversations, useConversations } from '../store/conversations.js';
import { useAuth } from '../store/auth.js';
import { colors, commonStyles, fontSize, radius, spacing } from '../theme.js';

export function ConversationsPage() {
  const { list, loaded, loading } = useConversations();
  const auth = useAuth();
  const [refreshing, setRefreshing] = useState(false);

  /** 刷新列表 */
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const data = await listConversations();
      setConversations(data);
    } catch {
      // 刷新失败保留旧数据，静默处理
    } finally {
      setRefreshing(false);
    }
  };

  /** 进入聊天页 */
  const openChat = (conv: ConversationSummary) => {
    push({
      name: 'chat',
      params: { conversationId: conv.id, title: conv.title },
    });
  };

  return (
    <view style={commonStyles.page}>
      {/* 顶部栏：品牌居左，动作用大按钮，全部垂直居中 */}
      <view style={commonStyles.header}>
        <view style={{ flex: 1, display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
          <view
            style={{
              width: 32,
              height: 32,
              borderRadius: 10,
              backgroundColor: colors.primary,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginRight: spacing.sm,
            }}
          >
            <text style={{ color: '#fff', fontSize: fontSize.md, fontWeight: '700' }}>C</text>
          </view>
          <text style={{ color: colors.text, fontSize: fontSize.lg, fontWeight: '700' }}>
            chat
          </text>
        </view>
        <text
          style={{
            color: colors.primary,
            fontSize: fontSize.sm,
            paddingLeft: spacing.sm,
            paddingRight: spacing.sm,
            paddingTop: spacing.xs,
            paddingBottom: spacing.xs,
          }}
          bindtap={() => push({ name: 'new-chat' })}
        >
          新建
        </text>
        <text
          style={{
            color: colors.textMuted,
            fontSize: fontSize.sm,
            padding: spacing.sm,
          }}
          bindtap={() => push({ name: 'invite' })}
        >
          邀请
        </text>
        <text
          style={{ color: colors.textMuted, fontSize: fontSize.sm, padding: spacing.sm }}
          bindtap={() => push({ name: 'profile' })}
        >
          我
        </text>
      </view>

      {/* 会话列表 */}
      <scroll-view scroll-orientation="vertical" style={commonStyles.scroll}>
        {!loaded || (loading && list.length === 0) ? (
          <view style={{ padding: spacing.xl, alignItems: 'center' }}>
            <text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>加载中…</text>
          </view>
        ) : list.length === 0 ? (
          <view
            style={{
              display: 'flex',
              alignItems: 'center',
              paddingTop: 100,
              paddingLeft: spacing.xxl,
              paddingRight: spacing.xxl,
            }}
          >
            <view
              style={{
                width: 84,
                height: 84,
                borderRadius: 28,
                backgroundColor: colors.surfaceAlt,
                borderWidth: 1,
                borderColor: colors.cardBorder,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: spacing.lg,
              }}
            >
              <text style={{ fontSize: 36 }}>💬</text>
            </view>
            <text style={{ color: colors.text, fontSize: fontSize.md, fontWeight: '600' }}>
              还没有会话
            </text>
            <text
              style={{
                color: colors.textFaint,
                fontSize: fontSize.sm,
                textAlign: 'center',
                marginTop: spacing.sm,
              }}
            >
              点击右上角「新建」，搜索邮箱或昵称发起聊天
            </text>
          </view>
        ) : (
          list.map((conv) => (
            <ConversationItem key={conv.id} conv={conv} onTap={() => openChat(conv)} />
          ))
        )}

        {/* 底部留白，避免最后一项贴边 */}
        <view style={{ height: spacing.xl }} />
      </scroll-view>

      {/* 刷新按钮（Lynx 各端下拉刷新手势不一致，用按钮兜底） */}
      <view
        style={{
          height: 40,
          borderTopWidth: 1,
          borderTopColor: colors.border,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        bindtap={refresh}
      >
        <text style={{ color: colors.textMuted, fontSize: fontSize.xs }}>
          {refreshing ? '刷新中…' : `已登录：${auth.user?.nickname ?? ''} · 点击刷新`}
        </text>
      </view>
    </view>
  );
}

/** 单个会话项 */
function ConversationItem(props: { conv: ConversationSummary; onTap: () => void }) {
  const { conv, onTap } = props;

  return (
    <view
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        padding: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        backgroundColor: conv.pinned ? colors.surfaceAlt : 'transparent',
      }}
      bindtap={onTap}
    >
      {/* 头像：有图显示图，无图显示昵称首字 */}
      <view
        style={{
          width: 46,
          height: 46,
          borderRadius: radius.full,
          backgroundColor: colors.primarySoft,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginRight: spacing.md,
        }}
      >
        {conv.avatarUrl ? (
          <image
            src={conv.avatarUrl}
            style={{ width: 46, height: 46, borderRadius: radius.full }}
          />
        ) : (
          <text style={{ color: colors.primary, fontSize: fontSize.lg, fontWeight: '600' }}>
            {conv.title.slice(0, 1)}
          </text>
        )}
      </view>

      {/* 标题 + 最后消息：用 view 包裹 text 做伸缩，避免 text 直接 flex 塌陷 */}
      <view style={{ flex: 1 }}>
        <view
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            marginBottom: 4,
          }}
        >
          <view style={{ flex: 1, marginRight: spacing.sm }}>
            <text
              style={{ color: colors.text, fontSize: fontSize.md, fontWeight: '500' }}
              text-maxline="1"
            >
              {conv.title}
              {conv.type === 'group' ? ` (${conv.memberCount})` : ''}
            </text>
          </view>
          <text style={{ color: colors.textFaint, fontSize: fontSize.xs }}>
            {formatTime(conv.lastMessageAt)}
          </text>
        </view>

        <view style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
          <view style={{ flex: 1, marginRight: spacing.sm }}>
            <text style={{ color: colors.textMuted, fontSize: fontSize.sm }} text-maxline="1">
              {conv.lastMessage
                ? `${conv.lastMessage.senderName}: ${conv.lastMessage.summary}`
                : '暂无消息'}
            </text>
          </view>

          {/* 未读红点 */}
          {conv.unreadCount > 0 ? (
            <view
              style={{
                minWidth: 18,
                height: 18,
                borderRadius: radius.full,
                backgroundColor: conv.muted ? colors.textFaint : colors.danger,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                paddingLeft: 5,
                paddingRight: 5,
              }}
            >
              <text style={{ color: '#fff', fontSize: 10, fontWeight: '600' }}>
                {conv.unreadCount > 99 ? '99+' : String(conv.unreadCount)}
              </text>
            </view>
          ) : null}
        </view>
      </view>
    </view>
  );
}

/**
 * 时间格式化
 * 规则：今天显示 HH:mm，昨天显示「昨天」，更早显示 MM-DD
 */
function formatTime(ts: number | null): string {
  if (!ts) return '';

  const d = new Date(ts);
  const now = new Date();

  const isSameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();

  if (isSameDay) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();

  if (isYesterday) return '昨天';

  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
