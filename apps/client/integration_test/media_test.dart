import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:chat/core/api.dart';
import 'package:chat/core/models.dart';
import 'package:chat/core/storage.dart';
import 'package:chat/services/chat_store.dart';
import 'package:chat/services/media.dart';
import 'package:chat/services/session.dart';

/// ============================================================
/// 媒体链路集成测试（真实设备 + 真实插件 + 真实网络）
/// ------------------------------------------------------------
/// 覆盖「本地文件 → 上传（含元数据）→ 发消息 → 服务端落库」。
///
/// 设计要点：**测试自包含**，不依赖 adb 推文件。
/// 原因：`flutter test integration_test` 跑完会卸载 App，
/// 预先塞进应用目录的文件会被一并删掉，测试就再也跑不起来。
/// 所以图片用 Canvas 现画成 PNG（宽高完全可控），
/// 视频/文件用合成字节（服务端不解码，只校验元数据透传）。
///
/// 运行：flutter test integration_test/media_test.dart -d emulator-5554
/// 前置：adb shell pm grant pub.lkz.chat android.permission.RECORD_AUDIO
/// ============================================================
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  late Directory tmpDir;
  late String conversationId;

  setUpAll(() async {
    await AppStorage.init();
    tmpDir = await Directory.systemTemp.createTemp('chat_media_test');

    if (!Session.instance.isAuthenticated) {
      await Session.instance.login(
        email: 'testa@videostack.top',
        password: 'Test12345',
      );
    }
    final list = await ApiClient.instance.listConversations();
    final direct = list.firstWhere(
      (c) => c.type == 'direct' && c.title.contains('TestB'),
      orElse: () => throw StateError('未找到与 TestB 的私聊会话'),
    );
    conversationId = direct.id;
    ChatStore.instance.attachWs();
  });

  tearDownAll(() async {
    try {
      await tmpDir.delete(recursive: true);
    } catch (_) {
      // 忽略
    }
  });

  testWidgets('图片：宽高提取 → 上传元数据 → 发送', (tester) async {
    // 1. 生成一张 1200x1600 的 PNG（宽高已知，可精确断言）
    const width = 1200;
    const height = 1600;
    final path = '${tmpDir.path}/test_image.png';
    await File(path).writeAsBytes(await _pngBytes(width, height));

    // 2. 宽高提取（图片气泡靠它算比例，丢了会变成方块）
    final size = await MediaService.instance.imageSizeOf(path);
    expect(size, isNotNull, reason: 'PNG 解码失败');
    expect(size!.width, width);
    expect(size.height, height);

    // 3. 上传 + 发送
    final beforeSeq = await _latestSeq(conversationId);
    await ChatStore.instance.sendMedia(
      conversationId: conversationId,
      type: 'image',
      filePath: path,
      filename: 'test_image.png',
      kind: 'image',
      width: size.width,
      height: size.height,
    );
    await _waitForSent(tester, conversationId);

    // 4. 服务端落库的元数据必须完整
    final sent = await _findSentMessage(conversationId, 'image', beforeSeq);
    final att = sent.attachments.first;
    expect(att.kind, 'image');
    expect(att.width, width, reason: '宽度元数据丢失（上传字段顺序错了？）');
    expect(att.height, height, reason: '高度元数据丢失');
    expect(att.url, isNotEmpty);
  });

  testWidgets('视频：时长元数据 → 上传 → 发送', (tester) async {
    // 视频字节合成即可：服务端不做视频解码，时长由客户端上报。
    // 这里传 3000ms 并断言服务端原样保存——这正是当初「时长恒 0:00」
    // 那个 bug 的回归测试（元数据字段必须排在 file 之前）。
    const durationMs = 3000;
    final path = '${tmpDir.path}/test_video.mp4';
    await File(path).writeAsBytes(_syntheticMp4());

    final beforeSeq = await _latestSeq(conversationId);
    await ChatStore.instance.sendMedia(
      conversationId: conversationId,
      type: 'video',
      filePath: path,
      filename: 'test_video.mp4',
      kind: 'video',
      durationMs: durationMs,
    );
    await _waitForSent(tester, conversationId);

    final sent = await _findSentMessage(conversationId, 'video', beforeSeq);
    final att = sent.attachments.first;
    expect(att.kind, 'video');
    expect(att.durationMs, isNotNull, reason: '视频时长丢失（气泡会显示 0:00）');
    expect(att.durationMs, durationMs);
  });

  testWidgets('文件：上传 → 发送', (tester) async {
    final content = 'flutter media test ${DateTime.now().toIso8601String()}';
    final path = '${tmpDir.path}/note.txt';
    await File(path).writeAsString(content);

    final beforeSeq = await _latestSeq(conversationId);
    await ChatStore.instance.sendMedia(
      conversationId: conversationId,
      type: 'file',
      filePath: path,
      filename: 'note.txt',
      kind: 'file',
    );
    await _waitForSent(tester, conversationId);

    final sent = await _findSentMessage(conversationId, 'file', beforeSeq);
    final att = sent.attachments.first;
    expect(att.filename, 'note.txt');
    expect(att.size, content.length);
  });

  testWidgets('语音：录音 → 波形 + 时长 → 发送', (tester) async {
    // 自动化测试没法应答系统授权弹窗，所以先探测权限（不弹框）：
    //   有权限 → 走真实录音，校验时长与波形是真实录出来的；
    //   没权限 → 用合成音频文件，仍校验「时长 + 波形」能透传到服务端。
    // 后者覆盖的正是当初「语音气泡没有波形 / 时长 0」的那个 bug。
    final hasPermission = await MediaService.instance.hasRecordingPermission();

    String audioPath;
    int durationMs;
    List<int> waveform;

    if (hasPermission) {
      final started = await MediaService.instance.startRecording();
      expect(started, isTrue, reason: '有权限但录音启动失败');
      await Future<void>.delayed(const Duration(milliseconds: 1500));
      final recorded = await MediaService.instance.stopRecording();
      expect(recorded, isNotNull, reason: '录音结果为空');
      audioPath = recorded!.path;
      durationMs = recorded.durationMs;
      waveform = recorded.waveform;
      expect(durationMs, greaterThan(0), reason: '录音时长应当大于 0');
      expect(waveform, isNotEmpty, reason: '录音应当产生波形');
    } else {
      // ignore: avoid_print
      print('⚠ 无录音权限（系统弹窗无法在测试中应答），改用合成音频验证上传链路');
      audioPath = '${tmpDir.path}/fake_voice.m4a';
      await File(audioPath).writeAsBytes(_syntheticM4a());
      durationMs = 2400;
      waveform = List<int>.generate(24, (i) => 20 + (i * 7) % 70);
    }

    final beforeSeq = await _latestSeq(conversationId);
    await ChatStore.instance.sendMedia(
      conversationId: conversationId,
      type: 'audio',
      filePath: audioPath,
      filename: 'voice.m4a',
      kind: 'audio',
      durationMs: durationMs,
      waveform: waveform,
    );
    await _waitForSent(tester, conversationId);

    final sent = await _findSentMessage(conversationId, 'audio', beforeSeq);
    final att = sent.attachments.first;
    expect(att.kind, 'audio');
    expect(att.durationMs, isNotNull, reason: '语音时长丢失');
    expect(att.durationMs, durationMs);
    expect(att.waveform, isNotNull, reason: '波形丢失（气泡会显示成一条直线）');
    expect(att.waveform, hasLength(waveform.length));
  });
}

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

