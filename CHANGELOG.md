# CHANGELOG.md — 变更日志

> 所有时间均为北京时间（UTC+8）。

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
