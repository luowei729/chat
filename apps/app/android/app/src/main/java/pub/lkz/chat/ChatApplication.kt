package pub.lkz.chat

import android.app.Application
import com.lynx.tasm.LynxEnv
import org.webrtc.PeerConnectionFactory

/**
 * ============================================================
 * 应用入口
 * ------------------------------------------------------------
 * 启动时做三件事：
 * 1. 初始化 Lynx 引擎（必须在使用 LynxView 之前完成）；
 * 2. 初始化 WebRTC（PeerConnectionFactory 全局唯一）；
 * 3. 注册自定义原生模块（录音、文件、推送、WebRTC 桥）。
 *
 * 为什么在这里初始化 WebRTC：
 * PeerConnectionFactory 的创建开销较大（约 100-200ms），
 * 放在 Application 里可以让首次通话更快，代价是启动慢一点，
 * 用异步初始化折中。
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

        // ---------- 1. 初始化 Lynx ----------
        // 必须在任何 LynxView 创建之前调用
        LynxEnv.inst().init(
            this,
            null,  // templateProvider：使用 assets 内置 bundle 时可为 null
            null,  // behaviorBundle
            null,  // lynxViewBuilder
        )

        // ---------- 2. 异步初始化 WebRTC ----------
        // 放在后台线程，避免拖慢冷启动
        Thread {
            initWebRtc()
        }.start()
    }

    /**
     * 初始化 WebRTC
     * 说明：初始化失败不崩溃，只是通话功能不可用，
     *      聊天等核心功能仍应正常工作。
     */
    private fun initWebRtc() {
        try {
            // 必须先初始化一次全局环境
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(this)
                    // 开启硬件编码，降低 CPU 占用（语音也要，因为要做回声消除）
                    .setEnableInternalTracer(false)
                    .createInitializationOptions(),
            )

            peerConnectionFactory = PeerConnectionFactory.builder()
                // 使用默认编码器工厂（Opus 音频）
                .createPeerConnectionFactory()

            webRtcReady = true
        } catch (e: Throwable) {
            // 记录但不崩溃：可能缺少硬件支持
            android.util.Log.e("ChatApplication", "WebRTC 初始化失败", e)
            webRtcReady = false
        }
    }
}
