#ifndef RUNNER_FLUTTER_WINDOW_H_
#define RUNNER_FLUTTER_WINDOW_H_

#include <flutter/dart_project.h>
#include <flutter/encodable_value.h>
#include <flutter/flutter_view_controller.h>
#include <flutter/method_channel.h>

#include <memory>
#include <string>

#include "win32_window.h"

// A window that does nothing but host a Flutter view.
class FlutterWindow : public Win32Window {
 public:
  // Creates a new FlutterWindow hosting a Flutter view running |project|.
  explicit FlutterWindow(const flutter::DartProject& project);
  virtual ~FlutterWindow();

 protected:
  // Win32Window:
  bool OnCreate() override;
  void OnDestroy() override;
  LRESULT MessageHandler(HWND window, UINT const message, WPARAM const wparam,
                         LPARAM const lparam) noexcept override;

 private:
  // 注册桌面能力通道（pub.lkz.chat/desktop）
  void RegisterDesktopChannel();

  // 更新托盘悬停提示（含未读数）
  void UpdateTrayTip(const std::wstring& tip);

  // 真正退出（托盘菜单「退出」/ Dart 侧请求）
  void QuitApplication();

  // The project to run.
  flutter::DartProject project_;

  // The Flutter instance hosted by this window.
  std::unique_ptr<flutter::FlutterViewController> flutter_controller_;

  // pub.lkz.chat/desktop：Dart 侧调用 Windows 原生能力
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>>
      desktop_channel_;

  // true = 允许窗口真正关闭（退出流程）
  // false = 点 X 只隐藏到托盘（微信行为，默认值）
  bool quitting_ = false;

  // 是否已提示过「已最小化到托盘」（气泡只提示第一次，不要每次都弹）
  bool tray_hint_shown_ = false;
};

#endif  // RUNNER_FLUTTER_WINDOW_H_
