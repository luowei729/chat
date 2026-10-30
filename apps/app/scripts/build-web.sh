#!/usr/bin/env bash
# ============================================================
# Web 预览一键构建脚本
# ============================================================
# 用途：把 Lynx bundle 打包成可在浏览器打开的静态站点，
#      便于快速验证 UI（不用每次出 APK，原生构建要 4 分钟）。
#
# 关键点（踩过的坑）：
# 1. 必须复制 web-core 的预构建运行时 client.js + client.css，
#    不要自己再打包一遍（官方已提供 dist/client_prod）
# 2. 必须复制 binary/*.wasm —— 缺了会报
#    "Failed to execute 'compile' on 'WebAssembly'" 然后整页黑屏
# 3. <lynx-view> 的 url 指向 bundle 相对路径
#
# 用法：
#   ./scripts/build-web.sh          # 构建
#   ./scripts/build-web.sh serve    # 构建并启动 8099 端口
# ============================================================
set -euo pipefail

cd "$(dirname "$0")/.."
DIST="dist-web"
ROOT="/opt/1panel/www/sites/chat.lkz.pub/index"

echo "1/4 构建 Lynx Web bundle"
NODE_ENV=production npx rspeedy build --config lynx.web.config.ts 2>&1 | grep -vE "ObjectRef|^$" | tail -4

echo "2/4 定位 web-core 运行时"
WEB_CORE_NM=$(find "$ROOT/node_modules/.pnpm" -maxdepth 1 -type d -name "@lynx-js+web-core@*" \
  | head -1)/node_modules/@lynx-js/web-core
if [ ! -d "$WEB_CORE_NM" ]; then
  echo "找不到 @lynx-js/web-core，请先 pnpm install"
  exit 1
fi
echo "  $WEB_CORE_NM"

echo "3/4 复制运行时与引擎"
mkdir -p "$DIST/binary/client" "$DIST/binary/client_legacy" "$DIST/binary/encode" \
         "$DIST/static/js/async" "$DIST/static/css"

# web-core 预构建运行时
cp "$WEB_CORE_NM/dist/client_prod/static/js/client.js"   "$DIST/static/js/"
cp "$WEB_CORE_NM/dist/client_prod/static/css/client.css" "$DIST/static/css/"
cp "$WEB_CORE_NM"/dist/client_prod/static/js/async/*.js   "$DIST/static/js/async/" 2>/dev/null || true

# WASM 引擎（最关键，缺了页面全黑）
cp "$WEB_CORE_NM/binary/client/"*.wasm        "$DIST/binary/client/"        2>/dev/null || true
cp "$WEB_CORE_NM/binary/client_legacy/"*.wasm "$DIST/binary/client_legacy/" 2>/dev/null || true
cp "$WEB_CORE_NM/binary/encode/"*.wasm        "$DIST/binary/encode/"        2>/dev/null || true

echo "4/4 生成预览页"
cat > "$DIST/index.html" <<'HTML'
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
    <title>chat · Lynx Web 预览</title>
    <link rel="stylesheet" href="./static/css/client.css" />
    <style>
      html, body {
        margin: 0; padding: 0; height: 100%;
        background: #070b14; color: #edf1f7;
        font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;
      }
      lynx-view { display: block; width: 100vw; height: 100vh; }
      #err {
        position: fixed; left: 0; right: 0; bottom: 0; max-height: 45vh; overflow: auto;
        padding: 10px 14px; background: #1a0f14; color: #ff6b6b;
        font: 11px/1.5 monospace; white-space: pre-wrap; display: none; z-index: 9999;
      }
    </style>
    <script type="module" src="./static/js/client.js"></script>
    <script>
      window.__showErr = function (msg) {
        var box = document.getElementById('err');
        if (!box) { box = document.createElement('div'); box.id = 'err'; document.body.appendChild(box); }
        box.style.display = 'block';
        box.textContent += String(msg) + '\n';
        console.error(msg);
      };
      window.addEventListener('error', function (e) {
        window.__showErr('[error] ' + (e.message || e.error));
      });
      window.addEventListener('unhandledrejection', function (e) {
        var r = e.reason;
        window.__showErr('[reject] ' + (r && (r.stack || r.message) || r));
      });
      window.addEventListener('load', function () {
        setTimeout(function () {
          var lv = document.querySelector('lynx-view');
          if (!lv || lv.children.length === 0) {
            window.__showErr('[check] 5s 后 lynx-view 仍无子节点，渲染失败');
          }
        }, 5000);
      });
    </script>
  </head>
  <body>
    <lynx-view url="./chat.web.bundle" height="100vh" width="100vw"></lynx-view>
    <div id="err"></div>
  </body>
</html>
HTML

echo
echo "完成，产物："
find "$DIST" -type f | sed "s|^|  |"

if [ "${1:-}" = "serve" ]; then
  echo
  echo "启动预览服务器"
  pkill -f "http.server 8099" 2>/dev/null || true
  sleep 1
  nohup python3 -m http.server 8099 --directory "$DIST" > /tmp/web8099.log 2>&1 &
  sleep 2
  curl -s -o /dev/null -w "  健康检查: HTTP %{http_code}\n" http://127.0.0.1:8099/index.html
  echo "  打开 http://127.0.0.1:8099/index.html"
fi
