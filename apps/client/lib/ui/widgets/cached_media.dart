import 'dart:io';

import 'package:flutter/material.dart';

import '../../core/config.dart';
import '../../core/models.dart';
import '../theme.dart';
import '../../services/media_resolver.dart';

/// ============================================================
/// 带本地缓存的附件图片
/// ------------------------------------------------------------
/// 行为：
///   1. 本地刚发/刚选的（localFilePath）→ 直接 Image.file，零延迟；
///   2. 缓存里有 → Image.file；
///   3. 都没有 → 后台下载一次写入缓存（之后所有入口复用）；
///   4. 下载失败/已过期 → 网络直连兜底，再失败显示占位。
///
/// 为什么做成 StatefulWidget：FutureBuilder 每次 rebuild 都会重建
/// Future，滚动列表时会反复闪「加载中」。这里只解析一次。
/// ============================================================
class CachedAttachmentImage extends StatefulWidget {
  const CachedAttachmentImage({
    super.key,
    required this.attachment,
    required this.width,
    required this.height,
    this.localFilePath,
    this.fit = BoxFit.cover,
  });

  final Attachment attachment;
  final double width;
  final double height;

  /// 本机临时文件（刚拍照/刚选图，还没上传完时用它即时预览）
  final String? localFilePath;

  final BoxFit fit;

  @override
  State<CachedAttachmentImage> createState() => _CachedAttachmentImageState();
}

class _CachedAttachmentImageState extends State<CachedAttachmentImage> {
  String? _localPath;
  bool _resolving = true;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _resolve();
  }

  @override
  void didUpdateWidget(CachedAttachmentImage oldWidget) {
    super.didUpdateWidget(oldWidget);
    // 附件换了（比如消息被替换为服务端版本）要重新解析
    if (oldWidget.attachment.id != widget.attachment.id ||
        oldWidget.localFilePath != widget.localFilePath) {
      _localPath = null;
      _failed = false;
      _resolving = true;
      _resolve();
    }
  }

  Future<void> _resolve() async {
    final immediate = widget.localFilePath;
    if (immediate != null && File(immediate).existsSync()) {
      if (mounted) {
        setState(() {
          _localPath = immediate;
          _resolving = false;
        });
      }
      return;
    }

    if (widget.attachment.expired) {
      if (mounted) {
        setState(() {
          _resolving = false;
          _failed = true;
        });
      }
      return;
    }

    final path = await MediaResolver.instance.resolveLocal(widget.attachment);
    if (!mounted) return;
    setState(() {
      _localPath = path;
      _resolving = false;
      _failed = path == null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = AppColors.of(context);

    final local = _localPath;
    if (local != null) {
      return Image.file(
        File(local),
        width: widget.width,
        height: widget.height,
        fit: widget.fit,
        errorBuilder: (_, __, ___) => _placeholder(c),
      );
    }

    if (_resolving) {
      return _loadingBox(c);
    }

    // 缓存拿不到 → 网络兜底（可能是刚好磁盘满或下载失败）
    final remote = AppConfig.mediaUrl(widget.attachment.url);
    if (_failed && remote.isNotEmpty && !widget.attachment.expired) {
      return Image.network(
        remote,
        width: widget.width,
        height: widget.height,
        fit: widget.fit,
        loadingBuilder: (_, child, progress) => progress == null ? child : _loadingBox(c),
        errorBuilder: (_, __, ___) => _placeholder(c),
      );
    }

    return _placeholder(c);
  }

  Widget _loadingBox(AppColors c) {
    return SizedBox(
      width: widget.width,
      height: widget.height,
      child: Center(
        child: SizedBox(
          width: 20,
          height: 20,
          child: CircularProgressIndicator(strokeWidth: 2, color: c.textMuted),
        ),
      ),
    );
  }

  Widget _placeholder(AppColors c) {
    return Container(
      width: widget.width,
      height: widget.height,
      color: c.surfaceAlt,
      alignment: Alignment.center,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.broken_image_outlined, size: 26, color: c.textFaint),
          const SizedBox(height: 6),
          Text(
            widget.attachment.expired ? '图片已过期' : '加载失败',
            style: TextStyle(fontSize: 12, color: c.textMuted),
          ),
        ],
      ),
    );
  }
}
