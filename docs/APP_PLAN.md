# chat — 三端 App 架构规划

> 版本: v1.1  
> 创建: 2026-08-28  北京时间  
> 最后更新: 2026-08-28 10:15 北京时间  
> 目录: `/opt/1panel/www/sites/chat.lkz.pub/index/app`  
> 目标: 一套代码同时产出 Android / iOS / HarmonyOS NEXT 三端 App，复用现有 `index.php + voice-server.js` 后端

---

## 一、现状盘点

| 项 | 现状 |
|---|---|
| 前端 | 单文件 `index.php` 4630 行，直出 HTML+CSS+JS，无构建，PHP 渲染 + 原生 JS |
| 后端 | PHP 文件存储 `chat_data/` + `uploads/`，Node `voice-server.js` WS 信令，PHP 文件轮询兜底 |
| 关键能力 | 文字/图片/视频/文件/语音条、WebRTC 多人实时语音（`RTCPeerConnection`）、`getUserMedia`、`MediaRecorder`、拖拽上传、Turnstile 人机验证、7天自动清理 |
| 域名 | `https://chat.lkz.pub`，已配置 `.htaccess` 伪静态 `/<id>` |
| 运行环境 | Ubuntu 22.04 / Node 22.23.2（已于 2026-08-28 从 12 升级，voice-server 已验证） |

**约束**：`index.php` 不可大改；鸿蒙 NEXT 无缝覆盖；审核要过；包体积小；工期短。

---

## 二、选型对比（安卓 + iOS + 鸿蒙 三端）

| 方案 | 安卓 | iOS | 鸿蒙 NEXT | 一套代码 | 包体积 | 团队学习 | 结论 |
|---|---|---|---|---|---|---|---|
| **A. uni-app x（Vue3 + UTS）** | ✅ | ✅ | ✅ 官方原生 | ✅ | 中 | 低（Vue） | ⭐ 推荐主方案 |
| **B. uni-app（Vue3 + JS）** | ✅ | ✅ | ✅ 适配层 | ✅ | 小 | 最低 | 次选，生态更成熟 |
| **C. Flutter + 鸿蒙分支** | ✅ | ✅ | ⚠️ 社区分支 `flutter_ohos` | ✅ | 大 | 高（Dart） | 不推荐，鸿蒙不官方 |
| **D. React Native + 鸿蒙适配** | ✅ | ✅ | ⚠️ 需 `react-native-harmony` | ✅ | 大 | 中 | 同上 |
| **E. 纯 WebView 壳（Capacitor/Cordova）** | ✅ | ✅ | ❌ 鸿蒙无 Capacitor | ❌ | 小 | 低 | 仅作兜底 |
| **F. 三套原生（ArkTS+Kotlin+Swift）** | ✅ | ✅ | ✅ | ❌ | 小 | 极高 | 维护地狱，否决 |

**结论：选 A 为主、B 为兜底。**  
国内唯一官宣“一套代码编译到 Android/iOS/鸿蒙 NEXT”的成熟方案就是 **DCloud uni-app 系**。其中 `uni-app x` 用 UTS 编译为原生，性能最接近原生；`uni-app` 用 JS 引擎，生态最全。两者可在 `app/` 中并存，`manifest.json` 同时配置。

> 参考：uni-app x 官网已支持 `h5` `app-android` `app-ios` `app-harmony` 四端；HBuilderX 一键云打包，无需本地 macOS 即可出 iOS 包。

---

## 三、总体架构

```
chat.lkz.pub (PHP + WS 3001)
        ▲  HTTPS / WSS
        │
┌───────┴────────────────────────────────┐
│  App (uni-app x / uni-app)              │
│  ┌─────────────┐  ┌──────────────────┐ │
│  │ 原生壳       │  │ 业务层（Vue3）    │ │
│  │ - 权限       │  │ - 首页/房间页     │ │
│  │ - 推送       │◄─┤ - 聊天室（复用   │ │
│  │ - 文件系统   │  │   现有 API）     │ │
│  │ - 录音/相机  │  │ - WebRTC 语音    │ │
│  └─────────────┘  └──────────────────┘ │
│  ┌──────────────────────────────────┐ │
│  │ 适配层                            │ │
│  │ web-view 兜底 → 渐进式原生化      │ │
│  └──────────────────────────────────┘ │
└──────────────────────────────────────┘
```

### 3.1 分阶段演进（渐进式原生化，避免一次性重写风险）

| 阶段 | 形态 | 说明 | 工期 |
|---|---|---|---|
| **Phase 0** | WebView 壳 | `web-view` 直接加载 `https://chat.lkz.pub/<id>`，App 仅提供权限/全屏/文件下载 | 1-2 天即可提测 |
| **Phase 1** | 混合 | 首页、房间列表用原生 Vue 页，聊天室仍用 `web-view`，JSBridge 互通 | 1 周 |
| **Phase 2** | 原生化 | 聊天室、消息列表、上传、语音条、WebRTC 全部用原生 Vue+UTS 重写，直连 PHP 接口 | 2-3 周 |
| **Phase 3** | 鸿蒙首发 | HBuilderX 云打包出 `app-harmony`，上架华为应用市场 | 同步 |

> 好处：Phase 0 立即可装机验证三端可行性，后续平滑升级，用户无感知。

