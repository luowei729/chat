/**
 * ============================================================
 * 通讯录
 * ------------------------------------------------------------
 * 功能：
 * 1. 好友列表（备注名优先显示）；
 * 2. 顶部入口：新的朋友（带红点）、添加好友；
 * 3. 点击好友 → 直接进入私聊；
 * 4. 长按/点击头像 → 他人资料页（可改备注、删好友、拉黑）；
 * 5. 分页加载：本布局下不能用滚动容器，用「加载更多」按钮代替。
 *
 * 【布局约束】不用 scroll-view / list（本项目集成下会空白），
 * 全部纯 view；所有长度带单位字符串。
 * ============================================================
 */

import { useEffect, useState } from '@lynx-js/react';
import type { FriendItem } from '@chat/shared';
import { createDirect } from '../api/index.js';
import { pop, push } from '../router.js';
import { refreshFriends, useFriends } from '../store/friends.js';
import { colors, commonStyles, fontSize, radius, spacing } from '../theme.js';
import { TabBar } from './TabBar.js';

/** 每页条数：一屏大约能放 8 条，取 8 保证不需要滚动 */
const PAGE_SIZE = 8;

export function ContactsPage() {
  const { friends, requests, loaded, loading } = useFriends();
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refreshFriends();
  }, []);

  const visible = friends.slice(0, page * PAGE_SIZE);
  const hasMore = visible.length < friends.length;

  /** 点好友：进入私聊（没有会话则先创建） */
  const openChat = async (f: FriendItem) => {
    if (busy) return;
    if (f.conversationId) {
      push({
        name: 'chat',
        params: { conversationId: f.conversationId, title: f.displayName },
      });
      return;
    }
    setBusy(true);
    try {
      const r = await createDirect(f.userId);
      push({ name: 'chat', params: { conversationId: r.conversationId, title: f.displayName } });
    } catch {
      // 失败静默：用户可以重试
    } finally {
      setBusy(false);
    }
  };

  return (
    <view style={commonStyles.page}>
      {/* 标题栏（Telegram 风格）：标题左对齐，右侧只留「添加」图标 */}
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
          联系人
        </text>

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
          <text style={{ fontSize: '20px', color: colors.primary }}>➕</text>
        </view>
      </view>

      {/*
        内容区：绝对定位锁定在「标题栏下沿」到「底部导航上沿」之间。
        ------------------------------------------------------------
        为什么不用 flex:1：
        实测本页 flex:1 拿不到剩余高度，导致子卡片被 flexShrink
        压扁、互相重叠（数据都在，只是布局错乱）。
        position:absolute + top/bottom 是确定的坐标约束，
        完全不依赖父级的 flex 分配，在任何渲染时机下都稳定。
        标题栏 56px、底部导航 56px 是固定值，直接写死。
      */}
      <view
        style={{
          position: 'absolute',
          left: 0,
          top: '56px',
          right: 0,
          bottom: '56px',
          display: 'flex',
          flexDirection: 'column',
          paddingLeft: spacing.lg,
          paddingRight: spacing.lg,
          paddingTop: spacing.md,
        }}
      >
        {/* 新的朋友入口 */}
        <view
          style={{
            width: '100%',
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: colors.card,
            borderWidth: '1px',
            borderColor: colors.cardBorder,
            borderRadius: radius.md,
            padding: spacing.md,
            marginBottom: spacing.md,
          }}
          bindtap={() => push({ name: 'friend-requests' })}
        >
          <view
            style={{
              width: '40px',
              height: '40px',
              borderRadius: radius.md,
              backgroundColor: colors.warning,
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              marginRight: spacing.md,
            }}
          >
            <text style={{ fontSize: '20px', color: '#FFFFFF' }}>+</text>
          </view>
          <view style={{ flexGrow: 1, flexShrink: 1, flexBasis: '0px' }}>
            <text style={{ color: colors.text, fontSize: fontSize.md }}>新的朋友</text>
          </view>
          {requests.incoming.length > 0 ? (
            <view
              style={{
                minWidth: '20px',
                height: '20px',
                borderRadius: radius.full,
                backgroundColor: colors.danger,
                display: 'flex',
                flexDirection: 'row', width: '100%',
                alignItems: 'center',
                justifyContent: 'center',
                paddingLeft: '6px',
                paddingRight: '6px',
              }}
            >
              <text style={{ color: '#FFFFFF', fontSize: '11px', fontWeight: '600' }}>
                {String(requests.incoming.length)}
              </text>
            </view>
          ) : null}
        </view>

        {/* 好友数量提示 */}
        <view
          style={{
            width: '100%',
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: spacing.sm,
          }}
        >
          <text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>
            {loaded ? `好友 ${String(friends.length)} 位` : '加载中…'}
          </text>
          {loading ? (
            <text style={{ color: colors.textFaint, fontSize: fontSize.xs }}>刷新中</text>
          ) : null}
        </view>

        {/* 好友列表 */}
        {visible.map((f) => (
          <FriendRow key={f.userId} friend={f} onChat={() => void openChat(f)} />
        ))}

        {/* 空状态 */}
        {loaded && friends.length === 0 ? (
          <view
            style={{
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              paddingTop: '48px',
            }}
          >
            <text style={{ color: colors.textMuted, fontSize: fontSize.md }}>还没有好友</text>
            <text
              style={{
                color: colors.textFaint,
                fontSize: fontSize.sm,
                marginTop: spacing.sm,
                textAlign: 'center',
              }}
            >
              点右上角「添加」，用邮箱或昵称搜索
            </text>
          </view>
        ) : null}

        {/* 加载更多 */}
        {hasMore ? (
          <view
            style={{
              width: '100%',
              height: '44px',
              borderRadius: radius.md,
              borderWidth: '1px',
              borderColor: colors.cardBorder,
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: spacing.sm,
            }}
            bindtap={() => setPage((p) => p + 1)}
          >
            <text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>
              加载更多（{String(friends.length - visible.length)} 位待显示）
            </text>
          </view>
        ) : null}
      </view>

      {/* 底部导航 */}
      <TabBar
        active="contacts"
        onChange={(key) => {
          if (key === 'chats') pop();
          else if (key === 'settings') push({ name: 'settings' });
        }}
        contactBadge={requests.incoming.length}
      />
    </view>
  );
}

