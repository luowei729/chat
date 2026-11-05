# DEVTIPS.md — 长期开发提示

> 只记录会反复踩的坑与已验证的结论。每条注明北京时间。

---

## 一、客户端技术栈（2026-11-05 定版）

- 客户端是 **Flutter 3.35.7 / Dart 3.9.2**，代码在 `apps/client`。
- 历史原因保留一段记录：原实现基于 Lynx（ReactLynx），2026-11-05 已整体迁移到 Flutter
  并删除。**不要再用 Lynx**，原因是引擎本身缺能力：
  没有 WebSocket、没有 WebRTC、没有 Storage API，
  `scroll-view` 会吞子元素点击、`flex:1` 会塌陷、原生桥接只能可靠传字符串。
  这些问题导致当时大量 bug 只能靠手写补丁绕过（4,718 行 Kotlin + 15,000 行 TSX）。
- 现在这些能力都由成熟插件承担：
  WebSocket → `web_socket_channel`；WebRTC → `flutter_webrtc`；
  存储 → `shared_preferences`；相机/相册 → `image_picker`；
  文件 → `file_picker`；录音 → `record`；音频播放 → `just_audio`；视频 → `video_player`。

## 二、跨端铁律

- 客户端**一套 Flutter 代码**覆盖 Android / iOS / Windows / macOS。
- **鸿蒙用 SIG 分支**：`openharmony-sig/flutter_flutter` 的 `oh-<版本>-release`，
  必须与标准 Flutter 版本号对齐（当前 3.35.7 对 `oh-3.35.7-release`）。
  仓库已从 gitee 迁到 **gitcode.com**，gitee 那个是归档的旧地址。
- 鸿蒙不是官方主线，插件需要 ohos 适配版（见 `openharmony-sig/flutter_packages`），
  涉及 `flutter_webrtc` / `record` / `image_picker` 时要逐个确认真机可用。
- 构建一律走 GitHub Actions：`.github/workflows/flutter.yml`
  负责 Android/iOS/macOS/Windows；鸿蒙只能在有 OpenHarmony SDK 的机器上打（步骤见
  `apps/client/README.md`）。
- **`permission_handler` 13.x 与 Kotlin 2.1 不兼容**
  （其 `android/build.gradle.kts` 用了 `compilerOptions`，直接让整个构建失败）。
  本项目不需要它：`record` 自带麦克风权限、`image_picker`/`file_picker` 走系统选择器。

---

## 三、通话架构（2026-10-29 定版）

- **首版只做语音**，P2P Mesh，最多 8 人。
- 服务器**零媒体转发**，只转发 JSON 信令 → 2C1.8G 完全够用。
- 视频通话需 SFU（mediasoup/LiveKit）+ 4C8G，排到 M6。
- 8 人语音：每端 7 条 PeerConnection，上行 ~280kbps，CPU <2%。
- 锁屏后台：Android 前台服务 / iOS CallKit+UIBackgroundModes:audio / 鸿蒙 VOIP 长时任务（API 13+）。

## 四、TURN 配置要点（已踩坑）

- **必须用临时凭据**（`use-auth-secret` + `static-auth-secret`），静态 `user=xxx:yyy` 等于公开账号。
- 凭据格式：`username = "<过期时间戳>:<用户id>"`，`credential = base64(HMAC-SHA1(secret, username))`。
- 服务器是阿里云 NAT 环境，**必须配 `external-ip=公网IP/内网IP`**，否则中继地址错误。
- 必须配 `denied-peer-ip` 内网段黑名单，否则 TURN 会被当内网穿透跳板。
- **UDP 443 被 OpenResty 的 HTTP/3 占用**，无法给 TURN 复用；`turns:` 只能走 5349。
- 测试命令：`turnutils_uclient -u <user> -w <pass> -p 3478 -y 127.0.0.1`，看到 `relay addr` 即成功。

## 五、443 反代架构（已实测）

- Node **只监听 127.0.0.1:8787**，不对外暴露端口。
- `/api/*` → Fastify；`/ws` → WebSocket；`/` → 静态 SPA。
- `/_internal_media/` 是 `internal` location，只能由 `X-Accel-Redirect` 触发，外部无法直接访问。
- WebSocket 必须用 **HTTP/1.1** 升级，HTTP/2 下 curl 测不通是正常现象（客户端会自动降级）。
- 媒体文件由 OpenResty 直发，Node 不参与传输 → 200MB 视频不占 Node 内存。

## 六、服务器限制（硬约束）

- 2 核 / 1.8G 内存（可用仅 ~300MB）/ 39G 磁盘。
- **绝不在服务器上编译任何前端项目**，全部走 GitHub Actions。
- 无 `mysql` 客户端，必须用 `docker exec -i 1Panel-mysql-m8de mysql ...`。
- 无 `docker compose`。
- 重载 OpenResty：`docker exec 1Panel-openresty-k8Im nginx -t && docker exec 1Panel-openresty-k8Im nginx -s reload`。

## 七、国内网络现实

- 国内 Android **无 GMS，FCM 不可用**，必须接厂商推送（华为/小米/OPPO/vivo）。
- App 被杀后来电响铃 = 厂商推送 + CallKit/ConnectionService，这是最贵的一块。
- `raw.githubusercontent.com` 在国内本机不可达，用 `api.github.com` 的 contents API 替代。

## 八、编码约定

- 消息 `clientId` 幂等：网络重试不会产生重复消息。
- 消息 `seq` 会话内单调递增，用 `UPDATE ... last_seq+1` + 行锁分配，不能用 `count(*)`。
- 验证码只存 HMAC 哈希，不存明文（6 位数字不加密钥等于明文）。
- 附件内容寻址存储（sha256 路径），相同文件只存一份。
- 所有时间存 bigint 毫秒时间戳，跨时区无歧义。
