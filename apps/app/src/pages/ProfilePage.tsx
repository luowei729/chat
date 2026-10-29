/**
 * ============================================================
 * 我的资料页
 * ------------------------------------------------------------
 * 功能：
 * 1. 展示昵称、邮箱、个性签名、邀请配额；
 * 2. 编辑昵称与签名；
 * 3. 退出登录。
 * ============================================================
 */

import { useState } from '@lynx-js/react';
import { logout, updateMe } from '../api/index.js';
import { ApiError, clearTokens } from '../api/client.js';
import * as ws from '../api/ws.js';
import { pop, reset } from '../router.js';
import { setUser, useAuth } from '../store/auth.js';
import { clearMessages } from '../store/conversations.js';
import { colors, commonStyles, fontSize, radius, spacing } from '../theme.js';

export function ProfilePage() {
  const auth = useAuth();
  const user = auth.user;

  const [nickname, setNickname] = useState(user?.nickname ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  /** 保存资料 */
  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);

    try {
      const updated = await updateMe({
        nickname: nickname.trim() || undefined,
        bio: bio.trim() || null,
      });
      setUser(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  /** 退出登录 */
  const handleLogout = async () => {
    await logout();
    ws.disconnect();
    clearTokens();
    clearMessages();
    reset({ name: 'login' });
  };

  return (
    <view style={commonStyles.page}>
      {/* 顶部栏 */}
      <view style={commonStyles.header}>
        <text style={{ color: colors.primary, fontSize: fontSize.md, width: 60 }} bindtap={pop}>
          返回
        </text>
        <text style={commonStyles.headerTitle}>我的</text>
        <view style={{ width: 60 }} />
      </view>

      <scroll-view style={commonStyles.scroll}>
        <view style={{ padding: spacing.lg, gap: spacing.md }}>
          {/* 头像与邮箱 */}
          <view style={{ ...commonStyles.card, alignItems: 'center', gap: spacing.sm }}>
            <view
              style={{
                width: 76,
                height: 76,
                borderRadius: radius.full,
                backgroundColor: colors.primarySoft,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <text style={{ color: colors.primary, fontSize: 30, fontWeight: '600' }}>
                {(user?.nickname ?? '?').slice(0, 1)}
              </text>
            </view>
            <text style={{ color: colors.text, fontSize: fontSize.lg, fontWeight: '600' }}>
              {user?.nickname ?? '未登录'}
            </text>
            <text style={{ color: colors.textFaint, fontSize: fontSize.sm }}>
              {user?.emailFull ?? ''}
            </text>
            <view
              style={{
                backgroundColor: colors.primarySoft,
                borderRadius: radius.full,
                paddingLeft: spacing.md,
                paddingRight: spacing.md,
                paddingTop: 4,
                paddingBottom: 4,
              }}
            >
              <text style={{ color: colors.primary, fontSize: fontSize.xs }}>
                剩余邀请名额 {user?.inviteQuota ?? 0}
              </text>
            </view>
          </view>

          {/* 编辑昵称 */}
          <text style={labelStyle}>昵称</text>
          <input
            style={commonStyles.input}
            default-value={nickname}
            placeholder="1-24 个字符"
            bindinput={(e: { detail: { value: string } }) => setNickname(e.detail.value)}
          />

          {/* 编辑签名 */}
          <text style={labelStyle}>个性签名</text>
          <input
            style={commonStyles.input}
            default-value={bio}
            placeholder="一句话介绍自己（选填）"
            bindinput={(e: { detail: { value: string } }) => setBio(e.detail.value)}
          />

          {error ? (
            <text style={{ color: colors.danger, fontSize: fontSize.sm }}>{error}</text>
          ) : null}
          {saved ? (
            <text style={{ color: colors.success, fontSize: fontSize.sm }}>已保存</text>
          ) : null}

          {/* 保存按钮 */}
          <view
            style={{ ...commonStyles.buttonPrimary, opacity: saving ? 0.6 : 1 }}
            bindtap={handleSave}
          >
            <text style={commonStyles.buttonPrimaryText}>
              {saving ? '保存中…' : '保存'}
            </text>
          </view>

          {/* 退出登录 */}
          <view
            style={{
              ...commonStyles.buttonGhost,
              marginTop: spacing.xl,
              borderColor: colors.danger,
            }}
            bindtap={handleLogout}
          >
            <text style={{ color: colors.danger, fontSize: fontSize.md }}>退出登录</text>
          </view>

          <view style={{ height: spacing.xxl }} />
        </view>
      </scroll-view>
    </view>
  );
}

const labelStyle = {
  color: colors.textMuted,
  fontSize: fontSize.sm,
  marginTop: spacing.md,
} as const;