/* ------------------------------------------------------------------ */
/* 好友行                                                               */
/* ------------------------------------------------------------------ */

function FriendRow(props: { friend: FriendItem; onChat: () => void }) {
  const { friend: f, onChat } = props;
  const initial = f.displayName.slice(0, 1).toUpperCase();

  return (
    <view
      style={{
        width: '100%',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.card,
        borderWidth: '1px',
        borderColor: colors.cardBorder,
        borderRadius: radius.md,
        padding: spacing.md,
        marginBottom: spacing.sm,
      }}
    >
      {/* 头像 → 资料页 */}
      <view
        style={{
          width: '42px',
          height: '42px',
          borderRadius: radius.full,
          backgroundColor: colors.primarySoft,
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          marginRight: spacing.md,
        }}
        bindtap={() => push({ name: 'user-profile', params: { userId: f.userId } })}
      >
        <text style={{ color: colors.primary, fontSize: fontSize.md, fontWeight: '600' }}>
          {initial}
        </text>
      </view>

      {/* 名字区 → 进入聊天 */}
      <view
        style={{ flexGrow: 1, flexShrink: 1, flexBasis: '0px', display: 'flex', flexDirection: 'column' }}
        bindtap={onChat}
      >
        <text style={{ color: colors.text, fontSize: fontSize.md }} text-maxline="1">
          {f.displayName}
        </text>
        {f.bio ? (
          <text style={{ color: colors.textFaint, fontSize: fontSize.xs }} text-maxline="1">
            {f.bio}
          </text>
        ) : (
          <text style={{ color: colors.textFaint, fontSize: fontSize.xs }} text-maxline="1">
            {f.email}
          </text>
        )}
      </view>

      {/* 详情入口 */}
      <view
        style={{
          width: '32px',
          height: '32px',
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        bindtap={() => push({ name: 'user-profile', params: { userId: f.userId } })}
      >
        <text style={{ color: colors.textFaint, fontSize: fontSize.lg }}>›</text>
      </view>
    </view>
  );
}
