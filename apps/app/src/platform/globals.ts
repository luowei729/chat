/**
 * ============================================================
 * Lynx 全局对象访问器
 * ============================================================
 * 【关键坑】Lynx 的全局变量不是 globalThis 的属性
 * ------------------------------------------------------------
 * 实测（Android / PrimJS 引擎，MOST_ON_TASM 线程策略）：
 *
 *   typeof NativeModules   → 'object'   ✅ 裸标识符可用
 *   typeof lynx            → 'object'   ✅ 裸标识符可用
 *   globalThis.NativeModules → undefined  ❌
 *   globalThis.lynx          → undefined  ❌
 *   'NativeModules' in globalThis → false
 *
 * 原因：这些全局由 Lynx 运行时注入为**独立的词法绑定**，
 * 并不挂在 globalThis 上。所以 `globalThis.lynx` 永远拿不到，
 * 必须写裸标识符；而裸标识符在未注入时直接访问会抛
 * ReferenceError，只能用 `typeof x !== 'undefined'` 探测。
 *
 * 这一条影响着三处原生能力：
 *   1. NativeModules.<自定义模块>  —— 媒体、存储
 *   2. lynx.os                     —— 平台判定
 *   3. lynx 上的其他系统能力
 * 之前用 globalThis 取，全部静默失效（PLATFORM 恒为 web、
 * 存储只写内存、重启即丢登录态）。
 * ============================================================
 */

/** 声明 Lynx 注入的裸全局（ambient，不产生运行时代码） */
declare const NativeModules: Record<string, unknown> | undefined;
declare const lynx: Record<string, unknown> | undefined;

type AnyModule = Record<string, unknown>;

/**
 * 取原生模块
 * ------------------------------------------------------------
 * 优先裸标识符，再退 globalThis（兼容 Web / 桌面端 polyfill）。
 * 拿不到返回 null，调用方据此走 Web 兜底。
 *
 * 注意不要缓存 null：模块可能在首帧之后才注册，
 * 缓空值会让「第一次点没反应、第二次才行」这种偶发问题出现。
 */
export function getNativeModule<T>(name: string): T | null {
  // 1. 裸标识符（Lynx 原生端唯一可行路径）
  try {
    if (typeof NativeModules !== 'undefined' && NativeModules) {
      const mod = (NativeModules as AnyModule)[name];
      if (mod) return mod as T;
    }
  } catch {
    // 某些宿主访问 NativeModules 会抛异常，忽略
  }

  // 2. globalThis（Web / 桌面端 polyfill 场景）
  try {
    const g = globalThis as unknown as { NativeModules?: AnyModule };
    const mod = g.NativeModules?.[name];
    if (mod) return mod as T;
  } catch {
    // 忽略
  }

  return null;
}

/** 取 lynx 全局对象（原生端才有） */
export function getLynx(): AnyModule | null {
  try {
    if (typeof lynx !== 'undefined' && lynx) return lynx as AnyModule;
  } catch {
    // 忽略
  }
  try {
    const g = globalThis as unknown as { lynx?: AnyModule };
    if (g.lynx) return g.lynx;
  } catch {
    // 忽略
  }
  return null;
}

/** 是否运行在 Lynx 原生容器内 */
export function isLynxNative(): boolean {
  return getLynx() !== null;
}
