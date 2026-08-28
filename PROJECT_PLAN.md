# chat — 项目开发方案

> 版本: v2.1
> 创建: 2026-08-23 北京时间
> 最后更新: 2026-08-28 10:15 北京时间
> 状态: **线上运行中** — Web聊天稳定，三端 App Phase 0 就绪；Node 已升至 22；App 内已去 Turnstile

---

## 一、项目概述

### 1.1 定位
轻量临时 Web 聊天 / 文件传输（chat），单 PHP 文件直出，无数据库，文件存储于 `chat_data/` + `uploads/`，支持文字/图片/视频/文件/语音条 + WebRTC 多人实时语音（`voice-server.js` WS 信令，PHP 文件轮询兜底），Cloudflare Turnstile 人机验证，7天自动清理，`.htaccess` 伪静态 `/:id`。

### 1.2 运行环境
Ubuntu 22.04 / PHP + Apache / Node 22.23.2（2026-08-28 已从 12.22.9 升级，voice-server 已验证）/ 域名 `https://chat.lkz.pub`（固定）

---

## 二、系统架构

```
浏览器 ──HTTPS──> index.php (PHP直出HTML+CSS+JS, 4630行)
   │                ├─ Turnstile 验证 + Cookie 鉴权
   │                ├─ chat_data/*.json + uploads/*  (文件存储)
   │                └─ rtc_*.json 信令文件轮询  ─┐
   │                                              │
   └──WSS──> voice-server.js:3001 (WS信令主链路) ─┘
                └─ RTCPeerConnection / getUserMedia / MediaRecorder
```

后端接口（`POST action=`）：`send_message / upload_file / upload_voice / get_messages / delete_message / rtc_signal / rtc_poll / check_creator_status / get_remaining_time`

---

## 三、三端 App 架构（2026-08-28 新增）

> 详见 `docs/APP_PLAN.md`，此处仅摘要，根目录不展开

- **目标**：一套代码产出 Android / iOS / HarmonyOS NEXT 三端包，放在 `/app`，复用现有后端零改动
- **选型**：**uni-app x (Vue3+UTS) 主方案**，uni-app 次选；唯一官宣同时编译到鸿蒙 NEXT 的成熟方案，HBuilderX 云打包无需本地 Mac 即可出 ipa/app
- **演进**：Phase 0 web-view 壳直载线上站(已完成) → Phase 1 混合(首页原生) → Phase 2 全原生化 → Phase 3 鸿蒙上架
- **目录**：`/app/manifest.json + pages.json + App.vue + pages/index/index.vue + pages/chat/chat.vue(web-view) + static/logo.svg`
- **关键点**：权限 `RECORD_AUDIO/CAMERA/READ_MEDIA_*`，鸿蒙 `app-harmony bundleName pub.lkz.chat minAPIVersion 12`，Turnstile：Web 保留，App 已去除（`hasValidAppToken` 白名单，`pages/chat/chat.vue` 自动带 `?app_token`）
- **打包**：HBuilderX 发行→原生App-云打包 → apk/aab / ipa / app；待确认：包名、应用名称、Apple/华为开发者账号、是否上架商店

---

## 四、后续计划
- [x] Phase 0 三端壳就绪（2026-08-28 08:58）
- [x] 应用名统一为 `chat`（2026-08-28 10:15）
- [x] 域名固定 `https://chat.lkz.pub`（2026-08-28 10:15）
- [x] 后端 `APP_TOKEN` 白名单已落地，App 内已去 Turnstile（`hasValidAppToken()` + `?app_token`，2026-08-28 10:15）
- [x] Node 从 12.22.9 升级至 22.23.2 并重启 `voice-server.service` 验证 `curl /health → ok`（2026-08-28 10:07）
- [ ] HBuilderX 云打包验证三端安装（需上传 Apple/华为证书后执行）
- [ ] Phase 1/2 渐进原生化（按需）

*本文档精简，详细 App 规划见 `docs/APP_PLAN.md`，App 使用说明见 `app/README.md`。*
