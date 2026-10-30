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

import { useEffect, useRef, useState } from '@lynx-js/react';
import { getIceConfig, getMe } from './api/index.js';
import { clearTokens, getAccessToken, getRefreshToken, onAuthStateChange } from './api/client.js';
import { hydrateStorage } from './storage.js';
import { getGlobalEventEmitter, getNativeModule } from './platform/globals.js';
import * as ws from './api/ws.js';
import { setBootstrapped, setUser, useAuth } from './store/auth.js';
import { setMemberRead } from './store/reads.js';
import {
  appendMessage,
  applyNewMessage,
  clearMessages,
  markMessageRecalled,
  removeMessage,
  setConversations,
  setConversationsLoading,
  useConversations,
  updateConversationPrefs,
} from './store/conversations.js';
import { canGoBack, pop, push, reset, subscribeRoute, useCurrentRoute } from './router.js';
import { registerWebRtc, stopCall, updatePeerMediaState, removePeer } from './rtc/engine.js';
import { commonStyles, colors, fontSize, spacing, useTheme } from './theme.js';

import { LoginPage } from './pages/LoginPage.js';
import { RegisterPage } from './pages/RegisterPage.js';
import { ResetPasswordPage } from './pages/ResetPasswordPage.js';
import { ConversationsPage } from './pages/ConversationsPage.js';
import { ChatPage } from './pages/ChatPage.js';
import { CallPage } from './pages/CallPage.js';
import { InvitePage } from './pages/InvitePage.js';
import { ProfilePage } from './pages/ProfilePage.js';
import { NewChatPage } from './pages/NewChatPage.js';
import { ContactsPage } from './pages/ContactsPage.js';
import { FriendRequestsPage } from './pages/FriendRequestsPage.js';
import { UserProfilePage } from './pages/UserProfilePage.js';
import { GroupInfoPage } from './pages/GroupInfoPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { SearchMessagesPage } from './pages/SearchMessagesPage.js';
import { MediaViewerPage } from './pages/MediaViewerPage.js';

