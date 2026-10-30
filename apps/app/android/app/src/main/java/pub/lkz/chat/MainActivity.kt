package pub.lkz.chat

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
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
import com.lynx.tasm.LynxViewClient
import com.lynx.tasm.ThreadStrategyForRendering
import com.lynx.tasm.provider.AbsTemplateProvider
import com.lynx.xelement.XElementBehaviors
import java.io.IOException

/**
 * ============================================================
 * 主界面：LynxView 宿主 + 原生诊断条
 * ============================================================
 * 【为什么这样设计】
 * 之前连续多次「纯黑屏且没有任何提示」，原因是：
 *   - Lynx 渲染失败不抛异常
 *   - 诊断信息只靠 Logcat，用户无法提供
 *
 * 现在把诊断做成**固定高度原生顶栏**（不是 weight 分配），
 * 从物理上保证它不可能因为布局塌陷而消失：
 *   LinearLayout(vertical)
 *     ├── 诊断条（固定 150dp，绿色等宽字体，含版本号与按钮）
 *     └── FrameLayout（weight=1，承载 LynxView）
 *
 * 判定逻辑：
 *   - 能看到绿色文字        → 原生层正常，问题在 Lynx/bundle
 *   - 连绿色文字都看不到    → Activity/主题/安装包层面的问题
 *   - 看到 Lynx 内容        → onFirstScreen 触发后自动收起诊断条
 *
 * 版本标记 BUILD_TAG 会显示在顶栏，用来确认装的确实是新包。
 * ============================================================
 */
class MainActivity : AppCompatActivity() {

    private var lynxView: LynxView? = null

    private lateinit var rootLayout: LinearLayout
    private lateinit var debugBar: LinearLayout
    private lateinit var logView: TextView
    private lateinit var statusView: TextView
    private lateinit var lynxContainer: FrameLayout

    private var lastBackPressedAt: Long = 0

    /** 是否已确认 Lynx 渲染成功（收到 onFirstScreen） */
    private var rendered = false

    /** 引擎自检模式：不自动收起诊断条，避免把结论一起藏掉 */
    private var selfTestMode = false

    companion object {
        private const val TAG = "MainActivity"
        private const val BUNDLE_NAME = "chat.lynx.bundle"
        private const val REQ_PERMISSIONS = 1001
        private const val DOUBLE_BACK_INTERVAL = 2000L

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

        try {
            main()
        } catch (e: Throwable) {
            // 兜底：连界面都构建失败时，直接展示异常文本
            BootLog.e("MainActivity.onCreate 崩溃: ${e.javaClass.simpleName}: ${e.message}")
            android.util.Log.e(TAG, "onCreate 崩溃", e)
            showEmergencyScreen(e)
        }
    }

    private fun main() {
        requestRuntimePermissions()
        buildLayout()

        BootLog.i("MainActivity 就绪，开始加载 $BUNDLE_NAME")
        log("版本: ${ChatApplication.BUILD_TAG} · v${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
        log("包名: $packageName")

        loadWithStrategy(ThreadStrategyForRendering.MOST_ON_TASM, attempt = 1)
    }

    /* ------------------------------------------------------------------ */
    /* 布局                                                                 */
    /* ------------------------------------------------------------------ */

    private fun buildLayout() {
        rootLayout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#070B14"))
        }

        /* ---------- 诊断条（固定高度，绝不塌陷） ---------- */
        debugBar = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#0E1A2E"))
            setPadding(20, 14, 20, 10)
        }

        // 状态行：一眼看到结论
        statusView = TextView(this).apply {
            text = "${ChatApplication.BUILD_TAG} 启动中…"
            setTextColor(Color.parseColor("#FFD166"))
            textSize = 12f
            typeface = Typeface.DEFAULT_BOLD
        }
        debugBar.addView(statusView)

        // 日志区（可滚动）
        logView = TextView(this).apply {
            setTextColor(Color.parseColor("#7CFFB2"))
            textSize = 9.5f
            typeface = Typeface.MONOSPACE
            setPadding(0, 8, 0, 0)
            setTextIsSelectable(true)
        }
        val logScroll = ScrollView(this).apply {
            addView(logView, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }
        debugBar.addView(
            logScroll,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f),
        )

