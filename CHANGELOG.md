# xxxx项目 变更日志

所有变更记录使用北京时间（UTC+8）。

- [2026-08-24 02:40 北京时间] ★★按照这样的严格的规范写入变更信息

##########  演示以下省略
- [2026-08-28 08:58 北京时间] 新增三端 App 架构与 Phase 0 实现：选型 uni-app x(Vue3+UTS) 一套代码编译到 Android/iOS/HarmonyOS NEXT，详见 docs/APP_PLAN.md。新增 /app 目录（manifest.json 含 app-harmony bundleName pub.lkz.chat、pages.json、App.vue 权限申请、pages/index/index.vue 原生首页、pages/chat/chat.vue web-view 壳直载 https://chat.lkz.pub/:id、static/logo.svg、package/vite配置、README 打包指南），后端零改动复用现有 PHP 接口与 WS 信令；更新 PROJECT_PLAN v2.0 与 DEVTIPS 三端铁律

- [2026-08-28 10:07 北京时间] 服务器 Node 从 12.22.9 升级至 22.23.2（nodesource 22.x，apt --force-overwrite），`systemctl restart voice-server` 验证 `curl http://127.0.0.1:3001/health → {"ok":true}`，`voice-server.js` 兼容无需改动
- [2026-08-28 10:15 北京时间] 定版：应用名统一为 `chat`（manifest/pages/index.html/package description/logo.svg/分享标题全量更新）；域名固定 `https://chat.lkz.pub`（chat.vue BASE_URL 锁死）；App 内去除 Turnstile（index.php 新增 `APP_TOKEN` + `hasValidAppToken()` 白名单，认 Header/GET/POST/Cookie，`hash_equals` 校验，命中跳过 `requireTurnstileVerified()`；`pages/chat/chat.vue` 的 `webSrc` 自动拼接 `?app_token=`，分享链接不带 token，错误提示同步更新）；放弃 `mcp-mobile-interaction`（服务器无 adb/真机环境）；`app/` 恢复 uni-app 单轨（回滚 deveco 分轨）；同步更新 `docs/APP_PLAN.md v1.1` / `PROJECT_PLAN.md v2.1` / `app/README.md` / `DEVTIPS §三`

- [2026-08-28 03:01 北京时间] 本地编译输出 Android APK（debug，可直接安装）：`pub.lkz.chat` v1.0.0 (100)，`compileSdk 34 / minSdk 24 / targetSdk 34`，WebView 壳固定 `https://chat.lkz.pub?app_token=...`（App 内已去 Turnstile，后端 `hasValidAppToken` 白名单），支持文件上传/相机/录音/下载/WebRTC 权限；腾讯镜像 Gradle 8.7 + 阿里云 maven + AGP 8.2.2 + AndroidX，产出 `5.3M` `sha256:75ab27e23bdfa03e79f8bfb92b999c87144f83764c1140823eb2e46d97e11e7e`，已发布至 `https://chat.lkz.pub/chat.apk` 与 `https://chat.lkz.pub/app/chat.apk`（`aapt dump badging` 验证通过）

- [2026-08-28 03:17 北京时间] 修复鸿蒙7卓易通闪退（从 5.3M 降至 1.5M）：`Activity` 替代 `AppCompatActivity`，`Theme.Material.Light.NoActionBar` 替代 `Theme.AppCompat`，`targetSdk 33 / minSdk 21`，`hardwareAccelerated=true` + `usesCleartextTraffic=true`，`WebView` 初始化 `try-catch` 防容器异常，依赖仅保留 `androidx.core` 移除 `appcompat/material`，`sha256:c7584f301a82b48650b18ab806827a15ca6e8a70aa8b08a1c600c543db7235f4`，已发布覆盖 `https://chat.lkz.pub/chat.apk`
- [2026-08-28 03:17 北京时间] 尝试本地 Android 模拟器自测：已安装 `emulator` 9.0M，但 `system-images;android-33;google_apis;x86_64` 因 `No space left on device`（剩余 2.1G）解压失败，且宿主机无 `KVM`（`vmx/svm=0`，`/dev/kvm` 缺失，`accel-check` 失败），无法启动硬件加速模拟器；已通过 `BUILD SUCCESSFUL + aapt dump badging` 验证 APK 可安装性，待真机验证
- [2026-08-28 17:56 北京时间] 修复 `git push origin main` 超时 `Failed to connect to github.com port 443 Connection timed out`：原 `systemd-resolved` 仅用阿里云内网 DNS `100.100.2.136/138`，解析虽成功但长连接写入时超时（`curl` 直连正常，`GIT_CURL_VERBOSE` 显示 `GET /info/refs?service=git-receive-pack` 200 但 `POST /git-receive-pack` 挂死）；按要求更换为公网 DNS `223.5.5.5/8.8.8.8/1.1.1.1/119.29.29.29`，持久化 ` /etc/systemd/resolved.conf.d/custom-dns.conf` + `netplan 99-custom-dns.yaml (dhcp4-overrides use-dns:false)` + 恢复 `resolv.conf → stub` 软链并补 `127.0.1.1 ubuntu` 到 `/etc/hosts` 消除 `sudo: unable to resolve host`，`netplan apply + systemctl restart systemd-resolved` 后验证 `dig/curl/git ls-remote/push` 均正常，`git push` 成功 `45be457..15951c0 main -> main (26 objects 1.36MiB)`
