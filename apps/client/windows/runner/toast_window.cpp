#include "toast_window.h"

#include <algorithm>

namespace {

constexpr wchar_t kToastClassName[] = L"ChatToastWindow";
constexpr int kToastWidthDip = 360;
constexpr int kToastHeightDip = 96;
constexpr int kMarginDip = 16;
constexpr UINT_PTR kAutoCloseTimerId = 1;
constexpr UINT kAutoCloseMs = 5000;

HWND g_toast = nullptr;
HWND g_owner = nullptr;
std::wstring g_title;
std::wstring g_body;

int ScaleForDpi(HWND hwnd, int dip) {
  UINT dpi = 96;
  // GetDpiForWindow 是 Win10 1607+ 的 API；直接动态取，老系统回退 96。
  HMODULE user32 = GetModuleHandleW(L"user32.dll");
  if (user32) {
    using GetDpiForWindowFn = UINT(WINAPI*)(HWND);
    auto fn = reinterpret_cast<GetDpiForWindowFn>(
        GetProcAddress(user32, "GetDpiForWindow"));
    if (fn) dpi = fn(hwnd);
  }
  return MulDiv(dip, static_cast<int>(dpi), 96);
}

void PaintToast(HWND hwnd) {
  PAINTSTRUCT ps;
  HDC dc = BeginPaint(hwnd, &ps);
  if (!dc) return;

  RECT client;
  GetClientRect(hwnd, &client);
  const int width = client.right;
  const int height = client.bottom;

  // 双缓冲，避免闪烁
  HDC mem = CreateCompatibleDC(dc);
  HBITMAP bitmap = CreateCompatibleBitmap(dc, width, height);
  HGDIOBJ old_bitmap = SelectObject(mem, bitmap);

  // 背景：Telegram 深色卡片
  HBRUSH background = CreateSolidBrush(RGB(0x2B, 0x2B, 0x2B));
  FillRect(mem, &client, background);
  DeleteObject(background);

  // 左侧强调条
  const int bar = ScaleForDpi(hwnd, 4);
  RECT accent = {0, 0, bar, height};
  HBRUSH accent_brush = CreateSolidBrush(RGB(0x3D, 0x8B, 0xFD));
  FillRect(mem, &accent, accent_brush);
  DeleteObject(accent_brush);

  SetBkMode(mem, TRANSPARENT);

  const int pad = ScaleForDpi(hwnd, 14);
  const int title_size = ScaleForDpi(hwnd, 15);
  const int body_size = ScaleForDpi(hwnd, 13);

  HFONT title_font = CreateFontW(
      -title_size, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
      DEFAULT_CHARSET, OUT_TT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
      DEFAULT_PITCH, L"Segoe UI");
  HFONT body_font = CreateFontW(
      -body_size, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
      OUT_TT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH,
      L"Segoe UI");

  // 标题
  HGDIOBJ old_font = SelectObject(mem, title_font);
  SetTextColor(mem, RGB(0xFF, 0xFF, 0xFF));
  RECT title_rect = {pad + bar, pad, width - pad, pad + title_size + 6};
  DrawTextW(mem, g_title.c_str(), -1, &title_rect,
            DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);

  // 正文（最多三行，超出省略）
  SelectObject(mem, body_font);
  SetTextColor(mem, RGB(0xB8, 0xB8, 0xB8));
  RECT body_rect = {pad + bar, pad + title_size + ScaleForDpi(hwnd, 8),
                    width - pad, height - pad};
  DrawTextW(mem, g_body.c_str(), -1, &body_rect,
            DT_LEFT | DT_WORDBREAK | DT_END_ELLIPSIS | DT_NOPREFIX);

  SelectObject(mem, old_font);
  DeleteObject(title_font);
  DeleteObject(body_font);

  BitBlt(dc, 0, 0, width, height, mem, 0, 0, SRCCOPY);

  SelectObject(mem, old_bitmap);
  DeleteObject(bitmap);
  DeleteDC(mem);
  EndPaint(hwnd, &ps);
}

// 主窗口被最小化时，SetForegroundWindow 不能直接生效，
// 需要先 Restore 才能把它带到前台。
void ActivateOwner() {
  if (!g_owner || !IsWindow(g_owner)) return;
  if (IsIconic(g_owner)) {
    ShowWindow(g_owner, SW_RESTORE);
  } else {
    ShowWindow(g_owner, SW_SHOW);
  }
  SetForegroundWindow(g_owner);
}

LRESULT CALLBACK ToastProc(HWND hwnd, UINT message, WPARAM wparam,
                           LPARAM lparam) {
  switch (message) {
    case WM_PAINT:
      PaintToast(hwnd);
      return 0;

    case WM_LBUTTONUP:
      ActivateOwner();
      DestroyWindow(hwnd);
      return 0;

    case WM_TIMER:
      if (wparam == kAutoCloseTimerId) {
        DestroyWindow(hwnd);
      }
      return 0;

    case WM_DESTROY:
      KillTimer(hwnd, kAutoCloseTimerId);
      g_toast = nullptr;
      return 0;

    default:
      break;
  }
  return DefWindowProcW(hwnd, message, wparam, lparam);
}

void EnsureClassRegistered() {
  static bool registered = false;
  if (registered) return;

  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(WNDCLASSEXW);
  wc.lpfnWndProc = ToastProc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.hCursor = LoadCursorW(nullptr, IDC_HAND);
  wc.lpszClassName = kToastClassName;
  RegisterClassExW(&wc);
  registered = true;
}

}  // namespace

