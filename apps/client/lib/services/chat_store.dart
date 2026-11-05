import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../core/api.dart';
import '../core/models.dart';
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
    if (!silent) {
      conversationsLoading = true;
      notifyListeners();
    }
    try {
      final list = await _api.listConversations();
      conversations = _sortConversations(list);
      conversationsLoaded = true;
    } on ApiException catch (e) {
      if (!silent) lastError = e.message;
    } finally {
      conversationsLoading = false;
      notifyListeners();
    }
  }

  String? lastError;

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
    notifyListeners();
  }

  /* ------------------------------------------------------------------ */
  /* 打开会话                                                            */
  /* ------------------------------------------------------------------ */

  Future<void> openConversation(String conversationId) async {
    activeConversationId = conversationId;
    _ws.subscribe([conversationId]);
    clearUnread(conversationId);

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

  /// 服务端数据合并：服务端为准，但保留本地「发送中/失败」的占位
  void _mergeServerMessages(String conversationId, List<Message> server, bool hasMore) {
    final existing = messagesOf(conversationId);
    final serverIds = server.map((m) => m.id).toSet();
    final serverClientIds = server.map((m) => m.clientId).whereType<String>().toSet();

    final pending = existing.where((m) {
      if (m.localStatus != LocalStatus.sending && m.localStatus != LocalStatus.failed) {
        return false;
      }
      if (serverIds.contains(m.id)) return false;
      if (m.clientId != null && serverClientIds.contains(m.clientId)) return false;
      return true;
    });

    _messages[conversationId] = _sortMessages([...server, ...pending]);
    _hasMore[conversationId] = hasMore;
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
    } catch (_) {
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
    } catch (_) {
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
    notifyListeners();
  }

  /// 删除：仅自己不可见
  Future<void> deleteForMe(Message message) async {
    await _api.hideMessage(message.id);
    final list = messagesOf(message.conversationId);
    _messages[message.conversationId] =
        list.where((m) => m.id != message.id).toList(growable: false);
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
    _touchConversation(conversationId, incoming, incomingSelf: incoming.senderId == myId);
    notifyListeners();
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
    notifyListeners();
  }

  void _onMessageDeleted(Map<String, dynamic> msg) {
    final conversationId = msg['conversationId'];
    final messageId = msg['messageId'];
    if (conversationId is! String || messageId is! String) return;
    final list = messagesOf(conversationId).where((m) => m.id != messageId).toList(growable: false);
    _messages[conversationId] = list;
    notifyListeners();
  }

  void _onReadUpdated(Map<String, dynamic> msg) {
    final conversationId = msg['conversationId'];
    final userId = msg['userId'];
    final seq = msg['seq'];
    if (conversationId is! String || userId is! String) return;
    final map = Map<String, int>.from(_reads[conversationId] ?? const {});
    final value = seq is int ? seq : (seq is num ? seq.toInt() : null);
    if (value == null) return;
    if ((map[userId] ?? 0) >= value) return;
    map[userId] = value;
    _reads[conversationId] = map;
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
      );
    }).toList(growable: false);

    conversations = _sortConversations(updated);
    if (!found) {
      // 新会话：拉一次列表把标题/头像补全
      unawaited(loadConversations(silent: true));
    }
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
    notifyListeners();
  }

  /// 供媒体选择器判断支持的能力（桌面端 picker 行为不同）
  static bool get isMobile => Platform.isAndroid || Platform.isIOS;
}
