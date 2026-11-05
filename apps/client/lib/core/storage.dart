import 'dart:math';

import 'package:shared_preferences/shared_preferences.dart';

/// ============================================================
/// 本地存储
/// ------------------------------------------------------------
/// 为什么用 SharedPreferences：
/// 令牌、设备 id、主题这些是「小、同步、非敏感到需要 Keystore」的数据。
///
/// 设备 id 必须持久且稳定：
/// 服务端把刷新令牌绑定在 deviceId 上（见 resolveDeviceId），
/// 每次启动换一个 id 会导致刷新失败 → 用户被踢下线。
/// ============================================================
class AppStorage {
  AppStorage._(this._prefs);

  final SharedPreferences _prefs;

  static AppStorage? _instance;
  static AppStorage get instance => _instance ?? (throw StateError('AppStorage 未初始化'));

  static Future<AppStorage> init() async {
    if (_instance != null) return _instance!;
    final prefs = await SharedPreferences.getInstance();
    _instance = AppStorage._(prefs);
    return _instance!;
  }

  static const _kAccess = 'auth.access_token';
  static const _kRefresh = 'auth.refresh_token';
  static const _kExpires = 'auth.access_expires_at';
  static const _kUserId = 'auth.user_id';
  static const _kUser = 'auth.user_json';
  static const _kDeviceId = 'device.id';
  static const _kThemeMode = 'ui.theme_mode';

  // ---------------- 令牌 ----------------

  String? get accessToken => _prefs.getString(_kAccess);
  String? get refreshToken => _prefs.getString(_kRefresh);
  int get accessExpiresAt => _prefs.getInt(_kExpires) ?? 0;
  String? get userId => _prefs.getString(_kUserId);

  /// 缓存的用户信息（冷启动先展示，避免闪登录页）
  String? get userJson => _prefs.getString(_kUser);

  Future<void> saveTokens({
    required String accessToken,
    required String refreshToken,
    required int expiresAt,
  }) async {
    await _prefs.setString(_kAccess, accessToken);
    await _prefs.setString(_kRefresh, refreshToken);
    await _prefs.setInt(_kExpires, expiresAt);
  }

  Future<void> saveUser(String id, String json) async {
    await _prefs.setString(_kUserId, id);
    await _prefs.setString(_kUser, json);
  }

  /// 清登录态（保留设备 id 与主题）
  Future<void> clearAuth() async {
    await _prefs.remove(_kAccess);
    await _prefs.remove(_kRefresh);
    await _prefs.remove(_kExpires);
    await _prefs.remove(_kUserId);
    await _prefs.remove(_kUser);
  }

  // ---------------- 设备 ----------------

  /// 稳定设备 id：首次生成后永久复用
  String get deviceId {
    final existing = _prefs.getString(_kDeviceId);
    if (existing != null && existing.isNotEmpty) return existing;
    final generated = _generateDeviceId();
    _prefs.setString(_kDeviceId, generated);
    return generated;
  }

  static String _generateDeviceId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    final rand = Random.secure();
    final buf = StringBuffer();
    for (var i = 0; i < 16; i++) {
      buf.write(chars[rand.nextInt(chars.length)]);
    }
    return buf.toString();
  }

  // ---------------- 主题 ----------------

  String get themeMode => _prefs.getString(_kThemeMode) ?? 'system';
  Future<void> setThemeMode(String mode) => _prefs.setString(_kThemeMode, mode);
}
