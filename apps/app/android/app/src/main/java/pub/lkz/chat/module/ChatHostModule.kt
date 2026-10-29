package pub.lkz.chat.module

import android.content.Context
import com.lynx.jsbridge.LynxMethod
import com.lynx.jsbridge.LynxModule
import com.lynx.react.bridge.Callback
import com.lynx.react.bridge.JavaOnlyMap
import pub.lkz.chat.ChatApplication
import pub.lkz.chat.MainActivity
import pub.lkz.chat.call.CallService

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
