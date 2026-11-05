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
import { moveTaskToBack, prepareCallBackground, setCallState } from '../platform/host.js';
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
  updateParticipantNames,
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

  /**
   * 主叫无应答保护
   * ------------------------------------------------------------
   * 服务端 45 秒振铃超时后会广播 missed，但弱网下该帧可能丢失，
   * 主叫会永远卡在「正在呼叫…」。这里 50 秒兜底：仍在振铃就
   * 主动挂断并提示，避免无限等待。
   */
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  useEffect(() => {
    if (phase !== 'ringing' || incoming) return;
    const t = setTimeout(() => {
      if (phaseRef.current === 'ringing') {
        setError('对方未接听，已自动挂断');
        ws.hangupCall(callId);
        setTimeout(() => pop(), 1500);
      }
    }, 50_000);
    return () => clearTimeout(t);
  }, [phase, incoming, callId]);

  /* ---------------- 监听通话状态与信令 ---------------- */
  useEffect(() => {
    const offState = ws.on('call.state', (msg) => {
      if (msg.callId !== callId) return;

      // 先落昵称：后面无论是哪条分支，参与者头像下方都能显示真实名字
      updateParticipantNames(msg.participantNames);

      if (msg.status === 'active') {
        /**
         * 防御：已接通但只剩自己
         * ------------------------------------------------------------
         * 正常情况下对方挂断时服务端会直接广播 ended；
         * 弱网下这一帧可能丢，导致自己停在「1 人通话中」计时。
         * 收到 active 但参与者只有自己时，视为通话已结束。
         */
        if ((msg.participantIds?.length ?? 0) <= 1) {
          setPhase('ended');
          setCallState(false, '');
          stopCall();
          setTimeout(() => pop(), 1500);
          return;
        }

        setPhase('active');

        void (async () => {
          const ice = await ensureIce();
          if (!ice) return;
          /**
           * 主叫入会补课
           * ------------------------------------------------------------
           * 之前的 bug：startLocalAudio() 只在「接听」里调，
           * 主叫方收到 active 时 engine.active 还是 false，
           * connectToNewPeer 第一行就 return，全程零媒体。
           * 表现就是「拨出去有振铃、对方接了却没声音、计时也不走」。
           * 现在 active 到达时若本地还没启动，先补启动，
           * 再与所有已在通话中的成员逐个建连。
           */
          if (!getCallState().active) {
            const ok = await startLocalAudio(callId, conversationId);
            if (!ok) {
              setError(getCallState().error ?? '无法启动麦克风');
              return;
            }
          }

          /**
           * Offer 角色规则（避免 glare）
           * ------------------------------------------------------------
           * joinedUserId 是「这次新加入的人」：
           *   · 我是已在通话中的人（joinedUserId ≠ 我）→ 我发 offer；
           *   · 我就是新加入者（joinedUserId === 我）→ 只等 offer，
           *     绝不主动发，否则双方同时 offer，互相
           *     setRemoteDescription 失败，连接永远停在「重连中」。
           * 之前的 bug：不管 joinedUserId 是谁，都遍历所有参与者
           * 发 offer，两端必然对撞，通话接通了也没声音。
           */
          if (msg.joinedUserId && msg.joinedUserId === myId) {
            return;
          }

          const targets = new Set<string>(msg.participantIds ?? []);
          if (msg.joinedUserId && msg.joinedUserId !== myId) targets.add(msg.joinedUserId);
          for (const pid of targets) {
            if (pid !== myId) await connectToNewPeer(pid, ice.iceServers);
          }
        })();
      }

      if (msg.status === 'ended' || msg.status === 'rejected' || msg.status === 'missed') {
        setPhase('ended');
        // 停前台服务 + 隐藏悬浮窗，否则通知栏会残留
        setCallState(false, '');
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
    setCallState(false, '');
    stopCall();
    pop();
  };

  /* ---------------- 挂断 ---------------- */
  const handleHangup = () => {
    ws.hangupCall(callId);
    setCallState(false, '');
    stopCall();
    pop();
  };

  /* ---------------- 后台通话与悬浮窗 ---------------- */
  /**
   * 生命周期与后台能力的绑定
   * ============================================================
   * 规则：
   *   已接通（active）→ 开启后台（前台服务 + 麦克风类型）；
   *   已结束（ended）→ 关闭并清理。
   *
   * 【振铃阶段不能启动麦克风前台服务】
   * Android 14 要求 FGS type=microphone 必须满足全部条件：
   *   有 FOREGROUND_SERVICE_MICROPHONE + RECORD_AUDIO，
   *   且进程处于「允许从后台启动 FGS」的状态。
   * 来电时 App 往往在后台，系统直接抛 SecurityException，
   * 且异常发生在 Service.onStartCommand 主线程 → **整个 App 崩溃**，
   * 用户看到的就是「一来电就闪退 / 完全没反应」。
   * 只在用户点接听（App 已在前台）后启动，既合规又不会崩。
   */
  useEffect(() => {
    if (phase === 'active') {
      prepareCallBackground(callerName ?? '通话中');
    } else if (phase === 'ended') {
      setCallState(false, '');
    }
  }, [phase, incoming, callerName]);

  /**
   * 通话心跳（服务端租约）
   * ------------------------------------------------------------
   * 服务端靠 lastSeenAt 判定通话是否还活着：
   * App 被杀/闪退后心跳停止，90 秒后自动回收这通电话，
   * 否则用户会永远被「你已在通话中」拒绝新的呼叫。
   * 复用 media-state 通道，不新增协议消息。
   */
  useEffect(() => {
    if (phase !== 'active') return;
    const beat = () => {
      const s = getCallState();
      ws.sendMediaState({ callId, muted: s.muted, speaking: s.speaking });
    };
    beat();
    const timer = setInterval(beat, 20_000);
    return () => clearInterval(timer);
  }, [phase, callId]);

  /* ---------------- 最小化到悬浮窗 ---------------- */
  /**
   * 主动最小化
   * ------------------------------------------------------------
   * 与「按 Home 键」等价，但更明确。悬浮窗需要系统权限：
   * 有权限 → 直接退后台，MainActivity.onStop 自动弹小窗；
   * 没权限 → 跳设置页引导授权（跳设置本身就把 App 送到后台，
   * 通话靠前台服务继续，授权后下次最小化就有小窗了）。
   */
  const handleMinimize = () => {
    void (async () => {
      try {
        const { hasOverlayPermission, requestOverlayPermission } = await import(
          '../platform/host.js'
        );
        if (await hasOverlayPermission()) moveTaskToBack();
        else requestOverlayPermission();
      } catch {
        moveTaskToBack();
      }
    })();
  };

  /* ---------------- 静音切换 ---------------- */
  const toggleMute = () => {
    setMuted(!engine.muted);
  };

  /* ---------------- 卸载时清理 ---------------- */
  useEffect(() => {
    return () => {
      /**
       * 页面销毁时的清理
       * ------------------------------------------------
       * 注意：这里**不能**条件式跳过 setCallState(false)。
       * 用户可能通过右滑返回、系统返回键、悬浮窗挂断等多种
       * 路径离开，任何一条漏掉清理都会导致前台服务残留、
       * 通知栏常驻、麦克风被长期占用。
       */
      setCallState(false, '');
      stopCall();
    };
  }, []);

  const peerList = Object.values(engine.peers);
  const participantCount = peerList.length + 1;

  /**
   * 布局必须用绝对定位，不能用 justifyContent:'space-between'
   * ------------------------------------------------------------
   * Lynx 在 Android 上的命中测试只认布局起点的偏移：
   * space-between / flex-end 把元素「视觉上」推到下方后，
   * 点击坐标仍按顶部计算 → 接听/拒接按钮看得见却点不动。
   * 症状就是「打语音电话有来电界面，但怎么点都没反应」。
   * 之前消息列表已经踩过同一个坑，这里统一改成 absolute。
   */
  return (
    <view
      style={{
        ...commonStyles.page,
        backgroundColor: colors.bg,
        position: 'relative',
      }}
    >
      {/* 顶部：通话对象与状态（全部居中，用 margin 代替 gap） */}
      <view
        style={{
          position: 'absolute',
          left: '0px',
          right: '0px',
          top: '0px',
          alignItems: 'center',
          paddingTop: '80px',
        }}
      >
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
          position: 'absolute',
          left: '0px',
          right: '0px',
          top: '340px',
          bottom: '220px',
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
            name={engine.names[peer.userId] ?? shortName(peer.userId)}
            speaking={peer.speaking}
            muted={peer.muted}
            connectionState={peer.connectionState}
          />
        ))}
      </view>

      {/* 底部：操作按钮（绝对定位，保证点击命中区与视觉一致） */}
      <view
        style={{
          position: 'absolute',
          left: '0px',
          right: '0px',
          bottom: '0px',
          paddingTop: '16px',
          paddingBottom: '60px',
          display: 'flex',
          flexDirection: 'row',
          width: '100%',
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
            <CircleButton
              label="最小化"
              color={colors.surfaceAlt}
              onTap={handleMinimize}
              action="minimize"
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
  /** 图标语义：接听 / 挂断 / 静音 / 最小化 */
  action: 'accept' | 'hangup' | 'mute' | 'minimize';
  /** true = 静音态（麦克风 + 斜杠） */
  muted?: boolean;
  onTap: () => void;
}) {
  const { label, color, action, muted = false, onTap } = props;

  return (
    <view
      style={{
        alignItems: 'center',
        marginLeft: spacing.lg,
        marginRight: spacing.lg,
        padding: '8px',
        position: 'relative',
      }}
    >
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
      >
        <view style={{ position: 'relative', width: '22px', height: '22px' }}>
          {action === 'mute' ? <IconMic size={22} color="#FFFFFF" /> : null}
          {action === 'accept' ? <IconCheck size={22} color="#FFFFFF" /> : null}
          {action === 'hangup' ? <IconClose size={22} color="#FFFFFF" /> : null}
          {/* 最小化：向下的箭头落到横线（"收起到后台"的通用语汇） */}
          {action === 'minimize' ? (
            <>
              <view
                style={{
                  position: 'absolute',
                  left: '8px',
                  top: '4px',
                  width: '2px',
                  height: '12px',
                  backgroundColor: '#FFFFFF',
                  borderRadius: '1px',
                }}
              />
              <view
                style={{
                  position: 'absolute',
                  left: '4px',
                  top: '12px',
                  width: '10px',
                  height: '2px',
                  backgroundColor: '#FFFFFF',
                  borderRadius: '1px',
                }}
              />
              <view
                style={{
                  position: 'absolute',
                  left: '2px',
                  top: '18px',
                  width: '18px',
                  height: '2px',
                  backgroundColor: '#FFFFFF',
                  borderRadius: '1px',
                }}
              />
            </>
          ) : null}

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

      {
        /**
         * 透明点击层
         * ------------------------------------------------------------
         * 图标是绝对定位的子 view，会先吃掉落在图标上的触摸，
         * 父级的 bindtap 不再触发 —— 用户点「接听」正中心毫无反应，
         * 这就是「语音通话没反应」的直接原因。
         * 在最上层盖一个等大的透明 view 承接所有点击，
         * 同时扩大了点击区（含文字），比原按钮更好点。
         */
      }
      <view
        style={{ position: 'absolute', left: '0px', right: '0px', top: '0px', bottom: '0px' }}
        bindtap={onTap}
      />
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
