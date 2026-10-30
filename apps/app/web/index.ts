/**
 * ============================================================
 * Web 测试页
 * ------------------------------------------------------------
 * 用法：打开本页 → <lynx-view> 加载同目录下的 chat.web.bundle
 * 用途：
 *   1. 浏览器里直接验证 UI 与交互（开发期快速迭代）
 *   2. 捕获 JS 运行时错误并显示在页面上，便于定位黑屏原因
 * ============================================================
 */

import './shell.js';

// ---------- 捕获运行时错误并显示出来 ----------
// 原生端黑屏往往没有任何提示，浏览器里则能看到具体异常
const errBox = document.createElement('pre');
errBox.style.cssText =
  'position:fixed;left:0;right:0;bottom:0;max-height:45vh;overflow:auto;' +
  'margin:0;padding:12px;background:#2a0d12;color:#ff8a8a;font:11px/1.5 monospace;' +
  'white-space:pre-wrap;z-index:99999;display:none';
document.body.appendChild(errBox);

let errorCount = 0;
function showError(text: string): void {
  errorCount += 1;
  errBox.style.display = 'block';
  errBox.textContent += `[${errorCount}] ${text}\n`;
}

window.addEventListener('error', (e) => {
  showError(`${e.message}\n  at ${e.filename}:${e.lineno}:${e.colno}`);
});
window.addEventListener('unhandledrejection', (e) => {
  showError(`未处理的 Promise 拒绝: ${String(e.reason)}`);
});

// 覆盖 console.error，把报错也显示在页面上
const origError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  showError(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(' '));
  origError(...args);
};

// ---------- 创建 lynx-view ----------
const view = document.createElement('lynx-view');
view.setAttribute('url', './chat.web.bundle');
view.style.cssText = 'display:block;height:100vh;width:100vw;';
document.body.appendChild(view);

// ---------- 渲染健康检查 ----------
setTimeout(() => {
  const shadow = (view as unknown as { shadowRoot?: ShadowRoot }).shadowRoot;
  const html = view.innerHTML;
  const shadowHtml = shadow?.innerHTML ?? '';
  const total = html.length + shadowHtml.length;

  console.log(
    `[check] lynx-view innerHTML=${html.length}B shadow=${shadowHtml.length}B children=${view.childElementCount}`,
  );

  if (total === 0) {
    showError('lynx-view 渲染后没有任何内容（DOM 为空）');
  } else {
    const ok = document.createElement('div');
    ok.style.cssText =
      'position:fixed;top:0;right:0;padding:4px 8px;background:#12351f;color:#7cffb2;' +
      'font:11px monospace;z-index:99999;border-radius:0 0 0 6px';
    ok.textContent = `已渲染 ${total}B`;
    document.body.appendChild(ok);
  }
}, 3000);
