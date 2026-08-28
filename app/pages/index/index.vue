<template>
  <!-- 首页：输入房间 ID / 随机创建 — 原生 Vue，不依赖 web-view -->
  <!-- 原因：首屏原生化可秒开，且不受 Turnstile 在 web-view 中加载失败的影响 -->
  <view class="page">
    <view class="card">
      <view class="logo">🔐</view>
      <view class="title">chat</view>
      <view class="subtitle">输入房间 ID 直接进入，或创建一个新房间</view>

      <view class="section-label">进入指定房间</view>
      <view class="input-row">
        <input
          v-model="roomId"
          class="id-input"
          type="text"
          placeholder="输入房间 ID，如 1、abc…"
          :maxlength="40"
          confirm-type="go"
          @confirm="goToRoom"
        />
        <button class="btn btn-primary" @tap="goToRoom">进入</button>
      </view>

      <view class="divider"><text class="divider-text">或者</text></view>

      <button class="btn-new" @tap="createRoom">✚ 随机创建新房间</button>
      <view class="footer">消息保留7天后自动清理 · 支持文件/语音/实时通话</view>
    </view>
  </view>
</template>

<script>
export default {
  data() {
    return {
      // 用户输入的房间 ID
      roomId: "",
      // 随机推荐 ID（每次打开页面刷新）
      suggested: "",
    };
  },
  onLoad() {
    // 生成 6 位随机 ID，供“随机创建新房间”使用
    this.suggested = this.randomShortId(6);
  },
  onShow() {
    // 每次显示都刷新推荐 ID，避免重复创建同一房间
    this.suggested = this.randomShortId(6);
  },
  methods: {
    // 生成指定长度的随机字母数字串（与 index.php 首页逻辑一致）
    randomShortId(len) {
      const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
      let id = "";
      for (let i = 0; i < len; i++) {
        id += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return id;
    },
    // 清洗 ID：仅保留字母数字下划线点连字符（与 index.php preg_replace 一致）
    cleanId(raw) {
      return (raw || "").trim().replace(/[^a-zA-Z0-9_.\-]/g, "");
    },
    // 跳转到指定房间
    goToRoom() {
      const id = this.cleanId(this.roomId);
      if (!id) {
        // 输入为空时聚焦输入框并轻提示
        uni.showToast({ title: "请输入房间 ID", icon: "none" });
        return;
      }
      // 跳转到聊天室页，通过 query 传递 id
      uni.navigateTo({ url: `/pages/chat/chat?id=${encodeURIComponent(id)}` });
    },
    // 随机创建新房间
    createRoom() {
      const id = this.suggested || this.randomShortId(6);
      uni.navigateTo({ url: `/pages/chat/chat?id=${encodeURIComponent(id)}` });
    },
  },
};
</script>

<style scoped>
/* 页面背景：与线上站渐变一致 */
.page {
  min-height: 100vh;
  /* 原因：兼容刘海屏与鸿蒙安全区 */
  padding: calc(18px + env(safe-area-inset-top)) 18px calc(18px + env(safe-area-inset-bottom));
  background: linear-gradient(135deg, #1b3068 0%, #2d5bb5 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
}
.card {
  background: #fff;
  border-radius: 20px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
  width: 100%;
  max-width: 420px;
  padding: 40px 32px;
  text-align: center;
  overflow: hidden;
}
.logo {
  font-size: 52px;
  margin-bottom: 16px;
}
.title {
  font-size: 19px;
  color: #1b3068;
  font-weight: 700;
  margin-bottom: 8px;
}
.subtitle {
  color: #8892b0;
  font-size: 13px;
  margin-bottom: 32px;
  line-height: 1.5;
}
.section-label {
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  color: #4f6ef7;
  margin-bottom: 8px;
  letter-spacing: 0.04em;
}
.input-row {
  display: flex;
  gap: 8px;
  margin-bottom: 24px;
  width: 100%;
  min-width: 0;
}
.id-input {
  flex: 1;
  min-width: 0;
  padding: 11px 14px;
  border: 2px solid #e3e8f7;
  border-radius: 10px;
  font-size: 15px;
  color: #1a1f36;
  outline: none;
  text-align: left;
  background: #fff;
}
.btn {
  padding: 11px 18px;
  border: none;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  min-height: 44px;
  line-height: 22px;
}
.btn-primary {
  background: linear-gradient(135deg, #4f6ef7, #6b4fff);
  color: #fff;
}
.btn-primary:active {
  opacity: 0.9;
}
.divider {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 20px 0;
  color: #c0c8d8;
  font-size: 12px;
}
.divider::before,
.divider::after {
  content: "";
  flex: 1;
  height: 1px;
  background: #e3e8f7;
}
.divider-text {
  color: #c0c8d8;
}
.btn-new {
  width: 100%;
  padding: 13px;
  background: #f0f4ff;
  color: #4f6ef7;
  border: 2px dashed #c0ccf7;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
}
.btn-new:active {
  background: #e3eaff;
}
.footer {
  margin-top: 28px;
  color: #b0bcc8;
  font-size: 11px;
}
</style>
