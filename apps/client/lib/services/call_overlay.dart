import 'dart:io';

import 'package:flutter/services.dart';

/// ============================================================
/// 通话悬浮窗（Android）
/// ------------------------------------------------------------
/// 通道：pub.lkz.chat/call_overlay
/// 原生实现：android/app/src/main/kotlin/pub/lkz/chat/CallOverlay.kt
///
/// 解决什么问题：
///   用户在通话中切到别的 App（微信、桌面），通话页就看不见了。
///   没有悬浮窗时，用户既不知道通话还在不在，也没法快速挂断。
///
/// 为什么需要单独权限：
///   SYSTEM_ALERT_WINDOW 是**特殊权限**，不能弹运行时对话框申请，
///   只能跳系统设置页。所以流程是：
///     点「最小化」→ 无权限 → 跳设置页 → 用户返回 → 再显示浮窗
///
/// 回调方向（原生 → Dart）：
///   onOverlayHangup  用户点了浮窗上的「挂断」
///   onOverlayOpen    用户点了浮窗主体（应回到 App）
///
/// 其它平台全部静默降级：能力探测而非平台判断。
/// ============================================================
class CallOverlayBridge {
  CallOverlayBridge._();

  static final CallOverlayBridge instance = CallOverlayBridge._();

  static const MethodChannel _channel = MethodChannel('pub.lkz.chat/call_overlay');

  bool? _available;
  bool _handlersBound = false;

  /// 用户点浮窗挂断
  VoidCallback? onHangup;

  /// 用户点浮窗主体（回到 App）
  VoidCallback? onOpen;

  Future<bool> get isAvailable async {
    if (_available != null) return _available!;
    if (!Platform.isAndroid) {
      _available = false;
      return false;
    }
    try {
      final granted = await _channel.invokeMethod<bool>('hasPermission');
      // 通道存在就认为能力可用（权限另算）
      _available = granted != null;
      _bindHandlers();
    } catch (_) {
      _available = false;
    }
    return _available!;
  }

  void _bindHandlers() {
    if (_handlersBound) return;
    _handlersBound = true;
    _channel.setMethodCallHandler((call) async {
      switch (call.method) {
        case 'onOverlayHangup':
          onHangup?.call();
        case 'onOverlayOpen':
          onOpen?.call();
      }
      return null;
    });
  }

  /// 是否已授予悬浮窗权限
  Future<bool> hasPermission() async {
    if (!await isAvailable) return false;
    try {
      return await _channel.invokeMethod<bool>('hasPermission') ?? false;
    } catch (_) {
      return false;
    }
  }

  /// 跳系统设置页申请悬浮窗权限（返回用户操作后的真实结果）
  Future<bool> requestPermission() async {
    if (!await isAvailable) return false;
    try {
      return await _channel.invokeMethod<bool>('requestPermission') ?? false;
    } catch (_) {
      return false;
    }
  }

  /// 显示悬浮窗
  Future<bool> show({required String peerName}) async {
    if (!await isAvailable) return false;
    try {
      return await _channel.invokeMethod<bool>('show', {'peerName': peerName}) ?? false;
    } catch (_) {
      return false;
    }
  }

  Future<void> hide() async {
    if (!await isAvailable) return;
    try {
      await _channel.invokeMethod<void>('hide');
    } catch (_) {
      // 静默降级
    }
  }

  /// 更新悬浮窗上的通话时长
  Future<void> updateTimer(String text) async {
    if (!await isAvailable) return;
    try {
      await _channel.invokeMethod<void>('updateTimer', {'text': text});
    } catch (_) {
      // 静默降级
    }
  }

  /// 把 App 拉回前台
  Future<void> bringToFront() async {
    if (!await isAvailable) return;
    try {
      await _channel.invokeMethod<void>('bringToFront');
    } catch (_) {
      // 静默降级
    }
  }
}

/// 避免额外引入 flutter/foundation 的类型别名
typedef VoidCallback = void Function();
