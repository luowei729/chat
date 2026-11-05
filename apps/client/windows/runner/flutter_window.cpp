#include "flutter_window.h"

#include <flutter/standard_method_codec.h>

#include <optional>
#include <string>

#include "flutter/generated_plugin_registrant.h"
#include "sound.h"
#include "toast_window.h"
#include "tray_icon.h"
#include "window_state.h"

namespace {

// 任务栏图标闪烁
//
// 这是 Windows 上「有新消息」最不打扰的提示方式：
// 不弹窗、不抢焦点，只是让任务栏按钮变色闪动，
// 用户点开或不理会都行（微信/QQ 都是这个行为）。
void FlashTaskbar(HWND hwnd, bool enable) {
  if (!hwnd) return;

  FLASHWINFO info = {};
  info.cbSize = sizeof(FLASHWINFO);
  info.hwnd = hwnd;
  if (enable) {
    info.dwFlags = FLASHW_ALL | FLASHW_TIMERNOFG;
    // 0xFFFFFFFF = 一直闪到用户点了窗口为止
    info.uCount = 0xFFFFFFFF;
    info.dwTimeout = 0;
  } else {
    info.dwFlags = FLASHW_STOP;
    info.uCount = 0;
    info.dwTimeout = 0;
  }
  FlashWindowEx(&info);
}

bool IsWindowForeground(HWND hwnd) {
  if (!hwnd) return false;
  HWND foreground = GetForegroundWindow();
  if (foreground == hwnd) return true;
  HWND root = GetAncestor(foreground, GA_ROOT);
  return root == hwnd;
}

// 通道传过来的是 UTF-8 字符串，GDI / Win32 API 需要宽字符
//
// 注意：Flutter 的 EncodableValue 在新版只包含 std::string（UTF-8），
// 已经没有 std::u16string。写 get_if<std::u16string> 会报
// static_assert 'T to occur exactly once' 的编译错误。
std::wstring ToWide(const flutter::EncodableValue* value) {
  if (!value) return std::wstring();
  const auto* str = std::get_if<std::string>(value);
  if (!str || str->empty()) return std::wstring();

  const int size = ::MultiByteToWideChar(CP_UTF8, 0, str->c_str(),
                                         static_cast<int>(str->size()),
                                         nullptr, 0);
  if (size <= 0) return std::wstring();
  std::wstring wide(static_cast<size_t>(size), L'\0');
  ::MultiByteToWideChar(CP_UTF8, 0, str->c_str(),
                        static_cast<int>(str->size()), wide.data(), size);
  return wide;
}

// 从 map 参数里取字符串
std::wstring ArgString(const flutter::EncodableMap* args, const char* key) {
  if (!args) return std::wstring();
  auto it = args->find(flutter::EncodableValue(key));
  if (it == args->end()) return std::wstring();
  return ToWide(&it->second);
}

}  // namespace

FlutterWindow::FlutterWindow(const flutter::DartProject& project)
    : project_(project) {}

FlutterWindow::~FlutterWindow() {}

bool FlutterWindow::OnCreate() {
  if (!Win32Window::OnCreate()) {
    return false;
  }

  RECT frame = GetClientArea();

  // The size here must match the window dimensions to avoid unnecessary surface
  // creation / destruction in the startup path.
  flutter_controller_ = std::make_unique<flutter::FlutterViewController>(
      frame.right - frame.left, frame.bottom - frame.top, project_);
  if (!flutter_controller_->engine() || !flutter_controller_->view()) {
    return false;
  }
  RegisterPlugins(flutter_controller_->engine());
  RegisterDesktopChannel();
  SetChildContent(flutter_controller_->view()->GetNativeWindow());

  flutter_controller_->engine()->SetNextFrameCallback([&]() {
    this->Show();
  });

  flutter_controller_->ForceRedraw();

  // 托盘图标常驻：即使窗口可见也先建好，隐藏时才能立刻看到
  ShowTrayIcon(GetHandle(), L"Chat");

  return true;
}

void FlutterWindow::UpdateTrayTip(const std::wstring& tip) {
  if (tip.empty()) {
    ShowTrayIcon(GetHandle(), L"Chat");
    return;
  }
  ShowTrayIcon(GetHandle(), tip.c_str());
}

void FlutterWindow::QuitApplication() {
  quitting_ = true;
  StopRingtone();
  RemoveTrayIcon();
  DestroyWindow(GetHandle());
}

