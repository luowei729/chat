import { defineConfig } from "vite";
import uni from "@dcloudio/vite-plugin-uni";

// https://vitejs.dev/config/
// 原因：uni-app 官方要求使用此插件，才能同时编译到 app-android / app-ios / app-harmony / h5 四端
export default defineConfig({
  // 插件：uni 会根据 manifest.json 和 pages.json 自动处理多端编译
  plugins: [uni()],
});
