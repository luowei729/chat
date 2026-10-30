/**
 * ============================================================
 * 新的朋友（好友请求）
 * ------------------------------------------------------------
 * 两个分区：
 *   收到的 —— 可接受 / 拒绝
 *   发出的 —— 可撤回（删除请求）
 *
 * 布局约束：纯 view，不用滚动容器；列表过长时用分页按钮。
 * ============================================================
 */

import { useEffect, useState } from '@lynx-js/react';
import type { FriendRequestItem } from '@chat/shared';
import { acceptFriend, rejectFriend } from '../api/index.js';
import { pop, push } from '../router.js';
import { refreshFriends, useFriends } from '../store/friends.js';
import { colors, commonStyles, fontSize, radius, spacing } from '../theme.js';
import { IconBack } from './Icons.js';

export function FriendRequestsPage() {
  const { requests, loaded } = useFriends();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'incoming' | 'outgoing'>('incoming');

  useEffect(() => {
    void refreshFriends();
  }, []);

  const handleAccept = async (item: FriendRequestItem) => {
    if (busyId) return;
    setBusyId(item.userId);
    setError(null);
    try {
      const r = await acceptFriend(item.userId);
      await refreshFriends();
      // 接受后直接进入聊天
      if (r.conversationId) {
        push({
          name: 'chat',
          params: { conversationId: r.conversationId, title: item.nickname },
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败，请重试');
    } finally {
      setBusyId(null);
    }
  };

  const handleReject = async (item: FriendRequestItem) => {
    if (busyId) return;
    setBusyId(item.userId);
    setError(null);
    try {
      await rejectFriend(item.userId);
      await refreshFriends();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败，请重试');
    } finally {
      setBusyId(null);
    }
  };

  const list = tab === 'incoming' ? requests.incoming : requests.outgoing;

  return (
    <view style={commonStyles.page}>
      {/* 顶部栏 */}
      <view style={commonStyles.header}>
        <view
          style={{ ...commonStyles.headerSide, justifyContent: 'center' }}
          bindtap={pop}
        >
          <IconBack size={22} color={colors.text} />
        </view>
        <view style={commonStyles.headerCenter}>
          <text style={commonStyles.headerTitle}>新的朋友</text>
        </view>
        <view style={commonStyles.headerSide} />
      </view>

      {/* 分区切换 —— iOS 分段控件：灰底轨道 + 选中态白色滑块，不用描边 */}
      <view
        style={{
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          paddingLeft: spacing.lg,
          paddingRight: spacing.lg,
          paddingTop: spacing.md,
        }}
      >
        <view
          style={{
            width: '100%',
            height: '34px',
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: colors.surfaceAlt,
            borderRadius: radius.sm,
            paddingLeft: '3px',
            paddingRight: '3px',
          }}
        >
          <view
            style={{
              width: '48.8%',
              height: '28px',
              borderRadius: radius.xs,
              backgroundColor:
                tab === 'incoming' ? colors.cardElevated : 'transparent',
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            bindtap={() => setTab('incoming')}
          >
            <text
              style={{
                color: tab === 'incoming' ? colors.text : colors.textMuted,
                fontSize: fontSize.sm,
                fontWeight: tab === 'incoming' ? '600' : '400',
              }}
            >
              收到的 {String(requests.incoming.length)}
            </text>
          </view>
          <view
            style={{
              width: '48.8%',
              height: '28px',
              marginLeft: '1.5%',
              borderRadius: radius.xs,
              backgroundColor:
                tab === 'outgoing' ? colors.cardElevated : 'transparent',
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            bindtap={() => setTab('outgoing')}
          >
            <text
              style={{
                color: tab === 'outgoing' ? colors.text : colors.textMuted,
                fontSize: fontSize.sm,
                fontWeight: tab === 'outgoing' ? '600' : '400',
              }}
            >
              发出的 {String(requests.outgoing.length)}
            </text>
          </view>
        </view>
      </view>

      {/* 列表：绝对定位锁定在「标题栏+分区切换」下方，避免 flex:1 塌陷 */}
      <view
        style={{
          position: 'absolute',
          left: 0,
          top: '108px',
          right: 0,
          bottom: 0,
          display: 'flex',
          flexDirection: 'column',
          paddingLeft: spacing.lg,
          paddingRight: spacing.lg,
          paddingTop: spacing.md,
        }}
      >
        {error ? (
          <text style={{ color: colors.danger, fontSize: fontSize.sm, marginBottom: spacing.sm }}>
            {error}
          </text>
        ) : null}

        {list.map((item) => (
          <RequestRow
            key={item.userId}
            item={item}
            busy={busyId === item.userId}
            onAccept={() => void handleAccept(item)}
            onReject={() => void handleReject(item)}
          />
        ))}

        {loaded && list.length === 0 ? (
          <view
            style={{
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              paddingTop: '48px',
            }}
          >
            <text style={{ color: colors.textMuted, fontSize: fontSize.md }}>
              {tab === 'incoming' ? '没有收到好友请求' : '没有发出的请求'}
            </text>
            <text
              style={{
                color: colors.textFaint,
                fontSize: fontSize.sm,
                marginTop: spacing.sm,
                textAlign: 'center',
              }}
            >
              {tab === 'incoming'
                ? '别人加你为好友时会出现在这里'
                : '去通讯录「添加」里搜索用户'}
            </text>
          </view>
        ) : null}
      </view>
    </view>
  );
}

/* ------------------------------------------------------------------ */
/* 请求行                                                               */
/* ------------------------------------------------------------------ */

function RequestRow(props: {
  item: FriendRequestItem;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  const { item, busy, onAccept, onReject } = props;
  const initial = item.nickname.slice(0, 1).toUpperCase();

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
        bindtap={() => push({ name: 'user-profile', params: { userId: item.userId } })}
      >
        <text style={{ color: colors.primary, fontSize: fontSize.md, fontWeight: '600' }}>
          {initial}
        </text>
      </view>

      <view style={{ flexGrow: 1, flexShrink: 1, flexBasis: '0px', display: 'flex', flexDirection: 'column' }}>
        <text style={{ color: colors.text, fontSize: fontSize.md }} text-maxline="1">
          {item.nickname}
        </text>
        <text style={{ color: colors.textFaint, fontSize: fontSize.xs }} text-maxline="1">
          {item.email}
        </text>
      </view>

      {item.incoming ? (
        <view style={{ display: 'flex', flexDirection: 'row', width: '100%', alignItems: 'center' }}>
          <view
            style={{
              width: '56px',
              height: '34px',
              borderRadius: radius.md,
              backgroundColor: busy ? colors.surfaceAlt : colors.primary,
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              marginRight: spacing.sm,
            }}
            bindtap={onAccept}
          >
            <text style={{ color: '#FFFFFF', fontSize: fontSize.sm }}>接受</text>
          </view>
          <view
            style={{
              width: '56px',
              height: '34px',
              borderRadius: radius.md,
              borderWidth: '1px',
              borderColor: colors.cardBorder,
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            bindtap={onReject}
          >
            <text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>拒绝</text>
          </view>
        </view>
      ) : (
        <view
          style={{
            width: '56px',
            height: '34px',
            borderRadius: radius.md,
            borderWidth: '1px',
            borderColor: colors.cardBorder,
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          bindtap={onReject}
        >
          <text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>撤回</text>
        </view>
      )}
    </view>
  );
}
