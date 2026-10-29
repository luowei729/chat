package pub.lkz.chat

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.lynx.tasm.LynxView
import com.lynx.tasm.LynxViewBuilder
import com.lynx.tasm.provider.AbsTemplateProvider
import com.lynx.xelement.XElementBehaviors
import java.io.IOException

/**
 * ============================================================
 * 主界面：LynxView 宿主
 * ------------------------------------------------------------
 * 职责：
 * 1. 创建 LynxView 并加载内置的 Lynx bundle；
 * 2. 申请运行时权限（麦克风、相机、通知）；
 * 3. 处理返回键（优先交给 Lynx 内部路由）。
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

    companion object {
        /** bundle 文件名：CI 会把构建产物拷贝到 assets 下 */
        private const val BUNDLE_NAME = "chat.lynx.bundle"

        /** 权限请求码 */
        private const val REQ_PERMISSIONS = 1001
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

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
    }

    /**
     * 创建 LynxView
     * 关键点：
     * - addBehaviors(XElementBehaviors)：注册 input/webview/video 等原生组件，
     *   不加会导致登录页的 <input> 完全不可用；
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
                        callback.onSuccess(bytes)
                    } catch (e: IOException) {
                        // bundle 缺失属于打包错误，明确上报便于定位
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
     * 说明：Lynx 内部有自己的页面栈，优先让 Lynx 处理，
     *      只有 Lynx 无法返回时才退出 App。
     */
    @Deprecated("Android 13+ 推荐用 OnBackPressedDispatcher")
    override fun onBackPressed() {
        // goBack 返回 true 表示 Lynx 已消费该事件
        val handled = lynxView.goBack()
        if (!handled) {
            super.onBackPressed()
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
        super.onDestroy()
    }
}
