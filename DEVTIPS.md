# DEVTIPS.md — 长期开发提示

> 只记录会反复踩的坑与已验证的结论。每条注明北京时间。

---

## 一、Lynx 能力边界（2026-10-29 核实，务必牢记）

- **Lynx 没有任何 WebRTC API**。已检索内核 14235 文件、lynx-examples 2198、lynx-stack 10867，命中 0。
- Lynx 内置 JS 模块仅有：`animation` `element` `event` `fetch` `nativeModules`(exposure/intersectionObserver/textInfo) `performance` `report` `selectorQuery` `sharedData`。
- **没有** media / camera / recorder / rtc 模块。
- WebRTC 只能通过两条路：① `<webview>` 加载 H5；② 写原生模块（`create-lynx-library` 的 `template-native-module`）。
- Lynx 官方 `<webview>` 元素支持 **Android / iOS / Harmony** 三端，支持 `src` `html` `bindmessage` `eval`。

## 二、框架选型铁律

- 客户端**只能用 ReactLynx**（`@lynx-js/react`，官方维护，2026-10-23 更新）。
- **不要用 `vue-lynx`**：个人仓库 `Huxpro/vue-lynx`，pre-alpha 血统，官方 UI 库/DevTool/文档全不覆盖。
- 官方组件库 `@lynx-js/lynx-ui`，构建工具 `@lynx-js/rspeedy`。

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

## 九、Lynx 构建与黑屏排查（2026-10-29 15:55 北京时间，实战验证）

- **黑屏第一大坑：缺 `pluginReactLynx()`**
  - Rspeedy 内置 `pluginLynx`（生成 `.bundle`），但**不内置** `@lynx-js/react-rsbuild-plugin`
  - 缺它时 `rspeedy build` 会「成功」，但产物只是普通 webpack JS（`dist/static/js/main.*.js`），
    Lynx 加载不到模板 → 黑屏
  - 必须装 `@lynx-js/react-rsbuild-plugin` 并在 `lynx.config.ts` 的 `plugins` 里注册
  - 正确产物：`dist/chat.lynx.bundle`（二进制 Lepus 模板，头部 `0.2.0.0` + 版本号）

- **黑屏第二大坑：根节点用 `<view>` 而非 `<page>`**
  - Lynx 的 `<page>` 提供全屏高度参照
  - 用 `<view style={{height:'100%'}}>` 会因无父高度参照而塌陷为 0 → 黑屏
  - 所有页面最外层必须是 `<page>`，内部再用 `<view>`

- **必须 `output.dataUriLimit: Infinity`**：Lynx 不支持用 URL 加载本地资源，图片要内联

- **APK 体积**：WebRTC 的 `libjingle_peerconnection_so.so` 单架构 6-12MB、`liblynx.so` 6-7MB
  - 打全 4 架构 = 109MB；只打 `arm64-v8a + armeabi-v7a` = 50MB
  - 模拟器调试用 `-PabiFilters=x86_64` 覆盖

- **黑屏排查套路**：
  1. `unzip -l app.apk | grep assets/` 确认 bundle 真的打进去了
  2. `head -c 20 bundle` 看是否二进制模板（`b\xb6"$0.2.0.0`），若是 `(()=>{` 说明是纯 JS，配置错了
  3. `adb logcat | grep -E "Lynx|MainActivity"` 看 bundle 加载字节数与渲染错误
  4. MainActivity 已加 3 秒 `childCount==0` 检查，失败会显示可读错误而非黑屏
