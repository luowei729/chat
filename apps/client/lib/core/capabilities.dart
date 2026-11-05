import 'dart:io';

/// ============================================================
/// 平台能力探测
/// ------------------------------------------------------------
/// 为什么需要它：
/// 各平台可用的插件不一样。鸿蒙（OpenHarmony）的 Flutter 是 SIG 分支，
/// 目前**没有** `flutter_webrtc`、`record`、`just_audio` 的适配版本。
///
/// 如果不管平台一律显示按钮，用户在鸿蒙上点「语音通话」只会得到一个
/// 异常或无响应——体验上等同于「功能坏了」。
/// 正确做法是**探测能力 → 隐藏/置灰 → 明确告知原因**。
///
/// 新增平台时只改这一个文件。
/// ============================================================
class Capabilities {
  Capabilities._();

  /// 当前是否运行在鸿蒙（OpenHarmony / HarmonyOS）
  ///
  /// 鸿蒙版 Flutter 的 `Platform.operatingSystem` 返回 `'ohos'`。
  /// 用字符串比较而不是 Platform.isXxx，是因为 dart:io 里没有 isOhos。
  static bool get isHarmony => Platform.operatingSystem == 'ohos';

  static bool get isMobile => Platform.isAndroid || Platform.isIOS || isHarmony;

  static bool get isDesktop => Platform.isWindows || Platform.isMacOS || Platform.isLinux;

  /// 能否发起/接听语音通话
  ///
  /// 依赖 `flutter_webrtc`，鸿蒙暂无适配 → false。
  static bool get canVoiceCall => !isHarmony;

  /// 能否录制语音消息
  ///
  /// 依赖 `record`，鸿蒙暂无适配 → false。
  static bool get canVoiceMessage => !isHarmony;

  /// 能否播放语音消息（鸿蒙缺 `just_audio`，播放待原生补齐）
  static bool get canPlayAudio => !isHarmony;

  /// 能否从相册/相机取图（image_picker 三端都有适配）
  static bool get canPickMedia => true;

  /// 能否选择文件
  static bool get canPickFile => true;

  /// 不支持时的统一提示文案
  static String unsupportedReason(String feature) {
    if (isHarmony) {
      return '鸿蒙端暂不支持$feature（插件适配中）';
    }
    return '当前设备不支持$feature';
  }
}
