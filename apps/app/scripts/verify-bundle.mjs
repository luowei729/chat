#!/usr/bin/env node
/**
 * ============================================================
 * Lynx bundle 校验脚本
 * ------------------------------------------------------------
 * 用途：在把 bundle 打进 APK 之前，确认它是「合法且完整」的 Lynx 二进制模板。
 *
 * 为什么需要这个脚本：
 * 历史上出现过两次「构建成功但装到手机上纯黑屏」：
 *   1. 缺少 pluginReactLynx → 产物是普通 webpack JS，不是 Lynx 模板
 *   2. 入口 main.tsx 引用了别的组件 → bundle 里没有真实 UI
 * 这两类问题构建阶段都不会报错，只有装到真机才暴露，
 * 而真机黑屏又没有任何错误信息，排查成本极高。
 *
 * 【Lynx 二进制 bundle 格式要点】
 *   - 前 4 字节不是「魔数」，而是文件总大小（小端 uint32）
 *     （曾误把它当魔数比对 8068/ab65，换个产物就误判失败）
 *   - 头部 64 字节内含二进制格式版本串 "0.2.0.0"
 *   - 真正的结构校验必须用 @lynx-js/tasm 解码
 *
 * 用法：
 *   node scripts/verify-bundle.mjs <bundle 路径> [期望包含的文本...]
 *
 * 退出码：0 通过 / 1 失败
 * ============================================================
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

/** 打印错误并以 1 退出 */
function fatal(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* 参数解析                                                             */
/* ------------------------------------------------------------------ */

const [, , bundlePath, ...needles] = process.argv;

if (!bundlePath) {
  fatal('用法: node scripts/verify-bundle.mjs <bundle 路径> [期望文本...]');
}
if (!existsSync(bundlePath)) {
  fatal(`bundle 不存在: ${bundlePath}`);
}

const data = readFileSync(bundlePath);
const size = data.length;
console.log(`bundle: ${bundlePath}`);
console.log(`大小: ${size} 字节`);

/* ------------------------------------------------------------------ */
/* 校验 1：文件头结构                                                    */
/* ------------------------------------------------------------------ */

// 前 4 字节 == 文件总大小（小端）
if (data.length < 64) {
  fatal(`文件过小（${size} 字节），不是有效 bundle`);
}

const sizePrefix = data.readUInt32LE(0);
if (sizePrefix !== size) {
  fatal(
    `文件头大小前缀(${sizePrefix}) != 实际大小(${size})，` +
      `不是合法 Lynx 二进制 bundle。头部字节: ${data.subarray(0, 32).toString('hex')}`,
  );
}
console.log(`✓ 大小前缀一致 (${sizePrefix})`);

// 头部必须含二进制格式版本串
if (!data.subarray(0, 64).includes(Buffer.from('0.2.0.0'))) {
  fatal(`头部缺少二进制格式版本串 0.2.0.0，头部字节: ${data.subarray(0, 32).toString('hex')}`);
}
console.log('✓ 头部含格式版本串 0.2.0.0');

/* ------------------------------------------------------------------ */
/* 校验 2：体积下限                                                     */
/* ------------------------------------------------------------------ */

// 真实应用（含完整登录/会话/聊天页面）远大于 100KB；
// 若只有几十 KB，多半是空模板或只打包了测试组件
const MIN_SIZE = 100 * 1024;
if (size < MIN_SIZE) {
  console.warn(
    `::warning::bundle 仅 ${(size / 1024).toFixed(1)} KB，` +
      `小于建议下限 ${MIN_SIZE / 1024} KB，可能缺少页面代码`,
  );
}

/* ------------------------------------------------------------------ */
/* 校验 3：用 @lynx-js/tasm 解码做结构校验                               */
/* ------------------------------------------------------------------ */

/** 在 pnpm 的虚拟目录里找到 tasm 包（从当前目录向上逐级查找） */
function resolveTasm() {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const pnpmDir = join(dir, 'node_modules/.pnpm');
    try {
      const hit = readdirSync(pnpmDir).find((d) => d.startsWith('@lynx-js+tasm@'));
      if (hit) {
        return require(join(pnpmDir, hit, 'node_modules/@lynx-js/tasm/index.js'));
      }
    } catch {
      // 该层没有，继续向上
    }
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return require('@lynx-js/tasm');
}

let tasm;
try {
  tasm = resolveTasm();
} catch (e) {
  // 拿不到解码器时降级为「只做头部校验」，不阻断构建
  console.warn(`::warning::未找到 @lynx-js/tasm（${e.message}），跳过结构校验`);
}

if (tasm) {
  const result = tasm.decode_napi(new Uint8Array(data));

  const isLepusNg = result['is-lepusng-binary'];
  const engineVersion = result['engine-version'];
  const appType = result['app-type'];
  const mainThread = result['main-thread-script'] ?? {};
  const mainThreadLen = mainThread.lepus_code?.length ?? 0;
  const bgThread = result['background-thread-script'];

  console.log(`  is-lepusng-binary: ${isLepusNg}`);
  console.log(`  engine-version: ${engineVersion} | app-type: ${appType}`);
  console.log(`  main-thread-script: ${mainThreadLen} 字节`);
  console.log(
    `  background-thread-script: ${Array.isArray(bgThread) ? bgThread.length : 0} 段`,
  );

  if (!isLepusNg) {
    fatal('不是 LepusNG 二进制，说明 pluginLynx 未生效');
  }
  if (mainThreadLen < 1000) {
    fatal(
      `main-thread-script 仅 ${mainThreadLen} 字节，UI 模板缺失 ` +
        `（检查 rsbuild.config.ts 是否注册了 pluginReactLynx）`,
    );
  }
  console.log('✓ 结构校验通过');
}

/* ------------------------------------------------------------------ */
/* 校验 4：关键 UI 文本是否真的编译进产物                                */
/* ------------------------------------------------------------------ */

if (needles.length > 0) {
  console.log('=== 检查关键 UI 文本 ===');
  let failed = false;
  for (const needle of needles) {
    /**
     * 编码说明：
     * Lepus 的字符串常量池用 UTF-16LE 存储，
     * 而元数据/注释是 UTF-8，所以两种都要查。
     * （踩坑记录：只用 UTF-8 匹配会误判「UI 文本缺失」）
     */
    const found =
      data.includes(Buffer.from(needle, 'utf8')) ||
      data.includes(Buffer.from(needle, 'utf16le'));
    if (found) {
      console.log(`✓ 找到: ${needle}`);
    } else {
      console.error(`::error::bundle 内缺少 UI 文本 "${needle}"，入口组件可能未编译进去`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
}

console.log('✅ bundle 校验全部通过');
