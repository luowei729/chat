/**
 * ============================================================
 * 注册页（两步式）
 * ------------------------------------------------------------
 * 【为什么分两步】
 *   本项目的 Lynx 集成里 scroll-view / list 都会把内容渲染成空白
 *   且不报错，所以页面不能用滚动容器。字段一次放全会超出屏幕，
 *   拆成两步后每一步都能一屏放下。
 *
 * 【布局约定（与 LoginPage 完全一致，已实测可用）】
 *   根 view: height 100% + width 100% + flex column
 *   卡片:    width 100% + flex column + padding
 *   每个 text 都不加 width，靠 margin 控制间距
 *   两个步骤用两个 return 分支，不用三元表达式嵌套
 * ============================================================
 */

import { useEffect, useRef, useState } from '@lynx-js/react';
import { getMe, register, sendEmailCode, validateInviteCode } from '../api/index.js';
import { ApiError } from '../api/client.js';
import * as ws from '../api/ws.js';
import { pop, reset } from '../router.js';
import { setUser } from '../store/auth.js';
import { colors } from '../theme.js';

export function RegisterPage(props: { initialInviteCode?: string }) {
  const [step, setStep] = useState(1);

  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [inviteCode, setInviteCode] = useState(props.initialInviteCode ?? 'CHAT8888');

  const [countdown, setCountdown] = useState(0);
  const [inviteHint, setInviteHint] = useState<{ ok: boolean; text: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

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

  const goStep2 = () => {
    if (!email.trim()) {
      setError('请输入邮箱');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError('邮箱格式不正确');
      return;
    }
    if (!code.trim()) {
      setError('请输入验证码');
      return;
    }
    setError(null);
    setStep(2);
  };

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

  const handleRegister = async () => {
    if (loading) return;

    if (password.length < 8) {
      setError('密码至少 8 位');
      return;
    }
    if (!nickname.trim()) {
      setError('请输入昵称');
      return;
    }
    if (!inviteCode.trim()) {
      setError('请输入邀请码');
      return;
    }

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
        const first = Object.values(e.fields)[0];
        setError(first ?? e.message);
      } else {
        setError(e instanceof ApiError ? e.message : '注册失败，请稍后重试');
      }
    } finally {
      setLoading(false);
    }
  };

  /* ---------------- 第一步：邮箱 + 验证码 ---------------- */
  if (step === 1) {
    return (
      <view
        style={{
          height: '100%',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: colors.bg,
        }}
      >
        <view
          style={{
            flex: 1,
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            paddingLeft: '24px',
            paddingRight: '24px',
            paddingTop: '24px',
          }}
        >
          {/* 顶部返回 */}
          <view style={{ width: '100%', display: 'flex', flexDirection: 'column' }}>
            <text
              style={{ fontSize: '14px', color: colors.primary, paddingTop: '4px', paddingBottom: '4px' }}
              bindtap={pop}
            >
              返回登录
            </text>
          </view>

          {/* 标题 */}
          <view
            style={{
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              marginTop: '12px',
              marginBottom: '20px',
            }}
          >
            <text style={{ fontSize: '22px', color: colors.text, fontWeight: '700' }}>创建账号</text>
            <text style={{ fontSize: '13px', color: colors.textFaint, marginTop: '4px' }}>
              第 1 步 / 共 2 步 · 验证邮箱
            </text>
          </view>

          {/* 表单卡片 */}
          <view
            style={{
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              backgroundColor: colors.card,
              borderWidth: '1px',
              borderColor: colors.cardBorder,
              borderRadius: '18px',
              padding: '16px',
            }}
          >
            <text style={{ fontSize: '13px', color: colors.textMuted, marginBottom: '8px' }}>邮箱</text>
            <input
              style={{
                width: '100%',
                height: '48px',
                borderRadius: '12px',
                backgroundColor: colors.surfaceAlt,
                borderWidth: '1px',
                borderColor: colors.border,
                paddingLeft: '16px',
                paddingRight: '16px',
                color: colors.text,
                fontSize: '15px',
              }}
              default-value={email}
              placeholder="用于接收验证码"
              bindinput={(e: { detail: { value: string } }) => setEmail(e.detail.value)}
            />

            <text style={{ fontSize: '13px', color: colors.textMuted, marginTop: '14px', marginBottom: '8px' }}>
              验证码
            </text>
            <input
              style={{
                width: '100%',
                height: '48px',
                borderRadius: '12px',
                backgroundColor: colors.surfaceAlt,
                borderWidth: '1px',
                borderColor: colors.border,
                paddingLeft: '16px',
                paddingRight: '16px',
                color: colors.text,
                fontSize: '15px',
              }}
              default-value={code}
              placeholder="6 位数字"
              bindinput={(e: { detail: { value: string } }) => setCode(e.detail.value)}
            />

            <view
              style={{
                width: '100%',
                height: '40px',
                borderRadius: '12px',
                backgroundColor: countdown > 0 ? colors.surfaceAlt : colors.primarySoft,
                borderWidth: '1px',
                borderColor: countdown > 0 ? colors.border : colors.primary,
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                marginTop: '10px',
              }}
              bindtap={handleSendCode}
            >
              <text style={{ fontSize: '13px', color: countdown > 0 ? colors.textFaint : colors.primary }}>
                {countdown > 0 ? `${countdown}s 后重发` : '获取验证码'}
              </text>
            </view>

            <view
              style={{
                width: '100%',
                height: '22px',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                marginTop: '8px',
              }}
            >
              {error ? (
                <text style={{ fontSize: '13px', color: colors.danger, textAlign: 'center' }}>{error}</text>
              ) : null}
            </view>

            <view
              style={{
                width: '100%',
                height: '48px',
                borderRadius: '12px',
                backgroundColor: colors.primary,
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                marginTop: '4px',
              }}
              bindtap={goStep2}
            >
              <text style={{ fontSize: '15px', color: '#FFFFFF', fontWeight: '600' }}>下一步</text>
            </view>
          </view>

          <text style={{ fontSize: '11px', color: colors.textFaint, marginTop: '16px', textAlign: 'center' }}>
            验证码会发送到你的邮箱，10 分钟内有效
          </text>
        </view>
      </view>
    );
  }

  /* ---------------- 第二步：密码 + 昵称 + 邀请码 ---------------- */
  return (
    <view
      style={{
        height: '100%',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: colors.bg,
      }}
    >
      <view
        style={{
          flex: 1,
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          paddingLeft: '24px',
          paddingRight: '24px',
          paddingTop: '24px',
        }}
      >
        <view style={{ width: '100%', display: 'flex', flexDirection: 'column' }}>
          <text
            style={{ fontSize: '14px', color: colors.primary, paddingTop: '4px', paddingBottom: '4px' }}
            bindtap={() => {
              setStep(1);
              setError(null);
            }}
          >
            上一步
          </text>
        </view>

        <view
          style={{
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            marginTop: '12px',
            marginBottom: '20px',
          }}
        >
          <text style={{ fontSize: '22px', color: colors.text, fontWeight: '700' }}>设置资料</text>
          <text style={{ fontSize: '13px', color: colors.textFaint, marginTop: '4px' }}>
            第 2 步 / 共 2 步 · {email}
          </text>
        </view>

        <view
          style={{
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: colors.card,
            borderWidth: '1px',
            borderColor: colors.cardBorder,
            borderRadius: '18px',
            padding: '16px',
          }}
        >
          <text style={{ fontSize: '13px', color: colors.textMuted, marginBottom: '8px' }}>密码</text>
          <input
            style={{
              width: '100%',
              height: '48px',
              borderRadius: '12px',
              backgroundColor: colors.surfaceAlt,
              borderWidth: '1px',
              borderColor: colors.border,
              paddingLeft: '16px',
              paddingRight: '16px',
              color: colors.text,
              fontSize: '15px',
            }}
            default-value={password}
            type="password"
            placeholder="至少 8 位"
            bindinput={(e: { detail: { value: string } }) => setPassword(e.detail.value)}
          />

          <text style={{ fontSize: '13px', color: colors.textMuted, marginTop: '14px', marginBottom: '8px' }}>
            昵称
          </text>
          <input
            style={{
              width: '100%',
              height: '48px',
              borderRadius: '12px',
              backgroundColor: colors.surfaceAlt,
              borderWidth: '1px',
              borderColor: colors.border,
              paddingLeft: '16px',
              paddingRight: '16px',
              color: colors.text,
              fontSize: '15px',
            }}
            default-value={nickname}
            placeholder="其他用户看到的名字"
            bindinput={(e: { detail: { value: string } }) => setNickname(e.detail.value)}
          />

          <text style={{ fontSize: '13px', color: colors.textMuted, marginTop: '14px', marginBottom: '8px' }}>
            邀请码
          </text>
          <input
            style={{
              width: '100%',
              height: '48px',
              borderRadius: '12px',
              backgroundColor: colors.surfaceAlt,
              borderWidth: '1px',
              borderColor: colors.border,
              paddingLeft: '16px',
              paddingRight: '16px',
              color: colors.text,
              fontSize: '15px',
            }}
            default-value={inviteCode}
            placeholder="已填好体验码 CHAT8888"
            bindinput={(e: { detail: { value: string } }) => setInviteCode(e.detail.value)}
            bindblur={handleInviteBlur}
          />
          <text
            style={{
              fontSize: '11px',
              color: inviteHint ? (inviteHint.ok ? colors.success : colors.danger) : colors.textFaint,
              marginTop: '6px',
            }}
          >
            {inviteHint ? inviteHint.text : '体验邀请码 CHAT8888 可直接使用'}
          </text>

          <view
            style={{
              width: '100%',
              height: '22px',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              marginTop: '8px',
            }}
          >
            {error ? (
              <text style={{ fontSize: '13px', color: colors.danger, textAlign: 'center' }}>{error}</text>
            ) : null}
          </view>

          <view
            style={{
              width: '100%',
              height: '48px',
              borderRadius: '12px',
              backgroundColor: colors.primary,
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: '4px',
              opacity: loading ? 0.6 : 1,
            }}
            bindtap={handleRegister}
          >
            <text style={{ fontSize: '15px', color: '#FFFFFF', fontWeight: '600' }}>
              {loading ? '注册中…' : '注 册'}
            </text>
          </view>
        </view>

        <text style={{ fontSize: '11px', color: colors.textFaint, marginTop: '16px', textAlign: 'center' }}>
          注册即表示同意用户协议与隐私政策
        </text>
      </view>
    </view>
  );
}