void FlutterWindow::RegisterDesktopChannel() {
  desktop_channel_ =
      std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
          flutter_controller_->engine()->messenger(), "pub.lkz.chat/desktop",
          &flutter::StandardMethodCodec::GetInstance());

  desktop_channel_->SetMethodCallHandler(
      [this](const flutter::MethodCall<flutter::EncodableValue>& call,
             std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>>
                 result) {
        const HWND hwnd = GetHandle();
        const std::string& method = call.method_name();

        /* ---------------- 任务栏 ---------------- */
        if (method == "flashTaskbar") {
          FlashTaskbar(hwnd, true);
          result->Success();
          return;
        }
        if (method == "stopTaskbarFlash") {
          FlashTaskbar(hwnd, false);
          result->Success();
          return;
        }
        if (method == "isWindowFocused") {
          result->Success(flutter::EncodableValue(IsWindowForeground(hwnd)));
          return;
        }

        /* ---------------- 通知卡片 ---------------- */
        if (method == "showNotification") {
          const auto* args =
              std::get_if<flutter::EncodableMap>(call.arguments());
          std::wstring title = ArgString(args, "title");
          const std::wstring body = ArgString(args, "body");
          if (title.empty()) title = L"Chat";

          ShowToastWindow(hwnd, title, body);
          // 没有声音的桌面通知用户基本感知不到，必须带提示音
          PlayMessageSound();
          if (!IsWindowForeground(hwnd)) FlashTaskbar(hwnd, true);
          result->Success();
          return;
        }

        /**
         * 语音来电通知
         * ------------------------------------------------------------
         * 与普通消息的关键区别：
         *   1. 必须**循环响铃**，一声提示音很容易被忽略；
         *   2. 即使窗口在前台也要响（正在打字时突然有人打进来）；
         *   3. 必须能被 stopIncomingCall 立刻打断（接听/拒接/超时）。
         */
        if (method == "showIncomingCall") {
          const auto* args =
              std::get_if<flutter::EncodableMap>(call.arguments());
          std::wstring title = ArgString(args, "title");
          const std::wstring body = ArgString(args, "body");
          if (title.empty()) title = L"语音来电";

          ShowToastWindow(hwnd, title, body);
          StartRingtone();
          FlashTaskbar(hwnd, true);
          result->Success();
          return;
        }
        if (method == "stopIncomingCall") {
          StopRingtone();
          DestroyToastWindow();
          result->Success();
          return;
        }

        if (method == "closeNotification") {
          DestroyToastWindow();
          result->Success();
          return;
        }

        /* ---------------- 窗口控制 ---------------- */
        if (method == "activateWindow") {
          if (hwnd) {
            if (IsIconic(hwnd)) {
              ShowWindow(hwnd, SW_RESTORE);
            } else {
              ShowWindow(hwnd, SW_SHOW);
            }
            SetForegroundWindow(hwnd);
            FlashTaskbar(hwnd, false);
            DestroyToastWindow();
            StopRingtone();
          }
          result->Success();
          return;
        }

        // 最小化到托盘（用户点「关闭」按钮的等价行为）
        if (method == "minimizeToTray") {
          if (hwnd) {
            ShowWindow(hwnd, SW_HIDE);
            ShowTrayIcon(hwnd, L"Chat");
          }
          result->Success();
          return;
        }

        // 真正退出（设置页「退出应用」或托盘菜单）
        if (method == "quitApp") {
          QuitApplication();
          result->Success();
          return;
        }

        // 更新托盘悬停提示（例如「Chat — 3 条未读」）
        if (method == "updateTrayTip") {
          const auto* args =
              std::get_if<flutter::EncodableMap>(call.arguments());
          UpdateTrayTip(ArgString(args, "tip"));
          result->Success();
          return;
        }

        // 播放提示音（Dart 侧也可以主动触发）
        if (method == "playNotificationSound") {
          PlayMessageSound();
          result->Success();
          return;
        }

        result->NotImplemented();
      });
}

void FlutterWindow::OnDestroy() {
  StopRingtone();
  DestroyToastWindow();
  RemoveTrayIcon();
  desktop_channel_.reset();
  if (flutter_controller_) {
    flutter_controller_ = nullptr;
  }

  Win32Window::OnDestroy();
}

LRESULT
FlutterWindow::MessageHandler(HWND hwnd, UINT const message,
                              WPARAM const wparam,
                              LPARAM const lparam) noexcept {
  // ------------------------------------------------------------
  // 点 X 最小化到托盘（默认行为，微信/QQ 一致）
  // ------------------------------------------------------------
  // 关键：返回 0 表示「已处理」，不转给 DefWindowProc，
  // 窗口就不会被销毁 —— 否则任务栏按钮消失、程序直接退出。
  // 只有走 QuitApplication()（托盘菜单「退出」或设置页退出）才会真正关闭。
  if (message == WM_CLOSE && !quitting_) {
    SaveWindowPlacement(hwnd);
    ShowWindow(hwnd, SW_HIDE);

    // 第一次隐藏时用气泡提示一下，否则用户以为程序崩了
    if (!tray_hint_shown_) {
      tray_hint_shown_ = true;
      NOTIFYICONDATAW nid = {};
      nid.cbSize = sizeof(NOTIFYICONDATAW);
      nid.hWnd = hwnd;
      nid.uID = 1;
      nid.uFlags = NIF_INFO;
      nid.dwInfoFlags = NIIF_INFO;
      wcscpy_s(nid.szInfoTitle, L"Chat 仍在后台运行");
      wcscpy_s(nid.szInfo, L"点托盘图标可以重新打开；右键可退出。");
      Shell_NotifyIconW(NIM_MODIFY, &nid);
    }
    return 0;
  }

  // 关窗前保存窗口尺寸（此时 HWND 仍然有效）
  if (message == WM_CLOSE) {
    SaveWindowPlacement(hwnd);
  }

  // 用户回到窗口：停止提醒
  if (message == WM_ACTIVATE && LOWORD(wparam) != WA_INACTIVE) {
    FlashTaskbar(hwnd, false);
    DestroyToastWindow();
    // 注意：这里**不**停来电响铃。
    // 用户可能只是切回来看一眼，电话还在响，铃不该断。
  }

  // 托盘图标的鼠标消息
  if (message == WM_TRAYICON) {
    if (HandleTrayMessage(hwnd, lparam)) return 0;
  }

  // Give Flutter, including plugins, an opportunity to handle window messages.
  if (flutter_controller_) {
    std::optional<LRESULT> result =
        flutter_controller_->HandleTopLevelWindowProc(hwnd, message, wparam,
                                                      lparam);
    if (result) {
      return *result;
    }
  }

  switch (message) {
    case WM_FONTCHANGE:
      flutter_controller_->engine()->ReloadSystemFonts();
      break;
  }

  return Win32Window::MessageHandler(hwnd, message, wparam, lparam);
}
