import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:media_kit/media_kit.dart';

import 'core/storage.dart';
import 'services/calls.dart';
import 'services/chat_store.dart';
import 'services/local_cache.dart';
import 'services/push_service.dart';
import 'services/session.dart';
import 'ui/app.dart';

/// ============================================================
/// 应用入口
/// ------------------------------------------------------------
/// 启动顺序很关键：
///   1. 初始化本地存储（令牌、设备 id）——必须 await，
///      否则首帧请求会拿不到令牌，直接把用户踢到登录页；
///   2. 初始化本地缓存（会话/消息/媒体）——失败也不能影响启动，
///      它只是「加速」，不是必需品；
///   3. 挂上 WS / 通话事件监听；
///   4. 后台校验登录态（不阻塞首帧）；
///   5. 启动 UI。
/// ============================================================
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  /**
   * 全屏沉浸（Android）
   * ------------------------------------------------------------
   * 目标：底部手势导航区域不再显示一条白色泳清条，
   *      内容延伸到系统栏下面，与微信 / TG 一致。
   *
   * 两个动作缺一不可：
   *   1. edgeToEdge：告诉系统「我要画到系统栏区域」；
   *   2. 透明系统栏颜色：不设置时系统会填一个不透明白底。
   *
   * 三者配合后的布局安全由各页面的 SafeArea 负责（已全部加上）。
   * 非 Android 平台这两个调用是 no-op。
   */
  SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.dark,
      statusBarBrightness: Brightness.light,
      systemNavigationBarColor: Colors.transparent,
      systemNavigationBarDividerColor: Colors.transparent,
      systemNavigationBarIconBrightness: Brightness.dark,
      systemNavigationBarContrastEnforced: false,
      systemStatusBarContrastEnforced: false,
    ),
  );

  // media_kit（语音/视频播放）必须在任何 Player 创建前初始化。
  // 它负责加载 libmpv 原生库，失败会让所有音视频播不了，
  // 所以单独 try：初始化失败也不该阻止文本聊天。
  try {
    MediaKit.ensureInitialized();
  } catch (_) {
    // 个别精简系统缺 libmpv，降级为无法播音频/视频（Capabilities 会提示）
  }

  await AppStorage.init();
  await LocalCache.instance.init();

  ChatStore.instance.attachWs();
  CallController.instance.attach();
  // 推送通道：必须先挂上，否则原生层先拿到的令牌/点击事件会丢
  PushService.instance.attach();
  unawaited(Session.instance.bootstrap());

  runApp(const ChatApp());
}
