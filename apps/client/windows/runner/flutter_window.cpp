#include "flutter_window.h"

#include <flutter/standard_method_codec.h>

#include <optional>
#include <string>

#include "flutter/generated_plugin_registrant.h"
#include "toast_window.h"
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
  // 焦点可能在 Flutter 的子窗口上，往上找根窗口比较
  HWND root = GetAncestor(foreground, GA_ROOT);
  return root == hwnd;
}

// 通道传过来的是 UTF-8 字符串，GDI 需要宽字符
//
// 注意：Flutter 的 EncodableValue 在新版只包含 std::string（UTF-8），
// 已经没有 std::u16string。写成 get_if<std::u16string> 会报
// "T to occur exactly once" 的 static_assert 编译错误。
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
  // Ensure that basic setup of the controller was successful.
  if (!flutter_controller_->engine() || !flutter_controller_->view()) {
    return false;
  }
  RegisterPlugins(flutter_controller_->engine());
  RegisterDesktopChannel();
  SetChildContent(flutter_controller_->view()->GetNativeWindow());

  flutter_controller_->engine()->SetNextFrameCallback([&]() {
    this->Show();
  });

  // Flutter can complete the first frame before the "show window" callback is
  // registered. The following call ensures a frame is pending to ensure the
  // window is shown. It is a no-op if the first frame hasn't completed yet.
  flutter_controller_->ForceRedraw();

  return true;
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

        if (method == "showNotification") {
          std::wstring title;
          std::wstring body;
          if (const auto* args =
                  std::get_if<flutter::EncodableMap>(call.arguments())) {
            auto title_it = args->find(flutter::EncodableValue("title"));
            if (title_it != args->end()) {
              title = ToWide(&title_it->second);
            }
            auto body_it = args->find(flutter::EncodableValue("body"));
            if (body_it != args->end()) {
              body = ToWide(&body_it->second);
            }
          }
          if (title.empty()) title = L"Chat";
          ShowToastWindow(hwnd, title, body);
          // 通知 + 任务栏闪烁：窗口不在前台时两者同时给反馈
          if (!IsWindowForeground(hwnd)) FlashTaskbar(hwnd, true);
          result->Success();
          return;
        }

        if (method == "closeNotification") {
          DestroyToastWindow();
          result->Success();
          return;
        }

        if (method == "activateWindow") {
          if (hwnd) {
            if (IsIconic(hwnd)) {
              ShowWindow(hwnd, SW_RESTORE);
            } else {
              ShowWindow(hwnd, SW_SHOW);
            }
            SetForegroundWindow(hwnd);
            FlashTaskbar(hwnd, false);
          }
          result->Success();
          return;
        }

        result->NotImplemented();
      });
}

void FlutterWindow::OnDestroy() {
  DestroyToastWindow();
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
  // 关窗前保存窗口尺寸（此时 HWND 仍然有效）
  if (message == WM_CLOSE) {
    SaveWindowPlacement(hwnd);
  }

  // 用户回到窗口：停止任务栏闪烁 + 关掉通知卡片
  if (message == WM_ACTIVATE && LOWORD(wparam) != WA_INACTIVE) {
    FlashTaskbar(hwnd, false);
    DestroyToastWindow();
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
