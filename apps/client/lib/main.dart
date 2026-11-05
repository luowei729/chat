import 'dart:async';

import 'package:flutter/material.dart';

import 'core/storage.dart';
import 'services/calls.dart';
import 'services/chat_store.dart';
import 'services/session.dart';
import 'ui/app.dart';

/// ============================================================
/// 应用入口
/// ------------------------------------------------------------
/// 启动顺序很关键：
///   1. 初始化本地存储（令牌、设备 id）——必须 await，
///      否则首帧请求会拿不到令牌，直接把用户踢到登录页；
///   2. 挂上 WS / 通话事件监听；
///   3. 后台校验登录态（不阻塞首帧）；
///   4. 启动 UI。
/// ============================================================
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await AppStorage.init();

  ChatStore.instance.attachWs();
  CallController.instance.attach();
  unawaited(Session.instance.bootstrap());

  runApp(const ChatApp());
}
