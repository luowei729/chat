import 'dart:io';

import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';

/// 图片 / 视频全屏查看器
///
/// 关键点：**任何时候都要有加载反馈**，否则用户以为点坏了。
class MediaViewerPage extends StatefulWidget {
  const MediaViewerPage({
    super.key,
    required this.title,
    this.imageUrl,
    this.videoUrl,
    this.localPath,
  });

  final String title;
  final String? imageUrl;
  final String? videoUrl;
  final String? localPath;

  @override
  State<MediaViewerPage> createState() => _MediaViewerPageState();
}

class _MediaViewerPageState extends State<MediaViewerPage> {
  VideoPlayerController? _video;
  bool _videoReady = false;
  bool _videoFailed = false;
  bool _imageLoading = true;
  bool _imageFailed = false;

  @override
  void initState() {
    super.initState();
    if (widget.videoUrl != null && widget.videoUrl!.isNotEmpty) {
      _initVideo(widget.videoUrl!);
    }
  }

  Future<void> _initVideo(String url) async {
    final controller = VideoPlayerController.networkUrl(Uri.parse(url));
    _video = controller;
    try {
      await controller.initialize();
      if (!mounted) return;
      setState(() => _videoReady = true);
      await controller.play();
      controller.addListener(_onVideoTick);
    } catch (_) {
      if (mounted) setState(() => _videoFailed = true);
    }
  }

  void _onVideoTick() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _video?.removeListener(_onVideoTick);
    _video?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final isVideo = widget.videoUrl != null && widget.videoUrl!.isNotEmpty;

    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black.withValues(alpha: 0.6),
        foregroundColor: Colors.white,
        title: Text(
          widget.title,
          style: const TextStyle(fontSize: 14, color: Colors.white),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        leading: IconButton(
          icon: const Icon(Icons.close),
          onPressed: () => Navigator.of(context).pop(),
        ),
      ),
      body: Center(
        child: isVideo ? _buildVideo() : _buildImage(),
      ),
    );
  }

  Widget _buildImage() {
    final localPath = widget.localPath;
    final hasLocal = localPath != null && File(localPath).existsSync();

    if (_imageFailed && !hasLocal) {
      return const _FailedView(text: '图片已过期或无法加载');
    }

    if (hasLocal) {
      return InteractiveViewer(
        minScale: 1,
        maxScale: 5,
        child: Image.file(File(localPath), fit: BoxFit.contain),
      );
    }

    return Stack(
      alignment: Alignment.center,
      children: [
        InteractiveViewer(
          minScale: 1,
          maxScale: 5,
          child: Image.network(
            widget.imageUrl ?? '',
            fit: BoxFit.contain,
            loadingBuilder: (_, child, progress) {
              if (progress == null) {
                // 解码完成
                WidgetsBinding.instance.addPostFrameCallback((_) {
                  if (mounted && _imageLoading) setState(() => _imageLoading = false);
                });
                return child;
              }
              return const SizedBox.shrink();
            },
            errorBuilder: (_, __, ___) {
              WidgetsBinding.instance.addPostFrameCallback((_) {
                if (mounted && !_imageFailed) setState(() => _imageFailed = true);
              });
              return const SizedBox.shrink();
            },
          ),
        ),
        if (_imageLoading)
          const Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              SizedBox(
                width: 28,
                height: 28,
                child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white70),
              ),
              SizedBox(height: 12),
              Text('加载中…', style: TextStyle(color: Colors.white70, fontSize: 13)),
            ],
          ),
      ],
    );
  }

  Widget _buildVideo() {
    if (_videoFailed) {
      return const _FailedView(text: '视频加载失败或已过期');
    }

    final video = _video;
    if (!_videoReady || video == null) {
      return const Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(
            width: 28,
            height: 28,
            child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white70),
          ),
          SizedBox(height: 12),
          Text('加载中…', style: TextStyle(color: Colors.white70, fontSize: 13)),
        ],
      );
    }

    final value = video.value;
    final position = value.position;
    final duration = value.duration;

    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        AspectRatio(
          aspectRatio: value.aspectRatio == 0 ? 16 / 9 : value.aspectRatio,
          child: Stack(
            alignment: Alignment.center,
            children: [
              VideoPlayer(video),
              GestureDetector(
                onTap: () {
                  setState(() {
                    if (value.isPlaying) {
                      video.pause();
                    } else {
                      video.play();
                    }
                  });
                },
                child: value.isPlaying
                    ? const SizedBox.shrink()
                    : const Icon(Icons.play_circle_fill, size: 64, color: Colors.white70),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Row(
            children: [
              Text(
                _fmt(position),
                style: const TextStyle(color: Colors.white70, fontSize: 12),
              ),
              Expanded(
                child: Slider(
                  value: duration.inMilliseconds == 0
                      ? 0
                      : position.inMilliseconds.clamp(0, duration.inMilliseconds).toDouble(),
                  max: duration.inMilliseconds == 0
                      ? 1
                      : duration.inMilliseconds.toDouble(),
                  activeColor: Colors.white,
                  inactiveColor: Colors.white24,
                  onChanged: (v) => video.seekTo(Duration(milliseconds: v.round())),
                ),
              ),
              Text(
                _fmt(duration),
                style: const TextStyle(color: Colors.white70, fontSize: 12),
              ),
            ],
          ),
        ),
      ],
    );
  }

  static String _fmt(Duration d) {
    final m = d.inMinutes;
    final s = d.inSeconds % 60;
    return '$m:${s.toString().padLeft(2, '0')}';
  }
}

class _FailedView extends StatelessWidget {
  const _FailedView({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const Icon(Icons.broken_image_outlined, size: 40, color: Colors.white38),
        const SizedBox(height: 12),
        Text(text, style: const TextStyle(color: Colors.white54, fontSize: 13)),
      ],
    );
  }
}
