import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';

import '../core/api.dart';
import '../core/config.dart';
import '../core/models.dart';
import '../core/storage.dart';
import 'push_service.dart';
import 'ws.dart';

enum AuthStatus { checking, authenticated, unauthenticated }

/// ============================================================
/// 登录态
/// ------------------------------------------------------------
/// 冷启动流程：
///   1. 先读本地用户缓存 → 立刻渲染，不闪登录页；
///   2. 再用令牌拉 /me 校验 → 失败才退出登录；
///   3. 校验通过后连接 WebSocket（实时能力的入口）。
/// ============================================================
class Session extends ChangeNotifier {
  Session._();

  static final Session instance = Session._();

  AuthStatus status = AuthStatus.checking;
  AuthUser? user;
  String? lastError;

  bool get isAuthenticated => status == AuthStatus.authenticated && user != null;
  String get userId => user?.id ?? '';

  final ApiClient _api = ApiClient.instance;

  /// 启动时调用一次
  Future<void> bootstrap() async {
    _api.onAuthLost = _handleAuthLost;
    WsService.instance.tokenProvider = _freshToken;

    // 1. 本地缓存：先让 UI 有东西可渲染
    final cached = AppStorage.instance.userJson;
    if (cached != null && cached.isNotEmpty) {
      try {
        user = AuthUser.fromJson(jsonDecode(cached) as Map<String, dynamic>);
        status = AuthStatus.authenticated;
        notifyListeners();
      } catch (_) {
        // 缓存损坏，忽略
      }
    }

    // 2. 没有令牌 → 未登录
    final token = AppStorage.instance.accessToken;
    if (token == null || token.isEmpty) {
      status = AuthStatus.unauthenticated;
      user = null;
      notifyListeners();
      return;
    }

    // 3. 用令牌校验身份
    try {
      if (!await _api.refreshIfNeeded()) {
        throw ApiException('登录已过期');
      }
      final fresh = await _api.me();
      user = fresh;
      status = AuthStatus.authenticated;
      await AppStorage.instance.saveUser(fresh.id, jsonEncode(fresh.toJson()));
      notifyListeners();
      unawaited(WsService.instance.connect());
      // 登录态就绪后上报推送令牌（失败不影响使用）
      unawaited(PushService.instance.sync());
    } on ApiException catch (e) {
      if (e.isAuthError) {
        await _clearAuth();
      } else {
        // 网络问题：保留缓存身份，允许离线查看历史，联网后自动重试
        status = user != null ? AuthStatus.authenticated : AuthStatus.unauthenticated;
        lastError = e.message;
        notifyListeners();
        if (isAuthenticated) unawaited(WsService.instance.connect());
      }
    } catch (_) {
      status = user != null ? AuthStatus.authenticated : AuthStatus.unauthenticated;
      notifyListeners();
    }
  }

  Future<String?> _freshToken() async {
    if (await _api.refreshIfNeeded()) return AppStorage.instance.accessToken;
    return AppStorage.instance.accessToken;
  }

  Future<void> login({required String email, required String password}) async {
    final result = await _api.login(email: email, password: password);
    await _applyAuth(result);
  }

  Future<void> register({
    required String email,
    required String code,
    required String password,
    required String nickname,
    required String inviteCode,
  }) async {
    final result = await _api.register(
      email: email,
      code: code,
      password: password,
      nickname: nickname,
      inviteCode: inviteCode,
    );
    await _applyAuth(result);
  }

  Future<void> _applyAuth(AuthResult result) async {
    await AppStorage.instance.saveTokens(
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: result.accessTokenExpiresAt,
    );
    await AppStorage.instance.saveUser(result.user.id, jsonEncode(result.user.toJson()));
    user = result.user;
    status = AuthStatus.authenticated;
    lastError = null;
    notifyListeners();
    unawaited(WsService.instance.connect());
    unawaited(PushService.instance.sync());
  }

  Future<void> logout() async {
    // 先注销推送令牌，避免下个账号收到上一个用户的消息
    await PushService.instance.unregister();
    await _api.logout();
    await WsService.instance.disconnect();
    await _clearAuth();
  }

  Future<void> _clearAuth() async {
    await AppStorage.instance.clearAuth();
    user = null;
    status = AuthStatus.unauthenticated;
    notifyListeners();
  }

  void _handleAuthLost() {
    if (status == AuthStatus.unauthenticated) return;
    unawaited(_clearAuth());
  }

  /// 本机平台标识（展示用）
  String get platformLabel => AppConfig.platform;

  /// 是否有网络（粗略判断，用于离线提示）
  static Future<bool> hasNetwork() async {
    try {
      final result = await InternetAddress.lookup('chat.lkz.pub');
      return result.isNotEmpty;
    } catch (_) {
      return false;
    }
  }
}
