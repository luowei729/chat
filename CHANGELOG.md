# CHANGELOG.md — 变更日志

> 所有时间均为北京时间（UTC+8）。

## 2026-11-05

### ★ 客户端迁移到 Flutter（v3.0 客户端）

**决策背景**：Lynx 引擎缺 WebSocket / WebRTC / Storage，
`scroll-view` 吞点击、`flex:1` 塌陷、原生桥接只能可靠传字符串。
这些问题导致大量功能只能靠手写补丁绕过（15,000 行 TSX + 4,718 行 Kotlin），
仍不断出现新 bug。经确认后整体迁移到 Flutter，**后端与契约层零改动**。

- 新增 `apps/client`（Flutter 3.35.7 / Dart 3.9.2），一套代码覆盖
  Android / iOS / Windows / macOS；鸿蒙走 SIG 分支 `oh-3.35.7-release`
- 删除旧 Lynx 客户端 `apps/app` 与 `android.yml`
- 新增 `.github/workflows/flutter.yml`：Android/iOS/macOS/Windows 四平台构建
- 新增 `docs/HARMONY.md`：鸿蒙插件适配现状与缺口（`flutter_webrtc`、`record`
  无 ohos 实现，需 ArkTS 补齐），代码里用 `Capabilities` 做能力降级

### v3.0.0 — 功能验证与缺陷修复

- **服务端修复：同一文件第二次发送必然失败**
  上传按 sha256 全局去重，第二次上传返回的是「已绑定消息」的旧附件行，
  发送时命中 `ATTACHMENT_ALREADY_BOUND`（附件已被使用）。
  改为只复用「同上传者 + 未绑定」的附件行；物理文件仍按 sha256 只存一份。
  顺带修掉「A 传过的文件 B 上传后拿到 A 的附件行，发送报不能引用他人附件」。
- **语音气泡波形不可见**：柱子用 `Expanded` 均分，2″ 短语音下每根不足 1px。
  改为按可用宽度反算柱数 + 固定 2.5px 柱宽，气泡最小宽度提到 170。
- **通话页向用户暴露内部枚举**（`RTCPeerConnectionStateConnected`），
  改为只显示「已接通」/「网络重连中…」。
- 发送失败不再静默：新增 `ChatStore.lastSendError`，气泡可看到真实原因。
- 新增集成测试 `integration_test/media_test.dart`：图片/视频/文件/语音
  四条链路在真机上跑真实插件与真实网络，验证上传元数据（宽高/时长/波形）
  全部落库。

**实测结果（Android 14 模拟器）**
- 媒体：4/4 通过（图片宽高、视频时长 3000ms、文件 45B、语音波形均正确持久化）
- 通话：B→A 呼叫、A 接听、P2P `connected`、双向计时、静音切换、
  挂断双端同步退出，全部正常
- 真实录音（按住说话）验证通过，上传 11.5KB m4a 并正确显示波形

## 2026-10-31

### v2.5.0 — 聊天滚动 + 语音通话可用

- **聊天页/会话/联系人改用 scroll-view 真实滚动**（之前普通 view 只能看最新一屏）
- **新增 Android 原生通话桥 ChatRtc**（WebRTC 麦克风+P2P），接听不再报「不支持语音通话」
- **主叫方接通后补启动本地音频并建连**（之前主叫全程零媒体）
- **服务端振铃超时广播 missed**（之前两端界面卡死在呼叫中）
- 主叫 50 秒无应答自动挂断保护

## 2026-10-29

### ★ 项目完全重构（v3.0）

**决策背景**：用户要求推翻原 PHP 单文件站点，基于 Lynx 重写为跨端聊天 App。

- **[2026-10-29 13:31] 清空旧项目**
  - 用户手动清空 `/opt/1panel/www/sites/chat.lkz.pub/index`
  - 从 1Panel 备份包恢复 SSL 证书（Let's Encrypt，有效期至 2027-01-22）
  - 重写 OpenResty 站点配置：移除 PHP-FPM，改为「静态 SPA + Node 反代」

- **[2026-10-29 13:38] 数据库**
  - 在现有 MySQL 8.4 容器中新建 `chat2` 库（utf8mb4_0900_ai_ci）
  - 创建专用账号 `chat2`，避免使用 root
  - 生成 12 张表：users/email_codes/invite_codes/invite_usages/refresh_tokens/conversations/conversation_members/messages/attachments/call_sessions/call_participants/push_tokens

- **[2026-10-29 13:38] 443 反代架构**
  - `proxy/api.conf`：`/api/*` → Fastify，`/ws` → WebSocket，`/_internal_media/` 内部媒体
  - `rewrite/chat.lkz.pub.conf`：SPA history 模式回退
  - 实测通过：HTTPS API ✅、WSS 握手 101 ✅

- **[2026-10-29 14:00] 技术选型确认**
  - 客户端：ReactLynx（`@lynx-js/react 0.129`），非 Vue（`vue-lynx` 为个人 pre-alpha 仓库）
  - 后端：Node 22 + Fastify 5 + Drizzle + MySQL
  - 桌面端：Electron
  - 编译：GitHub Actions（服务器不做编译）

- **[2026-10-29 14:20] Lynx WebRTC 能力核实**
  - 检索 Lynx 内核 14235 个文件、lynx-examples 2198 个、lynx-stack 10867 个：**WebRTC 命中 0**
  - 确认 Lynx 无内置 WebRTC API，需走 `<webview>` 或原生模块
  - 确认 Lynx 官方支持 Android/iOS/Harmony 的 `<webview>` 元素

- **[2026-10-29 14:30] 通话架构降级（关键决策）**
  - 用户选择「降低服务器要求，先做语音通话」
  - 从 SFU（mediasoup，需 4C8G）改为 **P2P Mesh**（现有 2C1.8G 够用）
  - 8 人语音：每端上行 ~280kbps，服务器 CPU <2%
  - 移除 mediasoup 依赖，信令协议从 `call.sfu` 改为 `call.p2p`

- **[2026-10-29 14:35] TURN 加固**
  - coturn 从静态账号密码改为 **TURN REST API 临时凭据**（HMAC-SHA1，24h 有效）
  - 新增 `denied-peer-ip` 内网段黑名单，防内网穿透
  - 新增配额限制：`user-quota=12`、`total-quota=100`
  - 实测：临时凭据认证通过，中继地址正常分配

- **[2026-10-29 14:40] 后端实现完成**
  - `packages/shared`：类型/校验/错误码/WS 协议（唯一契约真相源）
  - `apps/server`：配置/DB/认证/邀请/会话/消息/上传/通话/推送/WS 网关
  - 类型检查通过（`tsc --noEmit` 零错误）
  - 端到端测试通过：注册 ✅ 登录 ✅ 建会话 ✅ 发消息 ✅ 幂等 ✅ 拉取 ✅ 会话列表 ✅ ICE 配置 ✅

- **[2026-10-29 14:44] SMTP 修复**
  - Zoho 密码更正为 `782094.Asdf`，认证通过
  - 实测邮件发送成功（`delivered: true`）

- **[2026-10-29 14:50] 项目文档重建**
  - 重写 `AGENTS.md` / `PROJECT_PLAN.md` / `CHANGELOG.md` / `DEVTIPS.md`