/// 用 Canvas 画一张纯色 PNG——宽高完全可控，且不依赖任何外部文件
Future<Uint8List> _pngBytes(int width, int height) async {
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder);
  canvas.drawRect(
    Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
    Paint()..color = const Color(0xFF1E78DC),
  );
  // 画几条横线，避免全同色被编解码器过度优化
  final line = Paint()..color = const Color(0xFFFFFFFF);
  for (var y = 100.0; y < height; y += 200) {
    canvas.drawRect(Rect.fromLTWH(80, y, width - 160, 12), line);
  }
  final picture = recorder.endRecording();
  final image = await picture.toImage(width, height);
  final data = await image.toByteData(format: ui.ImageByteFormat.png);
  picture.dispose();
  image.dispose();
  return data!.buffer.asUint8List();
}

/// 合成一个「看起来像 mp4」的字节块（服务端不解析视频内容）
Uint8List _syntheticMp4() {
  final bytes = BytesBuilder();
  // ftyp box 头，让部分客户端能识别成 mp4
  bytes.add(<int>[0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
  bytes.add('isom'.codeUnits);
  bytes.add(<int>[0x00, 0x00, 0x02, 0x00]);
  bytes.add('isomiso2avc1mp41'.codeUnits);
  // 填充数据，保证体积大于「过小文件」阈值
  bytes.add(Uint8List(4096));
  return bytes.toBytes();
}

/// 合成一个「看起来像 m4a」的字节块（服务端不解析音频内容）
Uint8List _syntheticM4a() {
  final bytes = BytesBuilder();
  // ftyp box（M4A 常见头）
  bytes.add(<int>[0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]);
  bytes.add('M4A '.codeUnits);
  bytes.add(<int>[0x00, 0x00, 0x00, 0x00]);
  bytes.add('M4A isomiso2'.codeUnits);
  bytes.add(Uint8List(2048));
  return bytes.toBytes();
}

/// 当前会话最新一条消息的 seq（0 表示空会话）
Future<int> _latestSeq(String conversationId) async {
  final page = await ApiClient.instance.listMessages(conversationId, limit: 1);
  return page.items.isEmpty ? 0 : page.items.first.seq;
}

/// 等待本地消息全部从「发送中」变为「已发送」
Future<void> _waitForSent(WidgetTester tester, String conversationId) async {
  for (var i = 0; i < 60; i++) {
    await tester.pump(const Duration(milliseconds: 500));
    final list = ChatStore.instance.messagesOf(conversationId);
    if (list.any((m) => m.localStatus == LocalStatus.failed)) {
      throw StateError(
        '消息发送失败：${ChatStore.instance.lastSendError ?? '未知原因'}',
      );
    }
    final pending = list.where((m) => m.localStatus == LocalStatus.sending);
    if (pending.isEmpty && list.isNotEmpty) return;
  }
  throw StateError(
    '等待消息发送超时（30 秒）；最近错误：${ChatStore.instance.lastSendError ?? '无'}',
  );
}

/// 从服务端历史里找出这次新发的、指定类型的消息
Future<Message> _findSentMessage(
  String conversationId,
  String type,
  int afterSeq,
) async {
  final page = await ApiClient.instance.listMessages(conversationId, limit: 20);
  for (final m in page.items) {
    if (m.seq > afterSeq && m.type == type && m.attachments.isNotEmpty) {
      return m;
    }
  }
  throw StateError('$type 消息未在服务端落库（afterSeq=$afterSeq）');
}
