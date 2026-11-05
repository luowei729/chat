#ifndef RUNNER_WINDOW_STATE_H_
#define RUNNER_WINDOW_STATE_H_

#include <windows.h>

#include <string>

// ============================================================
// 窗口位置/尺寸持久化
// ------------------------------------------------------------
// 为什么放在原生层而不是 Dart：
//   Flutter 的窗口在 Dart 首帧之前就已经被创建并显示，
//   如果等 Dart 起来再调 setState 调整窗口，用户会看到明显的跳变。
//   在 wWinMain 里直接按上次的尺寸创建窗口才是无缝的。
//
// 为什么不用 window_manager 插件：
//   多一个原生依赖，且它同样要等 Dart 侧调用；
//   这里只需要「记住尺寸」一件事，几十行 Win32 就够。
//
// 存储位置：%LOCALAPPDATA%\Chat\window.txt
//   纯文本一行 "x y width height maximized"，不引入 JSON 依赖。
//   按用户隔离，卸载重装仍保留（符合直觉）。
// ============================================================
struct WindowPlacement {
  int x = 0;
  int y = 0;
  int width = 1280;
  int height = 720;
  bool maximized = false;
};

// 读取上次的窗口位置；文件不存在或内容非法时返回 false（用默认值）
bool LoadWindowPlacement(WindowPlacement* out);

// 保存当前窗口位置。窗口必须仍然有效（在 WM_CLOSE 里调用）。
void SaveWindowPlacement(HWND hwnd);

#endif  // RUNNER_WINDOW_STATE_H_
