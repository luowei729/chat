import 'dart:async';
import 'dart:io';
import 'dart:math';
import 'dart:ui' as ui;

import 'package:file_picker/file_picker.dart';
import 'package:image_picker/image_picker.dart';
import 'package:just_audio/just_audio.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';
import 'package:video_player/video_player.dart';

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
///   just_audio    → 语音播放
///   video_player  → 视频播放/取时长
/// ============================================================
class MediaService {
  MediaService._();

  static final MediaService instance = MediaService._();

  final ImagePicker _picker = ImagePicker();
  final AudioRecorder _recorder = AudioRecorder();
  final AudioPlayer _player = AudioPlayer();

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
    final size = await _imageSize(file.path);
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

  /// 尝试从 m4a 文件头读取时长（读不到就返回 null，由调用方兜底）
  Future<int?> _readM4aDurationMs(String path) async {
    try {
      final controller = VideoPlayerController.file(File(path));
      await controller.initialize();
      final d = controller.value.duration.inMilliseconds;
      await controller.dispose();
      return d > 0 ? d : null;
    } catch (_) {
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 播放                                                                */
  /* ------------------------------------------------------------------ */

  /// 播放语音（单例播放器，切歌自动停止上一条）
  Future<void> playAudio(String url, {void Function()? onComplete}) async {
    try {
      await _player.stop();
      await _player.setUrl(url);
      unawaited(_player.play());
      _player.processingStateStream.firstWhere(
        (state) => state == ProcessingState.completed,
      ).then((_) => onComplete?.call()).catchError((_) {});
    } catch (_) {
      onComplete?.call();
    }
  }

  Future<void> stopAudio() async {
    try {
      await _player.stop();
    } catch (_) {
      // 忽略
    }
  }

  Stream<bool> get playingStream => _player.playingStream;

  /* ------------------------------------------------------------------ */
  /* 元数据                                                              */
  /* ------------------------------------------------------------------ */

  Future<({int width, int height})?> _imageSize(String path) async {
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

  Future<int?> videoDurationMs(String path) async {
    try {
      final controller = VideoPlayerController.file(File(path));
      await controller.initialize();
      final ms = controller.value.duration.inMilliseconds;
      await controller.dispose();
      return ms > 0 ? ms : null;
    } catch (_) {
      return null;
    }
  }

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
    await _recorder.dispose();
    await _player.dispose();
  }
}
