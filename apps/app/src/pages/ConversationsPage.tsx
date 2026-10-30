/**
 * ============================================================
 * 聊天列表（首页，Telegram 风格）
 * ------------------------------------------------------------
 * 结构：
 *   标题栏  「聊天」 + 搜索 / 新建 图标
 *   会话列表（置顶优先，按最后消息时间排序）
 *   底部导航  聊天 / 联系人 / 设置
 *
 * 设计口径（对齐 Telegram）：
 * 1. 标题左对齐、大字号；操作靠图标而不用文字按钮；
 * 2. 主导航全部下沉到底部 Tab，标题栏不再塞业务入口；
 * 3. 未读红点聚合到「聊天」Tab 上，单会话红点同时保留。
 * ============================================================
 */

import { useState } from '@lynx-js/react';
import type { ConversationSummary } from '@chat/shared';
import { listConversations } from '../api/index.js';
import { push, switchTab } from '../router.js';
import { setConversations, useConversations } from '../store/conversations.js';
import { colors, commonStyles, fontSize, radius, spacing } from '../theme.js';
import { TabBar } from './TabBar.js';
import { IconChat, IconCompose, IconSearch } from './Icons.js';

export function ConversationsPage() {
  const { list, loaded, loading } = useConversations();
  const [refreshing, setRefreshing] = useState(false);

  /** 全部会话的未读总数（给底部「聊天」Tab 用） */
  const totalUnread = list.reduce((sum, c) => sum + (c.unreadCount ?? 0), 0);

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

  void refresh;
  void refreshing;

  /** 进入聊天页 */
  const openChat = (conv: ConversationSummary) => {
    push({
      name: 'chat',
      params: { conversationId: conv.id, title: conv.title },
    });
  };

  return (
    <view style={commonStyles.page}>
      {/*
        顶部栏（Telegram 风格）
        ------------------------------------------------------------
        左侧：页面标题「聊天」
        右侧：搜索、新建 两个图标按钮
        不再把「通讯录 / 邀请 / 我」塞进标题栏 ——
        这些入口由底部 Tab 承担，与 Telegram 一致。
      */}
      <view
        style={{
          width: '100%',
          height: '56px',
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingLeft: spacing.lg,
          paddingRight: spacing.lg,
          backgroundColor: colors.surface,
          borderBottomWidth: '1px',
          borderBottomColor: colors.border,
        }}
      >
        <text style={{ color: colors.text, fontSize: fontSize.xl, fontWeight: '700' }}>
          聊天
        </text>

        <view style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
          <view
            style={{
              width: '40px',
              height: '40px',
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            bindtap={() => push({ name: 'search-messages' })}
          >
            <IconSearch size={23} color={colors.text} />
          </view>
          <view
            style={{
              width: '40px',
              height: '40px',
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            bindtap={() => push({ name: 'new-chat' })}
          >
            <IconCompose size={23} color={colors.text} />
          </view>
        </view>
      </view>

      {/* 会话列表 */}
      {/* paddingBottom 给底部导航留位（TabBar 是绝对定位） */}
      <view style={{ flex: 1, width: '100%', display: 'flex', flexDirection: 'column', paddingBottom: '64px' }}>
        {!loaded || (loading && list.length === 0) ? (
          <view style={{ padding: spacing.xl, alignItems: 'center' }}>
            <text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>加载中…</text>
          </view>
        ) : list.length === 0 ? (
          <view
            style={{
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              paddingTop: '80px',
              paddingLeft: spacing.xxl,
              paddingRight: spacing.xxl,
            }}
          >
            <view
              style={{
                width: '84px',
                height: '84px',
                borderRadius: '28px',
                backgroundColor: colors.surfaceAlt,
                borderWidth: '1px',
                borderColor: colors.cardBorder,
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: spacing.lg,
              }}
            >
              <IconChat size={40} color={colors.textFaint} />
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
      </view>

      {/* 底部导航（Telegram 三栏：聊天 / 联系人 / 设置） */}
      <TabBar
        active="chats"
        onChange={switchTab}
        chatBadge={totalUnread}
      />
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
        flexDirection: 'row', width: '100%',
        alignItems: 'center',
        padding: spacing.md,
        borderBottomWidth: '1px',
        borderBottomColor: colors.border,
        backgroundColor: conv.pinned ? colors.surfaceAlt : 'transparent',
      }}
      bindtap={onTap}
    >
      {/* 头像：有图显示图，无图显示昵称首字 */}
      <view
        style={{
          width: '46px',
          height: '46px',
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
            style={{ width: '46px', height: '46px', borderRadius: radius.full }}
          />
        ) : (
          <text style={{ color: colors.primary, fontSize: fontSize.lg, fontWeight: '600' }}>
            {conv.title.slice(0, 1)}
          </text>
        )}
      </view>

      {/* 标题 + 最后消息：用固定百分比宽度，避免 flex:1 在本父级链下塌成 0 */}
      <view style={{ width: '72%' }}>
        <view
          style={{
            display: 'flex',
            flexDirection: 'row', width: '100%',
            alignItems: 'center',
            marginBottom: '4px',
          }}
        >
          <view style={{ width: '76%', marginRight: spacing.sm }}>
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

        <view style={{ display: 'flex', flexDirection: 'row', width: '100%', alignItems: 'center' }}>
          <view style={{ width: '82%', marginRight: spacing.sm }}>
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
                minWidth: '18px',
                height: '18px',
                borderRadius: radius.full,
                backgroundColor: conv.muted ? colors.textFaint : colors.danger,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                paddingLeft: '5px',
                paddingRight: '5px',
              }}
            >
              <text style={{ color: '#fff', fontSize: '10px', fontWeight: '600' }}>
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
