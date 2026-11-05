#include "window_state.h"

#include <shlobj.h>

#include <cstdio>
#include <sstream>

namespace {

// 取 %LOCALAPPDATA%\Chat，不存在则创建
bool GetStateDirectory(std::wstring* out) {
  PWSTR local_app_data = nullptr;
  if (FAILED(SHGetKnownFolderPath(FOLDERID_LocalAppData, KF_FLAG_CREATE, nullptr,
                                  &local_app_data))) {
    return false;
  }
  std::wstring dir(local_app_data);
  CoTaskMemFree(local_app_data);

  dir += L"\\Chat";
  CreateDirectoryW(dir.c_str(), nullptr);
  *out = dir;
  return true;
}

bool GetStateFilePath(std::wstring* out) {
  std::wstring dir;
  if (!GetStateDirectory(&dir)) return false;
  *out = dir + L"\\window.txt";
  return true;
}

// 校验矩形是否落在某个可见显示器上
//
// 用户可能拔掉外接显示器，上次保存的坐标就会变成「屏幕外」，
// 窗口创建出来后看不见 —— 必须挡掉这种情况。
bool IsRectVisibleOnSomeMonitor(const RECT& rect) {
  if (rect.right - rect.left < 200) return false;
  if (rect.bottom - rect.top < 200) return false;

  if (!MonitorFromRect(&rect, MONITOR_DEFAULTTONULL)) return false;

  MONITORINFO info = {};
  info.cbSize = sizeof(MONITORINFO);
  HMONITOR monitor = MonitorFromRect(&rect, MONITOR_DEFAULTTONEAREST);
  if (!GetMonitorInfoW(monitor, &info)) return false;

  // 至少要有 80x80 的工作区交叠，否则视为不可见
  RECT overlap = {};
  overlap.left = rect.left > info.rcWork.left ? rect.left : info.rcWork.left;
  overlap.top = rect.top > info.rcWork.top ? rect.top : info.rcWork.top;
  overlap.right = rect.right < info.rcWork.right ? rect.right : info.rcWork.right;
  overlap.bottom = rect.bottom < info.rcWork.bottom ? rect.bottom : info.rcWork.bottom;

  return (overlap.right - overlap.left) >= 80 &&
         (overlap.bottom - overlap.top) >= 80;
}

}  // namespace

bool LoadWindowPlacement(WindowPlacement* out) {
  if (!out) return false;

  std::wstring path;
  if (!GetStateFilePath(&path)) return false;

  FILE* file = nullptr;
  if (_wfopen_s(&file, path.c_str(), L"r") != 0 || !file) return false;

  int x = 0, y = 0, width = 0, height = 0, maximized = 0;
  const int read =
      fwscanf_s(file, L"%d %d %d %d %d", &x, &y, &width, &height, &maximized);
  fclose(file);

  if (read != 5) return false;

  RECT rect = {x, y, x + width, y + height};
  if (!IsRectVisibleOnSomeMonitor(rect)) {
    // 坐标失效：保留宽度和高度（仍然有用），位置回到默认
    if (width >= 800 && width <= 8000 && height >= 600 && height <= 8000) {
      out->width = width;
      out->height = height;
      out->maximized = maximized != 0;
    }
    return false;
  }

  out->x = x;
  out->y = y;
  out->width = width;
  out->height = height;
  out->maximized = maximized != 0;
  return true;
}

void SaveWindowPlacement(HWND hwnd) {
  if (!hwnd) return;

  std::wstring path;
  if (!GetStateFilePath(&path)) return;

  // 最大化状态下 GetWindowRect 返回的是整屏尺寸，
  // 存下来下次还原会变成「最大化的小窗」。用 GetWindowPlacement
  // 拿 normal 尺寸才是用户真正调整过的那个大小。
  WINDOWPLACEMENT placement = {};
  placement.length = sizeof(WINDOWPLACEMENT);
  if (!GetWindowPlacement(hwnd, &placement)) return;

  const RECT& normal = placement.rcNormalPosition;
  const int width = normal.right - normal.left;
  const int height = normal.bottom - normal.top;
  if (width <= 0 || height <= 0) return;

  const bool maximized =
      (placement.showCmd == SW_SHOWMAXIMIZED) ||
      (placement.showCmd == SW_MAXIMIZE) || IsZoomed(hwnd);

  FILE* file = nullptr;
  if (_wfopen_s(&file, path.c_str(), L"w") != 0 || !file) return;
  fwprintf_s(file, L"%d %d %d %d %d\n", normal.left, normal.top, width, height,
             maximized ? 1 : 0);
  fclose(file);
}
