# 鸿蒙（OpenHarmony / HarmonyOS）适配说明

> 本文记录**已核实**的事实与缺口，不写推测。
> 核实时间：2026-11-05。

## 一、构建链

鸿蒙版 Flutter 是 **SIG 分支**，不是官方主线：

| 项 | 值 |
|---|---|
| 仓库 | `https://gitcode.com/openharmony-sig/flutter_flutter`（gitee 旧仓已归档） |
| 分支 | `oh-3.35.7-release`（与标准 Flutter 3.35.7 版本号对齐） |
| 社区插件仓 | `https://gitcode.com/CPF-Flutter/flutter_packages`（原 `openharmony-tpc/flutter_packages`） |
| 产物 | `flutter build hap --release --target-platform ohos-arm64` → `.hap` |

构建步骤见 `apps/client/README.md` 的 HarmonyOS 章节。

## 二、插件适配现状（决定功能边界）

### 已适配（Flutter 3.35 对应版本）

| 插件 | ohos 版本 | 用途 |
|---|---|---|
| `shared_preferences` | 2.5.4 | 令牌 / 设备 id / 主题 |
| `path_provider` | 2.1.5 | 临时文件目录 |
| `image_picker` | 1.2.1 | 相册 / 拍照 |
| `video_player` | 2.10.1 | 视频播放 |
| `file_selector` | 1.1.0 | 文件选择（**替代 file_picker**） |
| `camera` | 0.11.3 | 摄像头（本项目未用） |

### 纯 Dart，天然可用

`dio`、`web_socket_channel` —— 登录、聊天、消息、上传下载全部不受影响。

### **未适配（鸿蒙上的真实缺口）**

| 插件 | 缺失后果 |
|---|---|
| `flutter_webrtc` | **语音通话不可用**（官方仅支持 Android/iOS/Linux/macOS/Windows） |
| `record` | **语音消息录制不可用**（官方仅支持 Android/iOS/Linux/macOS/Web/Windows） |
| `just_audio` | 语音消息**播放**需要替代方案 |

结论：
- 鸿蒙端可以做到**文字 / 图片 / 视频 / 文件的完整收发**；
- **语音消息**与**语音通话**需要写 ArkTS 原生实现，不能靠现成插件。

## 三、语音能力的补齐路径

### 1) 语音消息（工作量小，1-2 天）

HarmonyOS 有 `@ohos.multimedia.media` 的 `AVRecorder` / `AVPlayer`：

1. 在 `ohos/entry/src/main/ets/plugins/` 写一个 `MethodChannel` handler：
   - `startRecord(path)` → `AVRecorder` 开始录音（m4a / AAC）
   - `stopRecord()` → 返回时长与振幅采样数组
   - `play(url)` / `stopPlay()` → `AVPlayer`
2. Dart 侧已有统一出口 `MediaService`，只要在鸿蒙分支换成 MethodChannel 调用，
   上层 `ChatStore` 与 UI 零改动。

### 2) 语音通话（工作量大，风险高）

三条路，按推荐顺序：

1. **等待 / 共建 ohos 版 flutter_webrtc**
   WebRTC 的 ohos 移植是社区在做但未完成的硬骨头（涉及 C++ 引擎编译）。
2. **用 HarmonyOS 原生 RTC 能力**
   华为提供 `@ohos.multimedia.avsession` 与第三方 RTC SDK（如华为云 RTC、
   声网鸿蒙版），通过 MethodChannel 桥接。**需要引入商业 SDK**。
3. **鸿蒙端降级为「仅文字/媒体聊天」**
   通话按钮在鸿蒙隐藏（见第四节的能力开关），等平台能力就绪再补。

## 四、代码里的能力开关

`apps/client/lib/core/capabilities.dart` 定义了平台能力探测：

```dart
Capabilities.canVoiceCall   // 鸿蒙 = false
Capabilities.canVoiceMessage
Capabilities.canPickMedia
```

UI 依据这些开关**隐藏而不是报错**——用户看到的是「这个平台没有该功能」，
而不是点了没反应。

## 五、验证清单（有设备时按此顺序）

- [ ] `flutter build hap --release` 成功，`.hap` 能装到真机
- [ ] 登录、会话列表、聊天收发（纯 Dart 链路）
- [ ] 相册选图 → 上传 → 气泡显示
- [ ] 视频选择 → 上传 → 播放
- [ ] 文件选择 → 上传 → 下载
- [ ] 语音消息（需先补齐 ArkTS 录音）
- [ ] 语音通话（需先补齐 RTC）
