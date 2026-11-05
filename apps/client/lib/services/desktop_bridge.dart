import 'dart:io';

import 'package:flutter/services.dart';

/// ============================================================
/// 桌面端原生能力（Windows）
/// ------------------------------------------------------------
/// 通道：pub.lkz.chat/desktop
/// 原生实现：windows/runner/flutter_window.cpp
///
/// 能力清单：
///   flashTaskbar()        任务栏图标闪烁（新消息提示，像微信）
///   stopTaskbarFlash()    停止闪烁
///   isWindowFocused()     窗口是否在前台
///   showNotification()    右下角通知卡片（像 Telegram）
///   closeNotification()   关掉卡片
///   activateWindow()      把窗口拉到前台
///
/// 设计原则：**能力探测，不是平台判断**。
/// 拿不到通道就静默降级（macOS/Linux/移动端不实现即可），
/// 不允许因为缺原生实现把业务打挂。
/// ============================================================
class DesktopBridge {
  DesktopBridge._();

  static final DesktopBridge instance = DesktopBridge._();

  static const MethodChannel _channel = MethodChannel('pub.lkz.chat/desktop');

  bool? _available;

  /// 是否有原生实现（首次调用后缓存）
  Future<bool> get isAvailable async {
    if (_available != null) return _available!;
    if (!Platform.isWindows) {
      _available = false;
      return false;
    }
    try {
      // 用无副作用的查询方法探测
      final result = await _channel.invokeMethod<bool>('isWindowFocused');
      _available = result != null;
    } catch (_) {
      _available = false;
    }
    return _available!;
  }

  /// 任务栏闪烁（新消息到达且窗口不在前台时调用）
  Future<void> flashTaskbar() async {
    if (!await isAvailable) return;
    try {
      await _channel.invokeMethod<void>('flashTaskbar');
    } catch (_) {
      // 静默降级
    }
  }

  /// 停止任务栏闪烁（用户回到窗口 / 点开会话时调用）
  Future<void> stopTaskbarFlash() async {
    if (!await isAvailable) return;
    try {
      await _channel.invokeMethod<void>('stopTaskbarFlash');
    } catch (_) {
      // 静默降级
    }
  }

  /// 窗口是否在前台（决定要不要弹通知：在前台就别打扰）
  Future<bool> isWindowFocused() async {
    if (!await isAvailable) return false;
    try {
      return await _channel.invokeMethod<bool>('isWindowFocused') ?? false;
    } catch (_) {
      return false;
    }
  }

  /// 右下角通知卡片
  ///
  /// [title] 一般是发送者昵称
  /// [body] 消息摘要
  Future<void> showNotification({required String title, required String body}) async {
    if (!await isAvailable) return;
    try {
      await _channel.invokeMethod<void>('showNotification', {
        'title': title,
        'body': body,
      });
    } catch (_) {
      // 静默降级
    }
  }

  /// 关闭通知卡片（比如用户点进聊天了）
  Future<void> closeNotification() async {
    if (!await isAvailable) return;
    try {
      await _channel.invokeMethod<void>('closeNotification');
    } catch (_) {
      // 静默降级
    }
  }

  /// 把主窗口拉到前台
  Future<void> activateWindow() async {
    if (!await isAvailable) return;
    try {
      await _channel.invokeMethod<void>('activateWindow');
    } catch (_) {
      // 静默降级
    }
  }
}
