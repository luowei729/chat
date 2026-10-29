/**
 * ============================================================
 * 注册页
 * ------------------------------------------------------------
 * 流程：填邮箱 → 获取验证码 → 填验证码/密码/昵称/邀请码 → 注册
 *
 * 关键交互：
 * 1. 验证码按钮 60 秒倒计时，防止重复点击；
 * 2. 邀请码实时校验（失焦时调接口），提前告知用户码是否可用，
 *    避免填完所有信息才失败；
 * 3. 注册成功直接进入会话列表（无需再登录一次）。
 * ============================================================
 */

import { useEffect, useRef, useState } from '@lynx-js/react';
import { getMe, register, sendEmailCode, validateInviteCode } from '../api/index.js';
import { ApiError } from '../api/client.js';
import * as ws from '../api/ws.js';
import { pop, reset } from '../router.js';
import { setUser } from '../store/auth.js';
import { colors, commonStyles, fontSize, spacing } from '../theme.js';

export function RegisterPage(props: { initialInviteCode?: string }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [inviteCode, setInviteCode] = useState(props.initialInviteCode ?? '');

  const [countdown, setCountdown] = useState(0);
  const [inviteHint, setInviteHint] = useState<{ ok: boolean; text: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 组件卸载时清掉倒计时定时器，避免内存泄漏
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  /** 启动 60 秒倒计时 */
  const startCountdown = () => {
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
  };

  /** 获取验证码 */
  const handleSendCode = async () => {
    if (countdown > 0) return;
    if (!email.trim()) {
      setError('请先输入邮箱');
      return;
    }

    setError(null);
    try {
      await sendEmailCode({ email: email.trim(), purpose: 'register' });
      startCountdown();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '发送失败，请稍后重试');
    }
  };

  /** 邀请码失焦校验 */
  const handleInviteBlur = async () => {
    const v = inviteCode.trim().toUpperCase();
    if (!v) {
      setInviteHint(null);
      return;
    }
    try {
      const r = await validateInviteCode(v);
      setInviteHint({ ok: r.valid, text: r.valid ? '邀请码可用' : (r.reason ?? '邀请码无效') });
    } catch {
      setInviteHint(null);
    }
  };

  /** 提交注册 */
  const handleRegister = async () => {
    if (loading) return;

    if (!email.trim()) return setError('请输入邮箱');
    if (!code.trim()) return setError('请输入验证码');
    if (password.length < 8) return setError('密码至少 8 位');
    if (!nickname.trim()) return setError('请输入昵称');
    if (!inviteCode.trim()) return setError('请输入邀请码');

    setLoading(true);
    setError(null);

    try {
      await register({
        email: email.trim(),
        code: code.trim(),
        password,
        nickname: nickname.trim(),
        inviteCode: inviteCode.trim().toUpperCase(),
      });

      const me = await getMe();
      setUser(me);
      ws.connect();
      reset({ name: 'conversations' });
    } catch (e) {
      if (e instanceof ApiError && e.fields) {
        // 字段级错误：优先展示第一条
        const first = Object.values(e.fields)[0];
        setError(first ?? e.message);
      } else {
        setError(e instanceof ApiError ? e.message : '注册失败，请稍后重试');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <view style={commonStyles.page}>
      {/* 导航栏 */}
      <view style={commonStyles.header}>
        <text
          style={{ color: colors.primary, fontSize: fontSize.md, width: 60 }}
          bindtap={pop}
        >
          返回
        </text>
        <text style={commonStyles.headerTitle}>注册</text>
        <view style={{ width: 60 }} />
      </view>

      <scroll-view style={commonStyles.scroll}>
        <view style={{ padding: spacing.xl, gap: spacing.sm }}>
          {/* 邮箱 */}
          <text style={labelStyle}>邮箱</text>
          <input
            style={commonStyles.input}
            default-value={email}
            placeholder="用于接收验证码与找回密码"
            bindinput={(e: { detail: { value: string } }) => setEmail(e.detail.value)}
          />

          {/* 验证码 + 发送按钮 */}
          <text style={labelStyle}>验证码</text>
          <view style={{ display: 'flex', flexDirection: 'row', gap: spacing.sm }}>
            <input
              style={{ ...commonStyles.input, flex: 1 }}
              default-value={code}
              placeholder="6 位数字"
              bindinput={(e: { detail: { value: string } }) => setCode(e.detail.value)}
            />
            <view
              style={{
                width: 110,
                height: 48,
                borderRadius: 10,
                backgroundColor: countdown > 0 ? colors.surfaceAlt : colors.primarySoft,
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

          {/* 密码 */}
          <text style={labelStyle}>密码</text>
          <input
            style={commonStyles.input}
            default-value={password}
            type="password"
            placeholder="至少 8 位"
            bindinput={(e: { detail: { value: string } }) => setPassword(e.detail.value)}
          />

          {/* 昵称 */}
          <text style={labelStyle}>昵称</text>
          <input
            style={commonStyles.input}
            default-value={nickname}
            placeholder="其他用户看到的名字"
            bindinput={(e: { detail: { value: string } }) => setNickname(e.detail.value)}
          />

          {/* 邀请码 */}
          <text style={labelStyle}>邀请码</text>
          <input
            style={commonStyles.input}
            default-value={inviteCode}
            placeholder="必填，8 位字符"
            bindinput={(e: { detail: { value: string } }) => setInviteCode(e.detail.value)}
            bindblur={handleInviteBlur}
          />
          {inviteHint ? (
            <text
              style={{
                color: inviteHint.ok ? colors.success : colors.danger,
                fontSize: fontSize.xs,
              }}
            >
              {inviteHint.text}
            </text>
          ) : null}

          {/* 错误提示 */}
          <view style={{ height: 22, justifyContent: 'center', marginTop: spacing.xs }}>
            {error ? (
              <text style={{ color: colors.danger, fontSize: fontSize.sm }}>{error}</text>
            ) : null}
          </view>

          {/* 提交 */}
          <view
            style={{ ...commonStyles.buttonPrimary, opacity: loading ? 0.6 : 1 }}
            bindtap={handleRegister}
          >
            <text style={commonStyles.buttonPrimaryText}>
              {loading ? '注册中…' : '注册'}
            </text>
          </view>

          <text
            style={{
              color: colors.textFaint,
              fontSize: fontSize.xs,
              marginTop: spacing.md,
              lineHeight: 1.6,
            }}
          >
            注册即表示同意用户协议与隐私政策。邀请码由已注册用户提供，每个码有使用次数限制。
          </text>
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
