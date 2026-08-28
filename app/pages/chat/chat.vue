<template>
  <!-- 聊天室页：Phase 0 采用 web-view 壳，直接加载线上站 -->
  <!-- 原因：零后端改动即可三端可用；后续可渐进把此页替换为原生聊天实现 -->
  <view class="chat-page">
    <!-- 自定义导航栏：避免原生导航与 web-view 冲突，统一品牌色 -->
    <view class="nav-bar" :style="{ paddingTop: safeTop + 'px' }">
      <view class="nav-left" @tap="goBack">
        <text class="nav-back">‹</text>
        <text class="nav-title">房间 {{ displayId }}</text>
      </view>
      <view class="nav-right">
        <!-- 刷新按钮：web-view 偶发白屏时可手动重载 -->
        <view class="nav-btn" @tap="reload">↻ 刷新</view>
        <!-- 分享按钮：调用系统分享，兼容三端 -->
        <view class="nav-btn nav-btn-primary" @tap="shareRoom">分享</view>
      </view>
    </view>

    <!-- 加载中占位 -->
    <view v-if="loading" class="loading-bar">
      <text class="loading-text">正在连接 {{ webSrc }} …</text>
    </view>

    <!-- web-view：核心容器，HBuilderX 会在 App 端编译为原生 WebView / 鸿蒙 web 组件 -->
    <!-- 注意：web-view 必须占满剩余高度，且不能与其他元素重叠 -->
    <web-view
      v-if="webSrc"
      :src="webSrc"
      :key="webKey"
      :webview-styles="webviewStyles"
      :update-title="false"
      @message="onWebMessage"
      @load="onWebLoad"
      @error="onWebError"
    ></web-view>

    <!-- 错误态：加载失败时提示 -->
    <view v-if="errorMsg" class="error-box">
      <text class="error-title">加载失败</text>
      <text class="error-msg">{{ errorMsg }}</text>
      <view class="error-actions">
        <button class="btn btn-primary" size="mini" @tap="reload">重试</button>
        <button class="btn" size="mini" @tap="openInBrowser">用浏览器打开</button>
      </view>
      <text class="error-tip">提示：App 内已自动跳过人机验证（`app_token` 白名单）；Web 端仍需 Cloudflare Turnstile 验证，若持续失败请检查网络或域名是否可达。</text>
    </view>
  </view>
</template>

<script>
// 后端域名：固定线上站，详见定版确认（固定 https://chat.lkz.pub）
// 原因：所有请求都走现有 PHP，无需额外部署，App 与 H5 保持一致
const BASE_URL = "https://chat.lkz.pub";
// App 免验证 Token：与 index.php 中 APP_TOKEN 保持一致
// 原因：Cloudflare Turnstile 在 App WebView 内可能加载失败，携带此 Token 跳过验证（后端 hasValidAppToken 校验）
// 安全：分享链接不带此 Token，仅 WebView 内自用；泄露后可在 PHP 中轮换
const APP_TOKEN = "c2a8f1d9e4b603a7f8e2c9d1b6a4e0f8735d2c1e9a8b7f0d6c3e2a1b9f8d7e6c5a2b4";