export function App() {
  const auth = useAuth();
  const theme = useTheme();
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
      // 先把原生持久化的令牌灌进内存，否则重启后会被误判为未登录
      await hydrateStorage();
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

    /**
     * 消息撤回
     * 服务端保留 seq 占位，这里也必须保留气泡（显示「消息已撤回」），
     * 不能 removeMessage —— 否则本地序号断号，与重新拉取的结果不一致。
     */
    const offDeleted = ws.on('message.deleted', (msg) => {
      markMessageRecalled(msg.conversationId, msg.messageId);
    });

    // 已读回执：把对方的已读水位推进，双勾即时点亮
    const offRead = ws.on('read.updated', (msg) => {
      setMemberRead(msg.conversationId, msg.userId, msg.seq);
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
      offRead();
      offConvNew();
      offPresence();
      offIncoming();
      offCallState();
      offMediaState();
      offP2p();
    };
  }, [auth.user?.id]);

  /* ---------------- 返回键与右滑返回 ---------------- */
  /**
   * 原生返回键 → 前端退栈
   * ------------------------------------------------------------
   * 原生侧（MainActivity.onBackPressed）：
   *   有上一页 → sendGlobalEvent('backPressed')
   *   根页面   → moveTaskToBack（最小化，不退出）
   * 这里监听事件执行真正的 pop。
   */
  useEffect(() => {
    const emitter = getGlobalEventEmitter();
    if (!emitter) return;

    const onBack = () => {
      if (canGoBack()) pop();
    };

    /**
     * 悬浮窗挂断
     * ------------------------------------------------------------
     * 原生小窗的挂断按钮不能直接调 JS 函数，
     * 因此走全局事件：原生发 callHangup → 这里结束通话。
     * 必须同时停掉 RTC 引擎与前台服务，否则通知栏会残留。
     */
    const onHangup = () => {
      try {
        stopCall();
      } catch {
        // 忽略
      }
      void import('./platform/host.js')
        .then((h) => h.setCallState(false, ''))
        .catch(() => undefined);
      // 回到会话列表（通话页可能已被销毁）
      reset({ name: 'conversations' });
    };

    try {
      emitter.addListener('backPressed', onBack);
      emitter.addListener('callHangup', onHangup);
    } catch {
      return;
    }
    return () => {
      try {
        emitter.removeListener('backPressed', onBack);
        emitter.removeListener('callHangup', onHangup);
      } catch {
        // 忽略
      }
    };
  }, []);

  /**
   * 同步「能否返回」给原生
   * 原生需要同步查询（onBackPressed 里不能 await），
   * 所以每次路由变化都把栈深度推过去。
   */
  useEffect(() => {
    const sync = () => {
      const host = getNativeModule<{
        setCanGoBack?: (v: boolean) => void;
      }>('ChatHost');
      try {
        host?.setCanGoBack?.(canGoBack());
      } catch {
        // 模块未注册时忽略
      }
    };
    sync();
    return subscribeRoute(sync);
  }, []);

  /* ---------------- 右滑返回手势 ---------------- */
  /**
   * 从屏幕左边缘向右滑 → 返回上一页
   * ------------------------------------------------------------
   * 判定条件（避免误触）：
   *   1. 起始点距左边缘 < 32px
   *   2. 水平位移 > 80px
   *   3. 水平位移 > 垂直位移 × 2（排除上下滚动）
   *
   * 为什么在 JS 层做而不是原生：
   * 原生拦截需要包 LynxView 的 dispatchTouchEvent，会干扰
   * Lynx 内部的点击/滚动判定；JS 层用 touch 事件零侵入。
   */
  const swipeRef = useRef<{ x: number; y: number; active: boolean }>({
    x: 0,
    y: 0,
    active: false,
  });

  const onTouchStart = (e: { touches?: Array<{ pageX?: number; x?: number; pageY?: number; y?: number }> }) => {
    const t = e.touches?.[0];
    if (!t) return;
    const x = t.pageX ?? t.x ?? 0;
    const y = t.pageY ?? t.y ?? 0;
    swipeRef.current = { x, y, active: x < 32 };
  };

  const onTouchEnd = (e: { changedTouches?: Array<{ pageX?: number; x?: number; pageY?: number; y?: number }> }) => {
    const st = swipeRef.current;
    swipeRef.current.active = false;
    if (!st.active) return;

    const t = e.changedTouches?.[0];
    if (!t) return;
    const dx = (t.pageX ?? t.x ?? 0) - st.x;
    const dy = Math.abs((t.pageY ?? t.y ?? 0) - st.y);

    if (dx > 80 && dx > dy * 2 && canGoBack()) {
      pop();
    }
  };

  /* ---------------- 渲染 ---------------- */
  let content;

  if (!auth.bootstrapped) {
    content = (
      <view style={commonStyles.center}>
        <text style={{ color: colors.textMuted, fontSize: fontSize.md }}>加载中…</text>
      </view>
    );
  } else if (bootError) {
    content = (
      <view style={commonStyles.center}>
        <text style={{ color: colors.danger, fontSize: fontSize.md }}>{bootError}</text>
      </view>
    );
  } else {
    content = renderRoute(route.name, route.params);
  }

  /**
   * key={theme.resolved} 强制重建整棵子树
   * ============================================================
   * 切换明暗主题时，仅靠 colors 的 getter 不够：
   * 模块级的样式常量（如页面里的 infoCardStyle）在模块加载时就
   * 逃逸了颜色值，不会自己刷新。
   * 用 key 把整棵树卸载重建，所有样式重新求值，最彻底且无需
   * 在每个页面里写主题监听。
   */
  return (
    <page>
      <view
        style={rootStyle()}
        key={theme.resolved}
        bindtouchstart={onTouchStart}
        bindtouchend={onTouchEnd}
      >
        {content}
      </view>
    </page>
  );
}

/**
 * 根容器
 * ============================================================
 * 结构（Android 模拟器实测通过）：
 *
 *   <page>                                   ← 不带任何样式
 *     <view height:100vh flex column>
 *       <页面组件 flex:1 />
 *     </view>
 *   </page>
 *
 * 三条铁律，每条都是实测踩出来的：
 *
 * 1. 根必须是 <page>，且 page 上不写样式。
 *    page 尺寸由 LynxView 直接给定，再写 height 反而会干扰。
 *
 * 2. 内容容器必须 height:'100vh'，**不能是 minHeight**。
 *    min-height 让父级高度不确定，子元素的 flex:1 / scroll-view
 *    全部塌陷成 0 高。此时 Lynx 不报任何错、onFirstScreen 照常触发，
 *    表现就是「整屏空白」——最难排查的一类问题。
 *
 * 3. 不要用 position:absolute 做内容容器。
 *    absolute 会成为新的包含块，内部 flex 链同样失效。
 * ============================================================
 */
/**
 * 根容器样式
 * 必须是函数：colors 的每个属性都是 getter，
 * 写成模块级常量会在加载时就把颜色固化，切主题后不刷新。
 */
function rootStyle() {
  return {
    width: '100%',
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: colors.bg,
  } as const;
}

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
    case 'contacts':
      return <ContactsPage />;
    case 'friend-requests':
      return <FriendRequestsPage />;
    case 'user-profile':
      return <UserProfilePage userId={params?.userId as string} />;
    case 'group-info':
      return (
        <GroupInfoPage
          conversationId={params?.conversationId as string}
          title={params?.title as string | undefined}
        />
      );
    case 'settings':
      return <SettingsPage />;
    case 'search-messages':
      return <SearchMessagesPage />;
    case 'media-viewer':
      return (
        <MediaViewerPage
          url={(params?.url as string) ?? ''}
          kind={((params?.kind as string) ?? 'image') as 'image' | 'video'}
          filename={params?.filename as string | undefined}
        />
      );
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
