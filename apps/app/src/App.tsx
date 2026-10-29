/**
 * ============================================================
 * 应用根组件
 * ------------------------------------------------------------
 * 职责：
 * 1. 启动时恢复登录态（有 refresh token 就尝试静默登录）；
 * 2. 注册 WS 事件 → 分发到各 store；
 * 3. 根据路由渲染对应页面；
 * 4. 全局处理来电（无论当前在哪个页面都要弹出来电界面）。
 * ============================================================
 */

import { useEffect, useState } from '@lynx-js/react';
import { getIceConfig, getMe } from './api/index.js';
import { clearTokens, getAccessToken, getRefreshToken, onAuthStateChange } from './api/client.js';
import * as ws from './api/ws.js';
import { setBootstrapped, setUser, useAuth } from './store/auth.js';
import {
  appendMessage,
  applyNewMessage,
  clearMessages,
  removeMessage,
  setConversations,
  setConversationsLoading,
  useConversations,
  updateConversationPrefs,
} from './store/conversations.js';
import { push, reset, useCurrentRoute } from './router.js';
import { registerWebRtc, stopCall, updatePeerMediaState, removePeer } from './rtc/engine.js';
import { commonStyles, colors, fontSize, spacing } from './theme.js';

import { LoginPage } from './pages/LoginPage.js';
import { RegisterPage } from './pages/RegisterPage.js';
import { ResetPasswordPage } from './pages/ResetPasswordPage.js';
import { ConversationsPage } from './pages/ConversationsPage.js';
import { ChatPage } from './pages/ChatPage.js';
import { CallPage } from './pages/CallPage.js';
import { InvitePage } from './pages/InvitePage.js';
import { ProfilePage } from './pages/ProfilePage.js';
import { NewChatPage } from './pages/NewChatPage.js';

export function App() {
  const auth = useAuth();
  const route = useCurrentRoute();
  const conversations = useConversations();
  const [bootError, setBootError] = useState<string | null>(null);

  /* ---------------- 启动：恢复登录态 ---------------- */
  useEffect(() => {
    // 注册浏览器 WebRTC（Web/Electron 生效；原生端由 Lynx 模块注册）
    registerWebRtc();

    // 令牌失效时统一回到登录页
    onAuthStateChange((loggedIn) => {
      if (!loggedIn) {
        ws.disconnect();
        clearMessages();
        reset({ name: 'login' });
      }
    });

    void (async () => {
      const hasToken = !!getAccessToken() || !!getRefreshToken();
      if (!hasToken) {
        setBootstrapped();
        reset({ name: 'login' });
        return;
      }

      try {
        // 用 access token 拉自己的资料，验证登录态是否有效
        const me = await getMe();
        setUser(me);
        ws.connect();
        reset({ name: 'conversations' });
      } catch {
        // access 过期且刷新失败 → 回登录页
        clearTokens();
        reset({ name: 'login' });
      } finally {
        setBootstrapped();
      }
    })();
  }, []);

  /* ---------------- 登录后：加载会话列表 ---------------- */
  useEffect(() => {
    if (!auth.user) return;

    setConversationsLoading(true);
    void import('./api/index.js')
      .then((api) => api.listConversations())
      .then((list) => setConversations(list))
      .catch(() => setConversationsLoading(false));
  }, [auth.user?.id]);

  /* ---------------- WS 事件分发 ---------------- */
  useEffect(() => {
    if (!auth.user) return;

    // 新消息
    const offNew = ws.on('message.new', (msg) => {
      const current = routeRef.current;
      const activeId = current.name === 'chat' ? (current.params?.conversationId as string) : null;

      appendMessage(msg.conversationId, msg.message);
      applyNewMessage(msg.conversationId, msg.message, activeId);

      // 收到已读回执时把自己的未读数清零（当前会话）
      if (activeId === msg.conversationId) {
        ws.sendRead(msg.conversationId, msg.message.seq);
      }
    });

    // 消息撤回
    const offDeleted = ws.on('message.deleted', (msg) => {
      removeMessage(msg.conversationId, msg.messageId);
    });

    // 会话更新（别人新建会话、成员变动）
    const offConvNew = ws.on('conversation.new', () => {
      void import('./api/index.js')
        .then((api) => api.listConversations())
        .then((list) => setConversations(list))
        .catch(() => undefined);
    });

    // 在线状态（暂不展示，留给后续「最后上线」功能）
    const offPresence = ws.on('presence', () => undefined);

    /* ---------------- 通话事件 ---------------- */
    const offIncoming = ws.on('call.incoming', (msg) => {
      // 无论当前在哪，都弹来电页
      push({
        name: 'call',
        params: {
          callId: msg.callId,
          conversationId: msg.conversationId,
          mode: msg.mode,
          callerName: msg.caller.nickname,
          incoming: true,
          expiresAt: msg.expiresAt,
        },
      });
    });

    const offCallState = ws.on('call.state', (msg) => {
      if (msg.status === 'ended' || msg.status === 'rejected' || msg.status === 'missed') {
        stopCall();
        return;
      }
      // 有人离开：关闭对应 PeerConnection
      if (msg.leftUserId) removePeer(msg.leftUserId);
    });

    const offMediaState = ws.on('call.media-state', (msg) => {
      updatePeerMediaState({ userId: msg.userId, muted: msg.muted, speaking: msg.speaking });
    });

    const offP2p = ws.on('call.p2p', (msg) => {
      void handleP2pSignal(msg);
    });

    return () => {
      offNew();
      offDeleted();
      offConvNew();
      offPresence();
      offIncoming();
      offCallState();
      offMediaState();
      offP2p();
    };
  }, [auth.user?.id]);

  /* ---------------- 渲染 ---------------- */
  if (!auth.bootstrapped) {
    // 注意：根节点必须是 <page>，Lynx 用它提供全屏高度参照，
    // 用 <view> 会导致 height:100% 塌陷为 0（表现为黑屏）
    return (
      <page style={pageStyle}>
        <view style={commonStyles.center}>
          <text style={{ color: colors.textMuted, fontSize: fontSize.md }}>加载中…</text>
        </view>
      </page>
    );
  }

  if (bootError) {
    return (
      <page style={pageStyle}>
        <view style={commonStyles.center}>
          <text style={{ color: colors.danger, fontSize: fontSize.md }}>{bootError}</text>
        </view>
      </page>
    );
  }

  return (
    <page style={pageStyle}>
      {renderRoute(route.name, route.params)}
    </page>
  );
}

