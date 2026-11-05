#ifndef RUNNER_TRAY_ICON_H_
#define RUNNER_TRAY_ICON_H_

#include <windows.h>

// ============================================================
// 系统托盘图标
// ------------------------------------------------------------
// 用途：微信/QQ 的行为——点 X 窗口消失，但程序还在后台收消息，
// 托盘图标一直在，点它能拉回窗口，右键能真正退出。
//
// 为什么必须自己做：
//   窗口隐藏后任务栏按钮也跟着消失，用户就完全找不到应用了。
//   托盘图标是「后台驻留」唯一的可见入口。
//
// 实现要点：
//   · Shell_NotifyIconW(NIM_ADD/NIM_MODIFY/NIM_DELETE)
//   · 回调消息 WM_TRAYICON 由主窗口 MessageHandler 处理
//   · 双击托盘 = 显示窗口；右键 = 菜单（显示 / 退出）
//   · NIF_TIP 显示气泡提示（可用来展示未读数）
// ============================================================

// 托盘回调消息（主窗口 MessageHandler 里 case 这个）
constexpr UINT WM_TRAYICON = WM_APP + 1;

// 显示/更新托盘图标。已存在时只更新提示文字。
// @param tip 鼠标悬停提示（如「Chat — 3 条未读」）
bool ShowTrayIcon(HWND owner, const wchar_t* tip);

// 移除托盘图标。退出前必须调用，否则任务栏会留下一个「幽灵图标」
// （鼠标划过才消失，用户看着像程序坏了）。
void RemoveTrayIcon();

// 托盘是否已创建
bool IsTrayIconActive();

// 处理托盘回调（在 MessageHandler 里调用）。稳妥起见传入 click 消息类型。
// 返回 true 表示已处理。
bool HandleTrayMessage(HWND owner, LPARAM lparam);

#endif  // RUNNER_TRAY_ICON_H_