        // 按钮行
        val buttonRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        buttonRow.addView(makeButton("重载 Lynx") { reloadLynx() })
        buttonRow.addView(makeButton("换线程策略") { switchStrategyManually() })
        buttonRow.addView(makeButton("引擎自检") { engineSelfTest() })
        buttonRow.addView(makeButton("复制日志") { copyLog() })
        buttonRow.addView(makeButton("收起") { collapseDebugBar() })
        debugBar.addView(buttonRow)

        // 固定 150dp：一定看得见
        rootLayout.addView(
            debugBar,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(150),
            ),
        )

        /* ---------- Lynx 容器 ---------- */
        lynxContainer = FrameLayout(this)
        rootLayout.addView(
            lynxContainer,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f),
        )

        setContentView(rootLayout)

        if (!ChatApplication.SHOW_DEBUG_BAR) {
            debugBar.visibility = View.GONE
        }
    }

    private fun makeButton(label: String, onClick: () -> Unit): Button =
        Button(this).apply {
            text = label
            textSize = 10f
            setTextColor(Color.parseColor("#9FD3FF"))
            setBackgroundColor(Color.parseColor("#16274A"))
            minWidth = 0
            minimumWidth = 0
            setPadding(18, 6, 18, 6)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                dp(34),
            ).apply { marginEnd = dp(8) }
            setOnClickListener { onClick() }
        }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    /* ------------------------------------------------------------------ */
    /* 日志展示                                                             */
    /* ------------------------------------------------------------------ */

    private fun log(msg: String) {
        BootLog.i(msg)
        runOnUiThread {
            if (!this::logView.isInitialized) return@runOnUiThread
            logView.text = BootLog.dump()
            (logView.parent as? ScrollView)?.post {
                (logView.parent as? ScrollView)?.fullScroll(ScrollView.FOCUS_DOWN)
            }
        }
    }

    private fun setStatus(msg: String, ok: Boolean? = null) {
        runOnUiThread {
            if (!this::statusView.isInitialized) return@runOnUiThread
            statusView.text = msg
            statusView.setTextColor(
                when (ok) {
                    true -> Color.parseColor("#34D399")
                    false -> Color.parseColor("#FF6B6B")
                    else -> Color.parseColor("#FFD166")
                },
            )
        }
    }

    private fun collapseDebugBar() {
        runOnUiThread {
            debugBar.visibility = View.GONE
            Toast.makeText(this, "诊断条已收起", Toast.LENGTH_SHORT).show()
        }
    }

    private fun copyLog() {
        val text = buildString {
            append("BUILD=${ChatApplication.BUILD_TAG}\n")
            append("version=${BuildConfig.VERSION_NAME}(${BuildConfig.VERSION_CODE})\n")
            append(BootLog.dump())
        }
        val cm = getSystemService(android.content.ClipboardManager::class.java)
        cm?.setPrimaryClip(android.content.ClipData.newPlainText("chat-log", text))
        Toast.makeText(this, "日志已复制到剪贴板", Toast.LENGTH_SHORT).show()
    }

    /* ------------------------------------------------------------------ */
    /* 加载 Lynx                                                            */
    /* ------------------------------------------------------------------ */

    /** 当前使用的线程策略（手动切换用） */
    private var currentStrategy = ThreadStrategyForRendering.MOST_ON_TASM

    private fun switchStrategyManually() {
        currentStrategy = if (currentStrategy == ThreadStrategyForRendering.MOST_ON_TASM) {
            ThreadStrategyForRendering.ALL_ON_UI
        } else {
            ThreadStrategyForRendering.MOST_ON_TASM
        }
        reloadLynx()
    }

    private fun reloadLynx() {
        rendered = false
        selfTestMode = false
        loadWithStrategy(currentStrategy, attempt = 1)
    }

    /**
     * 引擎自检：绕开我们自己的 bundle，直接渲染一段内置 JSON 模板
     * ============================================================
     * 这是唯一能区分下面两种情况的手段：
     *   A. 出现粉红色方块 → Lynx 引擎、渲染管线、Surface 全部正常，
     *      问题 100% 在我们的 .lynx.bundle（版本不匹配 / 模板损坏）
     *   B. 依旧空白   → Lynx 引擎在这个设备上根本跑不起来
     *      （so 未加载 / GPU 不支持 / 被系统限制），
     *      这时换任何 bundle 都不可能显示
     * ============================================================
     */
    private fun engineSelfTest() {
        setStatus("${ChatApplication.BUILD_TAG} 引擎自检中…")
        log("---- 引擎自检：渲染内置 JSON 模板 ----")

        lynxContainer.removeAllViews()
        try {
            lynxView?.destroy()
        } catch (e: Throwable) {
            android.util.Log.w(TAG, "销毁旧 LynxView 失败", e)
        }
        lynxView = null
        rendered = false
        selfTestMode = true

        val view = try {
            createLynxView(ThreadStrategyForRendering.ALL_ON_UI)
        } catch (e: Throwable) {
            log("✗ 自检创建 LynxView 失败: ${e.message}")
            setStatus("✗ 引擎自检失败（无法创建 LynxView）", ok = false)
            return
        }
        lynxView = view
        lynxContainer.addView(
            view,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )

        // 最小 JSON 模板 AST：一个整宽粉色块 + 一行白字
        val json = """
            {
              "type": "view",
              "style": {
                "width": "100%",
                "height": "400px",
                "background-color": "#FF0055",
                "flex-direction": "column",
                "justify-content": "center",
                "align-items": "center"
              },
              "children": [
                {
                  "type": "text",
                  "style": { "color": "#FFFFFF", "font-size": "28px" },
                  "values": [ { "type": "raw-text", "text": "LYNX ENGINE OK" } ]
                }
              ]
            }
        """.trimIndent()

        try {
            view.renderTemplate(
                json.toByteArray(Charsets.UTF_8),
                com.lynx.tasm.TemplateData.empty(),
            )
            log("✓ renderTemplate(json) 已调用")
        } catch (e: Throwable) {
            log("✗ renderTemplate(json) 异常: ${e.javaClass.simpleName}: ${e.message}")
            setStatus("✗ 引擎自检失败（JSON 模板被拒绝）", ok = false)
            return
        }

        // 自检专用判定：不再自动收起诊断条
        view.postDelayed({
            if (rendered) {
                log("✓✓ 自检成功：粉红色块出现说明 Lynx 引擎正常")
                setStatus("✓ 引擎正常 —— 问题在 chat.lynx.bundle", ok = true)
            } else {
                log("✗✗ 自检失败：连内置 JSON 模板都没有渲染")
                setStatus("✗ 引擎异常 —— 与 bundle 无关", ok = false)
            }
        }, 6000)
    }

    /**
     * 加载 LynxView，并由 LynxViewClient 回调判定结果
     * ============================================================
     * 用 onFirstScreen / onLoadSuccess / onLoadFailed 作为权威信号，
     * 比 childCount 判断可靠得多（childCount 在异步渲染时会有假阴性）。
     * ============================================================
     */
    private fun loadWithStrategy(strategy: ThreadStrategyForRendering, attempt: Int) {
        currentStrategy = strategy
        setStatus("${ChatApplication.BUILD_TAG} 加载中… (第 $attempt 次 · $strategy)")
        log("---- 第 $attempt 次加载 · 策略=$strategy ----")

        // 清理上一次
        lynxContainer.removeAllViews()
        try {
            lynxView?.destroy()
        } catch (e: Throwable) {
            android.util.Log.w(TAG, "销毁旧 LynxView 失败", e)
        }
        lynxView = null

        val view = try {
            createLynxView(strategy)
        } catch (e: Throwable) {
            log("✗ 创建 LynxView 异常: ${e.javaClass.simpleName}: ${e.message}")
            setStatus("✗ 创建 LynxView 失败", ok = false)
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

        try {
            view.renderTemplateUrl(BUNDLE_NAME, "")
            log("✓ renderTemplateUrl 已调用")
        } catch (e: Throwable) {
            log("✗ renderTemplateUrl 异常: ${e.javaClass.simpleName}: ${e.message}")
        }

        // 兜底检查：8 秒后仍未收到 onFirstScreen 则视为失败
        view.postDelayed({
            if (rendered) return@postDelayed
            val w = view.width
            val h = view.height
            val children = view.childCount
            log("8s 未收到 onFirstScreen：尺寸=${w}x$h 子视图=$children")

            if (attempt == 1) {
                log("→ 自动切换 ALL_ON_UI 重试")
                loadWithStrategy(ThreadStrategyForRendering.ALL_ON_UI, 2)
            } else {
                setStatus("✗ 两种策略均未渲染，请点「复制日志」反馈", ok = false)
            }
        }, 8000)
    }

    /**
     * 创建 LynxView
     * ============================================================
     * - addBehaviors(XElementBehaviors)：注册 input/webview/video 等原生组件
     * - setThreadStrategyForRendering：ReactLynx 必须用多线程策略
     * - setTemplateProvider：从 assets 读取离线 bundle
     * - addLynxViewClient：接收渲染成功/失败回调（权威信号）
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
                        val bytes = readBundle(uri)
                        log("✓ bundle 读取成功: ${bytes.size} 字节 (${bundleSource})")
                        callback.onSuccess(bytes)
                    } catch (e: IOException) {
                        log("✗ bundle 读取失败: ${e.message}")
                        callback.onFailed(e.message ?: "读取 bundle 失败")
                    }
                }.start()
            }
        })

        val view = builder.build(this)

        // 权威回调
        view.addLynxViewClient(object : LynxViewClient() {
            override fun onPageStart(url: String?) {
                log("→ onPageStart")
            }

            override fun onLoadSuccess() {
                log("✓ onLoadSuccess（模板解析成功）")
                setStatus("${ChatApplication.BUILD_TAG} 模板加载成功，渲染中…")
            }

            override fun onRuntimeReady() {
                log("✓ onRuntimeReady（JS 运行时就绪）")
            }

            override fun onFirstScreen() {
                log("✓ onFirstScreen（首屏渲染完成）")
                // 关键诊断：Lynx 是自绘引擎，view.childCount 永远是 0，
                // 但 LynxView 自身的尺寸必须非零，否则 100vh 也会是 0。
                // 计入这条日志可以直接区分「容器没尺寸」和「内容没尺寸」。
                val v = lynxView
                if (v != null) {
                    log("   LynxView 尺寸: ${v.width}x${v.height} dp=${resources.displayMetrics.density}")
                }
                rendered = true
                if (!selfTestMode) {
                    setStatus("✓ 渲染成功", ok = true)
                    // 渲染成功 1 秒后收起诊断条，让出屏幕
                    runOnUiThread {
                        // 仅在诊断条真正显示时才收起（SHOW_DEBUG_BAR=true 的调试构建）；
        // 正式构建里诊断条本来就不可见，再去「收起」会闪一个无意义的 Toast。
        if (ChatApplication.SHOW_DEBUG_BAR) {
            statusView.postDelayed({ if (rendered && !selfTestMode) collapseDebugBar() }, 1000)
        }
                    }
                    BootLog.markSessionOk()
                }
            }

            override fun onLoadFailed(error: String?) {
                log("✗ onLoadFailed: $error")
                setStatus("✗ 加载失败: $error", ok = false)
            }
        })

        return view
    }

    /* ------------------------------------------------------------------ */
    /* Bundle 读取（支持开发期热替换）                                       */
    /* ------------------------------------------------------------------ */

    /** 本次 bundle 的来源，仅用于日志 */
    private var bundleSource = "assets"

    /**
     * 读取 Lynx bundle
     * ============================================================
     * debug 构建下优先读外部文件：
     *   /sdcard/Android/data/<包名>/files/chat.lynx.bundle
     *
     * 这样改前端代码后只需：
     *   adb push dist/chat.lynx.bundle <该路径> && 重启 App
     * 无需重新 gradle 构建 + 安装 APK（从 ~90 秒降到 ~5 秒）。
     *
     * release 构建永远只读 assets，热替换能力不会带入正式包。
     * 外部文件不存在或读取失败时自动回退到 assets。
     */
    private fun readBundle(uri: String): ByteArray {
        if (BuildConfig.DEBUG) {
            val external = getExternalFilesDir(null)?.resolve(uri)
            if (external != null && external.exists() && external.length() > 0) {
                try {
                    val bytes = external.readBytes()
                    bundleSource = "外部文件 ${external.absolutePath}"
                    return bytes
                } catch (e: Throwable) {
                    log("外部 bundle 读取失败，回退 assets: ${e.message}")
                }
            }
        }
        bundleSource = "assets"
        return assets.open(uri).use { it.readBytes() }
    }

    /* ------------------------------------------------------------------ */
    /* 兜底界面                                                             */
    /* ------------------------------------------------------------------ */

    /** onCreate 整体崩溃时的最后一道防线 */
    private fun showEmergencyScreen(e: Throwable) {
        try {
            val tv = TextView(this).apply {
                text = buildString {
                    append("chat 启动失败\n\n")
                    append("${e.javaClass.simpleName}: ${e.message}\n\n")
                    append(e.stackTraceToString().split('\n').take(20).joinToString("\n"))
                }
                setTextColor(Color.parseColor("#FF6B6B"))
                setBackgroundColor(Color.BLACK)
                textSize = 10f
                typeface = Typeface.MONOSPACE
                setPadding(30, 60, 30, 30)
                setTextIsSelectable(true)
            }
            setContentView(
                ScrollView(this).apply { addView(tv) },
            )
        } catch (ignored: Throwable) {
            android.util.Log.e(TAG, "连兜底界面都无法显示", ignored)
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

    /**
     * Activity 结果转发
     * ------------------------------------------------------------
     * LynxModule 自身拿不到 onActivityResult，选图/拍照/选文件
     * 全部由 MediaBridge 单槽挂起，这里统一转发。
     */
    @Deprecated("AndroidX 推荐 ActivityResultLauncher，但 Lynx 模块需要同步回调，保留旧 API")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        pub.lkz.chat.media.MediaBridge.handleActivityResult(requestCode, resultCode, data)
    }

    /**
     * 返回键
     * ------------------------------------------------------------
     * 语义（对齐主流 IM）：
     *   有上一页  → 通知前端 pop（前端负责真正的路由退栈）
     *   已在根页  → **最小化到后台**，绝不退出进程
     *
     * 为什么不能直接 finish()：
     * 退出会销毁 LynxView，丢掉全部内存态（会话列表、连接、
     * 草稿），下次打开要重新冷启动 + 重连 WS，体验很差。
     * moveTaskToBack 只是把任务挪到后台，进程与 Lynx 实例都保留，
     * 再次点图标是秒开。
     *
     * 前端如何收到：
     *   state.stack.length > 1 时前端会调 ChatHost.setCanGoBack(true)，
     *   原生据此发全局事件 backPressed，前端监听后执行 pop。
     */
    @Deprecated("Android 13+ 推荐用 OnBackPressedDispatcher")
    override fun onBackPressed() {
        if (pub.lkz.chat.module.ChatHostModule.isCanGoBack()) {
            // 让前端退栈；前端 pop 后会再次同步 setCanGoBack(false)
            try {
                lynxView?.sendGlobalEvent("backPressed", com.lynx.react.bridge.JavaOnlyArray())
            } catch (e: Throwable) {
                android.util.Log.w(TAG, "发送 backPressed 失败", e)
            }
            return
        }

        // 根页面：最小化，不退出
        moveTaskToBack(true)
    }

    /** 供 ChatHostModule 发全局事件（悬浮窗挂断等） */
    fun lynxViewForEvent(): LynxView? = lynxView

    override fun onStop() {
        super.onStop()
        /**
         * 通话中退到后台 → 弹悬浮窗
         * ------------------------------------------------
         * 判据用 isChangingConfigurations()：
         * 屏幕旋转等活动重建不应弹窗，否则会闪一下。
         * 是否真的在通话由前端 setCallState 置位，
         * 原生无法自行感知 WebRTC 状态。
         */
        if (!isChangingConfigurations &&
            pub.lkz.chat.module.ChatHostModule.isInCall()
        ) {
            pub.lkz.chat.call.FloatingCallWindow.show(
                applicationContext,
                pub.lkz.chat.module.ChatHostModule.peerNameOf(),
                pub.lkz.chat.module.ChatHostModule.callStartedAtOf(),
            )
        }
    }

    override fun onPause() {
        super.onPause()
        try {
            lynxView?.onEnterBackground()
        } catch (e: Throwable) {
            android.util.Log.w(TAG, "onEnterBackground 失败", e)
        }
    }

    override fun onResume() {
        super.onResume()
        // 回到 App：隐藏悬浮窗，避免遮挡界面
        try {
            pub.lkz.chat.call.FloatingCallWindow.hide()
        } catch (_: Throwable) {
        }
        try {
            lynxView?.onEnterForeground()
        } catch (e: Throwable) {
            android.util.Log.w(TAG, "onEnterForeground 失败", e)
        }
    }

    override fun onDestroy() {
        try {
            lynxView?.destroy()
        } catch (e: Throwable) {
            android.util.Log.w(TAG, "destroy 失败", e)
        }
        lynxView = null
        if (current === this) current = null
        super.onDestroy()
    }
}
