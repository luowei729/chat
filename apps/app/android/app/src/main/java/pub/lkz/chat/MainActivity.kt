package pub.lkz.chat

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.lynx.tasm.LynxView
import com.lynx.tasm.LynxViewBuilder
import com.lynx.tasm.ThreadStrategyForRendering
import com.lynx.tasm.provider.AbsTemplateProvider
import com.lynx.xelement.XElementBehaviors
import pub.lkz.chat.module.ChatHostModule
import java.io.IOException

/**
 * ============================================================
 * 主界面：LynxView 宿主（带原生诊断面板）
 * ============================================================
 * 【为什么要诊断面板】
 * Lynx 渲染失败时不会抛异常，只留一片黑屏，
 * 而且我们看不到用户的设备日志。
 *
 * 所以这里把「每一步的执行状态」用原生 TextView 直接画在屏幕上：
 *   - 如果连诊断面板都看不到 → Activity/窗口/主题层面的问题
 *   - 如果看到面板 → 直接知道卡在哪一步（bundle 读取/LynxView 创建/渲染）
 *   - Lynx 渲染成功后 1.5 秒自动隐藏面板，用户无感
 *
 * 这比让用户接 adb 抓日志快得多，也是定位「静默黑屏」最有效的手段。
 * ============================================================
 */
class MainActivity : AppCompatActivity() {

    private var lynxView: LynxView? = null

    /** 根容器：垂直排列「诊断面板 + LynxView」 */
    private lateinit var rootLayout: LinearLayout

    /** LynxView 的承载容器（重试时清空重建） */
    private lateinit var lynxContainer: FrameLayout

    /** 诊断日志文本 */
    private lateinit var diagText: TextView

    /** 诊断面板容器（渲染成功后隐藏） */
    private lateinit var diagPanel: ScrollView

    /** 记录上次按返回键的时间，用于「双击退出」 */
    private var lastBackPressedAt: Long = 0

    companion object {
        private const val TAG = "MainActivity"

        /** bundle 文件名：CI 会把构建产物拷贝到 assets 下 */
        private const val BUNDLE_NAME = "chat.lynx.bundle"

        /** 权限请求码 */
        private const val REQ_PERMISSIONS = 1001

        /** 双击退出的时间窗口（毫秒） */
        private const val DOUBLE_BACK_INTERVAL = 2000L

        /**
         * 当前 Activity 实例
         * 用途：原生模块（ChatHost.exitApp）需要拿到 Activity 才能 finish
         */
        @Volatile
        var current: MainActivity? = null
            private set
    }

    /* ------------------------------------------------------------------ */
    /* 生命周期                                                             */
    /* ------------------------------------------------------------------ */

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        current = this

        requestRuntimePermissions()

        buildLayout()

        log("=== chat 启动诊断 ===")
        log("设备: ${Build.MANUFACTURER} ${Build.MODEL}")
        log("Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
        log("ABI: ${Build.SUPPORTED_ABIS.joinToString()}")
        log("WebRTC: ${if (ChatApplication.webRtcReady) "就绪" else "未就绪"}")
        log("")
        log("开始加载 bundle: $BUNDLE_NAME")

        // 用官方推荐的线程策略加载；失败自动降级重试
        loadWithStrategy(ThreadStrategyForRendering.MOST_ON_TASM, attempt = 1)
    }

    /* ------------------------------------------------------------------ */
    /* 布局：诊断面板 + LynxView                                            */
    /* ------------------------------------------------------------------ */

    /**
     * 构建界面
     * ============================================================
     * 结构：
     *   LinearLayout(vertical)
     *     ├── ScrollView  诊断面板（默认占 45% 高度，可滚动）
     *     │     └── TextView 日志
     *     └── FrameLayout LynxView 容器（flex:1）
     *
     * 为什么用原生布局而不是直接 setContentView(lynxView)：
     * 需要一个「即使 Lynx 完全失败也能显示内容」的独立通道，
     * 否则黑屏时我们什么都看不到，无法定位。
     * ============================================================
     */
    private fun buildLayout() {
        rootLayout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#070B14"))
        }

