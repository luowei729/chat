package pub.lkz.chat

import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.view.WindowManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * 主 Activity
 * ============================================================
 * 职责：
 *   1. 全屏沉浸（edge-to-edge）
 *   2. 通话悬浮窗通道（pub.lkz.chat/call_overlay）
 *
 * 全屏沉浸为什么要在这里写，而不是只在 Dart 侧调 SystemChrome：
 *   Dart 的 setEnabledSystemUIMode 只影响 Flutter 渲染层，
 *   系统窗口本身仍会为导航栏留出区域并填色：
 *     · Android 15（API 35）起系统强制 edge-to-edge，
 *       但未显式声明时部分 ROM 会绘制半透明遮罩；
 *     · Android 14 及以下必须手动 setDecorFitsSystemWindows(false)。
 *   两套 API 都写，覆盖 minSdk 24+ 全部设备。
 */
class MainActivity : FlutterActivity() {

    private var overlay: CallOverlay? = null
    private var overlayChannel: MethodChannel? = null
    private var pushChannel: MethodChannel? = null

    /** 待处理的权限申请（用户从设置页返回后要回调） */
    private var pendingPermissionResult: MethodChannel.Result? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        applyEdgeToEdge()
        overlay = CallOverlay(applicationContext)
        // 冷启动：从通知栏点进来的 Intent 里带着会话 id
        PushBridge.handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // 热启动：App 已在后台，用户点通知栏再次进入
        PushBridge.handleIntent(intent)
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        /* ---------- 推送通道 ---------- */
        val push = MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "pub.lkz.chat/push",
        )
        pushChannel = push
        PushBridge.attach(push)

        push.setMethodCallHandler { call, result ->
            when (call.method) {
                "getToken" -> result.success(PushBridge.getToken())
                "notificationsEnabled" ->
                    result.success(PushBridge.notificationsEnabled(this))
                "openNotificationSettings" -> {
                    PushBridge.openNotificationSettings(this)
                    result.success(true)
                }
                // App 被杀期间点通知：Dart 首帧后来取一次
                "consumePendingClick" -> result.success(PushBridge.consumePendingClick())
                else -> result.notImplemented()
            }
        }

        /* ---------- 通话悬浮窗通道 ---------- */
        val channel = MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "pub.lkz.chat/call_overlay",
        )
        overlayChannel = channel

        val callOverlay = overlay ?: CallOverlay(applicationContext).also { overlay = it }

        // 用户点浮窗挂断：转给 Dart 走正常挂断流程
        callOverlay.onHangup = {
            channel.invokeMethod("onOverlayHangup", null)
        }
        // 用户点浮窗主体：把 App 拉回前台
        callOverlay.onOpen = {
            channel.invokeMethod("onOverlayOpen", null)
            bringToFront()
        }

        channel.setMethodCallHandler { call, result ->
            when (call.method) {
                "hasPermission" -> result.success(callOverlay.canDraw())

                /**
                 * 申请悬浮窗权限
                 *
                 * SYSTEM_ALERT_WINDOW 是特殊权限，无法用运行时弹窗申请，
                 * 只能跳系统设置页。用户返回后 onActivityResult 里再查询。
                 */
                "requestPermission" -> {
                    if (callOverlay.canDraw()) {
                        result.success(true)
                        return@setMethodCallHandler
                    }
                    pendingPermissionResult = result
                    try {
                        val intent = Intent(
                            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                            Uri.parse("package:$packageName"),
                        )
                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        startActivity(intent)
                    } catch (_: Throwable) {
                        // 个别 ROM 没有这个设置页，退化为应用详情页
                        try {
                            startActivity(
                                Intent(
                                    Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                    Uri.parse("package:$packageName"),
                                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                            )
                        } catch (_: Throwable) {
                            pendingPermissionResult = null
                            result.success(false)
                        }
                    }
                }

                "show" -> {
                    val name = call.argument<String>("peerName") ?: "通话中"
                    callOverlay.show(name)
                    result.success(callOverlay.isShowing())
                }

                "hide" -> {
                    callOverlay.hide()
                    result.success(true)
                }

                "updateTimer" -> {
                    val text = call.argument<String>("text") ?: ""
                    callOverlay.updateTimer(text)
                    result.success(true)
                }

                "bringToFront" -> {
                    bringToFront()
                    result.success(true)
                }

                else -> result.notImplemented()
            }
        }
    }

    override fun onResume() {
        super.onResume()
        // 从权限设置页返回：回调真实结果
        val pending = pendingPermissionResult
        if (pending != null) {
            pendingPermissionResult = null
            pending.success(overlay?.canDraw() == true)
        }
    }

    private fun bringToFront() {
        try {
            val intent = Intent(this, MainActivity::class.java)
            intent.addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP,
            )
            startActivity(intent)
        } catch (_: Throwable) {
            // 忽略
        }
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

        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
    }

    override fun onDestroy() {
        overlayChannel = null
        pushChannel?.let { PushBridge.detach(it) }
        pushChannel = null
        overlay?.hide()
        super.onDestroy()
    }
}
