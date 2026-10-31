package pub.lkz.chat

import android.app.Application
import android.content.Context
import com.facebook.drawee.backends.pipeline.Fresco
import com.facebook.imagepipeline.core.ImagePipelineConfig
import com.facebook.imagepipeline.memory.PoolConfig
import com.facebook.imagepipeline.memory.PoolFactory
import com.lynx.service.image.LynxImageService
import com.lynx.service.log.LynxLogService
import com.lynx.service.http.LynxHttpService
import com.lynx.tasm.LynxEnv
import com.lynx.tasm.service.LynxServiceCenter
import org.webrtc.PeerConnectionFactory
import pub.lkz.chat.media.ChatMediaModule
import pub.lkz.chat.media.ChatRtcModule
import pub.lkz.chat.media.ChatSocketModule
import pub.lkz.chat.media.ChatStoreModule
import pub.lkz.chat.module.ChatHostModule
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * ============================================================
 * 应用入口
 * ============================================================
 * 【设计原则：绝不崩溃、绝不静默】
 *
 * 之前每次初始化失败都会导致进程直接死掉，用户只看到一闪而过的黑窗，
 * 完全没有可排查的信息。现在每一步都：
 *   1. 单独 try/catch，失败不中断后续步骤
 *   2. 结果写入 BootLog（内存 + 文件双写）
 *   3. 下次启动时能读到上次的失败记录
 *
 * 启动顺序（顺序错了会崩溃或图片不显示）：
 *   1. Fresco 初始化
 *   2. 注册 Lynx 服务（图片/日志）
 *   3. LynxEnv.init
 *   4. 注册自定义原生模块（ChatHost）
 *   5. 异步初始化 WebRTC
 *
 * 为什么必须先 Fresco 再注册 LynxImageService：
 * LynxImageService 内部直接用 Fresco 的 ImagePipeline，
 * 若 Fresco 未初始化，image 元素会静默失败（图片不显示）。
 * ============================================================
 */
class ChatApplication : Application() {

    companion object {
        /** 全局单例：原生模块通过它访问 WebRTC */
        lateinit var instance: ChatApplication
            private set

        /** WebRTC 工厂：整个进程唯一 */
        var peerConnectionFactory: PeerConnectionFactory? = null
            private set

        /** WebRTC 是否初始化完成 */
        @Volatile
        var webRtcReady: Boolean = false
            private set

        /**
         * 调试开关：是否在界面上显示原生诊断条
         * 用途：黑屏问题时设为 true 可看到每一步状态；
         *      稳定后设为 false 即为正常 UI。
         */
        const val SHOW_DEBUG_BAR = false

        /** 构建标记：用户可在诊断条上看到，确认装的是新包 */
        const val BUILD_TAG = "RC-1"
    }

    override fun onCreate() {
        super.onCreate()
        instance = this

        BootLog.init(this)
        BootLog.i("=== 应用启动 $BUILD_TAG ===")
        BootLog.i("设备: ${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}")
        BootLog.i("Android ${android.os.Build.VERSION.RELEASE} (API ${android.os.Build.VERSION.SDK_INT})")
        BootLog.i("ABI: ${android.os.Build.SUPPORTED_ABIS.joinToString()}")

        // 上次启动是否异常退出（能看到崩溃前的最后几行）
        val prev = BootLog.readPreviousCrash()
        if (prev != null) {
            BootLog.i("!! 上次启动异常退出，最后记录：")
            // 注意：不要用 lineSequence().takeLast()，
            // CI 上的 Kotlin 版本对 Sequence.takeLast 解析会报 receiver 不匹配
            prev.split('\n').takeLast(12).forEach { BootLog.i("  $it") }
        }

        // 每一步独立 try/catch，任何一步失败都不影响后续
        safeStep("Fresco") { initFresco() }
        safeStep("注册 Lynx 服务") { registerLynxServices() }
        safeStep("LynxEnv.init") { initLynxEnv() }
        safeStep("注册原生模块") { registerNativeModules() }

        // WebRTC 放后台线程，避免拖慢首屏
        Thread { safeStep("WebRTC") { initWebRtc() } }.start()

        BootLog.i("=== Application 初始化完成 ===")
    }

    /** 单步安全执行：失败只记录，不中断 */
    private inline fun safeStep(name: String, block: () -> Unit) {
        try {
            block()
            BootLog.i("✓ $name")
        } catch (e: Throwable) {
            BootLog.e("✗ $name 失败: ${e.javaClass.simpleName}: ${e.message}")
            android.util.Log.e("ChatApplication", "$name 失败", e)
        }
    }

    /** Fresco：LynxImageService 的底层图片管线 */
    private fun initFresco() {
        val poolFactory = PoolFactory(PoolConfig.newBuilder().build())
        val builder = ImagePipelineConfig.newBuilder(applicationContext)
            .setPoolFactory(poolFactory)
        Fresco.initialize(applicationContext, builder.build())
    }

