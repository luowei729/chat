package pub.lkz.chat.call

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
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
import android.widget.TextView
import pub.lkz.chat.MainActivity
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * ============================================================
 * 通话悬浮窗（微信式小窗）
 * ============================================================
 * 行为：
 *   - 通话进行中且 App 退到后台 → 自动显示
 *   - 返回 App（onResume）        → 自动隐藏
 *   - 拖动                         可移动，松手吸附左右边缘
 *   - 点击（非拖动）              回到 App 的通话页
 *   - 挂断按钮                     直接结束通话
 *
 * 实现要点（都是踩过的坑）：
 * 1. 必须用 TYPE_APPLICATION_OVERLAY（API 26+）；
 *    旧的 TYPE_PHONE 在 8.0 之后会抛 BadTokenException 或直接不显示。
 * 2. 权限是「特殊权限」，只能引导用户去系统设置授权，
 *    没有运行时申请接口；未授权时 show() 会抛异常，必须捕获。
 * 3. 窗口尺寸用 px 计算，dp 转换要乘 density，
 *    否则在高 dpi 设备上小窗会小到看不清。
 * 4. 拖动要用「位移阈值」区分点击与拖动，否则用户想移动却触发了回 App。
 * 5. 主线程操作 View，所有入口都切主线程。
 *
 * 为什么不用画中画（PiP）：
 * PiP 是给视频设计的，音频通话缩成 PiP 会出现一块黑屏，
 * 且无法自定义挂断按钮 —— 微信/Telegram 都是自绘悬浮窗。
 * ============================================================
 */
object FloatingCallWindow {

    /** 悬浮窗所需权限是否已授予 */
    fun canDraw(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
        return Settings.canDrawOverlays(context)
    }

