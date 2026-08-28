// main.js — uni-app 入口
// 原因：Vue3 + uni-app 必须通过 createSSRApp 创建实例，适配多端编译
import { createSSRApp } from "vue";
import App from "./App.vue";

export function createApp() {
  // 创建 Vue 应用实例，交给 uni-app 的各端运行时挂载
  const app = createSSRApp(App);
  return {
    app,
  };
}
