/**
 * ============================================================
 * 重置密码页
 * ------------------------------------------------------------
 * 流程：填邮箱 → 获取验证码 → 填验证码 + 新密码 → 提交
 * 成功后回到登录页。
 * ============================================================
 */

import { useEffect, useRef, useState } from '@lynx-js/react';
import { resetPassword, sendEmailCode } from '../api/index.js';
import { ApiError } from '../api/client.js';
import { pop, replace } from '../router.js';
import { colors, commonStyles, fontSize, radius, spacing } from '../theme.js';

export function ResetPasswordPage() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  /** 获取验证码 */
  const handleSendCode = async () => {
    if (countdown > 0) return;
    if (!email.trim()) {
      setError('请先输入邮箱');
      return;
    }

    setError(null);
    try {
      await sendEmailCode({ email: email.trim(), purpose: 'reset' });
      setCountdown(60);
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            if (timerRef.current) clearInterval(timerRef.current);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '发送失败');
    }
  };

  /** 提交重置 */
  const handleSubmit = async () => {
    if (loading) return;

    if (!email.trim()) return setError('请输入邮箱');
    if (!code.trim()) return setError('请输入验证码');
    if (newPassword.length < 8) return setError('新密码至少 8 位');

    setLoading(true);
    setError(null);

    try {
      await resetPassword({
        email: email.trim(),
        code: code.trim(),
        newPassword,
      });
      setSuccess(true);
      // 2 秒后自动回登录页
      setTimeout(() => replace({ name: 'login' }), 2000);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '重置失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <view style={commonStyles.page}>
      {/* 顶部栏：三段式居中 */}
      <view style={commonStyles.header}>
        <view style={commonStyles.headerSide}>
          <text style={{ color: colors.primary, fontSize: fontSize.md }} bindtap={pop}>
            返回
          </text>
        </view>
        <view style={commonStyles.headerCenter}>
          <text style={commonStyles.headerTitle}>重置密码</text>
        </view>
        <view style={commonStyles.headerSide} />
      </view>

      <view style={{ flex: 1, width: '100%', display: 'flex', flexDirection: 'column' }}>
        <view style={{ padding: spacing.xl, paddingBottom: spacing.xxxl }}>
        {success ? (
          <view style={{ alignItems: 'center', paddingTop: spacing.xxl }}>
            <text style={{ color: colors.success, fontSize: fontSize.lg }}>密码已重置</text>
            <text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>
              正在返回登录页…
            </text>
          </view>
        ) : (
          <>
            <text style={labelStyle}>邮箱</text>
            <input
              style={commonStyles.input}
              default-value={email}
              placeholder="注册时使用的邮箱"
              bindinput={(e: { detail: { value: string } }) => setEmail(e.detail.value)}
            />

            <text style={labelStyle}>验证码</text>
            <view
              style={{
                display: 'flex',
                flexDirection: 'row', width: '100%',
                alignItems: 'center',
                marginTop: spacing.sm,
              }}
            >
              <view style={{ flex: 1, marginRight: spacing.sm }}>
                <input
                  style={commonStyles.input}
                  default-value={code}
                  placeholder="6 位数字"
                  bindinput={(e: { detail: { value: string } }) => setCode(e.detail.value)}
                />
              </view>
              <view
                style={{
                  width: '110px',
                  height: '50px',
                  borderRadius: radius.md,
                  backgroundColor: countdown > 0 ? colors.surfaceAlt : colors.primarySoft,
                  borderWidth: '1px',
                  borderColor: countdown > 0 ? colors.border : colors.primary,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                bindtap={handleSendCode}
              >
                <text
                  style={{
                    color: countdown > 0 ? colors.textFaint : colors.primary,
                    fontSize: fontSize.sm,
                  }}
                >
                  {countdown > 0 ? `${countdown}s` : '获取验证码'}
                </text>
              </view>
            </view>

            <text style={labelStyle}>新密码</text>
            <input
              style={commonStyles.input}
              default-value={newPassword}
              type="password"
              placeholder="至少 8 位"
              bindinput={(e: { detail: { value: string } }) => setNewPassword(e.detail.value)}
            />

            <view style={{ height: '22px', justifyContent: 'center', marginTop: spacing.xs }}>
              {error ? (
                <text style={{ color: colors.danger, fontSize: fontSize.sm }}>{error}</text>
              ) : null}
            </view>

            <view
              style={{ ...commonStyles.buttonPrimary, opacity: loading ? 0.6 : 1 }}
              bindtap={handleSubmit}
            >
              <text style={commonStyles.buttonPrimaryText}>
                {loading ? '提交中…' : '重置密码'}
              </text>
            </view>

            <text
              style={{
                color: colors.textFaint,
                fontSize: fontSize.xs,
                marginTop: spacing.md,
                lineHeight: '1.6px',
              }}
            >
              重置成功后，所有设备上的登录状态都会失效，需要重新登录。
            </text>
          </>
        )}
        </view>
      </view>
    </view>
  );
}

const labelStyle = {
  color: colors.textMuted,
  fontSize: fontSize.sm,
  marginTop: spacing.md,
} as const;
