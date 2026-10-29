package pub.lkz.chat

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.lynx.tasm.LynxView
import com.lynx.tasm.LynxViewBuilder
import com.lynx.tasm.provider.AbsTemplateProvider
import com.lynx.xelement.XElementBehaviors
import pub.lkz.chat.module.ChatHostModule
import java.io.IOException

/**
 * ============================================================
 * 主界面：LynxView 宿主
 * ============================================================
 * 职责：
 * 1. 创建 LynxView 并加载内置的 Lynx bundle；
 * 2. 申请运行时权限（麦克风、相机、通知）；
 * 3. 处理返回键（前端通过 ChatHost.setCanGoBack 告知路由深度）。
 *
 * 为什么用内置 bundle 而不是远程 URL：
 * 1. 离线可用，弱网下也能秒开；
 * 2. App 版本与前端代码绑定，行为可预期；
 * 3. 应用市场审核更容易通过（无动态加载代码的争议）。
 *
 * 必须用 AppCompatActivity + Theme.AppCompat 系主题：
 * 用平台主题 Theme.Material.* 会抛
 * "You need to use a Theme.AppCompat theme (or descendant) with this activity"。
 * ============================================================
 */
class MainActivity : AppCompatActivity() {

    private lateinit var lynxView: LynxView

    /** 记录上次按返回键的时间，用于「双击退出」 */
    private var lastBackPressedAt: Long = 0

    companion object {
        /** bundle 文件名：CI 会把构建产物拷贝到 assets 下 */
        private const val BUNDLE_NAME = "chat.lynx.bundle"

        /** 权限请求码 */
        private const val REQ_PERMISSIONS = 1001

        /** 双击退出的时间窗口（毫秒） */
        private const val DOUBLE_BACK_INTERVAL = 2000L

        /**
         * 当前 Activity 实例
         * 用途：原生模块（ChatHost.exitApp）需要拿到 Activity 才能 finish
         * 注意：Activity 销毁时必须置空，否则内存泄漏
         */
        @Volatile
        var current: MainActivity? = null
            private set
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        current = this

        // 先申请权限，再创建界面：避免用户点录音时才发现没权限
        requestRuntimePermissions()

        lynxView = createLynxView()

        // 用 FrameLayout 承载，方便后续叠加原生视图（如通话悬浮窗）
        val container = FrameLayout(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            // 内容延伸到状态栏下方（沉浸式），安全区由前端自己处理
            fitsSystemWindows = false
            addView(
                lynxView,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT,
                ),
            )
        }

        setContentView(container)

        // 加载 bundle（第二个参数是初始数据 JSON 字符串，空串表示不传）
        lynxView.renderTemplateUrl(BUNDLE_NAME, "")