        // ---------- 诊断面板 ----------
        diagText = TextView(this).apply {
            setTextColor(Color.parseColor("#7CFFB2"))
            textSize = 10.5f
            setBackgroundColor(Color.parseColor("#101A2E"))
            setPadding(24, 24, 24, 24)
            typeface = android.graphics.Typeface.MONOSPACE
            // 允许选中复制，方便用户反馈
            isTextSelectable = true
        }

        diagPanel = ScrollView(this).apply {
            addView(
                diagText,
                ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ),
            )
        }

        rootLayout.addView(
            diagPanel,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                0.45f, // 初始占 45%，渲染成功后隐藏
            ),
        )

        // ---------- LynxView 容器 ----------
        lynxContainer = FrameLayout(this)
        rootLayout.addView(
            lynxContainer,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                0.55f,
            ),
        )

        setContentView(rootLayout)
    }

    /** 追加一行诊断日志（同时输出到 Logcat） */
    private fun log(msg: String) {
        Log.i(TAG, msg)
        runOnUiThread {
            diagText.append("$msg\n")
            diagPanel.post { diagPanel.fullScroll(ScrollView.FOCUS_DOWN) }
        }
    }

    /* ------------------------------------------------------------------ */
    /* 加载与重试                                                           */
    /* ------------------------------------------------------------------ */

    private fun loadWithStrategy(strategy: ThreadStrategyForRendering, attempt: Int) {
        log("")
        log("[第 $attempt 次] 线程策略 = $strategy")

        // 清空上一次的视图
        lynxContainer.removeAllViews()
        lynxView?.let {
            try {
                it.destroy()
            } catch (e: Throwable) {
                Log.w(TAG, "销毁旧 LynxView 失败", e)
            }
        }
        lynxView = null

        // ---------- 创建 LynxView ----------
        val view = try {
            createLynxView(strategy)
        } catch (e: Throwable) {
            log("✗ 创建 LynxView 异常: ${e.javaClass.simpleName}: ${e.message}")
            Log.e(TAG, "创建 LynxView 失败", e)
            if (attempt == 1) {
                loadWithStrategy(ThreadStrategyForRendering.ALL_ON_UI, 2)
            }
            return
        }

        log("✓ LynxView 创建成功")
        lynxView = view

        lynxContainer.addView(
            view,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
        log("✓ 已挂载到容器")

        // ---------- 渲染 ----------
        try {
            view.renderTemplateUrl(BUNDLE_NAME, "")
            log("✓ renderTemplateUrl 已调用")
        } catch (e: Throwable) {
            log("✗ renderTemplateUrl 异常: ${e.javaClass.simpleName}: ${e.message}")
            Log.e(TAG, "渲染失败", e)
        }

        // ---------- 渲染结果检查 ----------
        view.postDelayed({
            val w = view.width
            val h = view.height
            val children = view.childCount
            log("检查: 尺寸=${w}x$h, 子视图=$children")

            val ok = children > 0 && w > 0 && h > 0
            if (ok) {
                log("✓ 渲染成功，隐藏诊断面板")
                hideDiagPanel()
            } else if (attempt == 1) {
                log("✗ 未渲染出内容，换 ALL_ON_UI 重试")
                loadWithStrategy(ThreadStrategyForRendering.ALL_ON_UI, 2)
            } else {
                log("")
                log("=== 两种策略均失败 ===")
                log("请截图本页反馈给开发者")
                showFatalError(
                    "渲染失败\n尺寸=${w}x$h 子视图=$children\n请截图上方日志反馈",
                )
            }
        }, 2500)
    }

    /**
     * 渲染成功后收起诊断面板，把空间让给 Lynx 界面
     */
    private fun hideDiagPanel() {
        runOnUiThread {
            try {
                val params = diagPanel.layoutParams as LinearLayout.LayoutParams
                params.height = 0
                params.weight = 0f
                diagPanel.layoutParams = params
                diagPanel.visibility = android.view.View.GONE

                val lynxParams = lynxContainer.layoutParams as LinearLayout.LayoutParams
                lynxParams.weight = 1f
                lynxContainer.layoutParams = lynxParams
            } catch (e: Throwable) {
                Log.w(TAG, "隐藏诊断面板失败", e)
            }
        }
    }

    /**
     * 创建 LynxView
     * ============================================================
     * 关键点：
     * - addBehaviors(XElementBehaviors)：注册 input/webview/video 等原生组件
     * - setThreadStrategyForRendering：ReactLynx 必须用多线程策略
     * - setTemplateProvider：从 assets 读取离线 bundle
     * ============================================================
     */
    private fun createLynxView(strategy: ThreadStrategyForRendering): LynxView {
        val builder = LynxViewBuilder()

        builder.addBehaviors(XElementBehaviors().create())
        builder.setThreadStrategyForRendering(strategy)

        builder.setTemplateProvider(object : AbsTemplateProvider() {
            override fun loadTemplate(uri: String, callback: Callback) {
                Thread {
                    try {
                        val bytes = assets.open(uri).use { it.readBytes() }
                        log("✓ bundle 读取成功: ${bytes.size} 字节")
                        callback.onSuccess(bytes)
                    } catch (e: IOException) {
                        log("✗ bundle 读取失败: ${e.message}")
                        Log.e(TAG, "读取 bundle 失败", e)
                        callback.onFailed(e.message ?: "读取 bundle 失败")
                    }
                }.start()
            }
        })

        return builder.build(this)
    }

    /* ------------------------------------------------------------------ */
    /* 错误展示                                                             */
    /* ------------------------------------------------------------------ */

    /**
     * 在 LynxView 之上叠加错误信息
     * 说明：即使 Lynx 完全黑屏，这段红字也应该可见；
     *      如果连红字都看不到，说明是窗口/主题层面的问题。
     */
    private fun showFatalError(message: String) {
        runOnUiThread {
            try {
                val tv = TextView(this).apply {
                    text = message
                    setTextColor(Color.parseColor("#FF6B6B"))
                    textSize = 13f
                    gravity = Gravity.CENTER
                    setPadding(40, 40, 40, 40)
                    setBackgroundColor(Color.parseColor("#1A0F14"))
                }
                lynxContainer.addView(
                    tv,
                    FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT,
                        FrameLayout.LayoutParams.WRAP_CONTENT,
                        Gravity.CENTER,
                    ),
                )
            } catch (e: Throwable) {
                Log.e(TAG, "展示错误信息失败", e)
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* 权限                                                                 */
    /* ------------------------------------------------------------------ */

    private fun requestRuntimePermissions() {
        val wanted = mutableListOf(
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.CAMERA,
            Manifest.permission.MODIFY_AUDIO_SETTINGS,
        )

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            wanted += Manifest.permission.READ_MEDIA_IMAGES
            wanted += Manifest.permission.READ_MEDIA_VIDEO
            wanted += Manifest.permission.READ_MEDIA_AUDIO
            wanted += Manifest.permission.POST_NOTIFICATIONS
        } else {
            wanted += Manifest.permission.READ_EXTERNAL_STORAGE
        }

        val missing = wanted.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }

        if (missing.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, missing.toTypedArray(), REQ_PERMISSIONS)
        }
    }

    /* ------------------------------------------------------------------ */
    /* 返回键与生命周期                                                     */
    /* ------------------------------------------------------------------ */

    @Deprecated("Android 13+ 推荐用 OnBackPressedDispatcher")
    override fun onBackPressed() {
        val view = lynxView
        if (view != null && ChatHostModule.isCanGoBack()) {
            try {
                view.sendGlobalEvent("hardwareBack", com.lynx.react.bridge.JavaOnlyArray())
                return
            } catch (e: Throwable) {
                Log.w(TAG, "发送返回事件失败", e)
            }
        }

        val now = System.currentTimeMillis()
        if (now - lastBackPressedAt < DOUBLE_BACK_INTERVAL) {
            finishAffinity()
            return
        }
        lastBackPressedAt = now
        Toast.makeText(this, "再按一次退出", Toast.LENGTH_SHORT).show()
    }

    override fun onPause() {
        super.onPause()
        try {
            lynxView?.onEnterBackground()
        } catch (e: Throwable) {
            Log.w(TAG, "onEnterBackground 失败", e)
        }
    }

    override fun onResume() {
        super.onResume()
        try {
            lynxView?.onEnterForeground()
        } catch (e: Throwable) {
            Log.w(TAG, "onEnterForeground 失败", e)
        }
    }

    override fun onDestroy() {
        try {
            lynxView?.destroy()
        } catch (e: Throwable) {
            Log.w(TAG, "destroy 失败", e)
        }
        lynxView = null
        if (current === this) current = null
        super.onDestroy()
    }
}
