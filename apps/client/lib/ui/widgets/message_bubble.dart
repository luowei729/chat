import 'dart:io';

import 'package:flutter/material.dart';

import '../../core/config.dart';
import '../../core/models.dart';
import '../theme.dart';
import 'common.dart';

/// 消息气泡
///
/// 长度与对齐全部由 Flutter 原生布局处理（不再有 Lynx 的命中测试问题）。
class MessageBubble extends StatelessWidget {
  const MessageBubble({
    super.key,
    required this.message,
    required this.isSelf,
    required this.peerReadSeq,
    required this.showSender,
    required this.showAvatar,
    this.onLongPress,
    this.onTap,
    this.onRetry,
    this.onMediaTap,
    this.onAudioTap,
    this.playing = false,
  });

  final Message message;
  final bool isSelf;
  final int peerReadSeq;
  final bool showSender;
  final bool showAvatar;
  final VoidCallback? onLongPress;
  final VoidCallback? onTap;
  final VoidCallback? onRetry;
  final VoidCallback? onMediaTap;
  final VoidCallback? onAudioTap;
  final bool playing;

  /// 已读 = 对方已读水位覆盖到这条
  bool get _read => peerReadSeq >= message.seq && message.seq > 0;

  @override
  Widget build(BuildContext context) {
    final c = AppColors.of(context);

    if (message.type == 'system' || message.deleted) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.md),
        child: Center(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            decoration: BoxDecoration(
              color: c.surfaceAlt,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Text(
              message.text ?? '消息已撤回',
              style: TextStyle(fontSize: 12, color: c.textMuted),
            ),
          ),
        ),
      );
    }

    final maxWidth = MediaQuery.of(context).size.width * 0.72;

    return Padding(
      padding: EdgeInsets.only(
        left: AppSpacing.md,
        right: AppSpacing.md,
        top: showSender ? AppSpacing.md : 3,
        bottom: 3,
      ),
      child: Row(
        mainAxisAlignment: isSelf ? MainAxisAlignment.end : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (!isSelf) _avatarSlot(c, showAvatar),
          Flexible(
            child: Column(
              crossAxisAlignment: isSelf ? CrossAxisAlignment.end : CrossAxisAlignment.start,
              children: [
                if (showSender && !isSelf)
                  Padding(
                    padding: const EdgeInsets.only(left: 4, bottom: 3),
                    child: Text(
                      message.senderName,
                      style: TextStyle(fontSize: 12, color: c.textMuted),
                    ),
                  ),
                GestureDetector(
                  onLongPress: onLongPress,
                  onTap: onTap,
                  child: ConstrainedBox(
                    constraints: BoxConstraints(maxWidth: maxWidth),
                    child: Container(
                      decoration: BoxDecoration(
                        color: isSelf ? c.bubbleSelf : c.bubbleOther,
                        borderRadius: _bubbleRadius,
                      ),
                      clipBehavior: Clip.antiAlias,
                      child: _content(context, c),
                    ),
                  ),
                ),
                const SizedBox(height: 3),
                _footer(c),
              ],
            ),
          ),
          if (isSelf) _avatarSlot(c, showAvatar),
        ],
      ),
    );
  }

  BorderRadius get _bubbleRadius {
    const r = Radius.circular(AppRadius.bubble);
    const small = Radius.circular(4);
    return BorderRadius.only(
      topLeft: r,
      topRight: r,
      bottomLeft: isSelf ? r : small,
      bottomRight: isSelf ? small : r,
    );
  }

  Widget _avatarSlot(AppColors c, bool show) {
    return SizedBox(
      width: 40,
      child: show
          ? Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: Avatar(
                name: message.senderName,
                url: message.senderAvatarUrl,
                size: 32,
              ),
            )
          : const SizedBox.shrink(),
    );
  }

  Widget _content(BuildContext context, AppColors c) {
    switch (message.type) {
      case 'image':
        return _imageContent(context, c);
      case 'video':
        return _videoContent(context, c);
      case 'audio':
        return _audioContent(c);
      case 'file':
        return _fileContent(c);
      default:
        return Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          child: Text(
            message.text ?? '',
            style: TextStyle(
              fontSize: 16,
              height: 1.35,
              color: isSelf ? c.bubbleSelfText : c.bubbleOtherText,
            ),
          ),
        );
    }
  }

  Widget _imageContent(BuildContext context, AppColors c) {
    final att = message.firstAttachment;
    final localPath = message.localFilePath;
    final remote = att == null ? '' : AppConfig.mediaUrl(att.url);

    double width = 200;
    double height = 150;
    if (att?.width != null && att?.height != null && att!.width! > 0) {
      final ratio = att.height! / att.width!;
      height = width * ratio;
      if (height > 280) {
        height = 280;
        width = height / ratio;
      }
      if (height < 80) height = 80;
    }

    Widget image;
    if (localPath != null && File(localPath).existsSync()) {
      image = Image.file(File(localPath), width: width, height: height, fit: BoxFit.cover);
    } else if (att?.expired == true || remote.isEmpty) {
      image = _expiredBox(c, width, height);
    } else {
      image = Image.network(
        remote,
        width: width,
        height: height,
        fit: BoxFit.cover,
        loadingBuilder: (_, child, progress) => progress == null
            ? child
            : SizedBox(
                width: width,
                height: height,
                child: Center(
                  child: SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2, color: c.textMuted),
                  ),
                ),
              ),
        errorBuilder: (_, __, ___) => _expiredBox(c, width, height),
      );
    }

    return GestureDetector(
      onTap: onMediaTap,
      child: SizedBox(width: width, height: height, child: image),
    );
  }

  Widget _expiredBox(AppColors c, double width, double height) {
    return Container(
      width: width,
      height: height,
      color: c.surfaceAlt,
      alignment: Alignment.center,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.broken_image_outlined, size: 28, color: c.textFaint),
          const SizedBox(height: 6),
          Text('图片已过期', style: TextStyle(fontSize: 12, color: c.textMuted)),
        ],
      ),
    );
  }

  Widget _videoContent(BuildContext context, AppColors c) {
    const width = 220.0;
    const height = 150.0;
    final att = message.firstAttachment;
    final duration = att?.durationMs ?? 0;

    return GestureDetector(
      onTap: onMediaTap,
      child: Container(
        width: width,
        height: height,
        color: const Color(0xFF1C1C1E),
        child: Stack(
          children: [
            if (message.localFilePath != null)
              Positioned.fill(
                child: Image.file(
                  File(message.localFilePath!),
                  fit: BoxFit.cover,
                  errorBuilder: (_, __, ___) => const SizedBox.shrink(),
                ),
              ),
            Positioned.fill(
              child: Container(color: Colors.black.withValues(alpha: 0.25)),
            ),
            const Center(
              child: Icon(Icons.play_circle_fill, size: 46, color: Colors.white),
            ),
            if (duration > 0)
              Positioned(
                right: 8,
                bottom: 8,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: Colors.black.withValues(alpha: 0.55),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text(
                    _durationText(duration),
                    style: const TextStyle(color: Colors.white, fontSize: 11),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _audioContent(AppColors c) {
    final att = message.firstAttachment;
    final duration = att?.durationMs ?? 0;
    final waveform = att?.waveform;
    // 气泡宽度随时长增长（微信手感）
    final width = (100 + (duration / 1000) * 12).clamp(120.0, 220.0);

    return GestureDetector(
      onTap: onAudioTap,
      child: SizedBox(
        width: width,
        height: 44,
        child: Row(
          children: [
            const SizedBox(width: 10),
            Icon(
              playing ? Icons.pause : Icons.play_arrow,
              size: 20,
              color: isSelf ? c.bubbleSelfText : c.primary,
            ),
            const SizedBox(width: 6),
            Expanded(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: _bars(waveform, c),
              ),
            ),
            const SizedBox(width: 8),
            Text(
              '${(duration / 1000).round().clamp(1, 999)}″',
              style: TextStyle(
                fontSize: 12,
                color: isSelf ? c.bubbleSelfText.withValues(alpha: 0.85) : c.textMuted,
              ),
            ),
            const SizedBox(width: 10),
          ],
        ),
      ),
    );
  }

  List<Widget> _bars(List<int>? waveform, AppColors c) {
    final bars = waveform != null && waveform.isNotEmpty
        ? waveform
        // 没有波形时用确定性伪随机，保证同一条消息每次高度一致
        : List<int>.generate(28, (i) => 20 + ((i * 37) % 60));

    final count = bars.length > 40 ? 40 : bars.length;
    final step = bars.length / count;

    return List<Widget>.generate(count, (i) {
      final value = bars[(i * step).floor().clamp(0, bars.length - 1)];
      return Expanded(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 0.8),
          child: Container(
            height: (value.clamp(10, 100) as num) * 0.22 + 4,
            decoration: BoxDecoration(
              color: isSelf
                  ? c.bubbleSelfText.withValues(alpha: 0.9)
                  : c.primary.withValues(alpha: 0.7),
              borderRadius: BorderRadius.circular(2),
            ),
          ),
        ),
      );
    });
  }

  Widget _fileContent(AppColors c) {
    final att = message.firstAttachment;
    return SizedBox(
      width: 230,
      child: Padding(
        padding: const EdgeInsets.all(10),
        child: Row(
          children: [
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                color: (isSelf ? Colors.white : c.primary).withValues(alpha: 0.16),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Icon(
                Icons.insert_drive_file_outlined,
                size: 22,
                color: isSelf ? c.bubbleSelfText : c.primary,
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    att?.filename ?? '文件',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w500,
                      color: isSelf ? c.bubbleSelfText : c.bubbleOtherText,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    att == null ? '' : formatFileSize(att.size),
                    style: TextStyle(
                      fontSize: 11,
                      color: isSelf
                          ? c.bubbleSelfText.withValues(alpha: 0.8)
                          : c.textMuted,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _footer(AppColors c) {
    final sending = message.localStatus == LocalStatus.sending;
    final failed = message.localStatus == LocalStatus.failed;
    final progress = message.localProgress;

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (sending && progress != null)
          Padding(
            padding: const EdgeInsets.only(right: 4),
            child: SizedBox(
              width: 11,
              height: 11,
              child: CircularProgressIndicator(
                strokeWidth: 1.6,
                value: progress <= 0 ? null : progress,
                color: c.primary,
              ),
            ),
          ),
        if (sending && progress != null)
          Text(
            '${(progress * 100).round()}%',
            style: TextStyle(fontSize: 10, color: c.textMuted),
          ),
        if (failed)
          GestureDetector(
            onTap: onRetry,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.error, size: 13, color: c.danger),
                const SizedBox(width: 2),
                Text('重发', style: TextStyle(fontSize: 10, color: c.danger)),
              ],
            ),
          ),
        if (!sending && !failed && isSelf)
          Padding(
            padding: const EdgeInsets.only(right: 3),
            child: _read
                ? Icon(Icons.done_all, size: 13, color: c.primary)
                : Icon(Icons.done, size: 13, color: c.textFaint),
          ),
        Text(
          formatMessageTime(message.createdAt),
          style: TextStyle(fontSize: 10, color: c.textFaint),
        ),
      ],
    );
  }

  static String _durationText(int ms) {
    final total = (ms / 1000).round();
    final m = total ~/ 60;
    final s = total % 60;
    return '$m:${s.toString().padLeft(2, '0')}';
  }
}
