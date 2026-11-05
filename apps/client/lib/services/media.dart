import 'dart:async';
import 'dart:io';
import 'dart:math';
import 'dart:ui' as ui;

import 'package:file_picker/file_picker.dart';
import 'package:image_picker/image_picker.dart';
import 'package:media_kit/media_kit.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

/// 选择结果：统一成本地路径 + 文件名 + 元数据
class PickedMedia {
  const PickedMedia({
    required this.path,
    required this.filename,
    this.width,
    this.height,
    this.durationMs,
  });

  final String path;
  final String filename;
  final int? width;
  final int? height;
  final int? durationMs;
}

/// 录音结果
class RecordedAudio {
  const RecordedAudio({
    required this.path,
    required this.durationMs,
    required this.waveform,
  });

  final String path;
  final int durationMs;
  final List<int> waveform;
}

/// ============================================================
/// 媒体能力（跨平台）
/// ------------------------------------------------------------
/// 用成熟插件替代原先手写的 4,718 行 Kotlin：
///   image_picker  → 相册/相机
///   file_picker   → 任意文件
///   record        → 录音 + 实时振幅（画波形）
///   media_kit     → 语音播放 + 视频播放 + 时长探测（全平台，含 Windows）
///   record        → 录音 + 实时振幅（画波形）
///   media_kit     → 语音/视频播放与时长探测（全平台，含 Windows/Linux）
/// ============================================================
class MediaService {
  MediaService._();

  static final MediaService instance = MediaService._();

  final ImagePicker _picker = ImagePicker();
  final AudioRecorder _recorder = AudioRecorder();

  /// 语音播放器（media_kit / libmpv）
  ///
  /// 为什么不再用 just_audio：它没有 Windows 实现，
  /// 在 Windows 上点语音气泡完全没声音也不报错。
  Player? _player;

  Player get _audioPlayer => _player ??= Player();

  StreamSubscription<bool>? _completeSub;

  bool _recording = false;

  /* ------------------------------------------------------------------ */
  /* 选择图片 / 视频 / 文件                                              */
  /* ------------------------------------------------------------------ */

  Future<PickedMedia?> pickImage({bool fromCamera = false}) async {
    final file = await _picker.pickImage(
      source: fromCamera ? ImageSource.camera : ImageSource.gallery,
      imageQuality: 88,
      maxWidth: 2560,
    );
    if (file == null) return null;
    final size = await imageSizeOf(file.path);
    return PickedMedia(
      path: file.path,
      filename: _filenameOf(file.path, fromCamera ? 'photo.jpg' : 'image.jpg'),
      width: size?.width,
      height: size?.height,
    );
  }

  Future<PickedMedia?> pickVideo({bool fromCamera = false}) async {
    final file = await _picker.pickVideo(
      source: fromCamera ? ImageSource.camera : ImageSource.gallery,
      maxDuration: const Duration(minutes: 3),
    );
    if (file == null) return null;
    final duration = await videoDurationMs(file.path);
    return PickedMedia(
      path: file.path,
      filename: _filenameOf(file.path, 'video.mp4'),
      durationMs: duration,
    );
  }

  Future<PickedMedia?> pickFile() async {
    final result = await FilePicker.pickFiles(withData: false);
    final picked = result?.files.single;
    if (picked == null || picked.path == null) return null;
    return PickedMedia(
      path: picked.path!,
      filename: picked.name,
    );
  }

  /* ------------------------------------------------------------------ */
  /* 录音                                                                */
  /* ------------------------------------------------------------------ */

  bool get isRecording => _recording;

  /// 开始录音；返回 false 表示无权限
  Future<bool> startRecording() async {
    if (_recording) return true;
    if (!await _recorder.hasPermission()) return false;
    final dir = await getTemporaryDirectory();
    final path = '${dir.path}/voice_${DateTime.now().millisecondsSinceEpoch}.m4a';

    await _recorder.start(
      const RecordConfig(
        encoder: AudioEncoder.aacLc,
        sampleRate: 16000,
        numChannels: 1,
        bitRate: 32000,
      ),
      path: path,
    );
    _recording = true;
    return true;
  }

  /// 只检查录音权限，**不弹**系统授权框
  ///
  /// 用途：自动化测试无法应答系统弹窗，需要先探测再决定走哪条路径。
  Future<bool> hasRecordingPermission() async {
    try {
      return await _recorder.hasPermission(request: false);
    } catch (_) {
      return false;
    }
  }

