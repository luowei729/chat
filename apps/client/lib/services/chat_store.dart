import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../core/api.dart';
import '../core/models.dart';
import 'desktop_bridge.dart';
import 'local_cache.dart';
import 'session.dart';
import 'ws.dart';

/// 输入中事件（供聊天页显示「对方正在输入…」）
class TypingEvent {
  const TypingEvent(this.conversationId, this.userId);

  final String conversationId;
  final String userId;
}

/// ============================================================
/// 聊天数据状态（会话列表 + 消息）
/// ------------------------------------------------------------
/// 设计原则：
/// 1. **单一数据源**：WS 推送与 REST 拉取都写进同一个 map，
///    避免两套数据打架（这是 Lynx 版本里消息时隐时现的根源）；
/// 2. **乐观更新**：发送立刻上屏（sending + 进度），成功后替换为服务端消息；
/// 3. **按 clientId 去重**：网络重试/回声都不会产生重复气泡；
/// 4. **撤回与删除分开**：撤回保留占位（seq 不能断），删除只本地移除。
/// ============================================================
class ChatStore extends ChangeNotifier {
  ChatStore._();

  static final ChatStore instance = ChatStore._();

  final ApiClient _api = ApiClient.instance;
  final WsService _ws = WsService.instance;

  /* ---------------- 会话列表 ---------------- */
  List<ConversationSummary> conversations = const [];
  bool conversationsLoaded = false;
  bool conversationsLoading = false;

  /* ---------------- 消息 ---------------- */
  final Map<String, List<Message>> _messages = {};
  final Map<String, bool> _hasMore = {};
  final Map<String, bool> _loadingMore = {};

  /* ---------------- 已读水位 ---------------- */
  /// conversationId → userId → lastReadSeq
  final Map<String, Map<String, int>> _reads = {};

  /* ---------------- 当前打开的会话 ---------------- */
  String? activeConversationId;

  /* ---------------- 输入中 ---------------- */
  final StreamController<TypingEvent> _typing = StreamController<TypingEvent>.broadcast();
  Stream<TypingEvent> get onTyping => _typing.stream;

  /* ---------------- 未读总数（TabBar 角标） ---------------- */
  int get totalUnread => conversations.fold(0, (sum, c) => sum + c.unreadCount);

  Session get _session => Session.instance;
  String get myId => _session.userId;

  List<Message> messagesOf(String conversationId) => _messages[conversationId] ?? const [];
  bool hasMoreOf(String conversationId) => _hasMore[conversationId] ?? false;
  bool isLoadingMore(String conversationId) => _loadingMore[conversationId] ?? false;

  /// 对方已读到的 seq（私聊=对方；群聊=最落后成员）
  int peerReadSeq(String conversationId) {
    final map = _reads[conversationId];
    if (map == null || map.isEmpty) return 0;
    var min = -1;
    for (final entry in map.entries) {
      if (entry.key == myId) continue;
      if (min < 0 || entry.value < min) min = entry.value;
    }
    return min < 0 ? 0 : min;
  }

