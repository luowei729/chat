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
import {
  deleteMessage as deleteMessageApi,
  getConversation,
  hideMessage as hideMessageApi,
  listConversations,
  listMessages,
  sendMessage,
} from '../api/index.js';
import { ApiError, newClientId } from '../api/client.js';
import * as ws from '../api/ws.js';
import { pop, push } from '../router.js';
import {
  appendMessage,
  clearUnread,
  insertOptimistic,
  markMessageFailed,
  markMessageRecalled,
  prependMessages,
  removeMessage,
  setConversations,
  setMessageProgress,
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
import { getLynx } from '../platform/globals.js';

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
  /**
   * 录音状态镜像
   * ------------------------------------------------------------
   * finishRecording 里不能用 `recording` 这个 state 做判断：
   * touchend 的回调可能在 setRecording(true) 生效之前就触发
   * （快速点击），此时闭包里的 recording 还是 false，
   * 函数直接 return，原生录音器就再也没人停了 ——
   * 表现为「录音停不下来 / 语音发送异常」。
   * 用 ref 存同一个值，读写都拿最新的。
   */
  const recordingRef = useRef(false);
  /** 按下时的 Y 坐标，用于计算「上滑取消」的相对位移 */
  const recordStartY = useRef(0);
  /** 有文字且非语音模式时才显示「发送」按钮，否则显示附件入口 */
  const showSendButton = !voiceMode && draft.trim().length > 0;
  /**
   * 当前渲染的消息条数
   * 消息不放在滚动容器里，只渲染最后 N 条保证性能与点击可靠性。
   * 「查看更早」每次 +20；切换会话时重置。
   */
  const [visibleCount, setVisibleCount] = useState(20);

  /**
   * 计算可见消息
   * ============================================================
   * 普通 view 没有 overflow:hidden（Lynx 不支持），
   * 内容超出容器会向上溢出、盖住标题栏。
   * 所以不能简单「取最后 N 条」，必须按**估算高度**截断：
   * 从最新一条往前累加，累计高度超过可视区就停。
   *
   * 估算凭经验取值（消息高度主要决定因素）：
   *   图片/视频  → 260px（气泡 200 + 头像行 + 间距 + 时间）
   *   语音/文件  → 100px
   *   文本      → 每 14 个字一行 × 30px + 46px 元信息
   * 宁可少渲染几条，也不要溢出盖住标题栏。
   */
  /**
   * 可见消息：取最后 visibleCount 条
   * ------------------------------------------------------------
   * 之前用普通 view + 按估算高度截断（LIST_MAX_HEIGHT），
   * 因为普通 view 不能滚动，内容一多就溢出盖住标题栏。
   * 现在改用真正的 scroll-view，高度截断不再需要，
   * 直接按条数切片即可，滚动容器负责裁剪与滚动。
   */
  const displayed = messages.slice(Math.max(0, messages.length - visibleCount));

  /**
   * 顶部加载防抖
   * ------------------------------------------------------------
   * bindscrolltoupper 在首帧挂载、图片解码导致内容变化时
   * 也可能触发一次。用时间窗过滤掉这些非用户手势，
   * 避免一进会话就把全部历史 cascade 拉完。
   */
  const upperGuardUntil = useRef(0);
  const handleScrollUpper = () => {
    if (Date.now() < upperGuardUntil.current) return;
    upperGuardUntil.current = Date.now() + 800;
    showEarlier();
  };

  const showEarlier = () => {
    // 本地还有更多就直接放出来，不够再去服务端拉
    if (displayed.length < messages.length) {
      setVisibleCount((n) => n + 20);
      return;
    }
    if (hasMore && !loading) void loadMore();
  };

  // 切换会话时重置可见条数
  useEffect(() => {
    setVisibleCount(20);
    // 新会话首帧布局未稳，1.5s 内忽略顶部事件
    upperGuardUntil.current = Date.now() + 1500;
  }, [conversationId]);
  /** 是否显示「添加到通讯录」提示条（对方还不在通讯录时） */
  const [showAddContact, setShowAddContact] = useState(false);
  const [addingContact, setAddingContact] = useState(false);
  /** 对方 userId（私聊才有） */
  const [peerId, setPeerId] = useState<string | null>(null);
  /** 长按操作的目标消息（null 表示菜单关闭） */
  const [actionTarget, setActionTarget] = useState<Message | null>(null);
  /** 操作进行中，防重复点击 */
  const [acting, setActing] = useState(false);
  /**
   * 输入框重建计数
   * ------------------------------------------------------------
   * Lynx 的 input 是**非受控**组件：只有 default-value，没有 value。
   * 发送后 setDraft('') 只更新了 state，输入框里的文字纹丝不动
   * —— 用户会以为没发出去，接着再点一次就是重复消息。
   * 唯一的清空办法是换 key 强制重建组件。
   */
  const [inputKey, setInputKey] = useState(0);

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

          /**
           * 私聊：判断对方是否已在通讯录
           * ------------------------------------------------------
           * 产品口径（对齐 Telegram）：不要求先加好友才能聊天，
           * 但如果不是联系人，就在顶部提示「添加到通讯录」，
           * 点一下即单向添加，不需要对方审批。
           */
          if (detail.type === 'direct') {
            const peer = detail.members.find((m) => m.userId !== myId);
            if (peer) {
              setPeerId(peer.userId);
              void import('../api/index.js')
                .then((api) => api.getUserProfile(peer.userId))
                .then((p) => {
                  if (!cancelled) setShowAddContact(p.relation !== 'friend');
                })
                .catch(() => undefined);
            }
          }
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

          /**
           * 刷新会话列表（必须在标记已读之后）
           * --------------------------------------------------
           * 顺序很关键：服务端只有在收到 read 回执后才会把
           * last_read_seq 推上去。如果在 sendRead 之前拉列表，
           * 拿回来的还是旧的 unreadCount，会把本地刚清零的
           * 未读数又盖回去 —— 红标就「点了也不消失」。
           *
           * 另外这里对当前会话强制清零：即使服务端的 read 回执
           * 还在路上（弱网下几十毫秒），也不该让用户看到自己
           * 正在看的会话还挂着红点。
           */
          void listConversations()
            .then((list) => {
              if (cancelled) return;
              setConversations(
                list.map((c) =>
                  c.id === conversationId ? { ...c, unreadCount: 0 } : c,
                ),
              );
            })
            .catch(() => undefined);
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
    setInputKey((k) => k + 1);

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
  /**
   * 发送媒体（图片/视频/文件）
   * ------------------------------------------------------------
   * 流程改为「先显示，再上传」：
   *   1. 立刻插入一条乐观消息（localStatus='sending'），
   *      附件 url 用本地文件路径，这样气泡里能马上看到缩略图；
   *   2. 上传过程中 setMessageProgress 更新百分比，
   *      气泡内画进度条；
   *   3. 上传完成 → 发消息 → 用服务端消息替换占位。
   *
   * 这样用户点完相册立刻有反馈，不会再出现「点了没反应」的错觉。
   */
  const sendPicked = async (files: media.PickedFile[], fallbackType: 'image' | 'video' | 'file') => {
    if (files.length === 0) return;
    setError(null);

    for (const f of files) {
      const type = pickMessageType(f.mime, fallbackType);
      const clientId = newClientId();

      // 本地占位消息：先让用户看到
      const localUri = localFileUri(f.uri);
      const optimistic: Message = {
        id: `local-${clientId}`,
        conversationId,
        seq: Number.MAX_SAFE_INTEGER,
        senderId: myId ?? '',
        senderName: '我',
        senderAvatarUrl: null,
        type,
        text: null,
        attachments: [
          {
            id: `local-${clientId}`,
            kind: type === 'file' ? 'file' : type === 'video' ? 'video' : 'image',
            filename: f.name,
            mime: f.mime,
            size: f.size,
            url: localUri,
            thumbUrl: null,
            width: f.width ?? null,
            height: f.height ?? null,
            durationMs: f.durationMs ?? null,
            waveform: null,
            expiresAt: null,
            expired: false,
            expiringSoon: false,
          } as Message['attachments'][number],
        ],
        replyToId: null,
        replyToPreview: null,
        createdAt: Date.now(),
        editedAt: null,
        localStatus: 'sending',
        localProgress: 0,
        clientId,
      };
      insertOptimistic(conversationId, optimistic);

      try {
        const up = await media.uploadPicked(
          f,
          {
            kind: type,
            width: f.width,
            height: f.height,
            durationMs: f.durationMs,
          },
          (ratio) => setMessageProgress(conversationId, clientId, ratio),
        );

        const saved = await sendMessage(conversationId, {
          clientId,
          type,
          attachmentIds: [up.attachment.id],
        });
        appendMessage(conversationId, { ...saved, clientId });
      } catch (e) {
        markMessageFailed(conversationId, clientId);
        if (e instanceof media.PlatformMediaError && e.code === 'cancelled') {
          // 用户取消：把占位消息删掉，不留垃圾
          removeMessage(conversationId, `local-${clientId}`);
        } else {
          setError(e instanceof Error ? e.message : '发送失败，请重试');
        }
      }
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

  const startRecording = async (startY: number) => {
    cancelRecordRef.current = false;
    recordStartY.current = startY;
    try {
      await media.startVoiceRecord();
      recordingRef.current = true;
      setRecording(true);
      setRecordSec(0);
      recordTimer.current = setInterval(() => setRecordSec((s) => s + 1), 1000);
    } catch (e) {
      recordingRef.current = false;
      setRecording(false);
      setError(e instanceof Error ? e.message : '无法录音');
    }
  };

  const finishRecording = async (cancel: boolean) => {
    // 必须用 ref：state 可能是旧值（见 recordingRef 的注释）
    if (!recordingRef.current) return;
    recordingRef.current = false;
    setRecording(false);
    if (recordTimer.current) {
      clearInterval(recordTimer.current);
      recordTimer.current = null;
    }

    if (cancel) {
      await media.cancelVoiceRecord().catch(() => undefined);
      return;
    }

    /**
     * 先停止录音拿到文件，再插入乐观消息
     * ------------------------------------------------------------
     * 顺序反了的话，气泡里没有 durationMs 与 waveform，
     * 语音条会显示 0″、波形是假数据，看起来就像「发坏了」。
     * stopVoiceRecord 只是一次本地文件收尾，耗时在毫秒级，
     * 放在插入之前不会影响响应速度。
     */
    let voice: Awaited<ReturnType<typeof media.stopVoiceRecord>>;
    try {
      voice = await media.stopVoiceRecord();
    } catch (e) {
      // 常见：录音太短（<600ms）被原生判定为误触
      setError(
        e instanceof media.PlatformMediaError && e.code === 'cancelled'
          ? '已取消'
          : e instanceof Error
            ? e.message
            : '录音失败',
      );
      return;
    }

    const clientId = newClientId();
    const localUri = localFileUri(voice.uri);

    // 乐观消息：带上真实时长与波形，气泡立即显示正确内容
    const optimistic: Message = {
      id: `local-${clientId}`,
      conversationId,
      seq: Number.MAX_SAFE_INTEGER,
      senderId: myId ?? '',
      senderName: '我',
      senderAvatarUrl: null,
      type: 'audio',
      text: null,
      attachments: [
        {
          id: `local-${clientId}`,
          kind: 'audio',
          filename: voice.name,
          mime: voice.mime,
          size: voice.size,
          url: localUri,
          thumbUrl: null,
          width: null,
          height: null,
          durationMs: voice.durationMs,
          waveform: voice.waveform,
          expiresAt: null,
          expired: false,
          expiringSoon: false,
        } as Message['attachments'][number],
      ],
      replyToId: null,
      replyToPreview: null,
      createdAt: Date.now(),
      editedAt: null,
      localStatus: 'sending',
      localProgress: 0,
      clientId,
    };
    insertOptimistic(conversationId, optimistic);

    try {
      const up = await media.uploadPicked(
        voice,
        {
          kind: 'audio',
          durationMs: voice.durationMs,
          waveform: voice.waveform,
        },
        (ratio) => setMessageProgress(conversationId, clientId, ratio),
      );
      const saved = await sendMessage(conversationId, {
        clientId,
        type: 'audio',
        attachmentIds: [up.attachment.id],
      });
      appendMessage(conversationId, { ...saved, clientId });
    } catch (e) {
      markMessageFailed(conversationId, clientId);
      if (!(e instanceof media.PlatformMediaError && e.code === 'cancelled')) {
        setError(e instanceof Error ? e.message : '语音发送失败');
      }
    }
  };

  /* ---------------- 消息长按操作 ---------------- */

  /**
   * 撤回
   * ------------------------------------------------------------
   * 服务端把 deleted_at 置位，并向全部成员广播 message.deleted，
   * 所有客户端把该气泡替换成「撤回了一条消息」。
   *
   * 【不做时间限制】
   * 微信限 2 分钟，但那条规则的实际效果是：用户长按老消息
   * 发现没有「撤回」选项，以为功能坏了。
   * Telegram 私聊同样不限时。这里跟随 TG：
   * 自己的消息随时可撤回，规则简单、可预期。
   */
  const canRecall = (m: Message): boolean =>
    m.senderId === myId &&
    !!m.id &&
    !m.id.startsWith('local-') &&
    m.type !== 'system';

  const handleRecall = async () => {
    const m = actionTarget;
    if (!m || acting) return;
    setActing(true);
    setActionTarget(null);
    try {
      await deleteMessageApi(conversationId, m.id);
      // 本地立即生效，不等 WS 回包（弱网下体验更顺）
      markMessageRecalled(conversationId, m.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : '撤回失败');
    } finally {
      setActing(false);
    }
  };

  /**
   * 删除（仅自己）
   * ------------------------------------------------------------
   * 服务端写 message_hides，之后所有端拉历史都不会再返回这条。
   * 不广播：别人的视图不受影响。
   */
  const handleDeleteLocal = async () => {
    const m = actionTarget;
    if (!m || acting) return;
    setActing(true);
    setActionTarget(null);

    // 本地占位消息（还没发成功）直接移除，不用打服务端
    if (m.id.startsWith('local-')) {
      removeMessage(conversationId, m.id);
      setActing(false);
      return;
    }

    try {
      await hideMessageApi(conversationId, m.id);
      removeMessage(conversationId, m.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    } finally {
      setActing(false);
    }
  };

  /** 复制文本到剪贴板 */
  const handleCopy = () => {
    const m = actionTarget;
    setActionTarget(null);
    if (!m?.text) return;
    try {
      const g = globalThis as unknown as {
        lynx?: { setClipboardData?: (p: { data: string }) => void };
      };
      g.lynx?.setClipboardData?.({ data: m.text });
    } catch {
      setError('复制失败');
    }
  };

  /* ---------------- 添加到通讯录 ---------------- */
  /**
   * 单向添加，不等对方审批。
   * 成功后立即隐藏提示条并刷新联系人列表（通讯录页数据同步）。
   */
  const handleAddContact = async () => {
    if (!peerId || addingContact) return;
    setAddingContact(true);
    try {
      const api = await import('../api/index.js');
      await api.addFriendDirectly(peerId);
      setShowAddContact(false);
      const friends = await import('../store/friends.js');
      await friends.refreshFriends();
    } catch (e) {
      setError(e instanceof Error ? e.message : '添加失败，请重试');
    } finally {
      setAddingContact(false);
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

  /**
   * 消息列表的起始位置
   * ------------------------------------------------------------
   * 标题栏 56px；如果显示了「添加到通讯录」提示条，
   * 列表要再往下让出 44px，否则会被提示条盖住。
   */
  /**
   * 列表起点
   * 顶部「添加到通讯录」提示条会占掉 44px。
   * 「查看更早 / 没有更多」提示行固定在上方 30px，
   * 所以列表本体再往下让 30px —— 用纯数值而不是 calc()
   * （Lynx 的 calc 支持不稳定，直接算好更可靠）。
   */
  const listTop = showAddContact && peerId ? '130px' : '86px';

  /**
   * 输入区高度（用于消息列表的 bottom 偏移）
   * ------------------------------------------------------------
   * 消息列表与输入栏都是绝对定位，必须自己算边界：
   *   56px  基础输入行
   * + 36px  录音提示条
   * + 116px 附件面板
   * 少算会让列表底部被面板盖住，多算会留出空隙。
   */
  const inputHeight =
    56 + (recording ? 36 : 0) + (panel === 'attach' ? 116 : 0);
  const listBottom = `${inputHeight}px`;

  /**
   * 自动滚到底部
   * ------------------------------------------------------------
   * scroll-view 没有「反向排列」能力，新消息追加在末尾，
   * 必须主动把滚动位置推到底，否则用户看到的还是旧消息。
   * 用 selectElementById + scrollTo 的替代方案：Lynx 的
   * scroll-view 支持通过 ui method 操作，但跨端稳定性一般，
   * 这里用最简单的「内容变化就滚到底」，配合 scroll-top 属性。
   */
  /**
   * 滚到底部
   * ============================================================
   * 【不能用 scroll-top 属性】
   * Lynx 的 scroll-view **没有** scroll-top（只有 initial-scroll-offset，
   * 而那个只在首次挂载时生效）。之前写 scroll-top={v} 完全没效果，
   * 表现就是「发了新消息，列表还停在旧位置，看不到自己的消息」。
   *
   * 正确做法：走 UI method
   *   lynx.createSelectorQuery().select('#msgScroll')
   *       .invoke({ method:'scrollTo', params:{ offset, smooth } })
   *       .exec()
   * offset 给一个远大于内容高度的值，列表会自行钳制到底部。
   *
   * 图片是异步加载的，消息刚插入时高度还没算出来，
   * 所以除了消息变化，图片 bindload 时也要再滚一次。
   */
  const scrollToBottom = () => {
    try {
      const l = getLynx();
      const query = (
        l as unknown as {
          createSelectorQuery?: () => {
            select: (sel: string) => {
              invoke: (opts: {
                method: string;
                params: Record<string, unknown>;
              }) => { exec: () => void };
            };
          };
        }
      )?.createSelectorQuery?.();
      if (!query) return;
      query
        .select('#msgScroll')
        .invoke({ method: 'scrollTo', params: { offset: 9_999_999, smooth: false } })
        .exec();
    } catch {
      // 首帧元素还没挂载时忽略
    }
  };

  useEffect(() => {
    scrollToBottom();
    // 内容刚变更时高度未定，补两次（图片解码、字体测量）
    const t1 = setTimeout(scrollToBottom, 100);
    const t2 = setTimeout(scrollToBottom, 350);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [conversationId, messages.length]);

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

      {/* 顶部提示：对方还不在通讯录（Telegram 式，不阻断聊天） */}
      {showAddContact && peerId ? (
        <view
          style={{
            width: '100%',
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingLeft: spacing.md,
            paddingRight: spacing.md,
            paddingTop: spacing.sm,
            paddingBottom: spacing.sm,
            backgroundColor: colors.primarySoft,
            borderBottomWidth: '1px',
            borderBottomColor: colors.border,
          }}
        >
          <text style={{ color: colors.textMuted, fontSize: fontSize.xs, width: '66%' }}>
            对方不在你的通讯录
          </text>
          <view
            style={{
              paddingLeft: spacing.md,
              paddingRight: spacing.md,
              paddingTop: '5px',
              paddingBottom: '5px',
              borderRadius: radius.sm,
              backgroundColor: colors.primary,
              opacity: addingContact ? 0.6 : 1,
            }}
            bindtap={handleAddContact}
          >
            <text style={{ color: colors.onPrimary, fontSize: fontSize.xs, fontWeight: '600' }}>
              {addingContact ? '添加中…' : '添加到通讯录'}
            </text>
          </view>
        </view>
      ) : null}

      {/*
        消息列表：真正的 scroll-view
        ============================================================
        之前用普通 view + 按估算高度截断，只能看最新一屏，
        历史消息翻不下去 —— 这就是「聊天页不能向下滑动」的根因。
        现在改回 scroll-view：
          · 绝对定位定死高度（top/bottom 双约束，任何屏宽都精确）；
          · 滚到顶部自动加载更早（bindscrolltoupper + 时间窗防抖）；
          · 新消息 / 图片解码后滚到底（沿用 scrollToBottom）。
        点击问题已查明与 scroll-view 无关：之前是 flex-end 布局下
        子元素命中区错位（见下 justifyContent 注释），顶对齐即解决。
      */}
      <scroll-view
        id="msgScroll"
        scroll-orientation="vertical"
        enable-scroll={true}
        upper-threshold={60}
        bindscrolltoupper={handleScrollUpper}
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: listTop,
          bottom: listBottom,
          display: 'flex',
          flexDirection: 'column',
          /**
           * 必须顶对齐，不能用 justifyContent:'flex-end'
           * ------------------------------------------------------------
           * 实测：flex-end 布局下子元素的**命中区没有跟着偏移**，
           * 视觉上消息在底部，但点击坐标仍按顶对齐计算，
           * 结果点图片/视频全部落空。这是 Lynx 的已知布局/hit-test 缺陷。
           */
          justifyContent: 'flex-start',
        }}
      >
        {/* 顶部提示行：在流内，不再独立定位 */}
        <view
          style={{
            width: '100%',
            flexShrink: 0,
            alignItems: 'center',
            justifyContent: 'center',
            paddingTop: spacing.sm,
            paddingBottom: spacing.sm,
          }}
          bindtap={showEarlier}
        >
          <text style={{ color: colors.textFaint, fontSize: fontSize.xs }}>
            {loading
              ? '加载中…'
              : displayed.length < messages.length || hasMore
                ? '查看更早的消息'
                : messages.length > 0
                  ? '没有更多了'
                  : ''}
          </text>
        </view>

        {displayed.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            isSelf={msg.senderId === myId}
            peerSeq={peerSeq}
            onLongPress={() => setActionTarget(msg)}
            onMediaLoad={scrollToBottom}
          />
        ))}

        <view style={{ width: '100%', height: spacing.sm, flexShrink: 0 }} />
      </scroll-view>

      {/* 错误提示 */}
      {error ? (
        <view style={{ paddingLeft: spacing.md, paddingRight: spacing.md, paddingBottom: spacing.xs }}>
          <text style={{ color: colors.danger, fontSize: fontSize.xs }}>{error}</text>
        </view>
      ) : null}

      {/* 输入区（微信式，绝对定位贴底） */}
      <view
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
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

        {/*
          输入行：全部绝对定位
          ------------------------------------------------------------
          为什么不用 flex：
          Lynx 里 row 容器的 flex:1 子项宽度会被算成 0，
          而写死百分比（如 width:'66%'）又会在不同屏宽下留出
          大小不一的空隙 —— 表现就是「按钮没贴右边缘、输入框
          没填满中间」，也就是用户说的「没有屏幕自适应」。
          用 left / right 同时约束的绝对定位，宽度由父级减去
          两侧偏移自动得出，任何屏宽都精确填满。
        */}
        <view
          style={{
            width: '100%',
            height: '56px',
            position: 'relative',
            backgroundColor: colors.surface,
          }}
        >
          {/* 左：语音 / 键盘 切换 */}
          <view
            style={{
              position: 'absolute',
              left: spacing.sm,
              top: '8px',
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

          {/* 中：输入框 / 按住说话 —— left + right 双约束自动撑满 */}
          <view
            style={{
              position: 'absolute',
              left: '50px',
              right: showSendButton ? '72px' : '54px',
              top: '8px',
              height: '40px',
            }}
          >
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
                bindtouchstart={(e: {
                  touches?: Array<{ pageY?: number; y?: number }>;
                }) => {
                  const y = e.touches?.[0]?.pageY ?? e.touches?.[0]?.y ?? 0;
                  void startRecording(y);
                }}
                /*
                  上滑取消：用「相对位移」判断，不能用绝对坐标。
                  之前写 y < 120（屏幕顶部 120px），而手指在输入栏
                  附近（约 2100px），永远不满足，取消功能等于失效。
                */
                bindtouchmove={(e: { touches?: Array<{ pageY?: number; y?: number }> }) => {
                  const y = e.touches?.[0]?.pageY ?? e.touches?.[0]?.y ?? 0;
                  cancelRecordRef.current = recordStartY.current - y > 60;
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
                key={inputKey}
                style={{ ...commonStyles.input, width: '100%', height: '40px' }}
                default-value={draft}
                placeholder="输入消息…"
                bindinput={(e: { detail: { value: string } }) => handleInput(e.detail.value)}
                bindconfirm={handleSend}
              />
            )}
          </view>

          {/* 右：发送（有文字时）或 附件入口 —— 始终贴右边缘 */}
          {showSendButton ? (
            <view
              style={{
                position: 'absolute',
                right: spacing.sm,
                top: '8px',
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
                position: 'absolute',
                right: spacing.sm,
                top: '8px',
                width: '38px',
                height: '40px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              bindtap={() => setPanel((pv) => (pv === 'attach' ? 'none' : 'attach'))}
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

      {/*
        长按操作菜单
        ------------------------------------------------------------
        用整屏遮罩 + 底部卡片而不是浮层气泡：
        Lynx 的绝对定位在滚动容器内行为不稳定，遮罩方案
        不依赖任何父级坐标，各端表现一致。
        点遮罩关闭，符合「点外面取消」的通用预期。
      */}
      {actionTarget ? (
        <view
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
            zIndex: 100,
            backgroundColor: 'rgba(0,0,0,0.45)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
          }}
          bindtap={() => setActionTarget(null)}
        >
          <view
            style={{
              width: '100%',
              backgroundColor: colors.surface,
              borderTopLeftRadius: radius.xl,
              borderTopRightRadius: radius.xl,
              paddingTop: spacing.sm,
              paddingBottom: spacing.xl,
              display: 'flex',
              flexDirection: 'column',
            }}
            /* 阻止冒泡：点菜单内部不关闭 */
            catchtap={() => undefined}
          >
            {actionTarget.text ? (
              <ActionRow label="复制" onTap={handleCopy} />
            ) : null}

            {canRecall(actionTarget) ? (
              <ActionRow label="撤回" onTap={() => void handleRecall()} danger />
            ) : null}

            <ActionRow
              label={actionTarget.senderId === myId ? '删除' : '删除（仅自己可见）'}
              onTap={() => void handleDeleteLocal()}
              danger
            />

            <ActionRow label="取消" onTap={() => setActionTarget(null)} />
          </view>
        </view>
      ) : null}
    </view>
  );
}

/* ------------------------------------------------------------------ */
/* 操作菜单行                                                           */
/* ------------------------------------------------------------------ */

/**
 * 菜单项
 * 三个状态（普通 / 危险 / 取消）用颜色区分，
 * 不做图标：文字菜单在中文语境下更直接，也避免再画一套图标。
 */
function ActionRow(props: { label: string; onTap: () => void; danger?: boolean }) {
  const { label, onTap, danger } = props;
  return (
    <view
      style={{
        width: '100%',
        height: '52px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      bindtap={onTap}
    >
      <text
        style={{
          color: danger ? colors.danger : colors.text,
          fontSize: fontSize.md,
        }}
      >
        {label}
      </text>
    </view>
  );
}

/* ------------------------------------------------------------------ */
/* 文件气泡                                                             */
/* ------------------------------------------------------------------ */

/**
 * 文件消息卡片
 * ============================================================
 * 【为什么必须固定宽度】
 * 之前只写了 text-maxline="1"，没有约束容器宽度。
 * Lynx 的 text 在无宽度约束时会按内容自然撑开，
 * 长文件名直接把气泡顶出屏幕，看起来就是「文件信息超出框了」。
 *
 * 这里改成 TG / 微信的文件卡片：
 *   固定 236px 宽 → 左侧文件图标 → 右侧两行（文件名 + 大小）
 * 文件名用 text-maxline="1" + 明确宽度才能可靠截断，
 * 两者缺一不可。
 *
 * 点击行为：
 *   未过期 → 打开查看器（图片/视频可预览，其他提示链接）
 *   已过期 → 提示保留期，不发起请求
 */
function FileBubble(props: { message: Message; isSelf: boolean }) {
  const { message, isSelf } = props;
  const att = message.attachments[0];

  const expired = !att?.url;
  const tone = isSelf ? '#FFFFFF' : colors.text;
  const subTone = isSelf ? 'rgba(255,255,255,0.72)' : colors.textMuted;

  return (
    <view
      style={{
        width: '236px',
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        opacity: expired ? 0.6 : 1,
      }}
    >
      {/* 文件图标 */}
      <view
        style={{
          width: '36px',
          height: '36px',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginRight: spacing.sm,
        }}
      >
        <IconFile size={30} color={tone} />
      </view>

      {/* 文件名 + 大小：必须给定宽度，否则 text 会横向撑开 */}
      <view
        style={{
          width: '184px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <text
          style={{ color: tone, fontSize: fontSize.sm }}
          text-maxline="1"
          text-ellipsis="true"
        >
          {att?.filename ?? '文件'}
        </text>
        <text style={{ color: subTone, fontSize: '10px', marginTop: '2px' }}>
          {expired ? '文件已过期（仅保留 30 天）' : formatBytes(att?.size ?? 0)}
        </text>
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

/**
 * 本地文件地址转可直接渲染的 uri
 * ------------------------------------------------------------
 * 原生返回的是绝对路径（/data/user/0/.../img.jpg），
 * Lynx 的 <image> 需要 file:// 前缀才能从本地读图；
 * 已经是 content:// 或 file:// 的原样返回。
 */
function localFileUri(uri: string): string {
  if (!uri) return '';
  if (uri.startsWith('file://') || uri.startsWith('content://')) return uri;
  if (uri.startsWith('http://') || uri.startsWith('https://')) return uri;
  return `file://${uri}`;
}

/** 是否是「可点开查看」的媒体消息 */
function isMediaMessage(m: Message): boolean {
  if (m.type !== 'image' && m.type !== 'video' && m.type !== 'file') return false;
  return !!m.attachments[0]?.url;
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

function MessageBubble(props: {
  message: Message;
  isSelf: boolean;
  peerSeq: number;
  onLongPress: () => void;
  /** 媒体加载完成（图片/视频）→ 让父级重新滚到底 */
  onMediaLoad: () => void;
}) {
  const { message, isSelf, peerSeq, onLongPress, onMediaLoad } = props;

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
    /**
     * 行布局：必须显式 width:'100%' + justifyContent
     * ------------------------------------------------------------
     * 之前用 flexDirection:'row-reverse' 让气泡靠右，但同排还放了
     * 自己的头像，头像占了最右侧的位置，气泡被挤到左边 ——
     * 看起来就是「消息没有右对齐」。
     *
     * Telegram / iMessage 的做法是：**自己的消息不显示头像**，
     * 气泡直接贴右边缘。这里照此实现，同时用 justifyContent
     * 而不是 flex 方向来对齐，避免 Lynx 下 row-reverse 的
     * 子项宽度计算异常。
     */
    <view
      style={{
        width: '100%',
        /*
          flexShrink: 0 绝对不能省
          ------------------------------------------------------------
          配合列表容器的 justifyContent:'flex-end'，当消息总高度
          超过可视区（或键盘弹出压缩高度）时，flex 容器会尝试压缩
          子项，消息行被压扁后互相重叠 —— 用户看到的就是
          「气泡叠在一起、时间文字压在气泡上」。
          flexShrink:0 让每行保持自身高度，超出部分由容器向上溢出
          （最新消息始终可见，符合聊天场景）。
        */
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'row',
        justifyContent: isSelf ? 'flex-end' : 'flex-start',
        paddingLeft: spacing.md,
        paddingRight: spacing.md,
        paddingTop: spacing.xs,
        paddingBottom: spacing.xs,
      }}
      /*
        手势分配（实测结论，很反直觉）
        ------------------------------------------------------------
        Lynx 里 tap 与 longpress **无法共存**：同一元素同时绑定时
        只有 tap 生效（文档写的是 longpress 优先，实测相反）；
        祖先绑 longpress 会让子元素 tap 完全失效。
        既然不能共存，就按消息类型分工：
          · 媒体消息（图/视频/文件）→ 绑 tap，点开大图（核心功能）
          · 文字 / 语音 / 系统消息  → 绑 longpress，弹操作菜单
        两类各用单一手势，互不干扰，功能都完整。
        需要撤回媒体消息时，可在查看器里操作（后续可加）。
      */
      bindtap={
        isMediaMessage(message)
          ? () => {
              const att = message.attachments[0];
              if (!att?.url) return;
              push({
                name: 'media-viewer',
                params: {
                  url: att.url,
                  kind:
                    message.type === 'video'
                      ? 'video'
                      : message.type === 'image'
                        ? 'image'
                        : 'file',
                  filename: att.filename,
                },
              });
            }
          : undefined
      }
      bindlongpress={isMediaMessage(message) ? undefined : onLongPress}
    >
      {/* 头像：只给对方消息显示（自己的消息不显示，与 TG 一致） */}
      {!isSelf ? (
        <view
          style={{
            width: '34px',
            height: '34px',
            flexShrink: 0,
            borderRadius: radius.full,
            backgroundColor: colors.primarySoft,
            borderWidth: '1px',
            borderColor: colors.cardBorder,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: spacing.sm,
          }}
        >
          <text style={{ color: colors.primary, fontSize: fontSize.sm, fontWeight: '600' }}>
            {message.senderName.slice(0, 1)}
          </text>
        </view>
      ) : null}

      {/* 气泡列：最宽 78%，自己贴右、对方贴左 */}
      <view
        style={{
          width: '78%',
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: isSelf ? 'flex-end' : 'flex-start',
        }}
      >
        {/* 群聊显示发送者昵称 */}
        {!isSelf ? (
          <text style={{ color: colors.textFaint, fontSize: fontSize.xs, marginBottom: '2px' }}>
            {message.senderName}
          </text>
        ) : null}

        <view
          style={{
            /**
             * 必须显式写 column
             * ------------------------------------------------------------
             * Lynx 的 view **默认是横排（row）**，不是 CSS 的 column。
             * 之前漏了这一行，结果气泡里的「正文」和「时间+勾选」
             * 被排在同一行，短文本时挤在右侧、长文本时直接溢出气泡
             * —— 就是用户说的「文字和发送时间并列，超出消息框」。
             *
             * maxWidth: '100%' 是第二道保险：
             * 父级已限制 78% 宽，这里再约束一次，
             * 防止长图片/长文本把气泡撑破。
             */
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: isSelf ? colors.primary : colors.surfaceAlt,
            borderRadius: radius.bubble,
            paddingLeft: spacing.md,
            paddingRight: spacing.md,
            paddingTop: spacing.sm,
            paddingBottom: spacing.sm,
          }}
        >
          <MessageContent message={message} isSelf={isSelf} onMediaLoad={onMediaLoad} />

          {/* 上传进度条：仅 optimistic 媒体消息显示 */}
          {isSelf && message.localStatus === 'sending' && typeof message.localProgress === 'number' ? (
            <view
              style={{
                width: '100%',
                height: '3px',
                borderRadius: '2px',
                backgroundColor: 'rgba(255,255,255,0.28)',
                marginTop: '4px',
              }}
            >
              <view
                style={{
                  width: `${Math.max(2, Math.round(message.localProgress * 100))}%`,
                  height: '3px',
                  borderRadius: '2px',
                  backgroundColor: '#FFFFFF',
                }}
              />
            </view>
          ) : null}

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
                {typeof message.localProgress === 'number'
                  ? ` ${Math.round(message.localProgress * 100)}%`
                  : ''}
              </text>
            ) : null}
          </view>
        </view>
      </view>
    </view>
  );
}

/** 按消息类型渲染不同内容 */
function MessageContent(props: {
  message: Message;
  isSelf: boolean;
  onMediaLoad?: () => void;
}) {
  const { message, isSelf, onMediaLoad } = props;

  switch (message.type) {
    case 'text': {
      /**
       * 文本气泡宽度
       * ------------------------------------------------------------
       * Lynx 里 flex column 容器的「内容自适应宽度」不可靠：
       * 父级给百分比时，text 的换行宽度与高度在布局阶段算不出来，
       * 表现就是多行文字溢出气泡、时间被挤到气泡外。
       *
       * 这里显式算一个宽度：
       *   中文按 fontSize.md 的 1 倍宽估算，英文按 0.55 倍；
       *   下限 72px（一两个字），上限 240px（超过就换行）。
       * 宽度确定后，高度由换行行数自然算出，不再溢出。
       */
      const raw = message.text ?? '';
      let units = 0;
      for (const ch of raw) {
        units += ch.charCodeAt(0) > 0x2e80 ? 1 : 0.55;
      }
      const bubbleW = Math.min(240, Math.max(72, Math.round(units * 15 + 26)));

      return (
        <text
          style={{
            width: `${bubbleW}px`,
            color: isSelf ? '#fff' : colors.text,
            fontSize: fontSize.md,
          }}
        >
          {raw}
        </text>
      );
    }

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
        /**
         * 点击区必须自己带尺寸
         * ------------------------------------------------------------
         * 之前这个 view 没有任何宽高，只包着 image。
         * Lynx 不会像 CSS 那样让父级被 image 撑开并继承点击区域，
         * 结果点击落空 —— 用户点了图片没有任何反应。
         * 显式把宽高写到容器上，点击区域与视觉完全一致。
         */
        <view
          style={{ width: `${w}px`, height: `${h}px` }}
          bindtap={() => {
            push({
              name: 'media-viewer',
              params: { url: att.url, kind: 'image', filename: att.filename },
            });
          }}
        >
          <image
            src={mediaUrl(att.url)}
            style={{
              width: `${w}px`,
              height: `${h}px`,
              borderRadius: radius.md,
            }}
            mode="aspectFill"
            /* 图片解码完成后再滚一次底：此时高度才真正确定 */
            bindload={onMediaLoad}
          />
        </view>
      );
    }

    case 'audio':
      return <VoiceBubble message={message} isSelf={isSelf} />;

    case 'video': {
      const att = message.attachments[0];
      const sec = att?.durationMs ? Math.max(1, Math.round(att.durationMs / 1000)) : 0;

      if (!att?.url) {
        return (
          <view
            style={{
              width: '200px',
              height: '130px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: colors.surfaceAlt,
              borderRadius: radius.md,
            }}
          >
            <text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>视频已过期</text>
          </view>
        );
      }

      /**
       * 视频气泡：封面 + 播放按钮 + 时长
       * ------------------------------------------------------------
       * 没有服务端生成的封面（thumbUrl 常为空），
       * 所以不硬解首帧（Lynx 的 video 无法取静帧），
       * 改用「深色卡片 + 播放三角 + 时长」的通用样式，
       * 与 TG 在无封面时的表现一致。
       */
      return (
        <view
          style={{
            width: '200px',
            height: '130px',
            borderRadius: radius.md,
            backgroundColor: 'rgba(0,0,0,0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
          }}
          bindtap={() => {
            push({
              name: 'media-viewer',
              params: { url: att.url, kind: 'video', filename: att.filename },
            });
          }}
        >
          {/* 播放按钮 */}
          <view
            style={{
              width: '46px',
              height: '46px',
              borderRadius: '23px',
              backgroundColor: 'rgba(255,255,255,0.92)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <IconPlay size={18} color="#000000" />
          </view>

          {/* 时长 */}
          <text
            style={{
              position: 'absolute',
              right: '8px',
              bottom: '6px',
              color: '#FFFFFF',
              fontSize: '11px',
            }}
          >
            {`${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`}
          </text>
        </view>
      );
    }

    case 'file':
      return <FileBubble message={message} isSelf={isSelf} />;

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