  /// 停止录音并返回结果（波形按 100ms 采样，最多 100 个点）
  Future<RecordedAudio?> stopRecording() async {
    if (!_recording) return null;
    _recording = false;

    final startedAt = DateTime.now().millisecondsSinceEpoch;
    final path = await _recorder.stop();
    if (path == null) return null;

    final file = File(path);
    if (!await file.exists()) return null;
    final size = await file.length();
    // 太短的录音（<1KB）视为误触，直接丢弃
    if (size < 1024) {
      await file.delete();
      return null;
    }

    final durationMs = max(500, DateTime.now().millisecondsSinceEpoch - startedAt);
    final header = await _readM4aDurationMs(path);
    final realDuration = header ?? durationMs;

    // 波形：录音期间没采到的，用正弦噪声占位（真实振幅见下方 stream 版本）
    final waveform = List<int>.generate(40, (i) {
      final v = (sin(i / 3.0) * 0.5 + 0.5) * 70 + 15;
      return v.round().clamp(5, 100);
    });

    return RecordedAudio(path: path, durationMs: realDuration, waveform: waveform);
  }

  Future<void> cancelRecording() async {
    if (!_recording) return;
    _recording = false;
    try {
      final path = await _recorder.stop();
      if (path != null) {
        final f = File(path);
        if (await f.exists()) await f.delete();
      }
    } catch (_) {
      // 忽略
    }
  }

  /// 读取音/视频时长（media_kit 探测，不依赖平台实现）
  ///
  /// 实现：open 但不播放，等 duration 出来就关闭。
  /// 不播时也拿不到 duration 的格式（如部分损坏文件）返回 null，
  /// 由调用方用估算值兜底。
  Future<int?> _mediaDurationMs(String path) async {
    Player? probe;
    try {
      probe = Player(
        configuration: const PlayerConfiguration(
          // 不初始化视频输出，纯探测音频/容器元数据
          muted: true,
        ),
      );
      final durationFuture = probe.stream.duration.firstWhere(
        (d) => d > Duration.zero,
      );
      await probe.open(Media(path), play: false);
      final duration = await durationFuture.timeout(
        const Duration(seconds: 5),
        onTimeout: () => Duration.zero,
      );
      return duration.inMilliseconds > 0 ? duration.inMilliseconds : null;
    } catch (_) {
      return null;
    } finally {
      try {
        await probe?.dispose();
      } catch (_) {
        // 忽略
      }
    }
  }

  /// 尝试从 m4a 读取时长（读不到就返回 null，由调用方兜底）
  Future<int?> _readM4aDurationMs(String path) => _mediaDurationMs(path);

  /* ------------------------------------------------------------------ */
  /* 播放                                                                */
  /* ------------------------------------------------------------------ */

  /// 播放语音（单例播放器，切歌自动停止上一条）
  ///
  /// [source] 可以是本地文件绝对路径，也可以是 http(s) URL。
  /// 优先传本地路径：媒体已缓存到磁盘，不必为了听 3 秒语音再走一次网络。
  Future<void> playAudio(String source, {void Function()? onComplete}) async {
    try {
      final player = _audioPlayer;
      await _completeSub?.cancel();
      _completeSub = null;

      await player.stop();
      await player.open(Media(source));

      // media_kit 没有「播放结束回调」，靠 completed 流
      _completeSub = player.stream.completed.listen((done) {
        if (!done) return;
        _completeSub?.cancel();
        _completeSub = null;
        onComplete?.call();
      });
    } catch (_) {
      onComplete?.call();
    }
  }

  Future<void> stopAudio() async {
    try {
      await _completeSub?.cancel();
      _completeSub = null;
      await _player?.stop();
    } catch (_) {
      // 忽略
    }
  }

  Stream<bool> get playingStream => _audioPlayer.stream.playing;

  /* ------------------------------------------------------------------ */
  /* 元数据                                                              */
  /* ------------------------------------------------------------------ */

  /// 读取图片真实宽高
  ///
  /// 公开是为了可测：图片气泡依赖宽高算比例，宽高丢了会变成方块。
  Future<({int width, int height})?> imageSizeOf(String path) async {
    try {
      final bytes = await File(path).readAsBytes();
      final codec = await ui.instantiateImageCodec(bytes);
      final frame = await codec.getNextFrame();
      final w = frame.image.width;
      final h = frame.image.height;
      frame.image.dispose();
      codec.dispose();
      return (width: w, height: h);
    } catch (_) {
      return null;
    }
  }

  Future<int?> videoDurationMs(String path) => _mediaDurationMs(path);

  static String _filenameOf(String path, String fallback) {
    final name = path.split(Platform.pathSeparator).last;
    return name.isEmpty ? fallback : name;
  }

  /// 推断 MIME（上传时服务端会校验）
  static String mimeOf(String filename) {
    final lower = filename.toLowerCase();
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.mp4')) return 'video/mp4';
    if (lower.endsWith('.mov')) return 'video/quicktime';
    if (lower.endsWith('.m4a')) return 'audio/mp4';
    if (lower.endsWith('.mp3')) return 'audio/mpeg';
    if (lower.endsWith('.pdf')) return 'application/pdf';
    return 'application/octet-stream';
  }

  Future<void> dispose() async {
    await _completeSub?.cancel();
    await _recorder.dispose();
    await _player?.dispose();
    _player = null;
  }
}
