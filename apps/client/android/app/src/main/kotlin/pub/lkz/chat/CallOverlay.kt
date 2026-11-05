package pub.lkz.chat

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

/**
 * 语音通话桌面悬浮窗
 * ============================================================
 * 为什么必须有：
 *   用户切到微信/桌面后，通话页就看不见了。没有悬浮窗时，
 *   用户既不知道通话是否还在，也没法快速挂断——只能凭运气
 *   重新点开 App。
 *
 * 权限：
 *   SYSTEM_ALERT_WINDOW 是**特殊权限**，不能用运行时弹窗申请，
 *   必须跳到系统设置页让用户手动开启（Android 6.0+ 一直如此）。
 *   Android 12+ 还限制了「隐藏浮窗」，但已授予该权限的应用不受影响。
 *
 * 交互：
 *   · 拖动移动位置
 *   · 点击挂断按钮 → 回调到 Dart
 *   · 显示头像首字 + 昵称 + 通话时长
 *
 * 为什么不用 Notification + 全屏 Intent：
 *   那是「来电」的形态。通话中需要的是常驻可见的小窗，
 *   通知会被其他消息挤下去，不如浮窗直接。
 */
class CallOverlay(private val context: Context) {

    private val main = Handler(Looper.getMainLooper())
    private var root: FrameLayout? = null
    private val params = WindowManager.LayoutParams()
    private var nameView: TextView? = null
    private var timerView: TextView? = null
    private var windowManager: WindowManager? = null

    /** 点挂断时回调（在 UI 线程） */
    var onHangup: (() -> Unit)? = null

    /** 点浮窗主体时回调（拉回 App） */
    var onOpen: (() -> Unit)? = null

    fun isShowing(): Boolean = root != null

    /** 是否已授予悬浮窗权限 */
    fun canDraw(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
        return Settings.canDrawOverlays(context)
    }

    /**
     * 显示悬浮窗
     * @param peerName 对方昵称
     */
    fun show(peerName: String) {
        if (!canDraw()) return
        if (root != null) {
            nameView?.text = peerName
            return
        }

        main.post {
            try {
                showInternal(peerName)
            } catch (_: Throwable) {
                root = null
            }
        }
    }

    private fun showInternal(peerName: String) {
        val manager =
            context.getSystemService(Context.WINDOW_SERVICE) as? WindowManager ?: return
        windowManager = manager

        val density = context.resources.displayMetrics.density
        fun dp(value: Int) = (value * density).toInt()

        val container = FrameLayout(context)

        // 圆角深色卡片
        val card = LinearLayout(context)
        card.orientation = LinearLayout.HORIZONTAL
        card.gravity = Gravity.CENTER_VERTICAL
        card.setPadding(dp(12), dp(10), dp(8), dp(10))
        val background = GradientDrawable().apply {
            cornerRadius = dp(24).toFloat()
            setColor(Color.parseColor("#E6202020"))
        }
        card.background = background

        // 头像圆点（用首字代替，避免加载图片）
        val avatar = TextView(context).apply {
            text = peerName.trim().take(1).ifEmpty { "通" }
            setTextColor(Color.WHITE)
            textSize = 16f
            gravity = Gravity.CENTER
            val circle = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#0A84FF"))
            }
            // 用 setBackground 而不是 background = ，
            // 外层有个同名局部变量 background，直接赋值会被它遮蔽而报错
            setBackground(circle)
        }
        val avatarSize = dp(36)
        card.addView(avatar, LinearLayout.LayoutParams(avatarSize, avatarSize))

        // 中间：昵称 + 时长
        val info = LinearLayout(context)
        info.orientation = LinearLayout.VERTICAL
        info.setPadding(dp(10), 0, dp(10), 0)

        val name = TextView(context).apply {
            text = peerName.ifEmpty { "通话中" }
            setTextColor(Color.WHITE)
            textSize = 14f
            maxLines = 1
        }
        val timer = TextView(context).apply {
            text = "正在通话"
            setTextColor(Color.parseColor("#AAAAAA"))
            textSize = 11f
        }
        info.addView(name)
        info.addView(timer)
        card.addView(info, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))

        // 挂断按钮
        val hangup = TextView(context).apply {
            text = "挂断"
            setTextColor(Color.WHITE)
            textSize = 13f
            gravity = Gravity.CENTER
            setPadding(dp(14), dp(8), dp(14), dp(8))
            val red = GradientDrawable().apply {
                cornerRadius = dp(18).toFloat()
                setColor(Color.parseColor("#FF3B30"))
            }
            setBackground(red)
            setOnClickListener {
                onHangup?.invoke()
                hide()
            }
        }
        card.addView(hangup)

        container.addView(
            card,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
            ),
        )

        nameView = name
        timerView = timer

        // 窗口参数：不可抢焦点（否则会遮挡键盘输入）
        params.width = WindowManager.LayoutParams.WRAP_CONTENT
        params.height = WindowManager.LayoutParams.WRAP_CONTENT
        params.type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }
        params.flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
        params.format = android.graphics.PixelFormat.TRANSLUCENT
        params.gravity = Gravity.TOP or Gravity.START
        params.x = dp(16)
        params.y = dp(120)

        // 拖拽 + 点击
        attachDragHandler(container, manager, dp(4))

        manager.addView(container, params)
        root = container
    }

    private fun attachDragHandler(view: View, manager: WindowManager, slop: Int) {
        var initialX = 0
        var initialY = 0
        var touchX = 0f
        var touchY = 0f
        var dragged = false

        view.setOnTouchListener { _, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    initialX = params.x
                    initialY = params.y
                    touchX = event.rawX
                    touchY = event.rawY
                    dragged = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = (event.rawX - touchX).toInt()
                    val dy = (event.rawY - touchY).toInt()
                    if (!dragged && (kotlin.math.abs(dx) > slop || kotlin.math.abs(dy) > slop)) {
                        dragged = true
                    }
                    if (dragged) {
                        params.x = initialX + dx
                        params.y = initialY + dy
                        try {
                            manager.updateViewLayout(view, params)
                        } catch (_: Throwable) {
                        }
                    }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    // 没拖动 = 点击 = 拉回 App
                    if (!dragged) onOpen?.invoke()
                    true
                }
                else -> false
            }
        }
    }

    /** 更新显示的通话时长 */
    fun updateTimer(text: String) {
        main.post { timerView?.text = text }
    }

    /** 隐藏悬浮窗 */
    fun hide() {
        main.post {
            val view = root ?: return@post
            root = null
            nameView = null
            timerView = null
            try {
                windowManager?.removeView(view)
            } catch (_: Throwable) {
                // 已被系统移除
            }
        }
    }
}
