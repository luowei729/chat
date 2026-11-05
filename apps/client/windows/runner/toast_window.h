#ifndef RUNNER_TOAST_WINDOW_H_
#define RUNNER_TOAST_WINDOW_H_

#include <windows.h>

#include <string>

// ============================================================
// 右下角通知卡片（仿 Telegram 风格）
// ------------------------------------------------------------
// 为什么自己做而不是用系统 Toast：
//   1. Windows 的系统 Toast 需要注册 AUMID + 快捷方式，
//      未打包的 exe（我们发的就是 zip/exe 安装版）经常弹不出来，
//      或者归到「Windows PowerShell」名下，看起来像广告软件；
//   2. 自己做可以精确控制位置（右下角）、时长、点击行为，
//      而且不需要任何第三方依赖或 COM 注册。
//
// 实现要点：
//   · WS_POPUP + WS_EX_TOPMOST + WS_EX_NOACTIVATE + WS_EX_TOOLWINDOW
//     —— 不进任务栏、不抢焦点（游戏/全屏时不会被打断）；
//   · SetWindowRgn 做圆角，壁纸透出来，观感接近原生；
//   · GDI 绘制，避免引入 Direct2D 依赖；
//   · 5 秒后自动消失，点击卡片回到主窗口。
//
// 文本由 Dart 侧传入（不在 C++ 里写中文，避免源文件编码问题）。
// ============================================================

// 弹出通知卡片；owner 用于点击后激活主窗口
void ShowToastWindow(HWND owner, const std::wstring& title,
                     const std::wstring& body);

// 立即销毁（退出时调用，避免残留窗口）
void DestroyToastWindow();

#endif  // RUNNER_TOAST_WINDOW_H_
