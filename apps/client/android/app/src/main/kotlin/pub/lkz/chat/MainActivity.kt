package pub.lkz.chat

import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import io.flutter.embedding.android.FlutterActivity

/**
 * 主 Activity
 * ============================================================
 * 全屏沉浸（edge-to-edge）
 * ------------------------------------------------------------
 * 目的：底部手势导航区域不再出现一条白色横条，内容延伸过去。
 *
 * 【为什么要在这里写，而不是只在 Dart 侧调 SystemChrome】
 * Dart 的 SystemChrome.setEnabledSystemUIMode 只影响 Flutter 渲染层，
 * 系统窗口本身仍然会为导航栏留出区域并填色：
 *   · Android 15（API 35）起系统强制 edge-to-edge，
 *     但未显式声明时部分 ROM 会绘制半透明遮罩；
 *   · Android 14 及以下必须手动 setDecorFitsSystemWindows(false)。
 *
 * 【为什么两套 API】
 *   setDecorFitsSystemWindows 是 API 30+ 的；
 *   老版本只能用 SYSTEM_UI_FLAG_LAYOUT_* 系列标志位。
 *   两者都写，覆盖全部 minSdk 24+ 设备。
 *
 * 【关于状态栏图标颜色】
 *   应用支持浅色/深色主题，状态栏图标颜色由 Flutter 侧控制；
 *   这里只保证「透明、不填色」。
 */
class MainActivity : FlutterActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        applyEdgeToEdge()
    }

    private fun applyEdgeToEdge() {
        val window = window ?: return

        // 1. 系统栏透明、不拦截绘制
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT

        // 2. 关掉系统绘制的对比度遮罩，否则会看到一条半透明色块
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isStatusBarContrastEnforced = false
            window.isNavigationBarContrastEnforced = false
        }

        // 3. 内容延伸到系统栏下面
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                )
        }

        // 4. 键盘弹出时不要强行 resize 顶部（沉浸式下更自然）
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
    }
}