    /** 跳系统设置页让用户授权 */
    fun requestPermission(context: Context) {
        if (canDraw(context)) return
        try {
            val intent = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                android.net.Uri.parse("package:${context.packageName}"),
            ).apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK }
            context.startActivity(intent)
        } catch (_: Throwable) {
            // 部分 ROM 没有该设置页，忽略（悬浮窗降级为不可用）
        }
    }

    private var root: View? = null
    private var params: WindowManager.LayoutParams? = null
    private var wm: WindowManager? = null
    private var timerView: TextView? = null
    private var nameView: TextView? = null
    private var startedAt = 0L
    private val main = Handler(Looper.getMainLooper())
    private var ticker: Runnable? = null

    /** 挂断回调：由 CallService / ChatHost 注入 */
    var onHangup: (() -> Unit)? = null

    /**
     * 显示悬浮窗
     * @param peerName 对方昵称（显示在窗口里）
     * @param startedAtMs 通话开始时间戳，用于显示时长
     */
    @SuppressLint("ClickableViewAccessibility")
    fun show(context: Context, peerName: String, startedAtMs: Long) {
        if (root != null) {
            // 已显示：只更新文案，避免反复 addView 造成闪烁
            nameView?.text = peerName
            startedAt = startedAtMs
            return
        }
        if (!canDraw(context)) {
            // 未授权：静默降级（通知栏仍可回到通话）
            requestPermission(context)
            return
        }

        main.post {
            try {
                showInternal(context.applicationContext, peerName, startedAtMs)
            } catch (_: Throwable) {
                root = null
                params = null
            }
        }
    }

    /** 隐藏悬浮窗 */
    fun hide() {
        main.post {
            ticker?.let { main.removeCallbacks(it) }
            ticker = null
            val r = root ?: return@post
            root = null
            try {
                wm?.removeView(r)
            } catch (_: Throwable) {
                // 已被系统移除，忽略
            }
        }
    }

    fun isShowing(): Boolean = root != null

    /* ------------------------------------------------------------------ */
    /* 内部实现                                                             */
    /* ------------------------------------------------------------------ */

    private fun showInternal(context: Context, peerName: String, startedAtMs: Long) {
        val manager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        wm = manager
        startedAt = startedAtMs

        val d = context.resources.displayMetrics.density
        fun dp(v: Int) = (v * d).roundToInt()

        // ---------- 卡片 ----------
        val card = FrameLayout(context)
        val bg = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(16).toFloat()
            setColor(Color.parseColor("#E61C1C1E"))
            setStroke(dp(1), Color.parseColor("#33FFFFFF"))
        }
        card.background = bg

        // 头像（首字母）
        val avatar = TextView(context).apply {
            text = peerName.take(1).uppercase()
            setTextColor(Color.WHITE)
            textSize = 16f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#FF0A84FF"))
            }
            layoutParams = FrameLayout.LayoutParams(dp(38), dp(38)).apply {
                leftMargin = dp(10)
                topMargin = dp(13)
            }
        }
        card.addView(avatar)

        // 昵称
        nameView = TextView(context).apply {
            text = peerName
            setTextColor(Color.WHITE)
            textSize = 13f
            typeface = Typeface.DEFAULT_BOLD
            maxLines = 1
            layoutParams = FrameLayout.LayoutParams(dp(96), dp(18)).apply {
                leftMargin = dp(56)
                topMargin = dp(12)
            }
        }
        card.addView(nameView)

        // 计时
        timerView = TextView(context).apply {
            text = "00:00"
            setTextColor(Color.parseColor("#99FFFFFF"))
            textSize = 11f
            layoutParams = FrameLayout.LayoutParams(dp(96), dp(16)).apply {
                leftMargin = dp(56)
                topMargin = dp(31)
            }
        }
        card.addView(timerView)

        // 挂断按钮
        val hangup = TextView(context).apply {
            text = "✕"
            setTextColor(Color.WHITE)
            textSize = 14f
            gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#FFFF3B30"))
            }
            layoutParams = FrameLayout.LayoutParams(dp(30), dp(30)).apply {
                leftMargin = dp(150)
                topMargin = dp(17)
            }
            setOnClickListener {
                hide()
                onHangup?.invoke()
            }
        }
        card.addView(hangup)

        // ---------- 窗口参数 ----------
        val w = dp(190)
        val h = dp(64)
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }

        val lp = WindowManager.LayoutParams(
            w,
            h,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = dp(12)
            y = dp(120)
        }
        params = lp

        // ---------- 拖动 ----------
        var downX = 0f
        var downY = 0f
        var originX = 0
        var originY = 0
        var dragging = false

        card.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = e.rawX
                    downY = e.rawY
                    originX = lp.x
                    originY = lp.y
                    dragging = false
                    true
                }

                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - downX
                    val dy = e.rawY - downY
                    if (!dragging && (abs(dx) > dp(6) || abs(dy) > dp(6))) {
                        dragging = true
                    }
                    if (dragging) {
                        lp.x = originX + dx.toInt()
                        lp.y = originY + dy.toInt()
                        try {
                            manager.updateViewLayout(card, lp)
                        } catch (_: Throwable) {
                        }
                    }
                    true
                }

                MotionEvent.ACTION_UP -> {
                    if (dragging) {
                        // 松手吸附到最近的一侧
                        val screenW = context.resources.displayMetrics.widthPixels
                        lp.x = if (lp.x + w / 2 < screenW / 2) dp(12) else screenW - w - dp(12)
                        // 限制在状态栏下方与屏幕底部之间
                        val maxY = context.resources.displayMetrics.heightPixels - h - dp(24)
                        if (lp.y < dp(40)) lp.y = dp(40)
                        if (lp.y > maxY) lp.y = maxY
                        try {
                            manager.updateViewLayout(card, lp)
                        } catch (_: Throwable) {
                        }
                    } else {
                        // 点击：回到 App
                        bringAppToFront(context)
                    }
                    true
                }

                else -> false
            }
        }

        try {
            manager.addView(card, lp)
            root = card
            startTicker()
        } catch (_: Throwable) {
            root = null
            params = null
        }
    }

    /** 每秒刷新通话时长 */
    private fun startTicker() {
        ticker?.let { main.removeCallbacks(it) }
        val task = object : Runnable {
            override fun run() {
                val elapsed = ((System.currentTimeMillis() - startedAt) / 1000).coerceAtLeast(0)
                timerView?.text = String.format(
                    "%02d:%02d",
                    elapsed / 60,
                    elapsed % 60,
                )
                main.postDelayed(this, 1000)
            }
        }
        ticker = task
        main.post(task)
    }

    /** 把 App 拉回前台（保留原任务栈与 Lynx 状态） */
    private fun bringAppToFront(context: Context) {
        try {
            val intent = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP or
                    Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
            }
            context.startActivity(intent)
        } catch (_: Throwable) {
        }
    }
}