export default {
  data() {
    return {
      // 房间 ID（已清洗）
      roomId: "",
      // 展示用 ID
      displayId: "",
      // web-view 的 src
      webSrc: "",
      // 用于强制重载 web-view 的 key
      webKey: 0,
      // 顶部安全区高度（适配刘海/鸿蒙胶囊）
      safeTop: 0,
      // 加载状态
      loading: true,
      // 错误信息
      errorMsg: "",
      // 基础域名
      baseUrl: BASE_URL,
      // web-view 样式：进度条与全屏
      webviewStyles: {
        progress: { color: "#4F6EF7" },
      },
    };
  },
  onLoad(options) {
    // 计算安全区：H5 用 0，App 用系统安全区
    // 原因：避免导航栏被刘海/状态栏遮挡
    try {
      const sys = uni.getSystemInfoSync();
      // App 端 safeAreaInsets.top 存在时使用，否则回退
      this.safeTop = (sys.safeAreaInsets && sys.safeAreaInsets.top) || sys.statusBarHeight || 20;
      // H5 下不需要额外 padding（浏览器已处理）
      // #ifdef H5
      this.safeTop = 0;
      // #endif
    } catch (e) {
      this.safeTop = 20;
    }

    // 解析房间 ID：支持 ?id=xxx
    const raw = (options && options.id) ? String(options.id) : "";
    const cleaned = this.cleanId(raw);
    if (!cleaned) {
      // 非法 ID 回首页
      uni.showToast({ title: "房间 ID 无效", icon: "none" });
      setTimeout(() => uni.reLaunch({ url: "/pages/index/index" }), 800);
      return;
    }
    this.roomId = cleaned;
    this.displayId = cleaned;
    // 拼接 app_token：Header 白名单在部分 WebView 不可靠，URL 参数最稳妥
    // 原因：后端 hasValidAppToken 同时认 Header 与 ?app_token=，此处用 URL 兜底
    this.webSrc = `${BASE_URL}/${encodeURIComponent(cleaned)}?app_token=${APP_TOKEN}`;
    this.loading = true;
    this.errorMsg = "";

    // 设置导航标题（系统分享时会读取）
    try {
      uni.setNavigationBarTitle({ title: `房间 ${cleaned}` });
    } catch (e) {}
  },
  onUnload() {
    // 页面卸载时无需额外清理，web-view 会自动销毁
  },
  methods: {
    // 清洗 ID：与 index.php preg_replace 保持一致
    cleanId(raw) {
      return (raw || "").trim().replace(/[^a-zA-Z0-9_.\-]/g, "");
    },
    // 返回首页
    goBack() {
      // 若有上一页则返回，否则重定向到首页
      const pages = getCurrentPages();
      if (pages.length > 1) uni.navigateBack({ delta: 1 });
      else uni.reLaunch({ url: "/pages/index/index" });
    },
    // 重新加载 web-view
    reload() {
      this.errorMsg = "";
      this.loading = true;
      // 通过递增 key 强制重建 web-view
      this.webKey += 1;
      // 额外触发：App 端可调用 plus webview reload（更彻底）
      // #ifdef APP-PLUS
      try {
        const wv = plus.webview.getWebviewById(plus.webview.currentWebview().id);
        // web-view 子窗口的 reload 由 uni 框架处理，此处仅日志
        console.log("reload web-view", this.webSrc);
      } catch (e) {}
      // #endif
    },
    // 分享房间链接：对外分享不带 app_token，避免泄露
    shareRoom() {
      const url = `${BASE_URL}/${this.roomId}`;
      const title = `加入房间 ${this.roomId} - chat`;
      // #ifdef APP-PLUS
      // App 端：优先用系统分享（uni.share），失败回退到剪贴板
      try {
        if (uni.share) {
          uni.share({
            provider: "system",
            type: 0,
            title: title,
            summary: url,
            href: url,
            success: () => uni.showToast({ title: "已分享", icon: "success" }),
            fail: () => this.copyUrl(url),
          });
          return;
        }
      } catch (e) {}
      this.copyUrl(url);
      // #endif
      // #ifndef APP-PLUS
      this.copyUrl(url);
      // #endif
    },
    copyUrl(url) {
      // 兼容 H5/小程序：复制到剪贴板
      uni.setClipboardData({
        data: url,
        success: () => uni.showToast({ title: "链接已复制", icon: "success" }),
        fail: () => uni.showToast({ title: url, icon: "none", duration: 3000 }),
      });
    },
    // 用系统浏览器打开（App 端）
    openInBrowser() {
      const url = `${BASE_URL}/${this.roomId}`;
      // #ifdef APP-PLUS
      try {
        plus.runtime.openURL(url);
        return;
      } catch (e) {}
      // #endif
      // H5 直接跳转
      window.open(url, "_blank");
    },
    // web-view 加载完成
    onWebLoad(e) {
      this.loading = false;
      this.errorMsg = "";
      console.log("web-view loaded", e);
    },
    // web-view 加载失败
    onWebError(e) {
      this.loading = false;
      this.errorMsg = (e && e.detail && e.detail.errMsg) || "网络异常或域名无法访问，请检查网络后重试";
      console.log("web-view error", e);
    },
    // 接收 web-view 内通过 uni.postMessage 发送的消息（预留给 Phase 1 JSBridge）
    // 原因：后续可让网页内点击“分享”时通知 App 壳做原生分享
    onWebMessage(e) {
      console.log("web-view message", e);
      const data = e.detail && e.detail.data && e.detail.data[0];
      if (!data) return;
      if (data.action === "share") this.shareRoom();
      if (data.action === "copy") this.copyUrl(data.url || `${BASE_URL}/${this.roomId}`);
    },
  },
};
</script>

<style scoped>
.chat-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  /* 原因：鸿蒙/刘海屏底部安全区 */
  padding-bottom: env(safe-area-inset-bottom);
  background: #eef1fb;
  box-sizing: border-box;
}
.nav-bar {
  height: 44px;
  min-height: 44px;
  background: linear-gradient(135deg, #1b3068 0%, #2648a0 55%, #2d5bb5 100%);
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
  flex-shrink: 0;
  box-shadow: 0 4px 20px rgba(27, 48, 104, 0.25);
}
.nav-left {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}
.nav-back {
  font-size: 26px;
  color: #fff;
  line-height: 26px;
  padding: 0 4px;
}
.nav-title {
  font-size: 14px;
  color: #fff;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nav-right {
  display: flex;
  flex-direction: row;
  gap: 8px;
  align-items: center;
  flex-shrink: 0;
}
.nav-btn {
  padding: 5px 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.14);
  border: 1px solid rgba(255, 255, 255, 0.28);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
}
.nav-btn-primary {
  background: #fff;
  color: #1b3068;
  border-color: #fff;
}
.loading-bar {
  padding: 8px 12px;
  background: #f0f4ff;
  border-bottom: 1px solid #e3e8f7;
  flex-shrink: 0;
}
.loading-text {
  font-size: 11px;
  color: #8892b0;
  word-break: break-all;
}
.error-box {
  margin: 16px;
  background: #fff;
  border: 1px solid #fecaca;
  border-radius: 14px;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.error-title {
  font-size: 15px;
  font-weight: 800;
  color: #c62828;
}
.error-msg {
  font-size: 12px;
  color: #666;
  line-height: 1.6;
  word-break: break-all;
}
.error-actions {
  display: flex;
  flex-direction: row;
  gap: 10px;
  margin-top: 4px;
}
.btn {
  padding: 8px 14px;
  border-radius: 10px;
  background: #f0f4ff;
  color: #4f6ef7;
  border: 1px solid #c0ccf7;
  font-size: 12px;
  font-weight: 700;
  text-align: center;
}
.btn-primary {
  background: linear-gradient(135deg, #4f6ef7, #6b4fff);
  color: #fff;
  border: none;
}
.error-tip {
  font-size: 11px;
  color: #a0aec0;
  line-height: 1.6;
}
/* web-view 占满剩余空间 */
web-view {
  flex: 1;
  width: 100%;
  min-height: 0;
}
</style>