        /**
         * 渲染健康检查
         * ============================================================
         * Lynx 渲染失败时不会抛异常，只会留一片黑屏，这是最难排查的故障。
         * 这里延迟 3 秒做三重检查，任一异常都给出可读提示：
         *   1. childCount == 0        → 模板没加载 / JS 崩了
         *   2. height == 0 或 width == 0 → 布局塌陷（例如嵌套 page、flex 计算为 0）
         *   3. 两者都正常              → 静默通过
         * 同时把尺寸打进 Logcat，便于远程排查。
         * ============================================================
         */
        lynxView.postDelayed({
            val w = lynxView.width
            val h = lynxView.height
            val children = lynxView.childCount
            android.util.Log.i(
                "MainActivity",
                "渲染检查: size=${w}x$h, childCount=$children",
            )

            if (children == 0) {
                showFatalError("页面渲染失败：没有生成任何视图\n请查看日志或重新安装应用")
            } else if (w == 0 || h == 0) {
                showFatalError("页面渲染失败：容器尺寸为 ${w}x$h\n布局塌陷，请更新到最新版本")
            }
        }, 3000)
    }

    /**
     * 创建 LynxView
     * 关键点：
     * - addBehaviors(XElementBehaviors)：注册 input/webview/video 等原生组件，
     *   不加会导致登录页的 input 完全不可用；
     * - setTemplateProvider：从 assets 读取离线 bundle。
     */
    private fun createLynxView(): LynxView {
        val builder = LynxViewBuilder()

        // 注册扩展元素（input / textarea / webview / video 等）
        builder.addBehaviors(XElementBehaviors().create())

        // 从 assets 读取 bundle：这是「内置离线包」的关键
        builder.setTemplateProvider(object : AbsTemplateProvider() {
            override fun loadTemplate(uri: String, callback: Callback) {
                // 读文件必须放子线程，否则大 bundle 会卡主线程
                Thread {
                    try {
                        val bytes = assets.open(uri).use { it.readBytes() }
                        android.util.Log.i("MainActivity", "bundle 加载成功: $uri, ${bytes.size} 字节")
                        callback.onSuccess(bytes)
                    } catch (e: IOException) {
                        // bundle 缺失属于打包错误，必须让用户看到原因，
                        // 否则界面上只会是一片黑屏，完全无法排查
                        android.util.Log.e("MainActivity", "bundle 加载失败: $uri", e)
                        runOnUiThread {
                            showFatalError("找不到内置页面包 $uri\n请重新安装应用")
                        }
                        callback.onFailed(e.message ?: "读取 bundle 失败")
                    }
                }.start()
            }
        })

        return builder.build(this)
    }

    /**
     * 申请运行时权限
     * 说明：Android 13+ 的通知权限、14+ 的前台服务权限都必须运行时申请，
     *      否则来电通知与锁屏通话会静默失效。
     */
    private fun requestRuntimePermissions() {
        val wanted = mutableListOf(
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.CAMERA,
            Manifest.permission.MODIFY_AUDIO_SETTINGS,
        )

        // Android 13+：媒体读取权限拆分了
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

    /**
     * 返回键处理
     * ============================================================
     * 逻辑：
     *   1. 前端路由栈 > 1 → 交给前端返回（前端在 setCanGoBack 里已同步状态）
     *      但 Lynx 没有同步的「执行返回」API，所以这里用另一种策略：
     *      把返回事件通过 sendGlobalEvent 通知前端，由前端自己 pop 路由；
     *   2. 前端在根页面 → 双击退出，防止误触直接关掉 App。
     *
     * 为什么用「双击退出」而不是直接退出：
     * 聊天 App 用户经常在根页面误触返回键，
     * 直接退出体验很差；双击退出是 Android 通用惯例。
     * ============================================================
     */
    @Deprecated("Android 13+ 推荐用 OnBackPressedDispatcher")
    override fun onBackPressed() {
        // 前端可返回：把事件发给前端，由前端 pop 路由
        if (ChatHostModule.isCanGoBack()) {
            notifyFrontendBack()
            return
        }

        // 根页面：双击退出
        val now = System.currentTimeMillis()
        if (now - lastBackPressedAt < DOUBLE_BACK_INTERVAL) {
            finishAffinity()
            return
        }
        lastBackPressedAt = now
        Toast.makeText(this, "再按一次退出", Toast.LENGTH_SHORT).show()
    }

    /**
     * 通知前端「按了返回键」
     * 说明：Lynx 的 sendGlobalEvent 是单向通知，
     *      前端用 useLynxGlobalEventListener 监听 "hardwareBack" 事件后自行 pop。
     */
    private fun notifyFrontendBack() {
        try {
            val args = com.lynx.react.bridge.JavaOnlyArray()
            lynxView.sendGlobalEvent("hardwareBack", args)
        } catch (e: Throwable) {
            android.util.Log.w("MainActivity", "发送返回事件失败", e)
        }
    }

    /**
     * 展示致命错误（覆盖在 LynxView 之上）
     * 说明：黑屏是最难排查的故障，必须让错误可见。
     */
    private fun showFatalError(message: String) {
        try {
            val tv = android.widget.TextView(this).apply {
                text = message
                setTextColor(android.graphics.Color.parseColor("#ff4d4f"))
                textSize = 14f
                gravity = android.view.Gravity.CENTER
                setPadding(48, 48, 48, 48)
            }
            val root = findViewById<ViewGroup>(android.R.id.content)
            root.addView(
                tv,
                ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ),
            )
        } catch (e: Throwable) {
            android.util.Log.e("MainActivity", "展示错误信息失败", e)
        }
    }

    override fun onPause() {
        super.onPause()
        // 通知 Lynx 进入后台：前端可据此降低轮询频率
        lynxView.onEnterBackground()
    }

    override fun onResume() {
        super.onResume()
        lynxView.onEnterForeground()
    }

    override fun onDestroy() {
        // 必须销毁，否则 Lynx 内部线程与定时器会泄漏
        lynxView.destroy()
        // 清空静态引用，避免内存泄漏
        if (current === this) current = null
        super.onDestroy()
    }
}
