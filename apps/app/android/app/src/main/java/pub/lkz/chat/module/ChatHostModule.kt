package pub.lkz.chat.module

import android.content.Context
import com.lynx.jsbridge.LynxMethod
import com.lynx.jsbridge.LynxModule
import com.lynx.react.bridge.Callback
import com.lynx.react.bridge.JavaOnlyMap
import pub.lkz.chat.ChatApplication
import pub.lkz.chat.MainActivity
import pub.lkz.chat.call.CallService
import pub.lkz.chat.call.FloatingCallWindow

/**
 * ============================================================
 * 宿主能力原生模块（ChatHost）
 * ============================================================
 * 为什么需要它：
 * 1. **返回键**：Lynx 没有提供「当前是否可返回」的同步查询，
 *    必须由前端主动告诉原生「我现在在根页面吗」，
 *    否则硬件返回键无法区分「返回上一页」和「退出 App」；
 * 2. **退出 App**：前端没有权限调用 finish()；
 * 3. **通话前台服务**：锁屏保活必须由原生启动 Service，
 *    前端无法直接操作；
 * 4. **平台信息**：前端需要知道运行平台做能力降级。
 *
 * 前端调用方式（ReactLynx）：
 *   const host = NativeModules.ChatHost;
 *   host.setCanGoBack(routeStack.length > 1);
 *   host.exitApp();
 *   host.startCallService();
 *   host.getPlatformInfo((info) => { ... });
 *
 * 注意：
 * - 所有方法必须加 @LynxMethod 注解，否则前端调不到；
 * - Lynx 会在后台线程调用这些方法，涉及 UI 的操作必须切主线程；
 * - 必须同时提供 (Context) 与 (Context, Any?) 两个构造函数，
 *   因为 Lynx 内部可能用任一签名实例化模块。
 * ============================================================
 */
class ChatHostModule : LynxModule {

    /** 单参构造：Lynx 默认实例化方式 */
    constructor(context: Context) : super(context)

    /** 双参构造：带模块参数的实例化方式 */
    constructor(context: Context, param: Any?) : super(context, param)

    companion object {
        /**
         * 前端当前是否还能返回上一页
         * 用 @Volatile 保证主线程（返回键）能立刻看到前端线程的更新
         */
        @Volatile
        private var canGoBack: Boolean = false

        /** 查询是否可返回（供 MainActivity 使用） */
        fun isCanGoBack(): Boolean = canGoBack

        /**
         * 是否正在通话中
         * ------------------------------------------------------------
         * MainActivity 在 onStop 时据此决定要不要弹悬浮窗，
         * 在 onResume 时据此隐藏。必须由前端显式置位，
         * 因为原生无法感知 WebRTC 的会话状态。
         */
        @Volatile
        private var inCall: Boolean = false

        fun isInCall(): Boolean = inCall

        /** 当前通话对方昵称，悬浮窗标题用 */
        @Volatile
        private var peerName: String = "通话中"

        fun peerNameOf(): String = peerName

        /** 通话开始时间戳，悬浮窗计时用 */
        @Volatile
        private var callStartedAt: Long = 0L

        fun callStartedAtOf(): Long = callStartedAt
    }

    /**
     * 前端通知原生：当前路由栈深度
     * @param value true 表示有上一页，false 表示在根页面
     */
    @LynxMethod
    fun setCanGoBack(value: Boolean) {
        canGoBack = value
    }

    /**
     * 退出 App
     * 说明：必须切主线程，且用 finishAffinity 关闭所有 Activity，
     *      避免只关掉当前页留下后台任务。
     */
    @LynxMethod
    fun exitApp() {
        val activity = MainActivity.current ?: return
        activity.runOnUiThread {
            activity.finishAffinity()
        }
    }

    /**
     * 启动通话前台服务
     * 说明：锁屏通话的关键 —— 没有前台服务，切后台约 1 分钟
     *      系统就会冻结进程，WebRTC 音频采集中断。
     */
    @LynxMethod
    fun startCallService() {
        val ctx = mContext ?: return
        CallService.start(ctx)
    }

    /** 停止通话前台服务（挂断时调用） */
    @LynxMethod
    fun stopCallService() {
        val ctx = mContext ?: return
        CallService.stop(ctx)
    }

