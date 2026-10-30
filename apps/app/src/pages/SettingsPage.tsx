/**
 * ============================================================
 * 设置（Telegram 风格）
 * ------------------------------------------------------------
 * 结构自上而下：
 *   1. 个人资料卡（头像 + 昵称 + 邮箱），点击进入资料页
 *   2. 功能分组列表（每行一个入口，右侧箭头）
 *   3. 退出登录
 *   4. 底部 Tab 导航
 *
 * 设计口径对齐 Telegram：
 * - 标题栏只放标题，不放业务按钮
 * - 列表行原生「左图标 + 标题 + 右箭头」布局
 * - 分组之间用空白间隔区分，不用分割线堆叠
 * ============================================================
 */

import { useEffect, useState } from '@lynx-js/react';
import { getInviteOverview, logout } from '../api/index.js';
import { pop, push, reset } from '../router.js';
import { clearFriends, useFriends } from '../store/friends.js';
import { setUser, useAuth } from '../store/auth.js';
import { colors, commonStyles, fontSize, radius, spacing } from '../theme.js';
import { TabBar } from './TabBar.js';

export function SettingsPage() {
  const auth = useAuth();
  const { requests } = useFriends();
  const [inviteQuota, setInviteQuota] = useState<number | null>(null);

  useEffect(() => {
    void getInviteOverview()
      // quota 是「剩余可创建的名额」，直接用即可
      .then((o) => setInviteQuota(o.quota))
      .catch(() => setInviteQuota(null));
  }, []);

  const handleLogout = async () => {
    await logout().catch(() => undefined);
    setUser(null);
    clearFriends();
    reset({ name: 'login' });
  };

  const user = auth.user;
  const initial = (user?.nickname ?? '?').slice(0, 1).toUpperCase();

  return (
    <view style={commonStyles.page}>
      {/* 标题栏 */}
      <view
        style={{
          width: '100%',
          height: '56px',
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          paddingLeft: spacing.lg,
          paddingRight: spacing.lg,
          backgroundColor: colors.surface,
          borderBottomWidth: '1px',
          borderBottomColor: colors.border,
        }}
      >
        <text style={{ color: colors.text, fontSize: fontSize.xl, fontWeight: '700' }}>
          设置
        </text>
      </view>

      {/*
        内容区：绝对定位锁定在标题栏与底部导航之间。
        同 ContactsPage 的做法 —— flex:1 在本集成下拿不到剩余高度，
        会导致子块被 flexShrink 压扁重叠。
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
          paddingTop: spacing.lg,
        }}
      >
        {/* 个人资料卡 */}
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
            marginBottom: spacing.lg,
          }}
          bindtap={() => push({ name: 'profile' })}
        >
          <view
            style={{
              width: '56px',
              height: '56px',
              borderRadius: radius.full,
              backgroundColor: colors.primary,
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              marginRight: spacing.md,
            }}
          >
            <text style={{ color: '#FFFFFF', fontSize: fontSize.xl, fontWeight: '700' }}>
              {initial}
            </text>
          </view>

          <view style={{ width: '70%', display: 'flex', flexDirection: 'column' }}>
            <text style={{ color: colors.text, fontSize: fontSize.lg, fontWeight: '600' }}>
              {user?.nickname ?? '未登录'}
            </text>
            <text style={{ color: colors.textMuted, fontSize: fontSize.sm, marginTop: '2px' }}>
              {user?.emailFull ?? ''}
            </text>
          </view>

          <text style={{ color: colors.textFaint, fontSize: fontSize.lg }}>›</text>
        </view>

        {/* 功能分组一：社交 */}
        <SectionTitle text="社交" />
        <Group>
          <Row
            icon="👥"
            label="联系人"
            value=""
            onTap={() => push({ name: 'contacts' })}
            badge={requests.incoming.length}
          />
          <Row
            icon="🎟️"
            label="邀请好友"
            value={inviteQuota === null ? '' : `剩余 ${String(inviteQuota)} 个名额`}
            onTap={() => push({ name: 'invite' })}
            last
          />
        </Group>

        {/* 功能分组二：数据 */}
        <SectionTitle text="数据" />
        <Group>
          <Row
            icon="🔍"
            label="搜索消息"
            value=""
            onTap={() => push({ name: 'search-messages' })}
            last
          />
        </Group>

        {/* 功能分组三：关于 */}
        <SectionTitle text="关于" />
        <Group>
          <Row icon="💾" label="聊天文件保留" value="30 天" onTap={() => undefined} />
          <Row icon="ℹ️" label="版本" value="2.0.0" onTap={() => undefined} last />
        </Group>

        {/* 退出登录 */}
        <view
          style={{
            width: '100%',
            height: '48px',
            flexShrink: 0,
            borderRadius: radius.md,
            borderWidth: '1px',
            borderColor: colors.danger,
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            marginTop: spacing.xl,
          }}
          bindtap={() => void handleLogout()}
        >
          <text style={{ color: colors.danger, fontSize: fontSize.md }}>退出登录</text>
        </view>
      </view>

      {/* 底部导航 */}
      <TabBar
        active="settings"
        onChange={(key) => {
          if (key === 'chats') pop();
          else if (key === 'contacts') push({ name: 'contacts' });
        }}
      />
    </view>
  );
}

/* ------------------------------------------------------------------ */
/* 分组与行                                                             */
/* ------------------------------------------------------------------ */

function SectionTitle(props: { text: string }) {
  return (
    <text
      style={{
        width: '100%',
        color: colors.textFaint,
        fontSize: fontSize.xs,
        marginBottom: spacing.xs,
        marginTop: spacing.sm,
        paddingLeft: spacing.xs,
      }}
    >
      {props.text}
    </text>
  );
}

function Group(props: { children: React.ReactNode }) {
  return (
    <view
      style={{
        width: '100%',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: colors.card,
        borderWidth: '1px',
        borderColor: colors.cardBorder,
        borderRadius: radius.md,
        overflow: 'hidden',
      }}
    >
      {props.children}
    </view>
  );
}

function Row(props: {
  icon: string;
  label: string;
  value: string;
  onTap: () => void;
  badge?: number;
  last?: boolean;
}) {
  const { icon, label, value, onTap, badge = 0, last } = props;

  return (
    <view
      style={{
        width: '100%',
        height: '50px',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: spacing.md,
        paddingRight: spacing.md,
        borderBottomWidth: last ? '0px' : '1px',
        borderBottomColor: colors.border,
      }}
      bindtap={onTap}
    >
      <text style={{ fontSize: '16px', marginRight: spacing.md }}>{icon}</text>

      <text style={{ color: colors.text, fontSize: fontSize.md }}>{label}</text>

      <view style={{ flex: 1 }} />

      {badge > 0 ? (
        <view
          style={{
            minWidth: '18px',
            height: '18px',
            borderRadius: radius.full,
            backgroundColor: colors.danger,
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            paddingLeft: '5px',
            paddingRight: '5px',
            marginRight: spacing.sm,
          }}
        >
          <text style={{ color: '#FFFFFF', fontSize: '10px', fontWeight: '600' }}>
            {String(badge)}
          </text>
        </view>
      ) : null}

      {value ? (
        <text style={{ color: colors.textFaint, fontSize: fontSize.sm, marginRight: spacing.sm }}>
          {value}
        </text>
      ) : null}

      <text style={{ color: colors.textFaint, fontSize: fontSize.lg }}>›</text>
    </view>
  );
}
