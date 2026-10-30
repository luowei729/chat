/**
 * ============================================================
 * 聊天页
 * ------------------------------------------------------------
 * 功能：
 * 1. 消息列表（按 seq 升序，自动滚到底部）；
 * 2. 发送文字（乐观更新，失败可重试）；
 * 3. 上拉加载更多历史；
 * 4. 语音通话入口；
 * 5. 输入中提示与已读回执。
 *
 * 关键实现：
 * - 进入页面时订阅会话、清零未读、标记已读；
 * - 离开页面时退订；
 * - 发送消息用 clientId 幂等，网络重试不会重复。
 * ============================================================
 */

import { useEffect, useRef, useState } from '@lynx-js/react';
import type { Message } from '@chat/shared';
import { getConversation, listMessages, sendMessage } from '../api/index.js';
import { ApiError, newClientId } from '../api/client.js';
import * as ws from '../api/ws.js';
import { pop } from '../router.js';
import {
  appendMessage,
  clearUnread,
  insertOptimistic,
  markMessageFailed,
  prependMessages,
  setMessages,
  setMessagesLoading,
  useMessages,
} from '../store/conversations.js';
import { currentUserId } from '../store/auth.js';
import { peerReadSeq, setMembersRead, useConversationReads } from '../store/reads.js';
import * as media from '../platform/media.js';
import {
  IconAttach,
  IconBack,
  IconCamera,
  IconFile,
  IconKeyboard,
  IconPhone,
  IconPhoto,
  IconPause,
  IconPlay,
  IconTicks,
  IconVoice,
} from './Icons.js';
import { colors, commonStyles, fontSize, radius, spacing } from '../theme.js';
import { mediaUrl } from '../config.js';

