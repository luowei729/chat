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
      {/* 居中内容区：整块表单垂直居中，不再堆在顶部 */}
      <scroll-view scroll-orientation="vertical" style={commonStyles.scroll}>
        <view
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            paddingLeft: spacing.xl,
            paddingRight: spacing.xl,
            paddingTop: spacing.xxxl,
            paddingBottom: spacing.xxxl,
          }}
        >
          <view style={{ width: '100%', maxWidth: 380 }}>
            {/* 品牌区：Logo 圆 + 标题 + 副标题，全部居中 */}
            <view style={{ display: 'flex', alignItems: 'center', marginBottom: spacing.xxl }}>
              <view
                style={{
                  width: 72,
                  height: 72,
                  borderRadius: 22,
                  backgroundColor: colors.primary,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: spacing.lg,
                }}
              >
                <text style={{ color: '#ffffff', fontSize: 30, fontWeight: '700' }}>C</text>
              </view>
              <text style={{ color: colors.text, fontSize: fontSize.xxl, fontWeight: '700' }}>
                chat
              </text>
              <text style={{ color: colors.textFaint, fontSize: fontSize.sm, marginTop: spacing.xs }}>
                安全 · 快速 · 跨平台聊天
              </text>
            </view>

            {/* 表单卡片 */}
            <view style={commonStyles.card}>
              <text style={{ color: colors.textMuted, fontSize: fontSize.sm, marginBottom: spacing.sm }}>
                邮箱
              </text>
              <input
                style={commonStyles.input}
                default-value={email}
                placeholder="you@example.com"
                bindinput={(e: { detail: { value: string } }) => setEmail(e.detail.value)}
              />

              <text
                style={{
                  color: colors.textMuted,
                  fontSize: fontSize.sm,
                  marginTop: spacing.lg,
                  marginBottom: spacing.sm,
                }}
              >
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
              <view style={{ height: 24, justifyContent: 'center', marginTop: spacing.sm }}>
                {error ? (
                  <text style={{ color: colors.danger, fontSize: fontSize.sm, textAlign: 'center' }}>
                    {error}
                  </text>
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
                  {loading ? '登录中…' : '登 录'}
                </text>
              </view>
            </view>

            {/* 底部链接：居中并排 */}
            <view
              style={{
                display: 'flex',
                flexDirection: 'row',
                justifyContent: 'center',
                marginTop: spacing.xl,
              }}
            >
              <text
                style={{ color: colors.primary, fontSize: fontSize.sm, padding: spacing.sm }}
                bindtap={() => push({ name: 'register' })}
              >
                注册新账号
              </text>
              <text style={{ color: colors.border, fontSize: fontSize.sm, padding: spacing.sm }}>
                |
              </text>
              <text
                style={{ color: colors.textMuted, fontSize: fontSize.sm, padding: spacing.sm }}
                bindtap={() => push({ name: 'reset-password' })}
              >
                忘记密码
              </text>
            </view>
          </view>
        </view>
      </scroll-view>
    </view>
  );
}

// 保留未使用引用
void radius;
