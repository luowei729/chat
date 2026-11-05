# Chat 客户端（Flutter）

跨平台即时通讯客户端：**Android / iOS / Windows / macOS / HarmonyOS** 一套代码。

## 为什么从 Lynx 迁到 Flutter

原实现基于 Lynx（ReactLynx），核心功能虽然跑通，但引擎本身缺能力，
导致大量问题只能靠手写补丁绕过：

| 能力 | Lynx | Flutter |
|---|---|---|
| WebSocket | ❌ 引擎没有 | ✅ `web_socket_channel` |
| WebRTC | ❌ 引擎没有 | ✅ `flutter_webrtc`（全平台） |
| 本地存储 | ❌ 无 Storage API | ✅ `shared_preferences` |
| 列表滚动 | ⚠️ `scroll-view` 吞点击 | ✅ `ListView` 原生可靠 |
| 布局 | ⚠️ `flex:1` 会塌陷、命中区错位 | ✅ 标准 Flex |
| 桥接传参 | ⚠️ 嵌套 Map 丢失、只能传字符串 | ✅ 无桥接 |
| 生态 | 几乎为零 | ✅ pub.dev |

迁移后删掉了 **4,718 行手写 Kotlin**（相机/录音/上传/WS/RTC/存储桥），
全部由成熟插件替代。

## 目录结构

```
lib/
  core/        配置、HTTP 客户端、本地存储、数据模型
  services/    WS、会话状态、媒体、通话
  ui/          主题、页面、组件
```

分层原则：
- `core` 不依赖 UI，可单独测试；
- `services` 是单一数据源（`ChangeNotifier`），页面只订阅不推断；
- `ui` 不做业务判断，只渲染状态 + 转发用户意图。

## 关键实现说明

### 令牌与设备
- 所有请求带 `x-device-id`：服务端把刷新令牌绑定在设备上，
  id 变化会导致刷新失败、用户被踢下线；
- 访问令牌提前 60 秒刷新；刷新失败才清登录态。

### WebSocket
- 任何断开（`onError` / `onDone` / 心跳超时）都触发重连，指数退避；
- 重连前先刷新令牌；
- 重连成功后重新订阅会话并拉一次增量——服务端不补推断线期间的消息。

### 消息
- 乐观更新：发送立刻上屏（`sending` + 进度），成功后替换为服务端消息；
- 按 `clientId` 去重，网络重试/回声不会产生重复气泡；
- 撤回保留占位（`seq` 不能断），删除只影响本机。

### 通话
- 服务端只转发信令，媒体 P2P（ICE 不通走 TURN）；
- 角色规则：**已在通话中的人发 offer，新加入者只应答**（避免 glare）；
- 挂断必须显式 `stop()` 所有音轨，否则麦克风指示灯常亮。

## 本地开发

```bash
flutter pub get
flutter analyze
flutter run -d <device>
```

## 打包

### Android
```bash
flutter build apk --release
# 产物 build/app/outputs/flutter-apk/app-release.apk
```

### iOS
```bash
flutter build ios --release --no-codesign
# 上架需要签名证书 + provisioning profile
```

### Windows / macOS
```bash
flutter build windows --release
flutter build macos --release
```

### HarmonyOS（OpenHarmony）

需要 **OpenHarmony SDK** 与 DevEco 工具链，且要使用
`openharmony-sig/flutter_flutter` 的对应分支（与标准 Flutter 版本对齐）：

```bash
# 1. 取鸿蒙版 Flutter SDK（与 3.35.7 对齐的 release 分支）
git clone -b oh-3.35.7-release https://gitcode.com/openharmony-sig/flutter_flutter.git

# 2. 环境变量
export PATH=<flutter_flutter>/bin:$PATH
export TOOL_HOME=<DevEco Studio 目录>
export DEVECO_SDK_HOME=$TOOL_HOME/sdk
export PATH=$TOOL_HOME/tools/ohpm/bin:$PATH
export PATH=$TOOL_HOME/tools/hvigor/bin:$PATH
export PATH=$TOOL_HOME/tools/node/bin:$PATH

# 3. 生成 ohos 平台目录
flutter create --platforms ohos .

# 4. 构建 HAP
flutter build hap --release --target-platform ohos-arm64
```

注意事项：
- 鸿蒙版 Flutter 是 SIG 分支，**不是官方主线**；
- 部分插件需要鸿蒙适配版本（见 `openharmony-sig/flutter_packages`），
  当前依赖里 `flutter_webrtc` / `record` / `image_picker` 需要确认是否有 ohos 实现；
- 建议在真机上验证后再对外发布。

## 服务端

后端（`apps/server`）无需任何改动，接口契约见
`packages/shared/src/types.ts` 与 `ws.ts`。
