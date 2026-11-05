import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

import '../core/models.dart';

/// ============================================================
/// 本地缓存（会话列表 + 消息 + 媒体文件）
/// ------------------------------------------------------------
/// 【为什么用 JSON 文件而不是 SQLite】
/// 1. `sqflite` 没有鸿蒙适配，而 `dart:io` 的文件操作所有平台都有，
///    包括 HarmonyOS 的 Flutter SIG 分支——这是唯一能一套代码覆盖
///    Android/iOS/Windows/macOS/鸿蒙的方案；
/// 2. 聊天场景的数据量很小：每人每会话通常几十到几百条，
///    一个 JSON 文件读写在毫秒级，没必要上数据库；
/// 3. 内存/复杂度都更低，也不需要处理 schema 迁移。
///
/// 目录结构：
///   `appSupport/cache/conversations.json`      会话列表
///   `appSupport/cache/messages/{convId}.json`  每个会话的消息（最多 200 条）
///   `appSupport/cache/media/{attId}.{ext}`     已下载的媒体文件
///
/// 设计原则：**缓存永远是「尽力而为」**。
/// 读写失败只记日志，绝不向上抛异常——否则磁盘满/权限异常会把聊天页打挂。
/// ============================================================
class LocalCache {
  LocalCache._();

  static final LocalCache instance = LocalCache._();

  Directory? _root;
  bool _ready = false;

  /// 每个会话最多保留多少条消息（older 的靠上拉重新拉取）
  static const int maxMessagesPerConversation = 200;

  Future<void> init() async {
    if (_ready) return;
    try {
      final support = await getApplicationSupportDirectory();
      _root = Directory('${support.path}/cache');
      await _root!.create(recursive: true);
      await Directory('${_root!.path}/messages').create(recursive: true);
      await Directory('${_root!.path}/media').create(recursive: true);
      _ready = true;
    } catch (_) {
      // 拿不到目录就当没有缓存，功能仍可用
      _ready = false;
    }
  }

  bool get isReady => _ready;

  File get _convFile => File('${_root!.path}/conversations.json');

  File _messageFile(String conversationId) =>
      File('${_root!.path}/messages/$conversationId.json');

  /* ------------------------------------------------------------------ */
  /* 会话列表                                                            */
  /* ------------------------------------------------------------------ */

  Future<void> saveConversations(List<ConversationSummary> list) async {
    if (!_ready) return;
    try {
      final data = list.map((c) => c.toJson()).toList(growable: false);
      await _writeAtomically(_convFile, jsonEncode(data));
    } catch (_) {
      // 忽略
    }
  }

  Future<List<ConversationSummary>> loadConversations() async {
    if (!_ready) return const [];
    try {
      final file = _convFile;
      if (!await file.exists()) return const [];
      final raw = await file.readAsString();
      if (raw.isEmpty) return const [];
      final decoded = jsonDecode(raw);
      if (decoded is! List) return const [];
      return decoded
          .whereType<Map>()
          .map((e) => ConversationSummary.fromJson(Map<String, dynamic>.from(e)))
          .toList(growable: false);
    } catch (_) {
      return const [];
    }
  }

  /* ------------------------------------------------------------------ */
  /* 消息                                                                */
  /* ------------------------------------------------------------------ */

  /// 全量写入某会话的消息（只保留最近 N 条）
  Future<void> saveMessages(String conversationId, List<Message> messages) async {
    if (!_ready) return;
    try {
      // 只缓存服务端已确认的消息；本地「发送中」的占位没有稳定 id，不落盘
      final persistable = messages
          .where((m) => m.seq > 0 && m.localStatus != LocalStatus.sending)
          .toList(growable: false);

      final trimmed = persistable.length > maxMessagesPerConversation
          ? persistable.sublist(persistable.length - maxMessagesPerConversation)
          : persistable;

      final data = trimmed.map((m) => m.toJson()).toList(growable: false);
      await _writeAtomically(_messageFile(conversationId), jsonEncode(data));
    } catch (_) {
      // 忽略
    }
  }