### 3.2 前后端契约（保持后端零改动）

- 复用现有 PHP 接口：`action=send_message / upload_file / upload_voice / get_messages / delete_message / rtc_signal / rtc_poll`，全部 `POST` 表单。
- App 端用 `uni.request` / `uni.uploadFile` 直连，不改 PHP。
- 鉴权：**Web 保留 `TURNSTILE_COOKIE` + `chat_user_id`**；**App 已去 Turnstile**，通过 `APP_TOKEN` 白名单（`?app_token=` / `Header X-App-Token`）直接跳过 `requireTurnstileVerified()`，见 §5.2。

### 3.3 语音方案

- Phase 0：WebView 内继续用现有 `RTCPeerConnection`，App 壳只需在 `manifest.json` 声明 `RECORD_AUDIO` / `CAMERA` / `MODIFY_AUDIO_SETTINGS`，并在 `App.vue` 请求权限。
- Phase 2：改用 `uni.createInnerAudioContext` + 原生 `WebRTC` 插件（`uts` 封装），信令仍走 `voice-server.js` WS，失败回退 PHP 轮询。

---

## 四、目录规划（`/app`）

```
/app
├── README.md                 # 本目录说明 + 打包指南
├── docs/
│   └── APP_PLAN.md           # 本文（架构规划）
├── uniapp/                   # uni-app 项目根（HBuilderX 打开此目录）
│   ├── manifest.json         # 三端包名、权限、鸿蒙配置
│   ├── pages.json            # 路由
│   ├── vite.config.js        # 构建
│   ├── index.html
│   ├── App.vue
│   ├── pages/
│   │   ├── index/index.vue   # 首页（输入房间 / 随机创建）
│   │   └── chat/chat.vue     # 聊天室（Phase0: web-view 壳）
│   ├── static/
│   └── uni_modules/
└── scripts/
    ├── build.sh              # 一键云打包脚本（可选）
    └── icons/                # App 图标
```

也可将 `uniapp/` 内容直接平铺到 `app/` 根，当前采用平铺以简化 HBuilderX 识别。

---

## 五、关键细节与风险

### 5.1 鸿蒙 NEXT 特殊点
- `manifest.json` 需新增 `app-harmony` 节：`bundleName`、`minAPIVersion: 12`、`abilities`。
- 鸿蒙 WebView 组件为 `web`，`web-view` 会自动映射。
- 权限在 `module.json5` 中声明，HBuilderX 云打包自动生成。

### 5.2 Turnstile — App 内已去除
- **Web 端保留**：`index.php` 仍对浏览器执行 `requireTurnstileVerified()`（`TURNSTILE_ENABLED=true`）。
- **App 端已去除**：App 的 `web-view` 不再走 Turnstile。实现为后端白名单——`index.php` 新增常量 `APP_TOKEN` 与函数 `hasValidAppToken()`（认 `Header X-App-Token` / `?app_token=` / `POST app_token` / `Cookie app_token`，`hash_equals` 校验），命中则 `hasValidTurnstileCookie()` 直接返回 true。
- App 侧 `pages/chat/chat.vue` 已固定 `https://chat.lkz.pub`，`webSrc` 自动拼接 `?app_token=APP_TOKEN`（分享链接不带 token，避免泄露）。此后 App 内不会再出现 Turnstile 拦截页。

### 5.3 Node 版本
- 服务器已从 Node 12.22.9 升级至 **Node 22.23.2**（2026-08-28，通过 nodesource 22.x 源 `apt --force-overwrite` 升级，`systemd voice-server` 已重启验证 `curl /health → {ok:true}`）。
- uni-app x 构建需 Node 18+，现已满足；`voice-server.js` 兼容 Node 22，无需改动。

### 5.4 iOS 打包
- 无需本地 Mac，使用 HBuilderX 云打包 + Apple 开发者证书即可出 `ipa`。本地仅需上传证书。

---

## 六、打包发布

| 端 | 方式 | 产物 |
|---|---|---|
| Android | HBuilderX 云打包 / 本地 Gradle | `apk` / `aab` |
| iOS | HBuilderX 云打包（需 Apple 证书） | `ipa` |
| HarmonyOS NEXT | HBuilderX 云打包（需华为签名） | `app` |

离线打包备选：`Android Studio` / `Xcode` / `DevEco Studio` 打开 `app/dist` 生成的原生工程。

---

## 七、已确认事项（2026-08-28 10:15 北京时间）

1. **应用名**：统一 `chat`（已更新 `manifest.json`/`pages.json`/`index.html`/`logo.svg`/`package.json`）
2. **域名**：固定 `https://chat.lkz.pub`（`pages/chat/chat.vue:BASE_URL` 已锁死）
3. **上架**：是，需上架商店（需处理内购/隐私与纯 web-view 审核策略，后续按需转混合/原生化）
4. **开发者账号**：Apple / 华为 已具备，后续自行上传证书并云打包
5. **App Token 白名单**：接受，已落地 `index.php:APP_TOKEN + hasValidAppToken()`，App 内已去 Turnstile

> 下一步：HBuilderX 打开 `/app` → 发行 → 原生App-云打包（分别勾选 Android / iOS / HarmonyOS）→ 上传证书 → 出包内测。


---

*维护人：AI Agent  ·  2026-08-28 北京时间*
