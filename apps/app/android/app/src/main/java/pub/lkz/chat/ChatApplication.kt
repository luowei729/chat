package pub.lkz.chat

import android.app.Application
import com.facebook.drawee.backends.pipeline.Fresco
import com.facebook.imagepipeline.core.ImagePipelineConfig
import com.facebook.imagepipeline.memory.PoolConfig
import com.facebook.imagepipeline.memory.PoolFactory
import com.lynx.service.image.LynxImageService
import com.lynx.service.log.LynxLogService
import com.lynx.tasm.LynxEnv
import com.lynx.tasm.service.LynxServiceCenter
import org.webrtc.PeerConnectionFactory

/**
 * ============================================================
 * 应用入口
 * ------------------------------------------------------------
 * 启动顺序（顺序错了会崩溃或图片不显示）：
 *   1. Fresco 初始化
 *   2. 注册 Lynx 服务（图片/日志）
 *   3. LynxEnv.init
 *   4. 异步初始化 WebRTC
 *
 * 为什么必须先 Fresco 再注册 LynxImageService：
 * LynxImageService 内部直接用 Fresco 的 ImagePipeline，
 * 若 Fresco 未初始化，<image> 元素会静默失败（图片不显示）。
 *
 * 为什么 WebRTC 异步初始化：
 * PeerConnectionFactory 创建约 100-200ms，放主线程会拖慢冷启动；
 * 初始化失败也不应影响聊天功能，所以放后台线程并 try-catch。
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
    }

    override fun onCreate() {
        super.onCreate()
        instance = this

        initLynxService()
        initLynxEnv()

        // WebRTC 放后台线程，避免拖慢首屏
        Thread { initWebRtc() }.start()
    }

    /**
     * 初始化 Lynx 依赖的服务
     * 说明：Lynx 的图片/日志能力是可插拔的服务，
     *      不注册的话对应功能直接不可用。
     */
    private fun initLynxService() {
        // Fresco：LynxImageService 的底层图片管线
        val poolFactory = PoolFactory(PoolConfig.newBuilder().build())
        val builder = ImagePipelineConfig.newBuilder(applicationContext)
            .setPoolFactory(poolFactory)
        Fresco.initialize(applicationContext, builder.build())

        // 注册图片加载服务
        LynxServiceCenter.inst().registerService(LynxImageService.getInstance())
        // 注册日志服务：前端 console.log 会输出到 Logcat（tag: Lynx）
        LynxServiceCenter.inst().registerService(LynxLogService.INSTANCE)
    }

    /** 初始化 Lynx 引擎（必须在创建 LynxView 之前） */
    private fun initLynxEnv() {
        // 四个参数：context, templateProvider, behaviorBundle, lynxViewBuilder
        // 全部传 null 表示使用默认实现，bundle 由 LynxViewBuilder 单独指定
        LynxEnv.inst().init(this, null, null, null)

        // debug 包开启调试与 LogBox；release 包自动关闭
        if (BuildConfig.DEBUG) {
            LynxEnv.inst().enableLynxDebug(true)
            LynxEnv.inst().enableDevtool(true)
            LynxEnv.inst().enableLogBox(true)
        }
    }

    /**
     * 初始化 WebRTC
     * 失败不崩溃：只是通话功能不可用，聊天等核心功能仍正常。
     */
    private fun initWebRtc() {
        try {
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(this)
                    // 关闭内部追踪：省内存，2G 设备友好
                    .setEnableInternalTracer(false)
                    .createInitializationOptions(),
            )

            peerConnectionFactory = PeerConnectionFactory.builder()
                .createPeerConnectionFactory()

            webRtcReady = true
        } catch (e: Throwable) {
            android.util.Log.e("ChatApplication", "WebRTC 初始化失败", e)
            webRtcReady = false
        }
    }
}