    /** 注册 Lynx 依赖的可插拔服务 */
    private fun registerLynxServices() {
        LynxServiceCenter.inst().registerService(LynxImageService.getInstance())
        // LynxLogService 是 Kotlin object，Kotlin 侧直接引用对象名
        LynxServiceCenter.inst().registerService(LynxLogService)
        // HTTP 服务：没有它，前端 fetch 一律失败（引擎不内置网络实现）
        LynxServiceCenter.inst().registerService(LynxHttpService)
    }

    /** 初始化 Lynx 引擎（必须在创建 LynxView 之前） */
    private fun initLynxEnv() {
        LynxEnv.inst().init(this, null, null, null)

        if (BuildConfig.DEBUG) {
            LynxEnv.inst().enableLynxDebug(true)
            LynxEnv.inst().enableDevtool(true)
            LynxEnv.inst().enableLogBox(true)
        }
    }

    /** 注册自定义原生模块（供前端调用返回键/退出/通话服务） */
    private fun registerNativeModules() {
        LynxEnv.inst().registerModule("ChatHost", ChatHostModule::class.java)
        // 媒体能力：选图/拍照/录像/选文件/录音/播放/上传
        // 与前端 src/platform/media.ts 的方法名一一对应，
        // iOS/HarmonyOS 按同一契约实现即可，前端无需改动
        LynxEnv.inst().registerModule("ChatMedia", ChatMediaModule::class.java)
        // 键值存储：Lynx 引擎本身没有 Storage API，令牌/主题/草稿
        // 必须靠原生持久化，否则每次重启都要重新登录
        LynxEnv.inst().registerModule("ChatStore", ChatStoreModule::class.java)
        // WebSocket：Lynx 引擎完全没有长连接能力（连 WebSocket 全局对象都没有
        // 可用实现），必须由宿主提供，否则消息不推送、通话收不到
        LynxEnv.inst().registerModule("ChatSocket", ChatSocketModule::class.java)
        // 语音通话：Lynx 引擎没有 WebRTC，原生桥接麦克风与 P2P 连接，
        // 前端 engine.ts 通过 registerNativeRtc() 注册为 RtcProvider
        LynxEnv.inst().registerModule("ChatRtc", ChatRtcModule::class.java)
    }

    /**
     * 初始化 WebRTC
     * 失败只是通话不可用，聊天等核心功能不受影响。
     */
    private fun initWebRtc() {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(this)
                .setEnableInternalTracer(false)
                .createInitializationOptions(),
        )
        peerConnectionFactory = PeerConnectionFactory.builder().createPeerConnectionFactory()
        webRtcReady = true
    }
}

/**
 * ============================================================
 * 启动日志（内存 + 文件双写）
 * ============================================================
 * 为什么需要它：
 * 1. 用户无法提供 adb 日志时，界面上的诊断条是唯一的观察窗口；
 * 2. 进程崩溃前的记录会留在文件里，下次启动可以读出来；
 * 3. 用户可一键复制/分享，便于远程排查。
 *
 * 文件位置：filesDir/boot.log，超过 200 行自动截断。
 * ============================================================
 */
object BootLog {
    private const val FILE_NAME = "boot.log"
    private const val CRASH_MARK = "---CRASH---"
    private const val MAX_LINES = 200

    private val lines = mutableListOf<String>()
    private var file: File? = null
    private val timeFmt = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    /** 当前进程是否已正常走完 init（用于判断上次是否崩溃） */
    private var sessionCompleted = false

    fun init(context: Context) {
        file = File(context.filesDir, FILE_NAME)

        // 上次进程没有走到 "SESSION_OK"，视为异常退出
        try {
            val prev = file?.takeIf { it.exists() }?.readText().orEmpty()
            if (prev.isNotBlank() && !prev.contains("SESSION_OK")) {
                // 保留上一轮日志，作为崩溃现场
                lastSession = prev
            }
        } catch (e: Throwable) {
            android.util.Log.w("BootLog", "读取上次日志失败", e)
        }

        // 本轮日志从头写
        try {
            file?.writeText("")
        } catch (e: Throwable) {
            android.util.Log.w("BootLog", "清空日志失败", e)
        }
        lines.clear()
    }

    private var lastSession: String? = null

    /** 读取上次异常退出的日志 */
    fun readPreviousCrash(): String? = lastSession

    fun i(msg: String) = append(msg)

    fun e(msg: String) = append("E/ $msg")

    private fun append(msg: String) {
        val line = "${timeFmt.format(Date())} $msg"
        synchronized(lines) {
            lines.add(line)
            if (lines.size > MAX_LINES) lines.removeAt(0)
        }
        android.util.Log.i("BootLog", msg)
        // 每次写盘：日志量小（<200 行），换取崩溃时数据不丢
        try {
            file?.writeText(buildString {
                append(lines.joinToString("\n"))
                append("\n")
                if (sessionCompleted) append("SESSION_OK\n")
            })
        } catch (e: Throwable) {
            // 写盘失败不影响运行
        }
    }

    /** 标记本次启动已成功走完（下次启动就不会误判为崩溃） */
    fun markSessionOk() {
        sessionCompleted = true
        append("SESSION_OK")
    }

    /** 取当前日志全文（供界面展示/复制） */
    fun dump(): String = synchronized(lines) { lines.joinToString("\n") }
}
