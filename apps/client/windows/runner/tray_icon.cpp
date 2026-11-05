#include "tray_icon.h"

#include <shellapi.h>

#include <string>

#include "resource.h"

namespace {

NOTIFYICONDATAW g_nid = {};
bool g_active = false;

// 显示并激活主窗口
void ShowOwnerWindow(HWND owner) {
  if (!owner || !IsWindow(owner)) return;
  if (IsIconic(owner)) {
    ShowWindow(owner, SW_RESTORE);
  } else {
    ShowWindow(owner, SW_SHOW);
  }
  SetForegroundWindow(owner);
}

// 右键菜单：显示主窗口 / 退出
void ShowContextMenu(HWND owner) {
  HMENU menu = CreatePopupMenu();
  if (!menu) return;

  AppendMenuW(menu, MF_STRING, IDM_TRAY_SHOW, L"打开 Chat");
  AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
  AppendMenuW(menu, MF_STRING, IDM_TRAY_QUIT, L"退出");

  // 必须 SetForegroundWindow，否则点菜单外面菜单不会消失（Win32 老坑）
  POINT cursor;
  GetCursorPos(&cursor);
  SetForegroundWindow(owner);

  // TPM_RETURNCMD：直接拿到选中项，省掉 WM_COMMAND 往返
  const UINT cmd = TrackPopupMenu(
      menu, TPM_RIGHTBUTTON | TPM_RETURNCMD | TPM_NONOTIFY, cursor.x,
      cursor.y, 0, owner, nullptr);

  DestroyMenu(menu);

  if (cmd == IDM_TRAY_SHOW) {
    ShowOwnerWindow(owner);
  } else if (cmd == IDM_TRAY_QUIT) {
    // 真正退出：先撤托盘图标，再关窗口
    RemoveTrayIcon();
    DestroyWindow(owner);
  }
}

}  // namespace

bool ShowTrayIcon(HWND owner, const wchar_t* tip) {
  if (!owner) return false;

  g_nid.cbSize = sizeof(NOTIFYICONDATAW);
  g_nid.hWnd = owner;
  g_nid.uID = 1;
  g_nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
  g_nid.uCallbackMessage = WM_TRAYICON;
  g_nid.hIcon = static_cast<HICON>(
      LoadImageW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(IDI_APP_ICON),
                 IMAGE_ICON, GetSystemMetrics(SM_CXSMICON),
                 GetSystemMetrics(SM_CYSMICON), LR_DEFAULTCOLOR));
  if (!g_nid.hIcon) {
    g_nid.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
  }

  if (tip) {
    wcsncpy_s(g_nid.szTip, tip, _TRUNCATE);
  } else {
    wcscpy_s(g_nid.szTip, L"Chat");
  }

  if (g_active) {
    // 已存在：只刷新图标与提示（NIM_MODIFY）
    return Shell_NotifyIconW(NIM_MODIFY, &g_nid) != FALSE;
  }

  if (!Shell_NotifyIconW(NIM_ADD, &g_nid)) {
    return false;
  }
  g_active = true;
  return true;
}

void RemoveTrayIcon() {
  if (!g_active) return;
  Shell_NotifyIconW(NIM_DELETE, &g_nid);
  g_active = false;
  if (g_nid.hIcon) {
    DestroyIcon(g_nid.hIcon);
    g_nid.hIcon = nullptr;
  }
}

bool IsTrayIconActive() { return g_active; }

bool HandleTrayMessage(HWND owner, LPARAM lparam) {
  switch (LOWORD(lparam)) {
    case WM_LBUTTONDBLCLK:
    case WM_LBUTTONUP:
      ShowOwnerWindow(owner);
      return true;
    case WM_RBUTTONUP:
    case WM_CONTEXTMENU:
      ShowContextMenu(owner);
      return true;
    default:
      return false;
  }
}
