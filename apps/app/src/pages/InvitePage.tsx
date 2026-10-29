/**
 * ============================================================
 * 邀请页
 * ------------------------------------------------------------
 * 展示：
 * 1. 剩余可邀请名额；
 * 2. 已发出的邀请码（含使用情况）；
 * 3. 通过我邀请注册的用户列表。
 *
 * 交互：点击「生成邀请码」，成功后可直接复制。
 * ============================================================
 */

import { useEffect, useState } from '@lynx-js/react';
import type { InviteOverview } from '@chat/shared';
import { createInvite, getInviteOverview } from '../api/index.js';
import { ApiError } from '../api/client.js';
import { pop } from '../router.js';
import { colors, commonStyles, fontSize, radius, spacing } from '../theme.js';

export function InvitePage() {
  const [data, setData] = useState<InviteOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  /** 加载邀请总览 */
  const load = async () => {
    setLoading(true);
    try {
      const overview = await getInviteOverview();
      setData(overview);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  /** 生成邀请码 */
  const handleCreate = async () => {
    if (creating) return;
    setCreating(true);
    setError(null);

    try {
      const r = await createInvite({ maxUses: 1 });
      setCopiedCode(r.code);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '生成失败');
    } finally {
      setCreating(false);
    }
  };

  /** 复制到剪贴板 */
  const copyCode = (code: string) => {
    const g = globalThis as unknown as {
      lynx?: { setClipboardData?: (p: { data: string }) => void };
      navigator?: { clipboard?: { writeText: (t: string) => Promise<void> } };
    };

    if (g.lynx?.setClipboardData) {
      g.lynx.setClipboardData({ data: code });
    } else if (g.navigator?.clipboard) {
      void g.navigator.clipboard.writeText(code);
    }

    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  return (
    <view style={commonStyles.page}>
      {/* 顶部栏 */}
      <view style={commonStyles.header}>
        <text style={{ color: colors.primary, fontSize: fontSize.md, width: 60 }} bindtap={pop}>
          返回
        </text>
        <text style={commonStyles.headerTitle}>邀请好友</text>
        <view style={{ width: 60 }} />
      </view>

      <scroll-view style={commonStyles.scroll}>
        <view style={{ padding: spacing.lg, gap: spacing.md }}>
          {/* 配额卡片 */}
          <view style={{ ...commonStyles.card, alignItems: 'center', gap: spacing.sm }}>
            <text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>剩余邀请名额</text>
            <text style={{ color: colors.primary, fontSize: 42, fontWeight: '700' }}>
              {data?.quota ?? 0}
            </text>
            <text style={{ color: colors.textFaint, fontSize: fontSize.xs }}>
              已邀请 {data?.invitees.length ?? 0} 位好友
            </text>

            <view
              style={{
                ...commonStyles.buttonPrimary,
                width: '100%',
                marginTop: spacing.md,
                opacity: (data?.quota ?? 0) <= 0 || creating ? 0.5 : 1,
              }}
              bindtap={handleCreate}
            >
              <text style={commonStyles.buttonPrimaryText}>
                {creating ? '生成中…' : (data?.quota ?? 0) <= 0 ? '名额已用完' : '生成邀请码'}
              </text>
            </view>
          </view>

          {error ? (
            <text style={{ color: colors.danger, fontSize: fontSize.sm }}>{error}</text>
          ) : null}

          {/* 已发出的邀请码 */}
          <text style={{ color: colors.textMuted, fontSize: fontSize.sm, marginTop: spacing.md }}>
            我的邀请码
          </text>

          {loading ? (
            <text style={{ color: colors.textFaint, fontSize: fontSize.sm }}>加载中…</text>
          ) : !data || data.codes.length === 0 ? (
            <text style={{ color: colors.textFaint, fontSize: fontSize.sm }}>
              还没有生成过邀请码
            </text>
          ) : (
            data.codes.map((c) => (
              <view
                key={c.id}
                style={{
                  ...commonStyles.card,
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'center',
                }}
                bindtap={() => copyCode(c.code)}
              >
                <view style={{ flex: 1, gap: 4 }}>
                  <text
                    style={{
                      color: colors.text,
                      fontSize: fontSize.lg,
                      fontWeight: '600',
                      letterSpacing: 3,
                    }}
                  >
                    {c.code}
                  </text>
                  <text style={{ color: colors.textFaint, fontSize: fontSize.xs }}>
                    {c.remainingUses > 0
                      ? `剩余 ${c.remainingUses}/${c.maxUses} 次`
                      : '已用完'}
                    {c.expiresAt ? ` · ${formatDate(c.expiresAt)} 过期` : ' · 永久有效'}
                  </text>
                </view>
                <text style={{ color: colors.primary, fontSize: fontSize.sm }}>
                  {copiedCode === c.code ? '已复制' : '复制'}
                </text>
              </view>
            ))
          )}

          {/* 已邀请的好友 */}
          <text style={{ color: colors.textMuted, fontSize: fontSize.sm, marginTop: spacing.md }}>
            已邀请的好友
          </text>

          {!data || data.invitees.length === 0 ? (
            <text style={{ color: colors.textFaint, fontSize: fontSize.sm }}>
              还没有好友通过你的邀请注册
            </text>
          ) : (
            data.invitees.map((u) => (
              <view
                key={u.userId}
                style={{
                  ...commonStyles.card,
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: spacing.md,
                }}
              >
                <view
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: radius.full,
                    backgroundColor: colors.primarySoft,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <text style={{ color: colors.primary, fontSize: fontSize.md, fontWeight: '600' }}>
                    {u.nickname.slice(0, 1)}
                  </text>
                </view>
                <view style={{ flex: 1 }}>
                  <text style={{ color: colors.text, fontSize: fontSize.md }}>{u.nickname}</text>
                  <text style={{ color: colors.textFaint, fontSize: fontSize.xs }}>
                    {formatDate(u.joinedAt)} 加入
                  </text>
                </view>
              </view>
            ))
          )}

          <view style={{ height: spacing.xxl }} />
        </view>
      </scroll-view>
    </view>
  );
}

/** 日期格式化：YYYY-MM-DD */
function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
