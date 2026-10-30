/**
 * ============================================================
 * 登录页
 * ------------------------------------------------------------
 * 交互：邮箱 + 密码登录；失败展示服务端返回的具体原因；
 *      提供注册与忘记密码入口。
 *
 * 【布局方案 —— 已在 Android 14 模拟器实测通过】
 *   page → 根 view(height:100vh) → 本页 view(height:100%)
 *        → 内层 view(flex:1) → 品牌 / 卡片 / 入口
 *
 * 【关键经验】
 * 1. 不用 scroll-view，也不用 list：
 *    这两个容器在部分父级组合下会把子内容渲染成空白，
 *    且不抛任何错误（onFirstScreen 照常成功），极难排查。
 *    页面内容能一屏放下时，纯 view 布局最可靠。
 * 2. 所有长度写成带单位的字符串（'16px'），
 *    数字形式会触发 CSS length need units 并中断渲染。
 * 3. text 不要直接设 flex，需要弹性布局就用 view 包一层。
 * ============================================================
 */

import { useState } from '@lynx-js/react';
import { login, getMe } from '../api/index.js';
import { ApiError } from '../api/client.js';
import * as ws from '../api/ws.js';
import { push, reset } from '../router.js';
import { setUser } from '../store/auth.js';

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
        height: '100%',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#070B14',
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
          paddingTop: '32px',
        }}
      >
        {/* 品牌区 */}
        <view
          style={{
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            marginBottom: '24px',
          }}
        >
          <view
            style={{
              width: '64px',
              height: '64px',
              borderRadius: '20px',
              backgroundColor: '#4C7DFF',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: '10px',
            }}
          >
            <text style={{ fontSize: '28px', color: '#FFFFFF', fontWeight: '700' }}>C</text>
          </view>
          <text style={{ fontSize: '26px', color: '#EDF1F7', fontWeight: '700' }}>chat</text>
          <text style={{ fontSize: '13px', color: '#5F6B84', marginTop: '4px' }}>
            安全 · 快速 · 跨平台聊天
          </text>
        </view>

        {/* 表单卡片 */}
        <view
          style={{
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: '#111A2E',
            borderWidth: '1px',
            borderColor: '#21304F',
            borderRadius: '18px',
            padding: '16px',
          }}
        >
          <text style={{ fontSize: '13px', color: '#9AA5BB', marginBottom: '8px' }}>邮箱</text>
          <input
            style={{
              width: '100%',
              height: '48px',
              borderRadius: '12px',
              backgroundColor: '#141D33',
              borderWidth: '1px',
              borderColor: '#1B2540',
              paddingLeft: '16px',
              paddingRight: '16px',
              color: '#EDF1F7',
              fontSize: '15px',
            }}
            default-value={email}
            placeholder="you@example.com"
            bindinput={(e: { detail: { value: string } }) => setEmail(e.detail.value)}
          />

          <text style={{ fontSize: '13px', color: '#9AA5BB', marginTop: '14px', marginBottom: '8px' }}>
            密码
          </text>
          <input
            style={{
              width: '100%',
              height: '48px',
              borderRadius: '12px',
              backgroundColor: '#141D33',
              borderWidth: '1px',
              borderColor: '#1B2540',
              paddingLeft: '16px',
              paddingRight: '16px',
              color: '#EDF1F7',
              fontSize: '15px',
            }}
            default-value={password}
            type="password"
            placeholder="请输入密码"
            bindinput={(e: { detail: { value: string } }) => setPassword(e.detail.value)}
          />

          {/* 错误提示：固定高度，避免布局跳动 */}
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
              <text style={{ fontSize: '13px', color: '#FF5C5C', textAlign: 'center' }}>{error}</text>
            ) : null}
          </view>

          <view
            style={{
              width: '100%',
              height: '48px',
              borderRadius: '12px',
              backgroundColor: '#4C7DFF',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: '8px',
              opacity: loading ? 0.6 : 1,
            }}
            bindtap={handleLogin}
          >
            <text style={{ fontSize: '15px', color: '#FFFFFF', fontWeight: '600' }}>
              {loading ? '登录中…' : '登 录'}
            </text>
          </view>
        </view>

        {/* 底部入口 */}
        <view
          style={{
            width: '100%',
            display: 'flex',
            flexDirection: 'row',
            justifyContent: 'center',
            marginTop: '18px',
          }}
        >
          <text
            style={{ fontSize: '14px', color: '#4C7DFF', padding: '8px' }}
            bindtap={() => push({ name: 'register' })}
          >
            注册新账号
          </text>
          <text style={{ fontSize: '14px', color: '#1B2540', padding: '8px' }}>|</text>
          <text
            style={{ fontSize: '14px', color: '#9AA5BB', padding: '8px' }}
            bindtap={() => push({ name: 'reset-password' })}
          >
            忘记密码
          </text>
        </view>
      </view>
    </view>
  );
}