/**
 * 根 page 样式
 * 说明：Lynx 的 <page> 默认全屏，但显式声明高度更稳妥，
 *      同时统一背景色，避免启动瞬间闪白。
 */
const pageStyle = {
  width: '100%',
  height: '100%',
  backgroundColor: colors.bg,
  display: 'flex',
  flexDirection: 'column',
} as const;

/** 路由 → 页面组件 */
function renderRoute(name: string, params?: Record<string, unknown>) {
  switch (name) {
    case 'login':
      return <LoginPage />;
    case 'register':
      return <RegisterPage initialInviteCode={params?.inviteCode as string | undefined} />;
    case 'reset-password':
      return <ResetPasswordPage />;
    case 'conversations':
      return <ConversationsPage />;
    case 'chat':
      return (
        <ChatPage
          conversationId={params?.conversationId as string}
          title={params?.title as string | undefined}
        />
      );
    case 'call':
      return (
        <CallPage
          callId={params?.callId as string}
          conversationId={params?.conversationId as string}
          mode={(params?.mode as 'audio' | 'video') ?? 'audio'}
          callerName={params?.callerName as string | undefined}
          incoming={!!params?.incoming}
        />
      );
    case 'invite':
      return <InvitePage />;
    case 'profile':
      return <ProfilePage />;
    case 'new-chat':
      return <NewChatPage />;
    default:
      return <ConversationsPage />;
  }
}

/* ------------------------------------------------------------------ */
/* P2P 信令处理（需要在组件外访问最新路由）                              */
/* ------------------------------------------------------------------ */

/** 当前路由的引用：供 WS 回调读取，避免闭包拿到旧值 */
const routeRef: { current: { name: string; params?: Record<string, unknown> } } = {
  current: { name: 'conversations' },
};

/** 由 App 内部同步路由到 ref（在渲染时更新） */
export function syncRouteRef(r: { name: string; params?: Record<string, unknown> }): void {
  routeRef.current = r;
}

/**
 * 处理收到的 P2P 信令
 * 说明：需要 ICE 配置（含 TURN 临时凭据），每次通话只取一次并缓存。
 */
let cachedIceServers: Awaited<ReturnType<typeof getIceConfig>> | null = null;

export async function getCachedIceConfig() {
  if (cachedIceServers) return cachedIceServers;
  cachedIceServers = await getIceConfig();
  return cachedIceServers;
}

async function handleP2pSignal(msg: {
  callId: string;
  kind: 'offer' | 'answer' | 'ice' | 'renegotiate';
  from: string;
  payload: string;
}): Promise<void> {
  const engine = await import('./rtc/engine.js');
  const ice = await getCachedIceConfig();

  if (msg.kind === 'offer') {
    await engine.handleOffer({ from: msg.from, payload: msg.payload, iceServers: ice.iceServers });
  } else if (msg.kind === 'answer') {
    await engine.handleAnswer({ from: msg.from, payload: msg.payload });
  } else if (msg.kind === 'ice') {
    await engine.handleIceCandidate({ from: msg.from, payload: msg.payload });
  }
}

// 保留未使用引用，避免打包器告警
void spacing;
void updateConversationPrefs;
void getRefreshToken;
