# DEVTIPS.md — 长期开发提示（注意要精简提示确保文件体积小，方便阅读）
-把在本项目需要长期记住的开发提示，按照下面的严格格式写到本文件的下方，记录写入北京时间和日期
--- 
开发提示如下：
## 一、项目定位与真相源（2026-08-23 口径）
- 项目 = 规则策略决策  演示省略

## 二、多用户平台铁律

...........演示省略

## 三、三端 App 开发铁律（2026-08-28 10:15 北京时间，定版更新）
- 三端选型：**uni-app Vue3 单轨**（uni-app x UTS 与 uni-app 均可，一套代码编译到 Android/iOS/HarmonyOS NEXT，HBuilderX 云打包无需本地 Mac 出 ipa/app）；已放弃 mcp-mobile-interaction（需本地 adb/idb + 真机/模拟器，服务器无此环境；Expo 已评估不采用）
- 应用名统一：**全部改为 `chat`**（manifest.json name、pages.json、index.html title、package.json description、static/logo.svg 文字、chat.vue 分享标题均已更新，PROJECT_PLAN/APP_PLAN/README 已同步）
- 域名固定：**`https://chat.lkz.pub`**（pages/chat/chat.vue:BASE_URL 锁死，webSrc 拼接 `?app_token=`，分享链接不带 token 防泄露）
- Turnstile：**Web 保留、App 已去除**（index.php 新增 `APP_TOKEN` 常量与 `hasValidAppToken()`，命中 Header X-App-Token / ?app_token / POST / Cookie 时 `hasValidTurnstileCookie()` 直接 true；App 侧自动带 token，不再出现验证页）
- 渐进式：Phase 0 web-view 壳直载线上站 → Phase1 首页原生 → Phase2 全原生化 → Phase3 鸿蒙上架，避免一次性重写
- 目录：所有 App 代码仅在 `/app`，HBuilderX 打开 `/app` 即识别（manifest.json+pages.json）；详细规划放 `docs/APP_PLAN.md`，根目录仅留 AGENTS/CHANGELOG/DEVTIPS/PROJECT_PLAN
- 权限：Android 必声明 RECORD_AUDIO/CAMERA/READ_MEDIA_IMAGES/VIDEO/AUDIO+INTERNET+MODIFY_AUDIO_SETTINGS，否则 web-view 内 getUserMedia 静默失败；App.vue onLaunch 300ms 后动态申请
- 鸿蒙：manifest.json 需 app-harmony 节 bundleName pub.lkz.chat minAPIVersion 12，HBuilderX 4.2+ 才可见 app-harmony 勾选
- Node：已从 **12.22.9 升级至 22.23.2**（2026-08-28 nodesource 22.x --force-overwrite，systemd voice-server 重启 curl /health→ok 验证，兼容无改动；原写 12 EOL/18+ 要求已满足）
- 代码注释：App 内所有 Vue/JS 均需中文注释说明实现原因
