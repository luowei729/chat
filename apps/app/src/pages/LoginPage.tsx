/**
 * ============================================================
 * 登录页
 * ============================================================
 * 设计语言（iOS 26/27 · Liquid Glass）：
 *   1. 以「分层材料」代替描边：背景 → 卡片 → 输入框三档明度递进
 *   2. 大圆角：卡片 26px、输入框 10px、主按钮 14px
 *   3. 强调色克制：只有主按钮与文字链接用 accent
 *   4. 字号阶梯：34 标题 / 17 正文 / 13 说明 / 11 脚注
 *   5. 所有颜色来自 theme.ts 的响应式 colors，自动适配明暗主题
 *
 * 布局（Lynx 铁律，勿改）：
 *   - 根节点 height:'100vh'，不依赖父级解析
 *   - 内容区不用 flex:1（会塌陷），整体居中靠定高容器 + marginTop
 *   - 所有宽度百分比，所有长度带单位
 * ============================================================
 */

import { useState } from '@lynx-js/react';
import { login, getMe } from '../api/index.js';
import { ApiError } from '../api/client.js';
import * as ws from '../api/ws.js';
import { push, reset } from '../router.js';
import { setUser } from '../store/auth.js';
import { colors, fontSize, radius, spacing } from '../theme.js';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async () => {
    if (loading) return;

    if (!email.trim()) {
      setError('请输入邮箱');
      return;
    }
    if (!password) {
      setError('请输入密码');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await login({ email: email.trim(), password });
      const me = await getMe();
      setUser(me);
      ws.connect();
      reset({ name: 'conversations' });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '登录失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <view
      style={{
        height: '100vh',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: colors.bg,
      }}
    >
      <view
        style={{
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          paddingLeft: spacing.xl,
          paddingRight: spacing.xl,
          paddingTop: '72px',
        }}
      >
        {/* ---------- 品牌区 ---------- */}
        <view
          style={{
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            marginBottom: spacing.xxl,
          }}
        >
          {/* Logo：大圆角应用图标 */}
          <view
            style={{
              width: '84px',
              height: '84px',
              borderRadius: radius.xl,
              backgroundColor: colors.primary,
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: spacing.lg,
            }}
          >
            <text style={{ fontSize: '38px', color: colors.onPrimary, fontWeight: '700' }}>
              C
            </text>
          </view>

          <text style={{ fontSize: fontSize.hero, color: colors.text, fontWeight: '700' }}>
            chat
          </text>
          <text
            style={{
              fontSize: fontSize.md,
              color: colors.textMuted,
              marginTop: spacing.xs,
            }}
          >
            安全 · 快速 · 跨平台
          </text>
        </view>

        {/* ---------- 表单卡片 ---------- */}
        <view
          style={{
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: colors.card,
            borderWidth: '1px',
            borderColor: colors.cardBorder,
            borderRadius: radius.xl,
            padding: spacing.lg,
          }}
        >
          {/* 邮箱 */}
          <text
            style={{
              fontSize: fontSize.sm,
              color: colors.textMuted,
              marginBottom: spacing.sm,
            }}
          >
            邮箱
          </text>
          <input
            style={{
              width: '100%',
              height: '48px',
              borderRadius: radius.sm,
              backgroundColor: colors.surfaceAlt,
              paddingLeft: spacing.lg,
              paddingRight: spacing.lg,
              color: colors.text,
              fontSize: fontSize.md,
            }}
            default-value={email}
            placeholder="you@example.com"
            bindinput={(e: { detail: { value: string } }) => setEmail(e.detail.value)}
          />

          {/* 密码 */}
          <text
            style={{
              fontSize: fontSize.sm,
              color: colors.textMuted,
              marginTop: spacing.lg,
              marginBottom: spacing.sm,
            }}
          >
            密码
          </text>
          <input
            style={{
              width: '100%',
              height: '48px',
              borderRadius: radius.sm,
              backgroundColor: colors.surfaceAlt,
              paddingLeft: spacing.lg,
              paddingRight: spacing.lg,
              color: colors.text,
              fontSize: fontSize.md,
            }}
            default-value={password}
            type="password"
            placeholder="请输入密码"
            bindinput={(e: { detail: { value: string } }) => setPassword(e.detail.value)}
          />

          {/* 错误提示：固定高度避免布局跳动 */}
          <view
            style={{
              width: '100%',
              height: '20px',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              marginTop: spacing.sm,
            }}
          >
            {error ? (
              <text style={{ fontSize: fontSize.sm, color: colors.danger, textAlign: 'center' }}>
                {error}
              </text>
            ) : null}
          </view>

          {/* 主按钮 */}
          <view
            style={{
              width: '100%',
              height: '50px',
              borderRadius: radius.md,
              backgroundColor: colors.primary,
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: spacing.md,
              opacity: loading ? 0.6 : 1,
            }}
            bindtap={handleLogin}
          >
            <text style={{ fontSize: fontSize.lg, color: colors.onPrimary, fontWeight: '600' }}>
              {loading ? '登录中…' : '登录'}
            </text>
          </view>
        </view>

        {/* ---------- 底部入口 ---------- */}
        <view
          style={{
            width: '100%',
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            marginTop: spacing.xl,
          }}
        >
          <view
            style={{
              height: '36px',
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              paddingLeft: spacing.md,
              paddingRight: spacing.md,
            }}
            bindtap={() => push({ name: 'register' })}
          >
            <text style={{ fontSize: fontSize.md, color: colors.primary }}>创建账号</text>
          </view>

          <view
            style={{
              height: '36px',
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              paddingLeft: spacing.md,
              paddingRight: spacing.md,
            }}
            bindtap={() => push({ name: 'reset-password' })}
          >
            <text style={{ fontSize: fontSize.md, color: colors.textMuted }}>忘记密码</text>
          </view>
        </view>
      </view>
    </view>
  );
}
