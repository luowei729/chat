/**
 * ============================================================
 * 通话页（语音）
 * ------------------------------------------------------------
 * 两种模式：
 *   来电（incoming=true）：显示「接听 / 拒接」
 *   呼出（incoming=false）：显示「等待对方接听 / 取消」
 *   接通后：显示参与者网格、静音、挂断
 *
 * 关键点：
 * 1. getUserMedia 必须由用户手势触发（浏览器/系统限制），
 *    所以接听按钮的点击是唯一启动麦克风的时机；
 * 2. Mesh 拓扑：接通后需要主动向已在通话中的人建立连接，
 *    规则是「已在通话中的人向新加入者发 offer」；
 * 3. 挂断时必须 stop() 所有音轨，否则麦克风指示灯常亮。
 * ============================================================
 */

import { useEffect, useRef, useState } from '@lynx-js/react';
import { getIceConfig } from '../api/index.js';
import * as ws from '../api/ws.js';
import { pop } from '../router.js';
import { currentUserId } from '../store/auth.js';
import {
  connectToNewPeer,
  getCallState,
  handleAnswer,
  handleIceCandidate,
  handleOffer,
  setMuted,
  startLocalAudio,
  stopCall,
  subscribeCallState,
  type CallEngineState,
} from '../rtc/engine.js';
import { IconCheck, IconClose, IconMic } from './Icons.js';
import { colors, commonStyles, fontSize, radius, spacing } from '../theme.js';

