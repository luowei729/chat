import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/api.dart';
import '../core/storage.dart';
import '../ui/app.dart';
import '../ui/pages/chat_page.dart';

/// ============================================================
/// 推送（MobPush）
/// ------------------------------------------------------------
/// 只在 Android 上有原生实现；其他平台是 no-op。
///
/// 设计要点：
///   1. 推送只是「锦上添花」——App 在线时消息走 WebSocket，
///      离线才依赖推送，所以这里任何失败都不该影响主流程；
///   2. 令牌可能在登录后才异步拿到，也可能在登录前就拿到，
///      两个时机都要触发一次上报（幂等，服务端按设备覆盖）；
///   3. 鸿蒙 7（纯血）通过卓易通跑 APK 时，容器内没有厂商通道，
///      令牌可能拿不到或送达不可靠，此时静默降级，
///      绝不能因此阻塞用户使用。
/// ============================================================
class PushService {
  PushService._();

  static final PushService instance = PushService._();

  static const MethodChannel _channel = MethodChannel('pub.lkz.chat/push');

  /// 服务端 provider 标识：Mob 聚合通道
  /// 服务端据此走 Mob REST 接口，由 Mob 再路由到华为/小米/OPPO/vivo。
  static const String _provider = 'mob';

  bool _bound = false;
  String? _lastToken;
  bool _registering = false;

  /// 点通知进来时要打开的会话（Dart 侧消费）
  final ValueNotifier<String?> pendingConversationId = ValueNotifier(null);

  void attach() {
    if (_bound || !Platform.isAndroid) return;
    _bound = true;
    _channel.setMethodCallHandler(_handleNativeCall);
  }

  Future<dynamic> _handleNativeCall(MethodCall call) async {
    switch (call.method) {
      case 'onPushToken':
        final token = call.arguments as String?;
        if (token != null && token.isNotEmpty) {
          await _register(token);
        }
        return null;
      case 'onNotificationClick':
        final args = call.arguments is Map
            ? Map<String, dynamic>.from(call.arguments as Map)
            : const <String, dynamic>{};
        _openFromNotification(args);
        return null;
      default:
        return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 令牌上报                                                            */
  /* ------------------------------------------------------------------ */

  /// 登录成功后调用：拉一次令牌并上报
  Future<void> sync() async {
    if (!Platform.isAndroid) return;
    attach();
    try {
      final token = await _channel.invokeMethod<String>('getToken');
      if (token != null && token.isNotEmpty) {
        await _register(token);
      }
      // 冷启动点通知进入：把积压的跳转取回来
      final pending =
          await _channel.invokeMethod<Map<dynamic, dynamic>>('consumePendingClick');
      if (pending != null) {
        _openFromNotification(Map<String, dynamic>.from(pending));
      }
    } catch (_) {
      // 原生层不可用（例如卓易通容器缺能力）：忽略
    }
  }

  Future<void> _register(String token) async {
    // 同一令牌不重复上报，避免每次重连都打一次接口
    if (_registering || token == _lastToken) return;
    _registering = true;
    try {
      await ApiClient.instance.registerPushToken(
        provider: _provider,
        platform: 'android',
        deviceId: AppStorage.instance.deviceId,
        token: token,
      );
      _lastToken = token;
    } catch (_) {
      // 网络失败：下次 sync 再试
    } finally {
      _registering = false;
    }
  }

  /// 退出登录时注销，避免把上个账号的消息推给下一个用户
  Future<void> unregister() async {
    if (!Platform.isAndroid) return;
    _lastToken = null;
    try {
      await ApiClient.instance.unregisterPushToken(
        deviceId: AppStorage.instance.deviceId,
      );
    } catch (_) {
      // 忽略
    }
  }

  /* ------------------------------------------------------------------ */
  /* 通知点击跳转                                                        */
  /* ------------------------------------------------------------------ */

  void _openFromNotification(Map<String, dynamic> args) {
    final conversationId = args['conversationId'] as String?;
    final callId = args['callId'] as String?;

    // 来电通知：通话链路会由 WS 的重连补偿逻辑兜底，
    // 这里只负责把 UI 带到前台，具体进通话页由 CallController 决定。
    if (conversationId == null || conversationId.isEmpty) {
      if (callId != null && callId.isNotEmpty) {
        pendingConversationId.value = null;
      }
      return;
    }

    final nav = rootNavigatorKey.currentState;
    if (nav == null) {
      // 首帧还没建好，先存起来，由 App 启动后消费
      pendingConversationId.value = conversationId;
      return;
    }
    nav.push(
      MaterialPageRoute<void>(
        builder: (_) => ChatPage(conversationId: conversationId),
      ),
    );
  }
}
