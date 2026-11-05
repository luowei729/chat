// windows.h 必须最先包含：shellapi.h / shobjidl.h 都依赖它定义的类型
// （HWND/BOOL/GUID 等），顺序反了在部分 Windows SDK 上会直接编译失败。
#include <windows.h>

// SetCurrentProcessExplicitAppUserModelID 声明在 shobjidl.h，
// 只包含 shellapi.h 会报 C2039/C3861（identifier not found）。
#include <shobjidl.h>
#include <shellapi.h>  // 命令行 / 其他 Shell 辅助函数

#include <flutter/dart_project.h>
#include <flutter/flutter_view_controller.h>

#include "flutter_window.h"
#include "utils.h"
#include "window_state.h"

int APIENTRY wWinMain(_In_ HINSTANCE instance, _In_opt_ HINSTANCE prev,
                      _In_ wchar_t *command_line, _In_ int show_command) {
  // Attach to console when present (e.g., 'flutter run') or create a
  // new console when running with a debugger.
  if (!::AttachConsole(ATTACH_PARENT_PROCESS) && ::IsDebuggerPresent()) {
    CreateAndAttachConsole();
  }

  // Initialize COM, so that it is available for use in the library and/or
  // plugins.
  ::CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

  /**
   * 设置 AppUserModelID（任务栏身份标识）
   * ------------------------------------------------------------
   * 不设置的话 Windows 只能靠可执行文件路径来识别应用，会带来三个问题：
   *   1. 任务栏图标分组异常，可能出现空白图标或重复按钮；
   *   2. 图标缓存混乱：换了图标后任务栏仍显示旧的；
   *   3. 「固定到任务栏」后无法正确关联回同一个应用。
   *
   * 必须用稳定且唯一的字符串（写成反向域名，不要改），
   * 一旦改了，用户固定在任务栏的快捷方式会失效。
   *
   * 必须在创建任何窗口之前调用。
   */
  ::SetCurrentProcessExplicitAppUserModelID(L"pub.lkz.chat.desktop");

  flutter::DartProject project(L"data");

  std::vector<std::string> command_line_arguments =
      GetCommandLineArguments();

  project.set_dart_entrypoint_arguments(std::move(command_line_arguments));

  FlutterWindow window(project);

  // ------------------------------------------------------------
  // 恢复上次的窗口位置与尺寸
  // ------------------------------------------------------------
  // 必须在 Create 之前读到值，否则会先按默认尺寸闪一下再跳变。
  // LoadWindowPlacement 内部会校验矩形是否落在当前可见的显示器上，
  // 用户拔掉外接屏后不会出现「窗口跑到屏幕外」。
  WindowPlacement placement;
  const bool restored = LoadWindowPlacement(&placement);

  Win32Window::Point origin(placement.x, placement.y);
  Win32Window::Size size(placement.width, placement.height);

  if (!restored) {
    // 首次启动（或旧坐标已失效）：居中显示，尺寸用默认值
    const int screen_width = ::GetSystemMetrics(SM_CXSCREEN);
    const int screen_height = ::GetSystemMetrics(SM_CYSCREEN);
    const int x = (screen_width - static_cast<int>(size.width)) / 2;
    const int y = (screen_height - static_cast<int>(size.height)) / 2;
    origin = Win32Window::Point(x < 0 ? 0 : x, y < 0 ? 0 : y);
  }

  if (!window.Create(L"Chat", origin, size)) {
    return EXIT_FAILURE;
  }
  window.SetQuitOnClose(true);

  // 上次是最大化：创建完成后再还原（Create 里用 normal 尺寸，
  // 这样用户点「还原」时回到的是他真正调整过的大小）
  if (restored && placement.maximized) {
    ::ShowWindow(window.GetHandle(), SW_SHOWMAXIMIZED);
  }

  ::MSG msg;
  while (::GetMessage(&msg, nullptr, 0, 0)) {
    ::TranslateMessage(&msg);
    ::DispatchMessage(&msg);
  }

  ::CoUninitialize();
  return EXIT_SUCCESS;
}