export function CallPage(props: {
  callId: string;
  conversationId: string;
  mode: 'audio' | 'video';
  callerName?: string;
  incoming: boolean;
}) {
  const { callId, conversationId, callerName, incoming } = props;

  const [engine, setEngine] = useState<CallEngineState>(getCallState());
  const [phase, setPhase] = useState<'ringing' | 'connecting' | 'active' | 'ended'>(
    incoming ? 'ringing' : 'ringing',
  );
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  /** ICE 配置缓存（含 TURN 临时凭据） */
  const iceRef = useRef<Awaited<ReturnType<typeof getIceConfig>> | null>(null);
  const myId = currentUserId();

  /* ---------------- 订阅引擎状态 ---------------- */
  useEffect(() => {
    return subscribeCallState(setEngine);
  }, []);

  /* ---------------- 通话计时 ---------------- */
  useEffect(() => {
    if (phase !== 'active') return;
    const timer = setInterval(() => setElapsed((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  /* ---------------- 监听通话状态与信令 ---------------- */
  useEffect(() => {
    const offState = ws.on('call.state', (msg) => {
      if (msg.callId !== callId) return;

      if (msg.status === 'active') {
        setPhase('active');

        /**
         * Mesh 拓扑维护：
         * 收到 joinedUserId 说明有人刚加入。
         * 规则：**已在通话中的人主动向新加入者发 offer**，
         * 避免双方同时发 offer 造成 glare。
         */
        if (msg.joinedUserId && msg.joinedUserId !== myId) {
          void (async () => {
            const ice = await ensureIce();
            if (ice) await connectToNewPeer(msg.joinedUserId!, ice.iceServers);
          })();
        }
      }

      if (msg.status === 'ended' || msg.status === 'rejected' || msg.status === 'missed') {
        setPhase('ended');
        stopCall();
        // 1.5 秒后自动返回，让用户看到「通话已结束」
        setTimeout(() => pop(), 1500);
      }
    });

    const offP2p = ws.on('call.p2p', (msg) => {
      if (msg.callId !== callId) return;
      void (async () => {
        const ice = await ensureIce();
        if (!ice) return;

        if (msg.kind === 'offer') {
          await handleOffer({ from: msg.from, payload: msg.payload, iceServers: ice.iceServers });
        } else if (msg.kind === 'answer') {
          await handleAnswer({ from: msg.from, payload: msg.payload });
        } else if (msg.kind === 'ice') {
          await handleIceCandidate({ from: msg.from, payload: msg.payload });
        }
      })();
    });

    const offMedia = ws.on('call.media-state', () => {
      // 引擎内部已处理，这里只是确保状态同步
      setEngine(getCallState());
    });

    return () => {
      offState();
      offP2p();
      offMedia();
    };
  }, [callId, myId]);

  /** 懒加载 ICE 配置（只取一次） */
  const ensureIce = async () => {
    if (iceRef.current) return iceRef.current;
    try {
      iceRef.current = await getIceConfig();
      return iceRef.current;
    } catch {
      setError('无法获取通话服务器配置');
      return null;
    }
  };

  /* ---------------- 接听 ---------------- */
  const handleAccept = async () => {
    setPhase('connecting');
    setError(null);

    // 1. 启动本地麦克风（必须在用户手势内）
    const ok = await startLocalAudio(callId, conversationId);
    if (!ok) {
      setError(getCallState().error ?? '无法启动麦克风');
      setPhase('ringing');
      return;
    }

    // 2. 通知服务端接听
    ws.acceptCall(callId);

    // 3. 预热 ICE 配置
    await ensureIce();
  };

  /* ---------------- 拒接 ---------------- */
  const handleReject = () => {
    ws.rejectCall(callId);
    stopCall();
    pop();
  };

  /* ---------------- 挂断 ---------------- */
  const handleHangup = () => {
    ws.hangupCall(callId);
    stopCall();
    pop();
  };

  /* ---------------- 静音切换 ---------------- */
  const toggleMute = () => {
    setMuted(!engine.muted);
  };

  /* ---------------- 卸载时清理 ---------------- */
  useEffect(() => {
    return () => {
      // 页面被销毁（用户返回）时必须释放麦克风
      stopCall();
    };
  }, []);

  const peerList = Object.values(engine.peers);
  const participantCount = peerList.length + 1;

  return (
    <view
      style={{
        ...commonStyles.page,
        backgroundColor: colors.bg,
        justifyContent: 'space-between',
      }}
    >
      {/* 顶部：通话对象与状态（全部居中，用 margin 代替 gap） */}
      <view style={{ alignItems: 'center', paddingTop: '80px' }}>
        <view
          style={{
            width: '96px',
            height: '96px',
            borderRadius: radius.full,
            backgroundColor: colors.primarySoft,
            borderWidth: '2px',
            borderColor: colors.cardBorder,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: spacing.lg,
          }}
        >
          <text style={{ color: colors.primary, fontSize: '36px', fontWeight: '600' }}>
            {(callerName ?? '通').slice(0, 1)}
          </text>
        </view>

        <text
          style={{ color: colors.text, fontSize: fontSize.xl, fontWeight: '600', textAlign: 'center' }}
          text-maxline="1"
        >
          {callerName ?? '语音通话'}
        </text>

        <text style={{ color: colors.textMuted, fontSize: fontSize.sm, marginTop: spacing.sm }}>
          {phase === 'ringing'
            ? incoming
              ? '邀请你语音通话'
              : '正在呼叫…'
            : phase === 'connecting'
              ? '正在连接…'
              : phase === 'active'
                ? `${formatDuration(elapsed)} · ${participantCount} 人`
                : '通话已结束'}
        </text>

        {error ? (
          <text style={{ color: colors.danger, fontSize: fontSize.sm, marginTop: spacing.sm }}>
            {error}
          </text>
        ) : null}
      </view>

      {/* 中部：参与者网格（语音用头像 + 说话高亮） */}
      <view
        style={{
          flex: 1,
          padding: spacing.xl,
          display: 'flex',
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignContent: 'center',
          justifyContent: 'center',
        }}
      >
        {/* 自己 */}
        <ParticipantTile
          name="我"
          speaking={engine.speaking}
          muted={engine.muted}
        />

        {/* 远端成员 */}
        {peerList.map((peer) => (
          <ParticipantTile
            key={peer.userId}
            name={shortName(peer.userId)}
            speaking={peer.speaking}
            muted={peer.muted}
            connectionState={peer.connectionState}
          />
        ))}
      </view>

      {/* 底部：操作按钮（用 margin 分隔，不用 gap） */}
      <view
        style={{
          paddingBottom: '60px',
          display: 'flex',
          flexDirection: 'row', width: '100%',
          justifyContent: 'center',
        }}
      >
        {phase === 'ringing' && incoming ? (
          <>
            <CircleButton label="拒接" color={colors.danger} onTap={handleReject} action="hangup" />
            <CircleButton label="接听" color={colors.success} onTap={handleAccept} action="accept" />
          </>
        ) : phase === 'ringing' ? (
          <CircleButton label="取消" color={colors.danger} onTap={handleHangup} action="hangup" />
        ) : (
          <>
            <CircleButton
              label={engine.muted ? '取消静音' : '静音'}
              color={engine.muted ? colors.primary : colors.surfaceAlt}
              onTap={toggleMute}
              action="mute"
              muted={engine.muted}
            />
            <CircleButton label="挂断" color={colors.danger} onTap={handleHangup} action="hangup" />
          </>
        )}
      </view>
    </view>
  );
}

/* ------------------------------------------------------------------ */
/* 子组件                                                               */
/* ------------------------------------------------------------------ */

/** 参与者方块：说话时边框高亮 */
function ParticipantTile(props: {
  name: string;
  speaking: boolean;
  muted: boolean;
  connectionState?: string;
}) {
  const { name, speaking, muted, connectionState } = props;

  return (
    <view
      style={{
        width: '88px',
        height: '112px',
        alignItems: 'center',
        margin: spacing.sm,
      }}
    >
      <view
        style={{
          width: '72px',
          height: '72px',
          borderRadius: radius.full,
          backgroundColor: speaking ? colors.primarySoft : colors.surfaceAlt,
          // 说话时用主色描边，是语音通话最重要的反馈
          borderWidth: speaking ? 3 : 1,
          borderColor: speaking ? colors.primary : colors.border,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <text style={{ color: colors.text, fontSize: fontSize.xl, fontWeight: '600' }}>
          {name.slice(0, 1)}
        </text>
      </view>

      <text
        style={{ color: colors.textMuted, fontSize: fontSize.xs, marginTop: '6px', textAlign: 'center' }}
        text-maxline="1"
      >
        {name}
        {muted ? '（静音）' : ''}
      </text>

      {connectionState && connectionState !== 'connected' ? (
        <text style={{ color: colors.textFaint, fontSize: '10px', marginTop: '2px' }}>
          {connectionState === 'connecting' ? '连接中' : '重连中'}
        </text>
      ) : null}
    </view>
  );
}

/** 圆形操作按钮 */
function CircleButton(props: {
  label: string;
  color: string;
  /** 图标语义：接听 / 挂断 / 静音 */
  action: 'accept' | 'hangup' | 'mute';
  /** true = 静音态（麦克风 + 斜杠） */
  muted?: boolean;
  onTap: () => void;
}) {
  const { label, color, action, muted = false, onTap } = props;

  return (
    <view style={{ alignItems: 'center', marginLeft: spacing.lg, marginRight: spacing.lg }}>
      <view
        style={{
          width: '64px',
          height: '64px',
          borderRadius: radius.full,
          backgroundColor: color,
          borderWidth: '1px',
          borderColor: colors.cardBorder,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: spacing.sm,
        }}
        bindtap={onTap}
      >
        <view style={{ position: 'relative', width: '22px', height: '22px' }}>
          {action === 'mute' ? <IconMic size={22} color="#FFFFFF" /> : null}
          {action === 'accept' ? <IconCheck size={22} color="#FFFFFF" /> : null}
          {action === 'hangup' ? <IconClose size={22} color="#FFFFFF" /> : null}

          {action === 'mute' && muted ? (
            /* 静音斜杠：45° 细线，覆盖在麦克风上 */
            <view
              style={{
                position: 'absolute',
                left: '-2px',
                top: '10px',
                width: '26px',
                height: '2px',
                backgroundColor: '#FFFFFF',
                borderRadius: '1px',
                transform: 'rotate(-45deg)',
              }}
            />
          ) : null}
        </view>
      </view>
      <text style={{ color: colors.textMuted, fontSize: fontSize.xs }}>{label}</text>
    </view>
  );
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                             */
/* ------------------------------------------------------------------ */

/** 秒 → mm:ss */
function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 用户 id 太长，取后 4 位做展示（正式版应拉取昵称） */
function shortName(userId: string): string {
  return userId.slice(-4);
}
