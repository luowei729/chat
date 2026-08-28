<script>
// App.vue — 全局入口，处理权限与初始化
// 原因：App 首次启动需主动申请录音/相机权限，否则 web-view 内 getUserMedia 会静默失败（Android 6+ 动态权限）
export default {
  // 应用启动时触发（仅 App 端）
  onLaunch() {
    // 打印启动日志，便于 HBuilderX 控制台排查
    console.log("App Launch — chat v1.0.0");

    // #ifdef APP-PLUS
    // 仅在原生 App 壳中执行，H5/小程序不会进入
    this.requestAppPermissions();
    // 隐藏原生启动页（若 manifest 中开启 autoclose 则此行可省略，保留以防白屏）
    try {
      const plusReady = () => {
        try {
          if (window.plus && plus.plus.navigator) {
            plus.navigator.closeSplashscreen();
          }
        } catch (e) {}
      };
      if (window.plus) plusReady();
      else document.addEventListener("plusready", plusReady, false);
    } catch (e) {}
    // #endif
  },
  onShow() {
    console.log("App Show");
  },
  onHide() {
    console.log("App Hide");
  },
  methods: {
    // 请求 App 必备权限（Android 动态权限）
    requestAppPermissions() {
      // #ifdef APP-PLUS
      // 延迟 300ms 再请求，避免与启动页冲突
      setTimeout(() => {
        const permissions = [
          "android.permission.RECORD_AUDIO",
          "android.permission.CAMERA",
          "android.permission.READ_MEDIA_IMAGES",
          "android.permission.READ_MEDIA_VIDEO",
        ];
        // 使用 plus.android 动态申请（uni 官方推荐方式）
        try {
          if (window.plus && plus.android) {
            const Build = plus.android.importClass("android.os.Build");
            // Android 13+ 不需要 WRITE_EXTERNAL_STORAGE，用媒体细分权限代替
            const activity = plus.android.runtimeMainActivity();
            const Context = plus.android.importClass("android.content.Context");
            // 简单触发系统授权弹窗：创建一个临时录音权限请求
            // 更稳妥的方式是用 permision 模块的 requestPermissions（HBuilderX 3.8+ 支持）
            if (typeof uni.requestPermissions === "function") {
              uni.requestPermissions({
                permissions: permissions,
                success: (res) => console.log("权限申请结果", res),
                fail: (err) => console.log("权限申请失败", err),
              });
            }
          }
        } catch (e) {
          console.log("权限申请异常（可忽略，系统会在使用时再次弹窗）", e);
        }
      }, 300);
      // #endif
    },
  },
};
</script>

<style>
/* 全局样式：统一字体与安全区适配 */
/* 原因：鸿蒙/刘海屏需 env(safe-area-inset-*)，避免内容被遮挡 */
page {
  font-family: -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif;
  background: #eef1fb;
  min-height: 100vh;
}
</style>