    /**
     * 标记通话状态并启动/停止后台保活
     * ------------------------------------------------------------
     * @param active true=通话开始（启动前台服务 + 允许后续弹悬浮窗）
     *               false=通话结束（停服务 + 隐藏悬浮窗）
     * @param peerName 对方昵称，用于通知与悬浮窗
     */
    @LynxMethod
    fun setCallState(active: Boolean, name: String) {
        inCall = active
        callStartedAt = if (active) System.currentTimeMillis() else 0L

        val ctx = mContext ?: return
        if (active) {
            peerName = name.ifEmpty { "通话中" }
            // 前台服务：锁屏后保持麦克风与网络
            try {
                CallService.start(ctx, peerName)
            } catch (_: Throwable) {
                // 没有通知权限时启动失败也不影响通话本身
            }
            // 提前申请悬浮窗权限（用户首次通话时弹系统设置页）
            if (!FloatingCallWindow.canDraw(ctx)) {
                FloatingCallWindow.requestPermission(ctx)
            }
        } else {
            FloatingCallWindow.hide()
            try {
                CallService.stop(ctx)
            } catch (_: Throwable) {
            }
        }
    }

    /** 悬浮窗权限是否已授予 */
    @LynxMethod
    fun hasOverlayPermission(callback: Callback) {
        val ctx = mContext ?: run {
            callback.invoke(false)
            return
        }
        callback.invoke(FloatingCallWindow.canDraw(ctx))
    }

    /** 跳系统设置页申请悬浮窗权限 */
    @LynxMethod
    fun requestOverlayPermission() {
        val ctx = mContext ?: return
        FloatingCallWindow.requestPermission(ctx)
    }

    /** 手动显示悬浮窗（通话中切后台可由前端主动调用） */
    @LynxMethod
    fun showFloatingCall() {
        val ctx = mContext ?: return
        if (!inCall) return
        FloatingCallWindow.show(ctx, peerName, callStartedAt)
    }

    /** 隐藏悬浮窗 */
    @LynxMethod
    fun hideFloatingCall() {
        FloatingCallWindow.hide()
    }

    /**
     * 最小化到后台（不退出进程）
     * 供前端「返回」逻辑或悬浮窗按钮调用。
     */
    @LynxMethod
    fun moveTaskToBack() {
        val activity = MainActivity.current ?: return
        activity.runOnUiThread { activity.moveTaskToBack(true) }
    }

    /**
     * 悬浮窗挂断按钮的落点
     * 前端注册后，点小窗的挂断会回调到这里再转给 JS 结束通话。
     */
    @LynxMethod
    fun setFloatingHangupHandler() {
        /**
         * 【必须无参】
         * ------------------------------------------------------------
         * 之前签名是 `handler: Any?`，Lynx 反射生成方法描述符时会抛
         *   RuntimeException: Got unknown param class: Object
         * 后果不是「这一个方法不可用」，而是**整个 ChatHost 模块**
         * 注册失败 —— setCanGoBack / setCallState / 悬浮窗 / 返回键
         * 全部失效，而且日志里只报一次，极难发现。
         *
         * Lynx 的 @LynxMethod 只支持基本类型 / String / Map / Array
         * / Callback。要传「回调」，正确做法是置位 + 全局事件，
         * 所以这里不需要任何参数。
         */
        FloatingCallWindow.onHangup = {
            val activity = MainActivity.current
            try {
                activity?.lynxViewForEvent()?.sendGlobalEvent(
                    "callHangup",
                    com.lynx.react.bridge.JavaOnlyArray(),
                )
            } catch (_: Throwable) {
            }
        }
    }

    /**
     * 获取平台信息
     * 前端用它做能力判断（比如 Android 是否支持后台通话）
     * 注意：必须用 JavaOnlyMap 而不是 Kotlin Map，
     *      否则 Lynx 的桥接层无法正确序列化。
     */
    @LynxMethod
    fun getPlatformInfo(callback: Callback) {
        val info = JavaOnlyMap.from(
            mapOf(
                "platform" to "android",
                "sdkInt" to android.os.Build.VERSION.SDK_INT,
                "model" to android.os.Build.MODEL,
                "manufacturer" to android.os.Build.MANUFACTURER.lowercase(),
                "webRtcReady" to ChatApplication.webRtcReady,
            ),
        )
        callback.invoke(info)
    }

    /**
     * 设备厂商
     * 用途：国内推送通道选择（华为/小米/OPPO/vivo 各用各的 SDK）
     */
    @LynxMethod
    fun getManufacturer(callback: Callback) {
        callback.invoke(android.os.Build.MANUFACTURER.lowercase())
    }
}