void ShowToastWindow(HWND owner, const std::wstring& title,
                     const std::wstring& body) {
  g_owner = owner;
  g_title = title;
  g_body = body;

  EnsureClassRegistered();

  // 已有卡片：先销毁，重新弹（连续来消息时以最新一条为准）
  if (g_toast && IsWindow(g_toast)) {
    DestroyWindow(g_toast);
    g_toast = nullptr;
  }

  // 位置：工作区右下角（排除任务栏）
  RECT work = {};
  SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);

  // 先用 96 DPI 估算尺寸，创建窗口后再按实际 DPI 修正
  int width = kToastWidthDip;
  int height = kToastHeightDip;
  int margin = kMarginDip;

  int x = work.right - width - margin;
  int y = work.bottom - height - margin;

  g_toast = CreateWindowExW(
      WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW, kToastClassName,
      L"", WS_POPUP, x, y, width, height, nullptr, nullptr,
      GetModuleHandleW(nullptr), nullptr);

  if (!g_toast) return;

  // 按实际 DPI 重新计算尺寸与位置
  width = ScaleForDpi(g_toast, kToastWidthDip);
  height = ScaleForDpi(g_toast, kToastHeightDip);
  margin = ScaleForDpi(g_toast, kMarginDip);
  x = work.right - width - margin;
  y = work.bottom - height - margin;
  SetWindowPos(g_toast, HWND_TOPMOST, x, y, width, height,
               SWP_NOACTIVATE | SWP_SHOWWINDOW);

  // 圆角：壁纸透出来
  const int radius = ScaleForDpi(g_toast, 12);
  HRGN region = CreateRoundRectRgn(0, 0, width + 1, height + 1, radius * 2,
                                   radius * 2);
  SetWindowRgn(g_toast, region, TRUE);
  // SetWindowRgn 成功后 region 归系统所有，不要 DeleteObject

  SetTimer(g_toast, kAutoCloseTimerId, kAutoCloseMs, nullptr);
  InvalidateRect(g_toast, nullptr, FALSE);
  UpdateWindow(g_toast);
}

void DestroyToastWindow() {
  if (g_toast && IsWindow(g_toast)) {
    DestroyWindow(g_toast);
  }
  g_toast = nullptr;
}
