/**
 * ============================================================
 * 登录页
 * ------------------------------------------------------------
 * 交互：
 * 1. 邮箱 + 密码登录；
 * 2. 登录失败展示服务端返回的具体原因（不是笼统的「登录失败」）；
 * 3. 提供「注册」与「忘记密码」入口。
 * ============================================================
 */

import { useState } from '@lynx-js/react';
import { login } from '../api/index.js';
import { ApiError } from '../api/client.js';
import { getMe } from '../api/index.js';
import * as ws from '../api/ws.js';
import { push, reset } from '../router.js';
import { setUser } from '../store/auth.js';
import { colors, commonStyles, fontSize, radius, spacing } from '../theme.js';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 提交登录 */
  const handleLogin = async () => {
    if (loading) return;

    // 前端预校验：减少一次无意义的网络请求
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
      // 登录成功后拉完整资料（含邀请配额）
      const me = await getMe();
      setUser(me);
      ws.connect();
      // 重置路由栈：登录页不应能返回
      reset({ name: 'conversations' });
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : '登录失败，请稍后重试';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <view style={commonStyles.page}>
      {/* 顶部留白 + 品牌区 */}
      <view style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <text style={{ color: colors.text, fontSize: fontSize.xxl, fontWeight: '700' }}>chat</text>
      </view>

      <view style={{ paddingLeft: spacing.xl, paddingRight: spacing.xl, gap: spacing.md }}>
        <text style={{ color: colors.textMuted, fontSize: fontSize.sm, marginBottom: spacing.xs }}>
          邮箱
        </text>
        <input
          style={commonStyles.input}
          default-value={email}
          placeholder="you@example.com"
          bindinput={(e: { detail: { value: string } }) => setEmail(e.detail.value)}
        />

        <text style={{ color: colors.textMuted, fontSize: fontSize.sm, marginTop: spacing.sm, marginBottom: spacing.xs }}>
          密码
        </text>
        <input
          style={commonStyles.input}
          default-value={password}
          type="password"
          placeholder="请输入密码"
          bindinput={(e: { detail: { value: string } }) => setPassword(e.detail.value)}
        />

        {/* 错误提示：固定高度避免布局跳动 */}
        <view style={{ height: 22, justifyContent: 'center' }}>
          {error ? (
            <text style={{ color: colors.danger, fontSize: fontSize.sm }}>{error}</text>
          ) : null}
        </view>

        <view
          style={{
            ...commonStyles.buttonPrimary,
            opacity: loading ? 0.6 : 1,
            marginTop: spacing.sm,
          }}
          bindtap={handleLogin}
        >
          <text style={commonStyles.buttonPrimaryText}>
            {loading ? '登录中…' : '登录'}
          </text>
        </view>

        <view
          style={{ display: 'flex', flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.lg }}
        >
          <text
            style={{ color: colors.primary, fontSize: fontSize.sm }}
            bindtap={() => push({ name: 'register' })}
          >
            注册新账号
          </text>
          <text
            style={{ color: colors.textMuted, fontSize: fontSize.sm }}
            bindtap={() => push({ name: 'reset-password' })}
          >
            忘记密码
          </text>
        </view>
      </view>
    </view>
  );
}

// 保留未使用引用
void radius;
