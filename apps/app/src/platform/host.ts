/**
 * ============================================================
 * 宿主能力访问层（ChatHost 原生模块）
 * ============================================================
 * 为什么单独抽一层：
 * 1. 页面不该直接拼 NativeModules 调用，方法名一改就要全项目搜；
 * 2. 所有方法都要 null 安全 —— Web / 桌面端 / iOS 未实现时
 *    必须静默降级，而不是抛异常把页面打挂（全平台可用原则）。
 * 3. 能力探测而非平台判断：拿不到模块就当不支持。
 *
 * 原生契约（Android 已实现，其余端按同名方法补齐即可）：
 *   setCanGoBack(boolean)
 *   setCallState(active: boolean, peerName: string)
 *   hasOverlayPermission(cb: (granted: boolean) => void)
 *   requestOverlayPermission()
 *   showFloatingCall() / hideFloatingCall()
 *   moveTaskToBack()
 *   startCallService() / stopCallService()
 * ============================================================
 */

import { getNativeModule } from './globals.js';

interface ChatHostNative {
  setCanGoBack?: (v: boolean) => void;
  setCallState?: (active: boolean, peerName: string) => void;
  hasOverlayPermission?: (cb: (granted: unknown) => void) => void;
  requestOverlayPermission?: () => void;
  showFloatingCall?: () => void;
  hideFloatingCall?: () => void;
  moveTaskToBack?: () => void;
  startCallService?: () => void;
  stopCallService?: () => void;
}

function host(): ChatHostNative | null {
  return getNativeModule<ChatHostNative>('ChatHost');
}

/**
 * 标记通话开始 / 结束
 * ------------------------------------------------------------
 * 这一个调用同时管三件事，缺一不可：
 *   1. 启动前台服务 → 后台/锁屏后麦克风与网络不被系统冻结；
 *   2. 置位「通话中」 → MainActivity.onStop 时据此弹悬浮窗；
 *   3. 首次通话时引导申请悬浮窗权限。
 *
 * 必须在通话真正建立后调用、并在挂断的所有路径上调用 false，
 * 否则会出现「已挂断但通知栏还在」「后台仍占麦克风」的问题。
 */
export function setCallState(active: boolean, peerName: string): void {
  try {
    host()?.setCallState?.(active, peerName);
  } catch {
    // 宿主不支持则忽略（Web 端后台由浏览器自己管）
  }
}

/** 悬浮窗权限状态（Promise 化，拿不到模块时返回 false） */
export function hasOverlayPermission(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const h = host();
    if (!h?.hasOverlayPermission) {
      resolve(false);
      return;
    }
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    // 原生没回调时兜底，避免 await 永久挂起
    setTimeout(() => finish(false), 800);
    try {
      h.hasOverlayPermission((v) => finish(v === true));
    } catch {
      finish(false);
    }
  });
}

/** 跳系统设置页申请悬浮窗权限 */
export function requestOverlayPermission(): void {
  try {
    host()?.requestOverlayPermission?.();
  } catch {
    // 忽略
  }
}

/** 显示 / 隐藏悬浮窗（通话中手动控制） */
export function showFloatingCall(): void {
  try {
    host()?.showFloatingCall?.();
  } catch {
    // 忽略
  }
}

export function hideFloatingCall(): void {
  try {
    host()?.hideFloatingCall?.();
  } catch {
    // 忽略
  }
}

/** 最小化到后台（不退出进程，保留全部内存态） */
export function moveTaskToBack(): void {
  try {
    host()?.moveTaskToBack?.();
  } catch {
    // 忽略
  }
}

/**
 * 通话开始时确认后台能力
 * ------------------------------------------------------------
 * 用户第一次通话时，如果还没给悬浮窗权限，顺手引导一次。
 * 不阻塞通话流程 —— 没授权就只是没有小窗，后台通话仍然可用。
 */
export function prepareCallBackground(peerName: string): void {
  setCallState(true, peerName);
  void hasOverlayPermission().then((granted) => {
    if (!granted) requestOverlayPermission();
  });
}
