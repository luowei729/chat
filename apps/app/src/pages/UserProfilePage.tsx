/**
 * ============================================================
 * 他人资料页
 * ------------------------------------------------------------
 * 按 relation 状态展示不同操作：
 *   friend            → 发消息 / 设置备注 / 删除好友 / 拉黑
 *   request-received  → 接受 / 拒绝
 *   request-sent      → 等待对方确认
 *   none              → 加为好友
 *   blocked           → 解除拉黑
 *   self              → 跳转到我的资料
 *
 * 备注名采用「点开输入 → 保存」的内联编辑，不弹窗
 * （Lynx 下弹窗组件可用性未验证，内联更稳）。
 * ============================================================
 */

import { useEffect, useState } from '@lynx-js/react';
import type { UserProfileView } from '@chat/shared';
import {
  acceptFriend,
  blockFriend,
  createDirect,
  getUserProfile,
  rejectFriend,
  removeFriend,
  requestFriend,
  setRemark,
  unblockFriend,
} from '../api/index.js';
import { pop, push, reset } from '../router.js';
import { refreshFriends } from '../store/friends.js';
import { colors, commonStyles, fontSize, radius, spacing } from '../theme.js';

export function UserProfilePage(props: { userId: string }) {
  const { userId } = props;

  const [profile, setProfile] = useState<UserProfileView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** 备注名编辑态 */
  const [editingRemark, setEditingRemark] = useState(false);
  const [remarkDraft, setRemarkDraft] = useState('');

  const load = async () => {
    try {
      const p = await getUserProfile(userId);
      setProfile(p);
      setRemarkDraft(p.remark ?? '');
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    }
  };

  useEffect(() => {
    void load();
  }, [userId]);

  /** 统一包装：处理 busy 与错误 */
  const run = async (fn: () => Promise<void>, failText: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : failText);
    } finally {
      setBusy(false);
    }
  };

  const goChat = () =>
    run(async () => {
      if (profile?.conversationId) {
        push({
          name: 'chat',
          params: { conversationId: profile.conversationId, title: profile.remark ?? profile.nickname },
        });
        return;
      }
      const r = await createDirect(userId);
      push({ name: 'chat', params: { conversationId: r.conversationId, title: profile?.nickname } });
    }, '打开聊天失败');

  const addFriend = () =>
    run(async () => {
      const r = await requestFriend(userId);
      await refreshFriends();
      await load();
      if (r.autoAccepted && r.conversationId) {
        push({ name: 'chat', params: { conversationId: r.conversationId, title: profile?.nickname } });
      }
    }, '发送好友请求失败');

  const doAccept = () =>
    run(async () => {
      const r = await acceptFriend(userId);
      await refreshFriends();
      await load();
      if (r.conversationId) {
        push({ name: 'chat', params: { conversationId: r.conversationId, title: profile?.nickname } });
      }
    }, '接受失败');

  const doReject = () =>
    run(async () => {
      await rejectFriend(userId);
      await refreshFriends();
      await load();
    }, '拒绝失败');

  const doRemove = () =>
    run(async () => {
      await removeFriend(userId);
      await refreshFriends();
      await load();
    }, '删除好友失败');

  const doBlock = () =>
    run(async () => {
      await blockFriend(userId);
      await refreshFriends();
      await load();
    }, '拉黑失败');

  const doUnblock = () =>
    run(async () => {
      await unblockFriend(userId);
      await refreshFriends();
      await load();
    }, '解除拉黑失败');

  const saveRemark = () =>
    run(async () => {
      await setRemark(userId, remarkDraft.trim());
      await refreshFriends();
      await load();
      setEditingRemark(false);
    }, '保存备注失败');

  /* ---------------- 加载中 ---------------- */
  if (!profile) {
    return (
      <view style={commonStyles.page}>
        <view style={commonStyles.header}>
          <view style={commonStyles.headerSide}>
            <text style={{ color: colors.primary, fontSize: fontSize.md }} bindtap={pop}>
              返回
            </text>
          </view>
          <view style={commonStyles.headerCenter}>
            <text style={commonStyles.headerTitle}>详细资料</text>
          </view>
          <view style={commonStyles.headerSide} />
        </view>
        <view
          style={{
            flex: 1,
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <text style={{ color: colors.textMuted, fontSize: fontSize.md }}>
            {error ?? '加载中…'}
          </text>
        </view>
      </view>
    );
  }

  const displayName = profile.remark?.trim() ? profile.remark : profile.nickname;
  const initial = displayName.slice(0, 1).toUpperCase();

  return (
    <view style={commonStyles.page}>
      {/* 顶部栏 */}
      <view style={commonStyles.header}>
        <view style={commonStyles.headerSide}>
          <text style={{ color: colors.primary, fontSize: fontSize.md }} bindtap={pop}>
            返回
          </text>
        </view>
        <view style={commonStyles.headerCenter}>
          <text style={commonStyles.headerTitle}>详细资料</text>
        </view>
        <view style={commonStyles.headerSide} />
      </view>

      <view
        style={{
          flex: 1,
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          paddingLeft: spacing.lg,
          paddingRight: spacing.lg,
          paddingTop: spacing.lg,
        }}
      >
        {/* 头像 + 名字 */}
        <view
          style={{
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            marginBottom: spacing.lg,
          }}
        >
          <view
            style={{
              width: '80px',
              height: '80px',
              borderRadius: radius.full,
              backgroundColor: colors.primarySoft,
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: spacing.md,
            }}
          >
            <text style={{ color: colors.primary, fontSize: fontSize.xxl, fontWeight: '700' }}>
              {initial}
            </text>
          </view>
          <text style={{ color: colors.text, fontSize: fontSize.xl, fontWeight: '600' }}>
            {displayName}
          </text>
          {profile.remark?.trim() ? (
            <text style={{ color: colors.textFaint, fontSize: fontSize.sm, marginTop: '4px' }}>
              昵称：{profile.nickname}
            </text>
          ) : null}
          <text style={{ color: colors.textMuted, fontSize: fontSize.sm, marginTop: spacing.xs }}>
            {profile.email}
          </text>
        </view>

        {/* 错误提示 */}
        {error ? (
          <text
            style={{
              color: colors.danger,
              fontSize: fontSize.sm,
              marginBottom: spacing.sm,
              textAlign: 'center',
            }}
          >
            {error}
          </text>
        ) : null}

        {/* 签名 */}
        {profile.bio ? (
          <view style={infoCardStyle}>
            <text style={{ color: colors.textMuted, fontSize: fontSize.xs, marginBottom: '4px' }}>
              个性签名
            </text>
            <text style={{ color: colors.text, fontSize: fontSize.sm }}>{profile.bio}</text>
          </view>
        ) : null}

        {/* 备注名（仅好友可设） */}
        {profile.relation === 'friend' ? (
          <view style={infoCardStyle}>
            <text style={{ color: colors.textMuted, fontSize: fontSize.xs, marginBottom: '6px' }}>
              备注名
            </text>
            {editingRemark ? (
              <view style={{ width: '100%', display: 'flex', flexDirection: 'column' }}>
                <input
                  style={{
                    width: '100%',
                    height: '44px',
                    borderRadius: radius.md,
                    backgroundColor: colors.surfaceAlt,
                    borderWidth: '1px',
                    borderColor: colors.border,
                    paddingLeft: spacing.md,
                    paddingRight: spacing.md,
                    color: colors.text,
                    fontSize: fontSize.md,
                  }}
                  default-value={remarkDraft}
                  placeholder="给 TA 起个名字"
                  bindinput={(e: { detail: { value: string } }) => setRemarkDraft(e.detail.value)}
                />
                <view
                  style={{
                    width: '100%',
                    display: 'flex',
                    flexDirection: 'row',
                    marginTop: spacing.sm,
                  }}
                >
                  <view
                    style={{
                      flex: 1,
                      height: '40px',
                      borderRadius: radius.md,
                      backgroundColor: colors.primary,
                      display: 'flex',
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginRight: spacing.sm,
                    }}
                    bindtap={() => void saveRemark()}
                  >
                    <text style={{ color: '#FFFFFF', fontSize: fontSize.sm }}>
                      {busy ? '保存中…' : '保存'}
                    </text>
                  </view>
                  <view
                    style={{
                      flex: 1,
                      height: '40px',
                      borderRadius: radius.md,
                      borderWidth: '1px',
                      borderColor: colors.cardBorder,
                      display: 'flex',
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                    bindtap={() => {
                      setEditingRemark(false);
                      setRemarkDraft(profile.remark ?? '');
                    }}
                  >
                    <text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>取消</text>
                  </view>
                </view>
              </view>
            ) : (
              <view
                style={{
                  width: '100%',
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
                bindtap={() => setEditingRemark(true)}
              >
                <text style={{ color: profile.remark ? colors.text : colors.textFaint, fontSize: fontSize.md }}>
                  {profile.remark?.trim() ? profile.remark : '未设置'}
                </text>
                <text style={{ color: colors.primary, fontSize: fontSize.sm }}>修改</text>
              </view>
            )}
          </view>
        ) : null}

        {/* 操作按钮 */}
        <view style={{ width: '100%', display: 'flex', flexDirection: 'column' }}>
          {profile.relation === 'friend' ? (
            <ActionButton label="发消息" primary onTap={() => void goChat()} />
          ) : null}

          {profile.relation === 'none' ? (
            <ActionButton label={busy ? '处理中…' : '加为好友'} primary onTap={() => void addFriend()} />
          ) : null}

          {profile.relation === 'request-received' ? (
            <view style={{ width: '100%', display: 'flex', flexDirection: 'row' }}>
              <view style={{ flex: 1, marginRight: spacing.sm }}>
                <ActionButton label="接受" primary onTap={() => void doAccept()} />
              </view>
              <view style={{ flex: 1 }}>
                <ActionButton label="拒绝" onTap={() => void doReject()} />
              </view>
            </view>
          ) : null}

          {profile.relation === 'request-sent' ? (
            <ActionButton label="等待对方确认" disabled onTap={() => {}} />
          ) : null}

          {profile.relation === 'blocked' ? (
            <ActionButton label="解除拉黑" primary onTap={() => void doUnblock()} />
          ) : null}

          {profile.relation === 'self' ? (
            <ActionButton label="编辑我的资料" primary onTap={() => { reset({ name: 'profile' }); }} />
          ) : null}

          {profile.relation === 'friend' ? (
            <view style={{ width: '100%', display: 'flex', flexDirection: 'row', marginTop: spacing.sm }}>
              <view style={{ flex: 1, marginRight: spacing.sm }}>
                <ActionButton label="删除好友" danger onTap={() => void doRemove()} />
              </view>
              <view style={{ flex: 1 }}>
                <ActionButton label="拉黑" danger onTap={() => void doBlock()} />
              </view>
            </view>
          ) : null}
        </view>
      </view>
    </view>
  );
}

/* ------------------------------------------------------------------ */
/* 样式与小组件                                                         */
/* ------------------------------------------------------------------ */

const infoCardStyle = {
  width: '100%',
  display: 'flex',
  flexDirection: 'column',
  backgroundColor: colors.card,
  borderWidth: '1px',
  borderColor: colors.cardBorder,
  borderRadius: radius.md,
  padding: spacing.md,
  marginBottom: spacing.sm,
} as const;

function ActionButton(props: {
  label: string;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onTap: () => void;
}) {
  const { label, primary, danger, disabled, onTap } = props;

  const bg = primary ? colors.primary : 'transparent';
  const border = primary ? colors.primary : (danger ? colors.danger : colors.cardBorder);
  const textColor = primary ? '#FFFFFF' : (danger ? colors.danger : colors.textMuted);

  return (
    <view
      style={{
        width: '100%',
        height: '46px',
        borderRadius: radius.md,
        backgroundColor: bg,
        borderWidth: '1px',
        borderColor: border,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: spacing.sm,
        opacity: disabled ? 0.5 : 1,
      }}
      bindtap={disabled ? undefined : onTap}
    >
      <text style={{ color: textColor, fontSize: fontSize.md, fontWeight: primary ? '600' : '400' }}>
        {label}
      </text>
    </view>
  );
}