  Future<List<Message>> loadMessages(String conversationId) async {
    if (!_ready) return const [];
    try {
      final file = _messageFile(conversationId);
      if (!await file.exists()) return const [];
      final raw = await file.readAsString();
      if (raw.isEmpty) return const [];
      final decoded = jsonDecode(raw);
      if (decoded is! List) return const [];
      final list = decoded
          .whereType<Map>()
          .map((e) => Message.fromJson(Map<String, dynamic>.from(e)))
          .toList();
      // 缓存里的消息一律视为已发送（未完成的本来就不落盘）
      for (final m in list) {
        m.localStatus = LocalStatus.sent;
      }
      list.sort((a, b) => a.seq.compareTo(b.seq));
      return list;
    } catch (_) {
      return const [];
    }
  }

  /// 单条写入/更新（收到 WS 推送时用，避免整会话重写）
  Future<void> upsertMessage(Message message) async {
    if (!_ready || message.seq <= 0) return;
    try {
      final list = await loadMessages(message.conversationId);
      final idx = list.indexWhere((m) => m.id == message.id);
      if (idx >= 0) {
        list[idx] = message;
      } else {
        list.add(message);
      }
      await saveMessages(message.conversationId, list);
    } catch (_) {
      // 忽略
    }
  }

  Future<void> removeMessage(String conversationId, String messageId) async {
    if (!_ready) return;
    try {
      final list = await loadMessages(conversationId);
      await saveMessages(
        conversationId,
        list.where((m) => m.id != messageId).toList(growable: false),
      );
    } catch (_) {
      // 忽略
    }
  }

  /* ------------------------------------------------------------------ */
  /* 媒体文件                                                            */
  /* ------------------------------------------------------------------ */

  /// 已下载的媒体文件路径；不存在返回 null
  ///
  /// 用附件 id 做文件名：服务端的内容寻址 id 稳定，
  /// 而 URL 带签名会过期变化，不能拿 URL 当 key。
  Future<String?> mediaPath(String attachmentId, String filename) async {
    if (!_ready) return null;
    try {
      final ext = _extensionOf(filename);
      final file = File('${_root!.path}/media/$attachmentId$ext');
      return await file.exists() ? file.path : null;
    } catch (_) {
      return null;
    }
  }

  /// 下载媒体到本地缓存（已存在直接返回）
  ///
  /// 说明：用 dio 之外的简单 HTTP 会丢进度，这里只负责「缓存」，
  /// 进度展示由上层的上传/下载流程负责。
  Future<String?> cacheMedia({
    required String attachmentId,
    required String filename,
    required Future<List<int>?> Function() fetch,
  }) async {
    if (!_ready) return null;
    try {
      final existing = await mediaPath(attachmentId, filename);
      if (existing != null) return existing;

      final bytes = await fetch();
      if (bytes == null || bytes.isEmpty) return null;

      final ext = _extensionOf(filename);
      final file = File('${_root!.path}/media/$attachmentId$ext');
      await file.writeAsBytes(bytes, flush: true);
      return file.path;
    } catch (_) {
      return null;
    }
  }

  static String _extensionOf(String filename) {
    final dot = filename.lastIndexOf('.');
    if (dot < 0 || dot == filename.length - 1) return '';
    final ext = filename.substring(dot).toLowerCase();
    // 限制长度，避免诡异文件名把路径撑爆
    return ext.length <= 8 ? ext : '';
  }

  /* ------------------------------------------------------------------ */
  /* 清理                                                                */
  /* ------------------------------------------------------------------ */

  /// 退出登录时清理（缓存里含聊天内容，不能留给下一个账号）
  Future<void> clearAll() async {
    if (!_ready) return;
    try {
      if (await _root!.exists()) {
        await _root!.delete(recursive: true);
      }
    } catch (_) {
      // 忽略
    }
    _ready = false;
    await init();
  }

  /// 缓存占用（设置页展示用）
  Future<int> sizeBytes() async {
    if (!_ready) return 0;
    var total = 0;
    try {
      await for (final entity in _root!.list(recursive: true)) {
        if (entity is File) total += await entity.length();
      }
    } catch (_) {
      // 忽略
    }
    return total;
  }

  /* ------------------------------------------------------------------ */
  /* 工具                                                                */
  /* ------------------------------------------------------------------ */

  /// 原子写：先写 .tmp 再 rename
  ///
  /// 直接 writeAsString 在写入过程中被杀进程会留下半个 JSON，
  /// 下次启动就解析失败、缓存全丢。rename 在同一文件系统内是原子的。
  Future<void> _writeAtomically(File target, String content) async {
    final tmp = File('${target.path}.tmp');
    await tmp.writeAsString(content, flush: true);
    await tmp.rename(target.path);
  }
}
