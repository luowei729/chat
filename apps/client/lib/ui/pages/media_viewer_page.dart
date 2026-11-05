import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:media_kit/media_kit.dart';
import 'package:media_kit_video/media_kit_video.dart';

import '../../core/config.dart';
import '../../core/models.dart';
import '../../services/media_resolver.dart';
import '../widgets/common.dart';

/// 图片 / 视频全屏查看器
///
/// 【为什么用 media_kit 而不是 video_player】
/// video_player 官方只实现 Android / iOS / macOS / Web，
/// **没有 Windows**。在 Windows 上 VideoPlayerController.initialize()
/// 会一直抛异常或永远不 ready，用户看到的就是「点了视频没反应」。
/// media_kit 基于 libmpv，一套代码覆盖全部桌面与移动端。
///
/// 两级来源，优先本地：
///   1. 刚发出去的本机文件（localFilePath）→ 立即播放；
///   2. 缓存里有 → 用本地文件，不再走网络；
///   3. 都没有 → 网络 URL 边下边播，同时后台落盘。
class MediaViewerPage extends StatefulWidget {
  const MediaViewerPage({
    super.key,
    required this.attachment,
    this.localFilePath,
  });

  final Attachment attachment;

  /// 本机临时文件（刚拍照/刚选文件）
  final String? localFilePath;

  @override
  State<MediaViewerPage> createState() => _MediaViewerPageState();
}

class _MediaViewerPageState extends State<MediaViewerPage> {
  String? _localPath;
  bool _resolving = true;

  bool _imageFailed = false;

  /// 视频播放器（只有视频才创建，避免音频文件也拉起 mpv 视频管线）
  Player? _player;
  VideoController? _videoController;

  StreamSubscription<bool>? _playingSub;
  StreamSubscription<Duration>? _positionSub;
  StreamSubscription<Duration>? _durationSub;
  StreamSubscription<String>? _errorSub;

  bool _playing = false;
  Duration _position = Duration.zero;
  Duration _duration = Duration.zero;
  String? _playbackError;

  bool get _isVideo => widget.attachment.kind == 'video';

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    // 1. 优先本机临时文件
    final immediate = widget.localFilePath;
    if (immediate != null && File(immediate).existsSync()) {
      _localPath = immediate;
    } else {
      _localPath = await MediaResolver.instance.resolveLocal(widget.attachment);
    }

    if (!mounted) return;
    setState(() => _resolving = false);

    if (_isVideo) {
      await _initVideo();
    }
  }

  Future<void> _initVideo() async {
    final local = _localPath;
    final remote = AppConfig.mediaUrl(widget.attachment.url);

    // 本地优先；本地没有就网络；两者都没有直接判失败
    String? source;
    if (local != null) {
      source = local;
    } else if (remote.isNotEmpty && !widget.attachment.expired) {
      source = remote;
    }
    if (source == null) {
      if (mounted) setState(() => _playbackError = '视频已过期或无法加载');
      return;
    }

    try {
      final player = Player();
      final controller = VideoController(player);
      _player = player;
      _videoController = controller;

      _playingSub = player.stream.playing.listen((v) {
        if (mounted) setState(() => _playing = v);
      });
      _positionSub = player.stream.position.listen((v) {
        if (mounted) setState(() => _position = v);
      });
      _durationSub = player.stream.duration.listen((v) {
        if (mounted && v > Duration.zero) setState(() => _duration = v);
      });
      _errorSub = player.stream.error.listen((v) {
        if (mounted) setState(() => _playbackError = '视频播放失败：$v');
      });

      await player.open(Media(source));
    } catch (e) {
      if (mounted) setState(() => _playbackError = '视频播放失败：$e');
    }
  }

  @override
  void dispose() {
    _playingSub?.cancel();
    _positionSub?.cancel();
    _durationSub?.cancel();
    _errorSub?.cancel();
    _player?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black.withValues(alpha: 0.6),
        foregroundColor: Colors.white,
        title: Text(
          widget.attachment.filename,
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
        child: _resolving
            ? const _LoadingView()
            : _isVideo
                ? _buildVideo()
                : _buildImage(),
      ),
    );
  }

  Widget _buildImage() {
    final local = _localPath;

    if (local != null) {
      return InteractiveViewer(
        minScale: 1,
        maxScale: 5,
        child: Image.file(
          File(local),
          fit: BoxFit.contain,
          errorBuilder: (_, __, ___) => const _FailedView(text: '图片已损坏'),
        ),
      );
    }

    if (_imageFailed) {
      return const _FailedView(text: '图片已过期或无法加载');
    }

    final remote = AppConfig.mediaUrl(widget.attachment.url);
    if (remote.isEmpty || widget.attachment.expired) {
      return const _FailedView(text: '图片已过期或无法加载');
    }

    return Stack(
      alignment: Alignment.center,
      children: [
        InteractiveViewer(
          minScale: 1,
          maxScale: 5,
          child: Image.network(
            remote,
            fit: BoxFit.contain,
            loadingBuilder: (_, child, progress) =>
                progress == null ? child : const SizedBox.shrink(),
            errorBuilder: (_, __, ___) {
              WidgetsBinding.instance.addPostFrameCallback((_) {
                if (mounted && !_imageFailed) setState(() => _imageFailed = true);
              });
              return const SizedBox.shrink();
            },
          ),
        ),
        const _LoadingView(),
      ],
    );
  }

  Widget _buildVideo() {
    if (_playbackError != null) {
      return _FailedView(text: _playbackError!);
    }

    final controller = _videoController;
    if (controller == null) {
      return const _LoadingView();
    }

    final total = _duration.inMilliseconds == 0 ? 1 : _duration.inMilliseconds;
    final current = _position.inMilliseconds.clamp(0, total).toDouble();

    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        Expanded(
          child: Stack(
            alignment: Alignment.center,
            children: [
              Video(
                controller: controller,
                // 控制条自己实现（全局统一样式，不依赖 media_kit 的本地化）
                controls: NoVideoControls,
              ),
              GestureDetector(
                onTap: () {
                  final player = _player;
                  if (player == null) return;
                  if (_playing) {
                    player.pause();
                  } else {
                    player.play();
                  }
                },
                behavior: HitTestBehavior.opaque,
                child: _playing
                    ? const SizedBox.expand()
                    : const Center(
                        child: Icon(
                          Icons.play_circle_fill,
                          size: 64,
                          color: Colors.white70,
                        ),
                      ),
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          child: Row(
            children: [
              Text(
                formatDuration(_position.inSeconds),
                style: const TextStyle(color: Colors.white70, fontSize: 12),
              ),
              Expanded(
                child: Slider(
                  value: current,
                  max: total.toDouble(),
                  activeColor: Colors.white,
                  inactiveColor: Colors.white24,
                  onChanged: (v) => _player?.seek(Duration(milliseconds: v.round())),
                ),
              ),
              Text(
                formatDuration(_duration.inSeconds),
                style: const TextStyle(color: Colors.white70, fontSize: 12),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _LoadingView extends StatelessWidget {
  const _LoadingView();

  @override
  Widget build(BuildContext context) {
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
}

class _FailedView extends StatelessWidget {
  const _FailedView({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.broken_image_outlined, size: 40, color: Colors.white38),
          const SizedBox(height: 12),
          Text(
            text,
            textAlign: TextAlign.center,
            style: const TextStyle(color: Colors.white54, fontSize: 13),
          ),
        ],
      ),
    );
  }
}
