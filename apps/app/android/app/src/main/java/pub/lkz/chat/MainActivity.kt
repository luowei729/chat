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
import com.lynx.tasm.TemplateData
import com.lynx.tasm.provider.AbsTemplateProvider
import java.io.IOException

/**
 * ============================================================
 * 主界面：LynxView 宿主
 * ------------------------------------------------------------
 * 职责：
 * 1. 创建 LynxView 并加载内置的 Lynx bundle；
 * 2. 申请运行时权限（麦克风、相机、通知）；
 * 3. 处理返回键（交给 Lynx 内部路由）。
 *
 * 为什么用内置 bundle 而不是远程 URL：
 * 1. 离线可用，弱网下也能秒开；
 * 2. 不受服务端发版影响，App 版本与前端代码绑定，行为可预期；
 * 3. 应用市场审核更容易通过（无动态加载代码的争议）。
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

        // ---------- 创建 LynxView ----------
        lynxView = createLynxView()

        // 用 FrameLayout 承载，方便后续叠加原生视图（如通话悬浮窗）
        val container = FrameLayout(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            // 让内容延伸到状态栏下方（沉浸式），由前端自己加安全区内边距
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

        // ---------- 加载 bundle ----------
        loadBundle()
    }

    /**
     * 创建 LynxView
     * 说明：
     * - setTemplateProvider 负责从 assets 读取 bundle 字节流；
     * - setImageFetcher / setFontLoader 等可选，未配置时用默认实现。
     */
    private fun createLynxView(): LynxView {
        val builder = LynxViewBuilder()

        // 从 assets 读取 bundle：这是「内置离线包」的关键
        builder.setTemplateProvider(object : AbsTemplateProvider() {
            override fun loadTemplate(
                uri: String,
                callback: com.lynx.tasm.provider.LynxTemplateProvider.LoadTemplateCallback,
            ) {
                try {
                    val bytes = assets.open(BUNDLE_NAME).use { it.readBytes() }
                    callback.onSuccess(bytes)
                } catch (e: IOException) {
                    // bundle 缺失是打包错误，直接上报，避免白屏无提示
                    callback.onFailed(e.message ?: "读取 bundle 失败", 404)
                }
            }
        })

        // 开启调试：仅在 debug 包生效，release 包会自动关闭
        if (BuildConfig.DEBUG) {
            builder.setEnableDevtool(true)
        }

        return builder.build(this)
    }

    /** 加载 bundle */
    private fun loadBundle() {
        // 传入初始数据：前端可在 useInitData() 中读取
        val data = TemplateData.fromMap(
            mapOf(
                "platform" to "android",
                "appVersion" to BuildConfig.VERSION_NAME,
                "osVersion" to Build.VERSION.RELEASE,
                "deviceModel" to Build.MODEL,
            ),
        )
        lynxView.renderTemplateUrl(BUNDLE_NAME, data)
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
        // LynxView 提供 goBack，返回 true 表示已消费
        val handled = lynxView.goBack()
        if (!handled) {
            super.onBackPressed()
        }
    }

    override fun onPause() {
        super.onPause()
        // 通知 Lynx 进入后台：前端可据此暂停动画、降低轮询频率
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
