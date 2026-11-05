import 'dart:io' show Platform;

/// ============================================================
/// 运行环境配置
/// ------------------------------------------------------------
/// 全部集中在常量里，避免各处硬编码域名导致切换环境时漏改。
/// 客户端所有平台（Android/iOS/Windows/macOS/鸿蒙）共用同一套接口。
/// ============================================================
class AppConfig {
  /// 源站（不带 /api）：媒体地址、下载链接都基于它拼
  static const String origin = 'https://chat.lkz.pub';

  /// REST 接口前缀
  static const String apiBase = '$origin/api';

  /// WebSocket 地址：实时消息与通话信令
  static const String wsUrl = 'wss://chat.lkz.pub/ws';

  /// 应用版本（上报设备信息用）
  static const String appVersion = '3.0.0';

  /// 请求超时
  static const Duration requestTimeout = Duration(seconds: 15);

  /// 上传超时（大文件）
  static const Duration uploadTimeout = Duration(minutes: 3);

  /// 把服务端返回的媒体相对路径转成绝对地址
  ///
  /// 服务端下发的是 `/api/media/xxx?e=..&s=..`（省流量、便于换域名），
  /// 而 Image/VideoPlayer 都要求绝对 URL，相对路径会静默加载失败。
  static String mediaUrl(String? path) {
    if (path == null || path.isEmpty) return '';
    if (path.startsWith('http://') || path.startsWith('https://')) return path;
    if (path.startsWith('//')) return 'https:$path';
    return path.startsWith('/') ? '$origin$path' : '$origin/$path';
  }

  /// 当前平台标识（用于登录设备记录与推送通道选择）
  static String get platform {
    if (Platform.isAndroid) return 'android';
    if (Platform.isIOS) return 'ios';
    if (Platform.isMacOS) return 'macos';
    if (Platform.isWindows) return 'windows';
    if (Platform.isLinux) return 'linux';
    return 'web';
  }

  /// 设备显示名
  static String get deviceName {
    if (Platform.isAndroid) return 'Android';
    if (Platform.isIOS) return 'iPhone';
    if (Platform.isMacOS) return 'Mac';
    if (Platform.isWindows) return 'Windows';
    return 'Device';
  }
}