  ConversationSummary? conversationById(String id) {
    for (final c in conversations) {
      if (c.id == id) return c;
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* 启动与重连                                                          */
  /* ------------------------------------------------------------------ */

  StreamSubscription<Map<String, dynamic>>? _wsSub;
  StreamSubscription<void>? _reconnectSub;

  void attachWs() {
    _wsSub ??= _ws.events.listen(_onWsEvent);
    _reconnectSub ??= _ws.onReconnected.listen((_) => syncAfterReconnect());
  }

  /// 断线重连后补齐数据：服务端不会补推断线期间的推送
  Future<void> syncAfterReconnect() async {
    await loadConversations(silent: true);
    final active = activeConversationId;
    if (active != null) {
      await reloadMessages(active);
      _ws.subscribe([active]);
      if (_messages[active]?.isNotEmpty == true) {
        _ws.sendRead(active, _messages[active]!.last.seq);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 会话列表                                                            */
  /* ------------------------------------------------------------------ */

  Future<void> loadConversations({bool silent = false}) async {
    if (!_session.isAuthenticated) return;

    /**
     * 先把本地缓存摆上屏，再走网络
     * ------------------------------------------------------------
     * 否则冷启动 / 切到聊天 Tab 都会先白屏一下（等接口返回）。
     * silent=true 表示背景刷新，此时不重置 loading，避免闪烁。
     */
    if (!conversationsLoaded) {
      final cached = await LocalCache.instance.loadConversations();
      if (cached.isNotEmpty) {
        conversations = _sortConversations(cached);
        conversationsLoaded = true;
        notifyListeners();
      }
    }

    if (!silent) {
      conversationsLoading = true;
      notifyListeners();
    }
    try {
      final list = await _api.listConversations();
      conversations = _sortConversations(list);
      conversationsLoaded = true;
      // 落盘：下次冷启动直接可用
      unawaited(LocalCache.instance.saveConversations(conversations));
    } on ApiException catch (e) {
      if (!silent) lastError = e.message;
    } finally {
      conversationsLoading = false;
      notifyListeners();
    }
  }

  String? lastError;

  /// 最近一次「发送媒体失败」的真实原因
  /// 以前这里只标 localStatus=failed，用户和测试都看不到为什么失败；
  /// 现在把底层异常文案留下来，气泡重试与排查都有据可依。
  String? lastSendError;

  static List<ConversationSummary> _sortConversations(List<ConversationSummary> list) {
    final sorted = List<ConversationSummary>.from(list);
    sorted.sort((a, b) {
      if (a.pinned != b.pinned) return a.pinned ? -1 : 1;
      final at = b.lastMessageAt ?? b.createdAt;
      final bt = a.lastMessageAt ?? a.createdAt;
      return at.compareTo(bt);
    });
    return sorted;
  }

  void clearUnread(String conversationId) {
    final updated = conversations
        .map((c) => c.id == conversationId ? c.copyWith(unreadCount: 0) : c)
        .toList(growable: false);
    conversations = updated;
    _syncTrayTip();
    notifyListeners();
  }

  /* ------------------------------------------------------------------ */
  /* 打开会话                                                            */
  /* ------------------------------------------------------------------ */

  Future<void> openConversation(String conversationId) async {
    activeConversationId = conversationId;
    _ws.subscribe([conversationId]);
    clearUnread(conversationId);

    // 用户已经来看这个会话了：停掉任务栏闪烁与右下角卡片
    unawaited(DesktopBridge.instance.stopTaskbarFlash());
    unawaited(DesktopBridge.instance.closeNotification());

    /**
     * 先用本地缓存渲染，再拉网络
     * ------------------------------------------------------------
     * 用户反复进出同一个会话时，不应该每次都等一次网络往返。
     * 缓存命中就立即可见，网络请求在后台做「对齐」：
     * 服务端为准，但保留本地还在发送中的占位（_mergeServerMessages）。
     */
    final cached = await LocalCache.instance.loadMessages(conversationId);
    if (cached.isNotEmpty && messagesOf(conversationId).isEmpty) {
      _messages[conversationId] = _sortMessages(cached);
      // 缓存里已经有内容，说明大概率还有更早的可以上拉
      _hasMore[conversationId] = true;
      notifyListeners();
    }

    // 已读水位先置为自己的最新，避免自己消息显示未读
    await _loadReads(conversationId);

    await reloadMessages(conversationId);

    final list = messagesOf(conversationId);
    if (list.isNotEmpty) {
      _ws.sendRead(conversationId, list.last.seq);
    }
  }

  void closeConversation(String conversationId) {
    if (activeConversationId == conversationId) activeConversationId = null;
    _ws.unsubscribe([conversationId]);
  }

  Future<void> _loadReads(String conversationId) async {
    try {
      final detail = await _api.conversation(conversationId);
      final map = <String, int>{};
      for (final m in detail.members) {
        map[m.userId] = m.lastReadSeq;
      }
      _reads[conversationId] = map;
      notifyListeners();
    } catch (_) {
      // 拿不到就沿用旧水位，不影响主流程
    }
  }

  /// 重新拉最新一页（保留本地未完成消息）
  Future<void> reloadMessages(String conversationId) async {
    try {
      final page = await _api.listMessages(conversationId, limit: 30);
      _mergeServerMessages(conversationId, page.items, page.hasMore);
    } on ApiException catch (e) {
      lastError = e.message;
      notifyListeners();
    }
  }

  /// 上拉加载更早
  Future<void> loadMore(String conversationId) async {
    if (_loadingMore[conversationId] == true) return;
    if (!hasMoreOf(conversationId)) return;
    final list = messagesOf(conversationId);
    final oldestSeq = list.isEmpty ? null : list.first.seq;
    if (oldestSeq == null) return;

    _loadingMore[conversationId] = true;
    notifyListeners();
    try {
      final page = await _api.listMessages(conversationId, before: oldestSeq, limit: 30);
      final existing = List<Message>.from(messagesOf(conversationId));
      final knownIds = existing.map((m) => m.id).toSet();
      final older = page.items.where((m) => !knownIds.contains(m.id)).toList();
      _messages[conversationId] = _sortMessages([...older, ...existing]);
      _hasMore[conversationId] = page.hasMore;
    } on ApiException catch (e) {
      lastError = e.message;
    } finally {
      _loadingMore[conversationId] = false;
      notifyListeners();
    }
  }

  /// 服务端数据合并
  ///
  /// 【不能简单「服务端为准」】
  /// 服务端这一页只返回最近 30 条，而本地缓存可能有 200 条历史。
  /// 直接替换会把更早的 170 条冲掉，用户上滑就再也翻不回去了
  /// （虽然能重新拉，但白白多一次往返，观感也像「消息丢了」）。
  ///
  /// 三条规则：
  ///   1. 服务端这一页 → 覆盖同 id 的本地版本（拿到最新撤回/编辑状态）；
  ///   2. 本地 seq 更早（< 服务端最小 seq）→ 保留，那是已加载的历史；
  ///   3. 本地「发送中/失败」的占位 → 保留；但如果它比服务端最新还旧，
  ///      说明已被服务端处理过（可能是别设备发的同 clientId），丢弃避免重复。
  void _mergeServerMessages(String conversationId, List<Message> server, bool hasMore) {
    final existing = messagesOf(conversationId);
    final serverIds = server.map((m) => m.id).toSet();
    final serverClientIds = server.map((m) => m.clientId).whereType<String>().toSet();

    final serverMinSeq = server.isEmpty ? 0 : server.first.seq;
    final serverMaxSeq = server.isEmpty ? 0 : server.last.seq;

    // 1. 保留本地已加载的更早历史
    final olderLocal = existing
        .where((m) => m.seq > 0 && m.seq < serverMinSeq)
        .toList(growable: false);

    // 2. 保留本地未完成的消息
    final pending = existing.where((m) {
      if (m.localStatus != LocalStatus.sending && m.localStatus != LocalStatus.failed) {
        return false;
      }
      if (serverIds.contains(m.id)) return false;
      if (m.clientId != null && serverClientIds.contains(m.clientId)) return false;
      return m.seq <= 0 || m.seq > serverMaxSeq;
    });

    _messages[conversationId] = _sortMessages([...olderLocal, ...server, ...pending]);
    // 本地还有更早的历史时保持可上拉，避免上滑入口消失
    _hasMore[conversationId] = hasMore || olderLocal.isNotEmpty;
    // 写回缓存：下次进会话直接用本地
    unawaited(LocalCache.instance.saveMessages(conversationId, _messages[conversationId]!));
    notifyListeners();
  }

  static List<Message> _sortMessages(List<Message> list) {
    final sorted = List<Message>.from(list);
    sorted.sort((a, b) {
      final aPending = a.seq <= 0;
      final bPending = b.seq <= 0;
      if (aPending != bPending) return aPending ? 1 : -1;
      if (aPending && bPending) return a.createdAt.compareTo(b.createdAt);
      return a.seq.compareTo(b.seq);
    });
    return sorted;
  }

  /* ------------------------------------------------------------------ */
  /* 发送                                                                */
  /* ------------------------------------------------------------------ */

  String _newClientId() {
    final rnd = Random().nextInt(0x7fffffff).toRadixString(36);
    return 'c${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}$rnd';
  }

  /// 发送文本
  Future<void> sendText(String conversationId, String text) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty) return;
    lastSendError = null;
    final clientId = _newClientId();
    final local = Message(
      id: 'local-$clientId',
      conversationId: conversationId,
      seq: 0,
      senderId: myId,
      senderName: _session.user?.nickname ?? '我',
      type: 'text',
      text: trimmed,
      createdAt: DateTime.now().millisecondsSinceEpoch,
      localStatus: LocalStatus.sending,
      clientId: clientId,
    );
    _appendLocal(local);

    try {
      final saved = await _api.sendMessage(
        conversationId,
        clientId: clientId,
        type: 'text',
        text: trimmed,
      );
      _replaceLocal(conversationId, clientId, saved);
    } catch (e) {
      lastSendError = e is ApiException ? e.message : e.toString();
      _markFailed(conversationId, clientId);
    }
  }

  /// 发送媒体（先上传再发消息，全程有进度）
  Future<void> sendMedia({
    required String conversationId,
    required String type,
    required String filePath,
    required String filename,
    String? kind,
    int? width,
    int? height,
    int? durationMs,
    List<int>? waveform,
  }) async {
    lastSendError = null;
    final clientId = _newClientId();
    final local = Message(
      id: 'local-$clientId',
      conversationId: conversationId,
      seq: 0,
      senderId: myId,
      senderName: _session.user?.nickname ?? '我',
      type: type,
      createdAt: DateTime.now().millisecondsSinceEpoch,
      localStatus: LocalStatus.sending,
      localProgress: 0,
      clientId: clientId,
      localFilePath: filePath,
    );
    _appendLocal(local);

    try {
      final uploaded = await _api.uploadMedia(
        filePath: filePath,
        filename: filename,
        kind: kind ?? type,
        width: width,
        height: height,
        durationMs: durationMs,
        waveform: waveform,
        onProgress: (p) => updateProgress(conversationId, clientId, p),
      );

      final saved = await _api.sendMessage(
        conversationId,
        clientId: clientId,
        type: type,
        attachmentIds: [uploaded.attachment.id],
      );
      _replaceLocal(conversationId, clientId, saved, keepLocalFile: filePath);
    } catch (e) {
      lastSendError = e is ApiException ? e.message : e.toString();
      _markFailed(conversationId, clientId);
    }
  }

  void _appendLocal(Message message) {
    final list = List<Message>.from(messagesOf(message.conversationId))..add(message);
    _messages[message.conversationId] = _sortMessages(list);
    notifyListeners();
  }

  void _replaceLocal(String conversationId, String clientId, Message saved, {String? keepLocalFile}) {
    final list = messagesOf(conversationId);
    final idx = list.indexWhere((m) => m.clientId == clientId);
    final replacement = keepLocalFile == null ? saved : saved;
    final updated = List<Message>.from(list);
    if (idx >= 0) {
      // 保留本地预览路径，避免上传完成瞬间图片闪白
      updated[idx] = Message(
        id: replacement.id,
        conversationId: replacement.conversationId,
        seq: replacement.seq,
        senderId: replacement.senderId,
        senderName: replacement.senderName,
        senderAvatarUrl: replacement.senderAvatarUrl,
        type: replacement.type,
        text: replacement.text,
        attachments: replacement.attachments,
        replyToId: replacement.replyToId,
        replyToPreview: replacement.replyToPreview,
        createdAt: replacement.createdAt,
        editedAt: replacement.editedAt,
        deletedAt: replacement.deletedAt,
        localStatus: LocalStatus.sent,
        clientId: clientId,
        localFilePath: keepLocalFile,
      );
    } else {
      updated.add(replacement);
    }
    _messages[conversationId] = _sortMessages(updated);
    _touchConversation(conversationId, saved);
    notifyListeners();
  }

  void _markFailed(String conversationId, String clientId) {
    final list = messagesOf(conversationId);
    final idx = list.indexWhere((m) => m.clientId == clientId);
    if (idx < 0) return;
    final updated = List<Message>.from(list);
    updated[idx] = updated[idx].copyWith(localStatus: LocalStatus.failed, clearProgress: true);
    _messages[conversationId] = updated;
    notifyListeners();
  }

  void updateProgress(String conversationId, String clientId, double progress) {
    final list = messagesOf(conversationId);
    final idx = list.indexWhere((m) => m.clientId == clientId);
    if (idx < 0) return;
    final updated = List<Message>.from(list);
    updated[idx] = updated[idx].copyWith(localProgress: progress.clamp(0.0, 1.0));
    _messages[conversationId] = updated;
    notifyListeners();
  }

  /// 重发失败消息（媒体需重新上传，这里只支持文本重发）
  Future<void> retry(Message message) async {
    if (message.localStatus != LocalStatus.failed) return;
    if (message.type != 'text' || message.text == null) return;
    final list = List<Message>.from(messagesOf(message.conversationId));
    final idx = list.indexWhere((m) => m.clientId == message.clientId);
    if (idx >= 0) {
      list[idx] = list[idx].copyWith(localStatus: LocalStatus.sending, clearProgress: true);
      _messages[message.conversationId] = list;
      notifyListeners();
    }
    try {
      final saved = await _api.sendMessage(
        message.conversationId,
        clientId: message.clientId ?? _newClientId(),
        type: 'text',
        text: message.text,
      );
      _replaceLocal(message.conversationId, message.clientId ?? '', saved);
    } catch (_) {
      _markFailed(message.conversationId, message.clientId ?? '');
    }
  }

  /* ------------------------------------------------------------------ */
  /* 撤回 / 删除                                                         */
  /* ------------------------------------------------------------------ */

  /// 撤回：保留气泡，显示「消息已撤回」
  Future<void> recall(Message message) async {
    await _api.recallMessage(message.id);
    final list = messagesOf(message.conversationId);
    final idx = list.indexWhere((m) => m.id == message.id);
    if (idx < 0) return;
    final updated = List<Message>.from(list);
    updated[idx] = Message(
      id: message.id,
      conversationId: message.conversationId,
      seq: message.seq,
      senderId: message.senderId,
      senderName: message.senderName,
      type: 'system',
      text: '消息已撤回',
      createdAt: message.createdAt,
      deletedAt: DateTime.now().millisecondsSinceEpoch,
      deleted: true,
      clientId: message.clientId,
    );
    _messages[message.conversationId] = updated;
    unawaited(LocalCache.instance.upsertMessage(updated[idx]));
    notifyListeners();
  }

  /// 删除：仅自己不可见
  Future<void> deleteForMe(Message message) async {
    await _api.hideMessage(message.id);
    final list = messagesOf(message.conversationId);
    _messages[message.conversationId] =
        list.where((m) => m.id != message.id).toList(growable: false);
    unawaited(LocalCache.instance.removeMessage(message.conversationId, message.id));
    notifyListeners();
  }

  /* ------------------------------------------------------------------ */
  /* WS 事件                                                             */
  /* ------------------------------------------------------------------ */

  void _onWsEvent(Map<String, dynamic> msg) {
    final type = msg['type'];
    switch (type) {
      case 'message.new':
        _onMessageNew(msg);
      case 'message.updated':
        _onMessageUpdated(msg);
      case 'message.deleted':
        _onMessageDeleted(msg);
      case 'read.updated':
        _onReadUpdated(msg);
      case 'conversation.new':
        unawaited(loadConversations(silent: true));
      case 'conversation.updated':
        unawaited(loadConversations(silent: true));
      case 'typing':
        final cid = msg['conversationId'];
        final uid = msg['userId'];
        if (cid is String && uid is String) {
          _typing.add(TypingEvent(cid, uid));
        }
      case 'friend.request':
      case 'friend.accepted':
      case 'friend.removed':
        unawaited(loadConversations(silent: true));
      case 'group.members-changed':
        unawaited(loadConversations(silent: true));
    }
  }

  void _onMessageNew(Map<String, dynamic> msg) {
    final conversationId = msg['conversationId'];
    final raw = msg['message'];
    if (conversationId is! String || raw is! Map) return;
    final incoming = Message.fromJson(Map<String, dynamic>.from(raw));

    final list = List<Message>.from(messagesOf(conversationId));

    // 自己的消息回声：用 clientId 替换本地占位
    final byClient = incoming.clientId == null
        ? -1
        : list.indexWhere((m) => m.clientId == incoming.clientId);
    final byId = list.indexWhere((m) => m.id == incoming.id);

    if (byId >= 0) {
      list[byId] = incoming;
    } else if (byClient >= 0) {
      final keepPath = list[byClient].localFilePath;
      list[byClient] = Message(
        id: incoming.id,
        conversationId: incoming.conversationId,
        seq: incoming.seq,
        senderId: incoming.senderId,
        senderName: incoming.senderName,
        senderAvatarUrl: incoming.senderAvatarUrl,
        type: incoming.type,
        text: incoming.text,
        attachments: incoming.attachments,
        replyToId: incoming.replyToId,
        replyToPreview: incoming.replyToPreview,
        createdAt: incoming.createdAt,
        editedAt: incoming.editedAt,
        localStatus: LocalStatus.sent,
        clientId: incoming.clientId,
        localFilePath: keepPath,
      );
    } else {
      list.add(incoming);
    }

    _messages[conversationId] = _sortMessages(list);
    // 单条落盘，避免整会话重写
    unawaited(LocalCache.instance.upsertMessage(incoming));
    _touchConversation(conversationId, incoming, incomingSelf: incoming.senderId == myId);
    notifyListeners();

    // 桌面端提示（任务栏闪烁 + 右下角卡片）
    unawaited(_notifyDesktop(conversationId, incoming));
  }

  /// 通知所有订阅者
  void _notifyAll() => notifyListeners();

  /// 同步托盘悬停提示（Windows）
  ///
  /// 托盘图标是窗口隐藏时用户唯一能看到的信息入口，
  /// 把未读数写上去，不用打开窗口就知道有几条。
  void _syncTrayTip() {
    final unread = totalUnread;
    final tip = unread > 0 ? 'Chat — $unread 条未读' : 'Chat';
    unawaited(DesktopBridge.instance.updateTrayTip(tip));
  }

  /// 桌面端新消息提示
  ///
  /// 三条规则：
  ///   1. 自己发的、当前正在看的会话 → 不打扰；
  ///   2. 窗口在前台 → 只响一次任务栏闪烁，不弹卡片（像微信）；
  ///   3. 窗口不在前台 → 卡片 + 闪烁（像 Telegram）。
  ///
  /// 移动端/鸿蒙上 DesktopBridge 会自己判定不可用，直接返回。
  Future<void> _notifyDesktop(String conversationId, Message message) async {
    if (message.senderId == myId) return;
    if (activeConversationId == conversationId) return;

    try {
      final focused = await DesktopBridge.instance.isWindowFocused();
      if (focused) {
        // 在窗口里但不在这个会话：只闪任务栏，不弹卡片
        await DesktopBridge.instance.flashTaskbar();
        return;
      }

      final title = conversationById(conversationId)?.title ?? message.senderName;
      await DesktopBridge.instance.showNotification(
        title: title,
        body: _summaryOf(message),
      );
    } catch (_) {
      // 桌面能力缺失不影响聊天
    }
  }

  void _onMessageUpdated(Map<String, dynamic> msg) {
    final conversationId = msg['conversationId'];
    final raw = msg['message'];
    if (conversationId is! String || raw is! Map) return;
    final updatedMsg = Message.fromJson(Map<String, dynamic>.from(raw));
    final list = List<Message>.from(messagesOf(conversationId));
    final idx = list.indexWhere((m) => m.id == updatedMsg.id);
    if (idx < 0) return;
    list[idx] = updatedMsg;
    _messages[conversationId] = list;
    unawaited(LocalCache.instance.upsertMessage(updatedMsg));
    notifyListeners();
  }

  void _onMessageDeleted(Map<String, dynamic> msg) {
    final conversationId = msg['conversationId'];
    final messageId = msg['messageId'];
    if (conversationId is! String || messageId is! String) return;
    final list = messagesOf(conversationId).where((m) => m.id != messageId).toList(growable: false);
    _messages[conversationId] = list;
    unawaited(LocalCache.instance.removeMessage(conversationId, messageId));
    notifyListeners();
  }

  void _onReadUpdated(Map<String, dynamic> msg) {
    final conversationId = msg['conversationId'];
    final userId = msg['userId'];
    final seq = msg['seq'];
    if (conversationId is! String || userId is! String) return;
    final value = seq is int ? seq : (seq is num ? seq.toInt() : null);
    if (value == null) return;

    final map = Map<String, int>.from(_reads[conversationId] ?? const {});
    if ((map[userId] ?? 0) < value) map[userId] = value;
    _reads[conversationId] = map;

    /**
     * 同步刷新会话摘要里的 peerReadSeq
     * ------------------------------------------------------------
     * 对方读了消息，列表里的单勾要立刻变双勾——不能等下次拉列表。
     * 群聊取「除我以外的最小值」，私聊就是对方那一个。
     */
    if (userId != myId) {
      var peerSeq = 0;
      for (final entry in map.entries) {
        if (entry.key == myId) continue;
        if (peerSeq == 0 || entry.value < peerSeq) peerSeq = entry.value;
      }
      conversations = conversations
          .map((c) => c.id == conversationId ? c.copyWith(peerReadSeq: peerSeq) : c)
          .toList(growable: false);
    }

    notifyListeners();
  }

  /// 更新会话摘要与未读数
  void _touchConversation(String conversationId, Message message, {bool? incomingSelf}) {
    final isSelf = incomingSelf ?? message.senderId == myId;
    final preview = MessagePreview(
      id: message.id,
      type: message.type,
      senderId: message.senderId,
      senderName: message.senderName,
      summary: _summaryOf(message),
      createdAt: message.createdAt,
    );

    var found = false;
    final updated = conversations.map((c) {
      if (c.id != conversationId) return c;
      found = true;
      final addUnread = !isSelf && activeConversationId != conversationId;
      return ConversationSummary(
        id: c.id,
        type: c.type,
        title: c.title,
        avatarUrl: c.avatarUrl,
        peerId: c.peerId,
        memberCount: c.memberCount,
        lastMessage: preview,
        lastMessageAt: message.createdAt,
        unreadCount: addUnread ? c.unreadCount + 1 : (activeConversationId == conversationId ? 0 : c.unreadCount),
        pinned: c.pinned,
        muted: c.muted,
        createdAt: c.createdAt,
        // 必须原样带回：否则重建时丢失已读水位，列表的双勾会退化成单勾
        peerReadSeq: c.peerReadSeq,
      );
    }).toList(growable: false);

    conversations = _sortConversations(updated);
    if (!found) {
      // 新会话：拉一次列表把标题/头像补全
      unawaited(loadConversations(silent: true));
    }
    _syncTrayTip();
    notifyListeners();
  }

  static String _summaryOf(Message m) {
    switch (m.type) {
      case 'image':
        return '[图片]';
      case 'video':
        return '[视频]';
      case 'audio':
        final ms = m.firstAttachment?.durationMs ?? 0;
        return '[语音] ${max(1, (ms / 1000).round())}″';
      case 'file':
        return '[文件] ${m.firstAttachment?.filename ?? ''}';
      case 'system':
        return m.text ?? '系统消息';
      default:
        return m.text ?? '';
    }
  }

  /* ------------------------------------------------------------------ */
  /* 已读与输入中                                                        */
  /* ------------------------------------------------------------------ */

  void markRead(String conversationId) {
    clearUnread(conversationId);
    final list = messagesOf(conversationId);
    if (list.isEmpty) return;
    _ws.sendRead(conversationId, list.last.seq);
  }

  void notifyTyping(String conversationId) {
    _ws.sendTyping(conversationId);
  }

  /* ------------------------------------------------------------------ */
  /* 退出登录                                                            */
  /* ------------------------------------------------------------------ */

  void reset() {
    conversations = const [];
    conversationsLoaded = false;
    _messages.clear();
    _hasMore.clear();
    _loadingMore.clear();
    _reads.clear();
    activeConversationId = null;
    // 缓存里是上一个账号的聊天内容，必须清掉
    unawaited(LocalCache.instance.clearAll());
    notifyListeners();
  }

  /// 供媒体选择器判断支持的能力（桌面端 picker 行为不同）
  static bool get isMobile => Platform.isAndroid || Platform.isIOS;
}