export function ChatPage(props: { conversationId: string; title?: string }) {
  const { conversationId } = props;
  const { messages, hasMore, loading } = useMessages(conversationId);

  /**
   * 已读水位
   * ------------------------------------------------------------
   * reads 是「成员 → 已读到的 seq」映射；
   * peerSeq 取其他成员里最落后的那个水位——比它小的消息才算出双勾。
   * 私聊即对方水位，群聊即「全部成员都已读」。
   */
  const reads = useConversationReads(conversationId);
  const peerSeq = peerReadSeq(reads, currentUserId());

  const [title, setTitle] = useState(props.title ?? '聊天');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 对方正在输入 */
  const [peerTyping, setPeerTyping] = useState(false);
  /** 底部面板：none=纯键盘  attach=附件面板 */
  const [panel, setPanel] = useState<'none' | 'attach'>('none');
  /** 语音输入模式（左侧按钮切换键盘/语音） */
  const [voiceMode, setVoiceMode] = useState(false);
  /** 正在录音 */
  const [recording, setRecording] = useState(false);
  /** 录音计时（秒） */
  const [recordSec, setRecordSec] = useState(0);
  /** 媒体上传中 */
  const [uploading, setUploading] = useState(false);
  /** 上滑取消录音 */
  const cancelRecordRef = useRef(false);

  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastTypingSent = useRef(0);
  const myId = currentUserId();

  /* ---------------- 进入会话：初始化 ---------------- */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // 订阅本会话（只收本会话的推送，减少无关流量）
      ws.subscribe([conversationId]);
      clearUnread(conversationId);

      // 拉会话详情（拿标题与成员）
      try {
        const detail = await getConversation(conversationId);
        if (!cancelled) {
          setTitle(detail.title);
          // 用服务端快照初始化已读水位，历史消息的双勾状态一进页就正确
          setMembersRead(conversationId, detail.members);
        }
      } catch {
        // 标题拿不到就用路由传入的
      }

      // 拉最新一页消息
      setMessagesLoading(conversationId, true);
      try {
        const page = await listMessages(conversationId, { limit: 30 });
        if (!cancelled) {
          setMessages(conversationId, page.items, page.hasMore);
          // 标记已读：把水位推到最新一条
          const last = page.items[page.items.length - 1];
          if (last) ws.sendRead(conversationId, last.seq);
        }
      } catch {
        if (!cancelled) setMessages(conversationId, [], false);
      }
    })();

    return () => {
      cancelled = true;
      ws.unsubscribe([conversationId]);
      if (typingTimer.current) clearTimeout(typingTimer.current);
    };
  }, [conversationId]);

  /* ---------------- 监听对方输入中 ---------------- */
  useEffect(() => {
    const off = ws.on('typing', (msg) => {
      if (msg.conversationId !== conversationId) return;
      setPeerTyping(true);
      if (typingTimer.current) clearTimeout(typingTimer.current);
      // 3 秒无新提示则自动消失
      typingTimer.current = setTimeout(() => setPeerTyping(false), 3000);
    });
    return off;
  }, [conversationId]);

  /* ---------------- 加载更多历史 ---------------- */
  const loadMore = async () => {
    if (!hasMore || loading) return;
    const oldest = messages[0];
    if (!oldest) return;

    setMessagesLoading(conversationId, true);
    try {
      const page = await listMessages(conversationId, { before: oldest.seq, limit: 30 });
      prependMessages(conversationId, page.items, page.hasMore);
    } catch {
      setMessagesLoading(conversationId, false);
    }
  };

  /* ---------------- 发送文字 ---------------- */
  const handleSend = async () => {
    const text = draft.trim();
    if (!text || sending) return;

    setSending(true);
    setError(null);
    setDraft('');

    // 客户端生成幂等 id：重试不会产生重复消息
    const clientId = newClientId();

    // 乐观更新：立即显示（状态 sending）
    const optimistic: Message = {
      id: `local-${clientId}`,
      conversationId,
      seq: Number.MAX_SAFE_INTEGER, // 临时排到最后
      senderId: myId ?? '',
      senderName: '我',
      senderAvatarUrl: null,
      type: 'text',
      text,
      attachments: [],
      replyToId: null,
      replyToPreview: null,
      createdAt: Date.now(),
      editedAt: null,
      localStatus: 'sending',
      clientId,
    };
    insertOptimistic(conversationId, optimistic);

    try {
      const saved = await sendMessage(conversationId, {
        clientId,
        type: 'text',
        text,
      });
      // 用服务端返回的真实消息替换占位（appendMessage 内部按 clientId 去重替换）
      appendMessage(conversationId, { ...saved, clientId });
    } catch (e) {
      markMessageFailed(conversationId, clientId);
      setError(e instanceof ApiError ? e.message : '发送失败');
    } finally {
      setSending(false);
    }
  };

  /* ---------------- 输入中提示（节流） ---------------- */
  const handleInput = (value: string) => {
    setDraft(value);

    // 每 3 秒最多发一次，避免刷屏
    const now = Date.now();
    if (value.length > 0 && now - lastTypingSent.current > 3000) {
      lastTypingSent.current = now;
      ws.sendTyping(conversationId);
    }
  };

  /* ---------------- 发送附件（图片/视频/文件） ---------------- */
  /**
   * 统一的上传 + 发送流程
   * ------------------------------------------------------------
   * 1. 上传拿到附件 id（服务端会按 sha256 去重，不会重复落盘）；
   * 2. 按 mime 决定消息类型：image/video/audio/file；
   * 3. 发送后用服务端返回的消息替换本地占位。
   *
   * 为什么先上传再发消息：
   * 消息里的附件必须是已落盘、已签名的 url，
   * 这样多端同步时对方拿到的就是可直接渲染的地址。
   */
  const sendPicked = async (files: media.PickedFile[], fallbackType: 'image' | 'video' | 'file') => {
    if (files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const f of files) {
        const type = pickMessageType(f.mime, fallbackType);
        const up = await media.uploadPicked(f, {
          kind: type,
          width: f.width,
          height: f.height,
          durationMs: f.durationMs,
        });
        const clientId = newClientId();
        const saved = await sendMessage(conversationId, {
          clientId,
          type,
          attachmentIds: [up.attachment.id],
        });
        appendMessage(conversationId, { ...saved, clientId });
      }
    } catch (e) {
      if (e instanceof media.PlatformMediaError && e.code === 'cancelled') {
        // 用户取消，不提示错误
      } else {
        setError(e instanceof Error ? e.message : '发送失败，请重试');
      }
    } finally {
      setUploading(false);
    }
  };

  const handlePickPhoto = () => {
    setPanel('none');
    void (async () => {
      try {
        const files = await media.pickImages(true);
        await sendPicked(files, 'image');
      } catch (e) {
        if (!(e instanceof media.PlatformMediaError && e.code === 'cancelled')) {
          setError(e instanceof Error ? e.message : '选择图片失败');
        }
      }
    })();
  };

  /** 打开相机：轻触拍照、长按录像，闪光灯在页面内切换 */
  const handleCamera = () => {
    setPanel('none');
    void (async () => {
      try {
        const file = await media.openCamera(false);
        await sendPicked([file], file.mime.startsWith('video') ? 'video' : 'image');
      } catch (e) {
        if (!(e instanceof media.PlatformMediaError && e.code === 'cancelled')) {
          setError(e instanceof Error ? e.message : '拍摄失败');
        }
      }
    })();
  };

  const handlePickFile = () => {
    setPanel('none');
    void (async () => {
      try {
        const files = await media.pickFile();
        await sendPicked(files, 'file');
      } catch (e) {
        if (!(e instanceof media.PlatformMediaError && e.code === 'cancelled')) {
          setError(e instanceof Error ? e.message : '选择文件失败');
        }
      }
    })();
  };

  /* ---------------- 语音消息（按住说话） ---------------- */

  const startRecording = async () => {
    cancelRecordRef.current = false;
    try {
      await media.startVoiceRecord();
      setRecording(true);
      setRecordSec(0);
      recordTimer.current = setInterval(() => setRecordSec((s) => s + 1), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法录音');
      setRecording(false);
    }
  };

  const finishRecording = async (cancel: boolean) => {
    if (!recording) return;
    setRecording(false);
    if (recordTimer.current) {
      clearInterval(recordTimer.current);
      recordTimer.current = null;
    }

    if (cancel) {
      await media.cancelVoiceRecord().catch(() => undefined);
      return;
    }

    try {
      const voice = await media.stopVoiceRecord();
      setUploading(true);
      const up = await media.uploadPicked(voice, {
        kind: 'audio',
        durationMs: voice.durationMs,
        waveform: voice.waveform,
      });
      const clientId = newClientId();
      const saved = await sendMessage(conversationId, {
        clientId,
        type: 'audio',
        attachmentIds: [up.attachment.id],
      });
      appendMessage(conversationId, { ...saved, clientId });
    } catch (e) {
      if (!(e instanceof media.PlatformMediaError && e.code === 'cancelled')) {
        setError(e instanceof Error ? e.message : '语音发送失败');
      }
    } finally {
      setUploading(false);
    }
  };

  /* ---------------- 发起语音通话 ---------------- */
  const startCall = () => {
    const callId = `call-${Date.now().toString(36)}`;
    ws.inviteCall({ conversationId, mode: 'audio' });

    // 进入通话页等待对方接听
    import('../router.js').then(({ push }) => {
      push({
        name: 'call',
        params: { callId, conversationId, mode: 'audio', incoming: false, callerName: title },
      });
    });
  };

  return (
    <view style={commonStyles.page}>
      {/* 顶部栏：三段式，标题区用 view 包裹居中 */}
      <view style={commonStyles.header}>
        <view
          style={{ ...commonStyles.headerSide, justifyContent: 'center' }}
          bindtap={pop}
        >
          <IconBack size={22} color={colors.text} />
        </view>
        <view style={commonStyles.headerCenter}>
          <view style={{ display: 'flex', alignItems: 'center' }}>
            <text
              style={{ color: colors.text, fontSize: fontSize.md, fontWeight: '600' }}
              text-maxline="1"
            >
              {title}
            </text>
            {peerTyping ? (
              <text style={{ color: colors.primary, fontSize: fontSize.xs, marginTop: '2px' }}>
                对方正在输入…
              </text>
            ) : null}
          </view>
        </view>
        <view
          style={{ ...commonStyles.headerSide, justifyContent: 'flex-end' }}
          bindtap={startCall}
        >
          <IconPhone size={23} color={colors.text} />
        </view>
      </view>

      {/* 消息列表 */}
      <view style={{ flex: 1, width: '100%', display: 'flex', flexDirection: 'column' }}>
        {/* 加载更多 */}
        {hasMore ? (
          <view
            style={{ height: '44px', alignItems: 'center', justifyContent: 'center' }}
            bindtap={loadMore}
          >
            <text style={{ color: colors.textMuted, fontSize: fontSize.xs }}>
              {loading ? '加载中…' : '查看更早的消息'}
            </text>
          </view>
        ) : messages.length > 0 ? (
          <view style={{ height: '32px', alignItems: 'center', justifyContent: 'center' }}>
            <text style={{ color: colors.textFaint, fontSize: fontSize.xs }}>没有更多了</text>
          </view>
        ) : null}

        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            isSelf={msg.senderId === myId}
            peerSeq={peerSeq}
          />
        ))}

        <view style={{ height: spacing.lg }} />
      </view>

      {/* 错误提示 */}
      {error ? (
        <view style={{ paddingLeft: spacing.md, paddingRight: spacing.md, paddingBottom: spacing.xs }}>
          <text style={{ color: colors.danger, fontSize: fontSize.xs }}>{error}</text>
        </view>
      ) : null}

      {/* 上传中提示 */}
      {uploading ? (
        <view
          style={{
            width: '100%',
            paddingLeft: spacing.md,
            paddingRight: spacing.md,
            paddingBottom: spacing.xs,
          }}
        >
          <text style={{ color: colors.textMuted, fontSize: fontSize.xs }}>正在发送…</text>
        </view>
      ) : null}

      {/* 输入区（微信式） */}
      <view
        style={{
          width: '100%',
          backgroundColor: colors.surface,
          borderTopWidth: '1px',
          borderTopColor: colors.border,
        }}
      >
        {/* 录音浮层提示 */}
        {recording ? (
          <view
            style={{
              width: '100%',
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              paddingTop: spacing.sm,
              paddingBottom: spacing.sm,
              backgroundColor: colors.surfaceAlt,
            }}
          >
            <view
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '4px',
                backgroundColor: colors.danger,
                marginRight: spacing.sm,
              }}
            />
            <text style={{ color: colors.text, fontSize: fontSize.sm }}>
              {`${String(Math.floor(recordSec / 60))}:${String(recordSec % 60).padStart(2, '0')} · 松开发送，上滑取消`}
            </text>
          </view>
        ) : null}

        {/* 底部一行：语音切换 / 输入 / 附件 */}
        <view
          style={{
            width: '100%',
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            paddingLeft: spacing.sm,
            paddingRight: spacing.sm,
            paddingTop: spacing.sm,
            paddingBottom: spacing.sm,
          }}
        >
          {/* 语音 / 键盘 切换 */}
          <view
            style={{
              width: '38px',
              height: '40px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            bindtap={() => {
              setVoiceMode((v) => !v);
              setPanel('none');
            }}
          >
            {voiceMode ? (
              <IconKeyboard size={24} color={colors.text} />
            ) : (
              <IconVoice size={24} color={colors.text} />
            )}
          </view>

          {/* 中间：输入框 or 按住说话 */}
          <view style={{ width: '66%', marginLeft: spacing.xs, marginRight: spacing.xs }}>
            {voiceMode ? (
              <view
                style={{
                  width: '100%',
                  height: '40px',
                  borderRadius: radius.md,
                  backgroundColor: recording ? colors.primarySoft : colors.surfaceAlt,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                bindtouchstart={() => {
                  void startRecording();
                }}
                bindtouchmove={(e: { touches?: Array<{ y?: number }> }) => {
                  // 上滑超过阈值则标记取消（Lynx 的 touch 事件带坐标）
                  const y = e.touches?.[0]?.y ?? 0;
                  if (y < 120) cancelRecordRef.current = true;
                  else cancelRecordRef.current = false;
                }}
                bindtouchend={() => {
                  void finishRecording(cancelRecordRef.current);
                }}
                bindtouchcancel={() => {
                  void finishRecording(true);
                }}
              >
                <text
                  style={{
                    color: recording ? colors.primary : colors.text,
                    fontSize: fontSize.md,
                  }}
                >
                  {recording ? '松开发送' : '按住 说话'}
                </text>
              </view>
            ) : (
              <input
                style={{ ...commonStyles.input, height: '40px' }}
                default-value={draft}
                placeholder="输入消息…"
                bindinput={(e: { detail: { value: string } }) => handleInput(e.detail.value)}
                bindconfirm={handleSend}
              />
            )}
          </view>

          {/* 右侧：有文字则发送，否则显示附件入口 */}
          {draft.trim() && !voiceMode ? (
            <view
              style={{
                width: '56px',
                height: '40px',
                borderRadius: radius.md,
                backgroundColor: colors.primary,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              bindtap={handleSend}
            >
              <text style={{ color: colors.onPrimary, fontSize: fontSize.sm, fontWeight: '600' }}>
                发送
              </text>
            </view>
          ) : (
            <view
              style={{
                width: '38px',
                height: '40px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              bindtap={() => setPanel((p) => (p === 'attach' ? 'none' : 'attach'))}
            >
              <IconAttach size={24} color={colors.text} />
            </view>
          )}
        </view>

        {/* 附件面板：相册 / 拍摄 / 文件 */}
        {panel === 'attach' ? (
          <view
            style={{
              width: '100%',
              display: 'flex',
              flexDirection: 'row',
              paddingLeft: spacing.md,
              paddingRight: spacing.md,
              paddingTop: spacing.md,
              paddingBottom: spacing.lg,
              backgroundColor: colors.surface,
              borderTopWidth: '1px',
              borderTopColor: colors.border,
            }}
          >
            <AttachButton
              label="相册"
              onTap={handlePickPhoto}
              renderIcon={() => <IconPhoto size={26} color={colors.text} />}
            />
            <AttachButton
              label="拍摄"
              onTap={handleCamera}
              renderIcon={() => <IconCamera size={26} color={colors.text} />}
            />
            <AttachButton
              label="文件"
              onTap={handlePickFile}
              renderIcon={() => <IconFile size={26} color={colors.text} />}
            />
          </view>
        ) : null}
      </view>
    </view>
  );
}

/* ------------------------------------------------------------------ */
/* 语音气泡                                                             */
/* ------------------------------------------------------------------ */

/**
 * 语音消息条
 * ------------------------------------------------------------
 * 交互：点一下播放，再点停止（与微信一致）。
 * 波形：优先用发送端上传的 waveform（0~100），
 *       没有就按条数生成等宽刻度，保证视觉上不是一条死板横线。
 *
 * 时长上限保护：超过 60 秒的条子宽度封顶，
 * 否则群里一条 10 分钟的语音会把气泡撑满整屏。
 */
function VoiceBubble(props: { message: Message; isSelf: boolean }) {
  const { message, isSelf } = props;
  const att = message.attachments[0];
  const [playing, setPlaying] = useState(false);

  const expired = !att?.url;
  const sec = att?.durationMs ? Math.max(1, Math.round(att.durationMs / 1000)) : 0;

  // 宽度随时长增长：最短 90px，最长 220px
  const widthPx = Math.min(220, 90 + Math.min(sec, 60) * 2.2);

  const wave = (att?.waveform && att.waveform.length > 0
    ? att.waveform
    : buildFallbackWave(sec)
  ).slice(0, 32);

  const tone = isSelf ? '#FFFFFF' : colors.text;

  const toggle = () => {
    if (expired) return;
    if (playing) {
      void media.stopAudio().catch(() => undefined);
      setPlaying(false);
      return;
    }
    setPlaying(true);
    // 播放器同样需要绝对地址
    void media
      .playAudio(mediaUrl(att!.url))
      .catch(() => setPlaying(false));
    // 播放结束后自动复位（原生回调未接事件，按时长兜底）
    // 注意：Lynx 的 setTimeout 是**裸全局**，不在 globalThis 上，
    // 写成 globalThis.setTimeout 会抛 "is not a function"。
    const wait = att?.durationMs && att.durationMs > 0 ? att.durationMs : 3000;
    setTimeout(() => setPlaying(false), wait + 300);
  };

  return (
    <view
      style={{
        width: `${widthPx}px`,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        opacity: expired ? 0.5 : 1,
      }}
      bindtap={toggle}
    >
      {playing ? <IconPause size={16} color={tone} /> : <IconPlay size={16} color={tone} />}

      {/* 波形：每根柱子用百分比宽度，避免 flex:1 在 Lynx 下塌成 0 */}
      <view
        style={{
          width: '58%',
          height: '18px',
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          marginLeft: '8px',
          marginRight: '8px',
        }}
      >
        {wave.map((v, i) => (
          <view
            key={`w${i}`}
            style={{
              width: '2px',
              height: `${Math.max(15, Math.min(100, v))}%`,
              borderRadius: '1px',
              backgroundColor: tone,
              opacity: playing ? 1 : 0.75,
              marginRight: '2px',
            }}
          />
        ))}
      </view>

      <text style={{ color: tone, fontSize: fontSize.xs }}>
        {expired ? '已过期' : `${sec}″`}
      </text>
    </view>
  );
}

/** 没有波形数据时生成一条起伏自然的假波形，避免整条一样高 */
function buildFallbackWave(sec: number): number[] {
  const n = Math.max(12, Math.min(28, sec + 10));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = 35 + Math.abs(Math.sin(i * 1.7) * 45) + ((i * 13) % 17);
    out.push(Math.min(100, Math.round(v)));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 附件面板按钮                                                          */
/* ------------------------------------------------------------------ */

/**
 * 附件面板里的单个入口
 * 用 renderIcon 传函数而不是直接传元素，
 * 避免主题切换后图标颜色被缓存的元素实例带偏。
 */
function AttachButton(props: { label: string; onTap: () => void; renderIcon: () => React.ReactElement }) {
  const { label, onTap, renderIcon } = props;
  return (
    <view
      style={{
        width: '33.33%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
      }}
      bindtap={onTap}
    >
      <view
        style={{
          width: '56px',
          height: '56px',
          borderRadius: radius.md,
          backgroundColor: colors.surfaceAlt,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {renderIcon()}
      </view>
      <text style={{ color: colors.textMuted, fontSize: fontSize.xs, marginTop: '6px' }}>
        {label}
      </text>
    </view>
  );
}

/** 按 mime 推断消息类型，认不出就用调用方的兜底类型 */
function pickMessageType(mime: string, fallback: 'image' | 'video' | 'audio' | 'file') {
  if (mime.startsWith('image/')) return 'image' as const;
  if (mime.startsWith('video/')) return 'video' as const;
  if (mime.startsWith('audio/')) return 'audio' as const;
  return fallback === 'audio' ? ('audio' as const) : fallback;
}

/* ------------------------------------------------------------------ */
/* 消息气泡                                                             */
/* ------------------------------------------------------------------ */

function MessageBubble(props: { message: Message; isSelf: boolean; peerSeq: number }) {
  const { message, isSelf, peerSeq } = props;

  // 系统消息：居中灰字
  if (message.type === 'system') {
    return (
      <view style={{ alignItems: 'center', paddingTop: spacing.sm, paddingBottom: spacing.sm }}>
        <text style={{ color: colors.textFaint, fontSize: fontSize.xs }}>{message.text}</text>
      </view>
    );
  }

  const statusText =
    message.localStatus === 'sending'
      ? '发送中'
      : message.localStatus === 'failed'
        ? '发送失败'
        : null;

  /**
   * 双勾判定
   * ------------------------------------------------------------
   * peerSeq 是对方（群聊取最落后成员）读到的最大 seq。
   * 消息 seq 小于等于它，说明对方已经读到这条 —— 双勾。
   * 未确认送达（sending）或发送失败时不画勾，只显示文字状态。
   */
  const delivered = message.seq <= peerSeq;
  const showTicks = isSelf && !statusText;

  /** 气泡内次要文字颜色：自己气泡是蓝底，用半透明白才协调 */
  const metaColor = isSelf ? 'rgba(255,255,255,0.72)' : colors.textFaint;

  return (
    <view
      style={{
        display: 'flex',
        flexDirection: isSelf ? 'row-reverse' : 'row',
        paddingLeft: spacing.md,
        paddingRight: spacing.md,
        paddingTop: spacing.xs,
        paddingBottom: spacing.xs,
      }}
    >
      {/* 头像 */}
      <view
        style={{
          width: '34px',
          height: '34px',
          borderRadius: radius.full,
          backgroundColor: colors.primarySoft,
          borderWidth: '1px',
          borderColor: colors.cardBorder,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginLeft: isSelf ? spacing.sm : 0,
          marginRight: isSelf ? 0 : spacing.sm,
        }}
      >
        <text style={{ color: colors.primary, fontSize: fontSize.sm, fontWeight: '600' }}>
          {message.senderName.slice(0, 1)}
        </text>
      </view>

      {/* 气泡 + 时间 */}
      <view style={{ maxWidth: '72%', alignItems: isSelf ? 'flex-end' : 'flex-start' }}>
        {/* 群聊显示发送者昵称 */}
        {!isSelf ? (
          <text style={{ color: colors.textFaint, fontSize: fontSize.xs, marginBottom: '2px' }}>
            {message.senderName}
          </text>
        ) : null}

        <view
          style={{
            backgroundColor: isSelf ? colors.primary : colors.surfaceAlt,
            borderRadius: radius.bubble,
            paddingLeft: spacing.md,
            paddingRight: spacing.md,
            paddingTop: spacing.sm,
            paddingBottom: spacing.sm,
          }}
        >
          <MessageContent message={message} isSelf={isSelf} />

          {/* 时间 + 勾选：放在气泡内右下角，白勾才读得清 */}
          <view
            style={{
              width: '100%',
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'flex-end',
              marginTop: '3px',
            }}
          >
            <text style={{ color: metaColor, fontSize: '10px' }}>
              {formatClock(message.createdAt)}
            </text>
            {showTicks ? (
              <view style={{ marginLeft: '4px' }}>
                <IconTicks
                  double={delivered}
                  size={13}
                  color={metaColor}
                  stroke={2.6}
                />
              </view>
            ) : null}
            {statusText ? (
              <text style={{ color: metaColor, fontSize: '10px', marginLeft: '5px' }}>
                {statusText}
              </text>
            ) : null}
          </view>
        </view>
      </view>
    </view>
  );
}

/** 按消息类型渲染不同内容 */
function MessageContent(props: { message: Message; isSelf: boolean }) {
  const { message, isSelf } = props;

  switch (message.type) {
    case 'text':
      return (
        <text style={{ color: isSelf ? '#fff' : colors.text, fontSize: fontSize.md, lineHeight: '1.5px' }}>
          {message.text ?? ''}
        </text>
      );

    case 'image': {
      const att = message.attachments[0];
      if (!att) {
        return <text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>[图片]</text>;
      }

      /**
       * 按原始比例缩放到气泡内
       * ------------------------------------------------------------
       * 两条硬约束：
       * 1. **宽高必须带 px 单位**。Lynx 不接受无单位数字，
       *    写成 width: 220 会被静默丢弃 —— 元素没尺寸，
       *    表现就是「蓝色空气泡」，且不报任何错。
       * 2. 不能只给一个约束让图片自适应：Lynx 的 image 不做
       *    intrinsic sizing，必须两端都给死值，所以这里自己算比例。
       */
      const maxW = 220;
      const maxH = 260;
      const ow = att.width && att.width > 0 ? att.width : 4;
      const oh = att.height && att.height > 0 ? att.height : 3;
      const ratio = Math.min(maxW / ow, maxH / oh, 1);
      const w = Math.max(80, Math.round(ow * ratio));
      const h = Math.max(60, Math.round(oh * ratio));

      if (!att.url) {
        // 超过保留期被清理：给出明确提示，但消息本身保留
        return (
          <view
            style={{
              width: `${w}px`,
              height: `${h}px`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: colors.surfaceAlt,
              borderRadius: radius.md,
            }}
          >
            <text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>文件已过期</text>
          </view>
        );
      }

      return (
        <image
          src={mediaUrl(att.url)}
          style={{
            width: `${w}px`,
            height: `${h}px`,
            borderRadius: radius.md,
          }}
          mode="aspectFill"
        />
      );
    }

    case 'audio':
      return <VoiceBubble message={message} isSelf={isSelf} />;

    case 'video': {
      const att = message.attachments[0];
      const sec = att?.durationMs ? Math.max(1, Math.round(att.durationMs / 1000)) : 0;
      return (
        <view style={{ display: 'flex', flexDirection: 'row', width: '100%', alignItems: 'center' }}>
          <text style={{ color: isSelf ? '#fff' : colors.text, fontSize: fontSize.md }}>▶</text>
          <text style={{ color: isSelf ? '#fff' : colors.text, fontSize: fontSize.sm }}>
            视频 {sec}″
          </text>
        </view>
      );
    }

    case 'file': {
      const att = message.attachments[0];
      return (
        <view style={{}}>
          <text style={{ color: isSelf ? '#fff' : colors.text, fontSize: fontSize.sm }} text-maxline="1">
            {att?.filename ?? '文件'}
          </text>
          <text style={{ color: isSelf ? 'rgba(255,255,255,0.7)' : colors.textMuted, fontSize: '10px' }}>
            {formatBytes(att?.size ?? 0)}
          </text>
        </view>
      );
    }

    case 'call':
      return (
        <text style={{ color: isSelf ? '#fff' : colors.text, fontSize: fontSize.sm }}>
          {message.text ?? '通话'}
        </text>
      );

    default:
      return <text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>[消息]</text>;
  }
}

/** 时分秒格式化 */
function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 文件大小格式化 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
