# chat — 三端 App（Android / iOS / HarmonyOS NEXT）

> 目录：`/opt/1panel/www/sites/chat.lkz.pub/index/app`  
> 形态：uni-app Vue3 + web-view 壳（Phase 0），渐进式原生化  
> 后端：复用 `https://chat.lkz.pub`（固定）+ `index.php` + `voice-server.js:3001 (Node 22.23.2)`  
> 定版：应用名 `chat` / 域名固定 / 需上架 / 已备 Apple+华为账号 / App 内已去 Turnstile（`APP_TOKEN` 白名单）

详细架构见 `../docs/APP_PLAN.md`。

---

## 一、目录结构

```
/app
├── manifest.json        # 三端包名/权限/图标（HBuilderX 识别）
├── pages.json           # 路由
├── package.json         # 依赖（Vue3 + Vite + uni-app）
├── vite.config.js       # 构建配置
├── index.html           # H5 模板
├── App.vue              # 全局入口
├── uni.scss             # 全局样式变量
├── pages/
│   ├── index/index.vue  # 首页：输入房间ID / 随机创建
│   └── chat/chat.vue    # 聊天室：web-view 壳加载线上站
├── static/
│   └── logo.png         # 应用图标（请替换为 1024x1024）
└── docs/APP_PLAN.md     # 架构规划（上一级 docs）
```

## 二、快速开始（HBuilderX 云打包，无需本地 Mac）

### 1. 安装 HBuilderX
下载 https://www.dcloud.io/hbuilderx.html（需 4.x 版本以支持 HarmonyOS）

### 2. 打开项目
`HBuilderX → 文件 → 打开目录 → 选择 /app 目录`（需看到 manifest.json）

### 3. 安装依赖（可选，云打包可不装）
```bash
cd /app
npm install
# 本机预览：npm run dev:h5
```

### 4. 云打包
`发行 → 原生App-云打包`
- Android：选 `apk`（测试）或 `aab`（上架 Google Play），一键出包
- iOS：需在 Apple Developer 后台创建 App ID + 证书，上传到 HBuilderX 后云打包出 `ipa`
- HarmonyOS：需在 `manifest.json → app-harmony` 填 `bundleName`，用华为开发者账号签名后云打包出 `app` 包

> 离线打包：`发行 → 原生App-本地打包 → 生成本地打包App资源`，再用 Android Studio / Xcode / DevEco Studio 打开 `dist` 工程

## 三、Phase 0 说明（当前已实现）

- 首页原生 Vue，不依赖后端
- 聊天室用 `<web-view src="https://chat.lkz.pub/<id>">` 直接加载线上站，**后端零改动**
- 权限已声明：`RECORD_AUDIO`（语音）、`CAMERA`（拍照）、`READ_MEDIA_IMAGES/VIDEO`（相册）、`INTERNET` 等，App 首次会自动弹窗授权
- 鸿蒙 NEXT 已配置 `app-harmony` 节，HBuilderX 4.3+ 可直接勾选 `app-harmony` 打包

## 四、待确认后修改

| 项 | 位置 | 默认值 | 需改成 |
|---|---|---|---|
| 包名 | `manifest.json → app-plus/distribute/android/packagename` | `pub.lkz.chat` | 你的反向域名 |
| Bundle | `manifest.json → app-harmony/bundleName` | `pub.lkz.chat` | 同上 |
| AppID | `manifest.json → appid` | `__UNI__LKZCHAT` | DCloud 后台新建后替换 |
| 域名 | `pages/chat/chat.vue → BASE_URL` | `https://chat.lkz.pub` | 如需切环境在此改 |
| 图标 | `static/logo.png` + `manifest.json → app-plus/distribute/icons` | 占位 | 替换为 1024x1024 png |

## 五、常见问题

- **Turnstile？** → **Web 保留，App 已去除**：App 的 `web-view` 通过 `?app_token=APP_TOKEN` 白名单直接跳过 `requireTurnstileVerified()`（见 `index.php:hasValidAppToken()`），不会再出现验证页；Web 浏览器仍需 Turnstile 验证
- **iOS 无 Mac 怎么打包？** → 用 HBuilderX 云打包，不需本地 Mac
- **Node 版本？** → 本机需 Node 18+（服务器已升级至 Node 22.23.2，voice-server 已重启验证，不影响打包）
- **鸿蒙打包失败？** → 升级 HBuilderX 到最新，检查 `manifest.json → app-harmony → minAPIVersion: 12`

---

*2026-08-28 10:15 北京时间 · Phase 0 已就绪（chat 定版 / Node 22 / App 去 Turnstile）→ HBuilderX 云打包出 apk/aab/ipa/app*
