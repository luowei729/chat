import 'dart:async';

import 'package:dio/dio.dart';

import '../core/api.dart';
import '../core/config.dart';
import '../core/models.dart';
import 'local_cache.dart';

/// ============================================================
/// 媒体文件解析器（本地优先）
/// ------------------------------------------------------------
/// 目标：**同一个图片/视频/语音只下载一次**。
///
/// 为什么不直接用 `cached_network_image`：
/// 它依赖 `flutter_cache_manager` → `sqflite`，而 sqflite 没有鸿蒙适配。
/// 本项目要覆盖 Android/iOS/Windows/macOS/鸿蒙，所以自己用
/// `dart:io` + dio 做一层，零额外原生依赖。
///
/// 工作方式：
///   1. 附件 id 就是缓存 key（服务端内容寻址，稳定）；
///   2. 有本地文件 → 直接返回路径，完全不发网络请求；
///   3. 没有 → 下载一次写入缓存，后续复用；
///   4. 同一附件并发请求合并成一个 Future（避免列表滚动时重复下载）。
///
/// 失败语义：返回 null 表示「拿不到本地文件」，调用方应回退到网络 URL。
/// ============================================================
class MediaResolver {
  MediaResolver._();

  static final MediaResolver instance = MediaResolver._();

  /// 同一附件的并发下载合并
  final Map<String, Future<String?>> _inflight = {};

  /// 超过这个大小不缓存（避免一次点开 500MB 视频把磁盘塞满）
  static const int maxCacheBytes = 80 * 1024 * 1024;

  /// 解析成可直接使用的本地路径（拿不到返回 null）
  ///
  /// [attachment] 必须带 id 与 filename（扩展名用于本地文件后缀）。
  Future<String?> resolveLocal(Attachment attachment) {
    final key = attachment.id;
    if (key.isEmpty) return Future<String?>.value(null);

    final existing = _inflight[key];
    if (existing != null) return existing;

    final future = _doResolve(attachment);
    _inflight[key] = future;
    // 无论成功失败都要清掉，否则失败会永久缓存成 null
    future.whenComplete(() => _inflight.remove(key));
    return future;
  }

  Future<String?> _doResolve(Attachment attachment) async {
    try {
      // 1. 命中缓存直接返回
      final cached = await LocalCache.instance.mediaPath(attachment.id, attachment.filename);
      if (cached != null) return cached;

      // 2. 已过期/无地址的附件不下载
      if (attachment.expired) return null;
      final url = AppConfig.mediaUrl(attachment.url);
      if (url.isEmpty) return null;

      // 3. 体积过大不缓存（仍可由调用方直接用网络 URL 播放）
      if (attachment.size > maxCacheBytes) return null;

      // 4. 下载一次并落盘
      return await LocalCache.instance.cacheMedia(
        attachmentId: attachment.id,
        filename: attachment.filename,
        fetch: () async {
          final resp = await ApiClient.instance.dio.get<List<int>>(
            url,
            options: Options(
              responseType: ResponseType.bytes,
              // 媒体走签名 URL，不需要 Authorization，也不该被 401 逻辑干扰
              validateStatus: (code) => code != null && code >= 200 && code < 300,
            ),
          );
          return resp.data;
        },
      );
    } catch (_) {
      return null;
    }
  }

  /// 预热：列表/聊天页可提前把可视范围的图片拉下来
  ///
  /// 不 await，失败无副作用（下一帧还会再试）。
  void prefetch(Iterable<Attachment> attachments) {
    for (final att in attachments) {
      if (att.expired || att.url.isEmpty) continue;
      if (att.size > maxCacheBytes) continue;
      unawaited(resolveLocal(att));
    }
  }

  /// 清空并发标记（退出登录时调用）
  void reset() => _inflight.clear();
}
