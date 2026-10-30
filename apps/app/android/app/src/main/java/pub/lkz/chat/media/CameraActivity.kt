package pub.lkz.chat.media

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.FallbackStrategy
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * ============================================================
 * 微信式相机页（短按拍照 / 长按录像 / 闪光灯开关）
 * ============================================================
 * 手势口径（对齐微信）：
 *   - 按下后 300ms 内抬起  → 拍照
 *   - 按住超过 300ms       → 开始录像，抬起即停止
 *   - 录像中上滑超过 80dp  → 取消本次录像（不产出文件）
 *   - 录像满 60s            → 自动停止
 *
 * 为什么把这套手感放在原生而不是前端：
 * 1. 前端拿不到「按下-抬起」的毫秒级精度，Lynx 的事件经过
 *    线程切换，长按判定会抖；
 * 2. 相机预览必须是原生 SurfaceView，前端无法在其上叠加
 *    真正低延迟的取景画面；
 * 3. 全平台一致：iOS/HarmonyOS 只需实现同样的 300ms 阈值，
 *    前端调用方式完全不变。
 *
 * 结果回传：setResult 里带 path/isVideo/mime/width/height/durationMs，
 * 由 MediaBridge 统一转成 JS 对象。
 * ============================================================
 */
class CameraActivity : AppCompatActivity() {

    companion object {
        /** 长按判定阈值：与微信一致 */
        private const val LONG_PRESS_MS = 300L
        /** 录像上限 */
        private const val MAX_VIDEO_MS = 60_000L
        /** 上滑取消距离（dp） */
        private const val CANCEL_SLIDE_DP = 80f
        private const val REQ_PERM = 3001
    }

    private lateinit var previewView: PreviewView
    private lateinit var shutter: ShutterView
    private lateinit var flashBtn: IconButton
    private lateinit var switchBtn: IconButton
    private lateinit var hintView: TextView
    private lateinit var timerView: TextView
    private lateinit var closeBtn: IconButton
    private lateinit var topBar: View

    private var cameraProvider: ProcessCameraProvider? = null
    /** 绑定用例时返回的 Camera，闪光灯控制必须用它 */
    private var boundCamera: androidx.camera.core.Camera? = null
    private var imageCapture: ImageCapture? = null
    private var videoCapture: VideoCapture<Recorder>? = null
    private var recording: Recording? = null

    private lateinit var cameraExecutor: ExecutorService
    private val main = Handler(Looper.getMainLooper())

    /** 闪光灯（手电筒）是否开启 */
    private var torchOn = false

    /**
     * 当前是否前置摄像头
     * ------------------------------------------------------------
     * 前置没有闪光灯硬件，所以切到前置时必须：
     *   1. 隐藏闪光灯按钮（不是禁用，禁用会让人反复点）；
     *   2. 强制 torchOn = false 并关闭手电筒，
     *      否则 CameraX 会抛 "Torch not supported"；
     *   3. ImageCapture 的 flashMode 复位为 OFF。
     */
    private var usingFront = false

    /** 按下时间，用于区分短按/长按 */
    private var downAt = 0L
    private var downY = 0f
    private var longPressFired = false
    private var cancelBySlide = false
    private var recordingsStartAt = 0L
    private var busy = false

    private var pendingFile: File? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        cameraExecutor = Executors.newSingleThreadExecutor()
        buildUi()

        if (!hasPermissions()) {
            requestPermissions(
                arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO),
                REQ_PERM,
            )
            return
        }
        startCamera()
    }

    /* ------------------------------------------------------------------ */
    /* UI                                                                  */
    /* ------------------------------------------------------------------ */

    private fun buildUi() {
        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }

        previewView = PreviewView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            scaleType = PreviewView.ScaleType.FILL_CENTER
        }
        root.addView(previewView)

        // 顶部：关闭 + 闪光灯（全部自绘，不用 emoji —— emoji 是彩色
        // 拟物字形，与 App 的白色线性图标语言冲突）
        val top = FrameLayout(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(96),
            ).apply { gravity = Gravity.TOP }
        }
        topBar = top

        closeBtn = IconButton(this, IconButton.Kind.CLOSE).apply {
            layoutParams = FrameLayout.LayoutParams(dp(48), dp(48)).apply {
                gravity = Gravity.START or Gravity.TOP
                leftMargin = dp(8)
                topMargin = dp(40)
            }
            setOnClickListener { finishWithCancel() }
        }
        top.addView(closeBtn)

        // 前置没有闪光灯，所以闪光灯按钮要能整体隐藏；
        // 切换摄像头的按钮固定在右上角，闪光灯排在它左边。
        switchBtn = IconButton(this, IconButton.Kind.SWITCH).apply {
            layoutParams = FrameLayout.LayoutParams(dp(48), dp(48)).apply {
                gravity = Gravity.END or Gravity.TOP
                rightMargin = dp(8)
                topMargin = dp(40)
            }
            setOnClickListener { switchCamera() }
        }
        top.addView(switchBtn)

        flashBtn = IconButton(this, IconButton.Kind.FLASH).apply {
            layoutParams = FrameLayout.LayoutParams(dp(48), dp(48)).apply {
                gravity = Gravity.END or Gravity.TOP
                rightMargin = dp(60)
                topMargin = dp(40)
            }
            setOnClickListener { toggleFlash() }
        }
        top.addView(flashBtn)

        root.addView(top)

        // 底部：提示 + 快门
        val bottom = FrameLayout(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(180),
            ).apply { gravity = Gravity.BOTTOM }
        }

        hintView = TextView(this).apply {
            text = "轻触拍照，长按摄像"
            setTextColor(Color.parseColor("#CCFFFFFF"))
            textSize = 13f
            gravity = Gravity.CENTER
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(24),
            ).apply { gravity = Gravity.TOP; topMargin = dp(6) }
        }
        bottom.addView(hintView)

        timerView = TextView(this).apply {
            text = ""
            setTextColor(Color.parseColor("#FFFF5252"))
            textSize = 15f
            gravity = Gravity.CENTER
            visibility = View.GONE
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(24),
            ).apply { gravity = Gravity.TOP; topMargin = dp(32) }
        }
        bottom.addView(timerView)

        shutter = ShutterView(this).apply {
            layoutParams = FrameLayout.LayoutParams(dp(84), dp(84)).apply {
                gravity = Gravity.CENTER_HORIZONTAL or Gravity.TOP
                topMargin = dp(60)
            }
        }
        bottom.addView(shutter)
        root.addView(bottom)

        bindShutterGesture()
        setContentView(root)

        applyImmersive()
    }

    /**
     * 全屏沉浸
     * ------------------------------------------------------------
     * 必须在 setContentView 之后调用，否则会先被主题里的
     * windowFullscreen 覆盖掉；再在 onWindowFocusChanged 里补一次，
     * 因为下拉通知栏后系统会把状态栏重新显示出来。
     */
    private fun applyImmersive() {
        runCatching {
            androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, false)
            val controller = androidx.core.view.WindowInsetsControllerCompat(
                window,
                window.decorView,
            )
            controller.hide(
                androidx.core.view.WindowInsetsCompat.Type.statusBars() or
                    androidx.core.view.WindowInsetsCompat.Type.navigationBars(),
            )
            controller.systemBarsBehavior =
                androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) applyImmersive()
    }

    /**
     * 快门手势
     * ------------------------------------------------------------
     * 用 OnTouchListener 而不是 OnClickListener：
     * 需要在「按下」瞬间启动 300ms 定时器，一旦超时就立刻开录，
     * 用户不用松手就能看到录像开始（与微信一致）。
     */
    private fun bindShutterGesture() {
        val touchSlopForCancel = dp(CANCEL_SLIDE_DP.toInt())

        shutter.setOnTouchListener { v, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    if (busy) return@setOnTouchListener true
                    downAt = System.currentTimeMillis()
                    downY = e.rawY
                    longPressFired = false
                    cancelBySlide = false
                    v.isPressed = true
                    main.postDelayed(longPressRunnable, LONG_PRESS_MS)
                    true
                }

                MotionEvent.ACTION_MOVE -> {
                    if (longPressFired && recording != null) {
                        // 上滑取消：微信这里会显示「松开取消」，这里直接置标记
                        if (downY - e.rawY > touchSlopForCancel) {
                            cancelBySlide = true
                            hintView.text = "松开取消"
                        } else if (cancelBySlide) {
                            cancelBySlide = false
                            hintView.text = "松开发送"
                        }
                    }
                    true
                }

                MotionEvent.ACTION_UP -> {
                    v.isPressed = false
                    main.removeCallbacks(longPressRunnable)
                    val held = System.currentTimeMillis() - downAt
                    when {
                        longPressFired -> stopVideo()
                        held >= LONG_PRESS_MS -> {
                            // 理论上不会走到（阈值已触发），兜底按录像处理
                            startVideo()
                            main.postDelayed({ stopVideo() }, 50)
                        }
                        else -> takePhoto()
                    }
                    true
                }

                MotionEvent.ACTION_CANCEL -> {
                    v.isPressed = false
                    main.removeCallbacks(longPressRunnable)
                    if (longPressFired) cancelVideo()
                    true
                }

                else -> false
            }
        }
    }

    /** 300ms 到点：如果手指还在按着，开始录像 */
    private val longPressRunnable = Runnable {
        if (shutter.isPressed) {
            longPressFired = true
            startVideo()
        }
    }

    /* ------------------------------------------------------------------ */
    /* 相机绑定                                                             */
    /* ------------------------------------------------------------------ */

    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            try {
                cameraProvider = future.get()
                if (!bindCamera()) {
                    finishWithError("相机启动失败")
                    return@addListener
                }
                // 没有前置摄像头就没必要显示切换按钮，
                // 否则用户点了没反应（比隐藏更困惑）
                if (!hasFrontCamera()) switchBtn.visibility = View.GONE
            } catch (e: Throwable) {
                finishWithError("相机启动失败：${e.message ?: e.javaClass.simpleName}")
            }
        }, ContextCompat.getMainExecutor(this))
    }

    /**
     * 绑定（或重绑）预览 / 拍照 / 录像三个用例
     * ------------------------------------------------------------
     * 切换前后摄像头时复用这个方法：先 unbindAll 再 bind。
     * 用例必须每次重建 —— CameraX 的 ImageCapture / VideoCapture
     * 与 Camera 实例绑定，复用旧实例会导致切换后拍照无声失效。
     */
    private fun bindCamera(): Boolean {
        val provider = cameraProvider ?: return false

        val preview = Preview.Builder().build().also {
            it.setSurfaceProvider(previewView.surfaceProvider)
        }

        imageCapture = ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
            .build()

        val recorder = Recorder.Builder()
            .setQualitySelector(
                QualitySelector.from(
                    Quality.HD,
                    FallbackStrategy.lowerQualityOrHigherThan(Quality.SD),
                ),
            )
            .build()
        videoCapture = VideoCapture.withOutput(recorder)

        val selector = if (usingFront) {
            CameraSelector.DEFAULT_FRONT_CAMERA
        } else {
            CameraSelector.DEFAULT_BACK_CAMERA
        }

        provider.unbindAll()

        /**
         * 绑定失败必须捕获
         * ------------------------------------------------
         * 常见原因：设备没有对应摄像头（模拟器默认只配后置）、
         * 摄像头被其他应用独占、USB 摄像头热插拔。
         * 不捕获的话 bindToLifecycle 会抛 IllegalArgumentException，
         * 直接把整个相机页崩掉 —— 用户看到的是「点切换就闪退」。
         */
        val bound = try {
            provider.bindToLifecycle(this, selector, preview, imageCapture, videoCapture)
        } catch (_: Throwable) {
            null
        }

        if (bound == null) {
            if (usingFront) {
                // 前置不可用：回退到后置，并保持 UI 状态一致
                usingFront = false
                hintView.text = "当前设备没有可用的前置摄像头"
                return bindCamera()
            }
            return false
        }

        boundCamera = bound
        syncFlashAvailability()
        applyTorch()
        // 前置预览是镜像的，与系统相机行为一致（自拍时左右不反）
        previewView.scaleX = if (usingFront) -1f else 1f
        return true
    }

    /** 设备是否有前置摄像头：用于决定切换按钮是否显示 */
    private fun hasFrontCamera(): Boolean {
        val provider = cameraProvider ?: return false
        return try {
            provider.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA)
        } catch (_: Throwable) {
            false
        }
    }

    /**
     * 闪光灯可用性同步
     * 前置无闪光灯 → 隐藏按钮并把状态清零，
     * 否则残留的 torchOn=true 会在切回后置时意外点亮手电筒。
     */
    private fun syncFlashAvailability() {
        if (usingFront) {
            if (torchOn) {
                torchOn = false
                flashBtn.setActive(false)
            }
            flashBtn.visibility = View.GONE
        } else {
            flashBtn.visibility = View.VISIBLE
        }
    }

    /** 前置 / 后置切换 */
    private fun switchCamera() {
        if (recording != null) {
            // 录像中切换会让输出文件损坏，直接忽略
            return
        }
        if (!usingFront && !hasFrontCamera()) {
            hintView.text = "当前设备没有可用的前置摄像头"
            return
        }
        usingFront = !usingFront
        busy = false
        shutter.setBusy(false)
        hintView.text = "轻触拍照，长按摄像"
        bindCamera()
    }

    /** 应用闪光灯状态：拍照用 FLASH_MODE，预览/录像用手电筒 */
    private fun applyTorch() {
        val cam = boundCamera ?: return
        // 前置无闪光灯单元，一律不触发
        val enabled = torchOn && !usingFront
        runCatching { cam.cameraControl.enableTorch(enabled) }
        imageCapture?.flashMode = when {
            usingFront -> ImageCapture.FLASH_MODE_OFF
            torchOn -> ImageCapture.FLASH_MODE_ON
            else -> ImageCapture.FLASH_MODE_OFF
        }
    }

    private fun toggleFlash() {
        // 前置时闪光灯按钮已隐藏，这里再兜一层，防止误调用
        if (usingFront) return
        torchOn = !torchOn
        flashBtn.setActive(torchOn)
        applyTorch()
    }

    /* ------------------------------------------------------------------ */
    /* 拍照                                                                 */
    /* ------------------------------------------------------------------ */

    private fun takePhoto() {
        val cap = imageCapture ?: run {
            finishWithError("相机未就绪")
            return
        }
        if (busy) return
        busy = true
        shutter.setBusy(true)

        val dir = File(filesDir, "media").apply { mkdirs() }
        val file = File(dir, "img_${System.currentTimeMillis()}.jpg")

        val options = ImageCapture.OutputFileOptions.Builder(file).build()
        cap.takePicture(
            options,
            ContextCompat.getMainExecutor(this),
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(results: ImageCapture.OutputFileResults) {
                    busy = false
                    shutter.setBusy(false)
                    val (w, h) = MediaBridge.imageSize(file)
                    finishWithFile(file, isVideo = false, width = w, height = h, durationMs = 0)
                }

                override fun onError(exception: ImageCaptureException) {
                    busy = false
                    shutter.setBusy(false)
                    file.delete()
                    finishWithError("拍照失败：${exception.message ?: ""}")
                }
            },
        )
    }

    /* ------------------------------------------------------------------ */
    /* 录像                                                                 */
    /* ------------------------------------------------------------------ */

    private fun startVideo() {
        val cap = videoCapture ?: run {
            finishWithError("相机未就绪")
            return
        }
        if (recording != null) return

        val dir = File(filesDir, "media").apply { mkdirs() }
        val file = File(dir, "vid_${System.currentTimeMillis()}.mp4")
        pendingFile = file

        val options = FileOutputOptions.Builder(file).build()
        var pending = cap.output.prepareRecording(this, options)
        if (hasPermissions()) {
            try {
                pending = pending.withAudioEnabled()
            } catch (_: Throwable) {
                // 无权录音时静默录制画面
            }
        }

        recordingsStartAt = System.currentTimeMillis()
        hintView.text = "松开发送"
        timerView.visibility = View.VISIBLE
        shutter.setRecording(true)
        startTimer()

        recording = pending.start(ContextCompat.getMainExecutor(this)) { event ->
            if (event is VideoRecordEvent.Finalize) {
                val err = event.hasError()
                val out = pendingFile
                pendingFile = null
                recording = null
                stopTimer()
                shutter.setRecording(false)

                if (err || out == null || !out.exists() || out.length() == 0L) {
                    out?.delete()
                    hintView.text = "轻触拍照，长按摄像"
                    timerView.visibility = View.GONE
                    if (event.hasError() && event.error != VideoRecordEvent.Finalize.ERROR_NONE) {
                        // 录制过短也会进这里，不弹错误，回到可拍状态
                        shutter.setBusy(false)
                        busy = false
                    }
                    return@start
                }

                val duration = MediaBridge.videoDuration(out)
                finishWithFile(out, isVideo = true, width = 0, height = 0, durationMs = duration)
            }
        }
    }

    private fun stopVideo() {
        val rec = recording ?: return
        if (cancelBySlide) {
            cancelVideo()
            return
        }
        busy = true
        rec.stop()
        stopTimer()
    }

    private fun cancelVideo() {
        val rec = recording ?: return
        recording = null
        try {
            rec.stop()
        } catch (_: Throwable) {
        }
        pendingFile?.delete()
        pendingFile = null
        stopTimer()
        shutter.setRecording(false)
        hintView.text = "轻触拍照，长按摄像"
        timerView.visibility = View.GONE
        busy = false
    }

    private fun startTimer() {
        main.post(timerTick)
    }

    private val timerTick = object : Runnable {
        override fun run() {
            val elapsed = System.currentTimeMillis() - recordingsStartAt
            val sec = elapsed / 1000
            timerView.text = String.format("● %d:%02d", sec / 60, sec % 60)
            if (elapsed >= MAX_VIDEO_MS) {
                stopVideo()
                return
            }
            main.postDelayed(this, 200)
        }
    }

    private fun stopTimer() {
        main.removeCallbacks(timerTick)
        timerView.visibility = View.GONE
    }

    /* ------------------------------------------------------------------ */
    /* 结果                                                                 */
    /* ------------------------------------------------------------------ */

    private fun finishWithFile(file: File, isVideo: Boolean, width: Int, height: Int, durationMs: Long) {
        val data = Intent().apply {
            putExtra("path", file.absolutePath)
            putExtra("isVideo", isVideo)
            putExtra("mime", if (isVideo) "video/mp4" else "image/jpeg")
            putExtra("width", width)
            putExtra("height", height)
            putExtra("durationMs", durationMs)
        }
        setResult(RESULT_OK, data)
        finish()
    }

    private fun finishWithCancel() {
        setResult(RESULT_CANCELED)
        finish()
    }

    private fun finishWithError(message: String) {
        val data = Intent().apply { putExtra("error", message) }
        setResult(RESULT_CANCELED, data)
        finish()
    }

    /* ------------------------------------------------------------------ */
    /* 权限与生命周期                                                       */
    /* ------------------------------------------------------------------ */

    private fun hasPermissions(): Boolean {
        val camera = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
        val mic = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
        return camera == PackageManager.PERMISSION_GRANTED && mic == PackageManager.PERMISSION_GRANTED
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_PERM) return
        if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            startCamera()
        } else {
            finishWithError("需要相机与麦克风权限才能拍摄")
        }
    }

    override fun onPause() {
        super.onPause()
        if (recording != null) cancelVideo()
    }

    override fun onDestroy() {
        super.onDestroy()
        main.removeCallbacks(longPressRunnable)
        stopTimer()
        cancelVideo()
        runCatching { cameraProvider?.unbindAll() }
        runCatching { cameraExecutor.shutdown() }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}

/**
 * 快门按钮
 * ============================================================
 * 状态：
 *   idle      —— 白色圆环 + 白色实心圆
 *   pressed   —— 内圆缩小（缩放反馈）
 *   recording —— 内圆变成圆角方块（微信的录制态）
 *   busy      —— 半透明，禁用
 *
 * 为什么自己画而不是用 drawable 选择器：
 * 录制态需要连续改变圆角半径做形变，drawable 做不到平滑过渡，
 * 而且自绘可以保证各 Android 版本视觉完全一致。
 * ============================================================
 */
private class ShutterView(context: android.content.Context) : View(context) {

    private var pressedState = false
    private var recordingState = false
    private var busyState = false

    /** 0 = 圆，1 = 圆角方 */
    private var morph = 0f

    private val ringPaint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
        style = android.graphics.Paint.Style.STROKE
        color = Color.WHITE
        strokeWidth = 5f * context.resources.displayMetrics.density
    }

    private val fillPaint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
        style = android.graphics.Paint.Style.FILL
        color = Color.WHITE
    }

    private val redPaint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
        style = android.graphics.Paint.Style.FILL
        color = Color.parseColor("#FFFF3B30")
    }

    fun setRecording(on: Boolean) {
        recordingState = on
        animateMorph(if (on) 1f else 0f)
    }

    fun setBusy(on: Boolean) {
        busyState = on
        alpha = if (on) 0.4f else 1f
        invalidate()
    }

    private fun animateMorph(target: Float) {
        val start = morph
        val steps = 8
        for (i in 1..steps) {
            postDelayed({
                morph = start + (target - start) * (i.toFloat() / steps)
                invalidate()
            }, i * 14L)
        }
    }

    override fun setPressed(pressed: Boolean) {
        super.setPressed(pressed)
        pressedState = pressed
        invalidate()
    }

    override fun onDraw(canvas: android.graphics.Canvas) {
        super.onDraw(canvas)
        val cx = width / 2f
        val cy = height / 2f
        val d = context.resources.displayMetrics.density

        // 外圈：录制时变细、变红
        ringPaint.color = if (recordingState) Color.parseColor("#FFFF3B30") else Color.WHITE
        ringPaint.strokeWidth = (if (recordingState) 4f else 5f) * d
        canvas.drawCircle(cx, cy, width / 2f - 4f * d, ringPaint)

        // 内圆：录制时缩小变圆角方
        val baseR = width / 2f - 11f * d
        val scale = when {
            recordingState -> 0.52f
            pressedState -> 0.86f
            else -> 1f
        }.let { it + (0f) }
        val r = baseR * scale
        fillPaint.color = if (recordingState) Color.parseColor("#FFFF3B30") else Color.WHITE
        fillPaint.alpha = if (busyState) 120 else 255

        if (morph <= 0.01f) {
            canvas.drawCircle(cx, cy, r, fillPaint)
        } else {
            // 圆角矩形：圆角半径随 morph 从 r 收敛到 0.28r
            val half = r
            val corner = r * (1f - morph * 0.72f)
            val rect = android.graphics.RectF(cx - half, cy - half, cx + half, cy + half)
            canvas.drawRoundRect(rect, corner, corner, fillPaint)
        }
    }
}

/**
 * 顶部工具按钮（关闭 / 闪光灯）
 * ============================================================
 * 为什么自绘而不用「✕」「⚡」字符：
 * 这两个字符在 Android 上会落到 emoji 字库，渲染成彩色拟物字形，
 * 与本 App 的白色线性图标语言冲突（用户已明确要求不要拟物）。
 *
 * 关闭：两条 45° 圆头线
 * 闪光灯：标准闪电多边形
 *   - 关闭态：白色描边（细）
 *   - 开启态：白色实心 + 半透明圆底（一眼可辨「已开启」）
 * ============================================================
 */
private class IconButton(context: android.content.Context, private val kind: Kind) : View(context) {

    enum class Kind { CLOSE, FLASH, SWITCH }

    private var active = false

    private val stroke = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
        style = android.graphics.Paint.Style.STROKE
        color = Color.WHITE
        strokeCap = android.graphics.Paint.Cap.ROUND
        strokeWidth = 2.4f * context.resources.displayMetrics.density
    }

    private val fill = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
        style = android.graphics.Paint.Style.FILL
        color = Color.WHITE
    }

    private val bgPaint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
        style = android.graphics.Paint.Style.FILL
        color = Color.parseColor("#59000000")
    }

    private val bolt = android.graphics.Path()
    private var boltBuilt = false

    private val arcRect = android.graphics.RectF()
    private val head = android.graphics.Path()
    private var headBuilt = false

    fun setActive(on: Boolean) {
        active = on
        invalidate()
    }

    override fun onDraw(canvas: android.graphics.Canvas) {
        super.onDraw(canvas)
        val d = context.resources.displayMetrics.density
        val cx = width / 2f
        val cy = height / 2f
        val r = width / 2f

        // 半透明圆底：保证在任意取景内容上都看得清
        canvas.drawCircle(cx, cy, r - 4f * d, bgPaint)

        val half = 9f * d // 图标半边长

        when (kind) {
            Kind.CLOSE -> {
                canvas.drawLine(cx - half, cy - half, cx + half, cy + half, stroke)
                canvas.drawLine(cx + half, cy - half, cx - half, cy + half, stroke)
            }

            Kind.SWITCH -> {
                /**
                 * 切换摄像头：旋转箭头
                 * ------------------------------------------------
                 * 画法：3/4 圆弧 + 圆弧末端的实心三角箭头。
                 * 这是「旋转/翻转」的通用语汇，在相机页面语境下
                 * 自然读作「切换前后摄像头」。
                 * 不用「相机机身里套箭头」：24dp 下机身只剩 2px 高，
                 * 细节会全部糊掉。
                 */
                val rr = half * 0.92f
                arcRect.set(cx - rr, cy - rr, cx + rr, cy + rr)
                stroke.strokeWidth = 2f * d
                // 从左下开始逆时针画 300°，留出右上缺口
                canvas.drawArc(arcRect, 130f, 280f, false, stroke)
                stroke.strokeWidth = 2.4f * d

                if (!headBuilt) {
                    // 箭头指向逆时针方向的终点（约为 -130°，即左上）
                    val ang = Math.toRadians(-150.0)
                    val tipX = cx + (rr * Math.cos(ang)).toFloat()
                    val tipY = cy + (rr * Math.sin(ang)).toFloat()
                    val a1 = Math.toRadians(-175.0)
                    val a2 = Math.toRadians(-125.0)
                    val w = 4.2f * d
                    head.reset()
                    head.moveTo(tipX, tipY)
                    head.lineTo(
                        tipX + (w * Math.cos(a1)).toFloat(),
                        tipY + (w * Math.sin(a1)).toFloat(),
                    )
                    head.lineTo(
                        tipX + (w * Math.cos(a2)).toFloat(),
                        tipY + (w * Math.sin(a2)).toFloat(),
                    )
                    head.close()
                    headBuilt = true
                }
                canvas.drawPath(head, fill)
            }

            Kind.FLASH -> {
                if (!boltBuilt) {
                    // 24×24 基准的闪电多边形，映射到 ±half
                    fun px(v: Float) = cx - half + v / 24f * (half * 2)
                    fun py(v: Float) = cy - half + v / 24f * (half * 2)
                    bolt.reset()
                    bolt.moveTo(px(13f), py(2f))
                    bolt.lineTo(px(4.5f), py(14f))
                    bolt.lineTo(px(10.5f), py(14f))
                    bolt.lineTo(px(10f), py(22f))
                    bolt.lineTo(px(19.5f), py(9.5f))
                    bolt.lineTo(px(13.5f), py(9.5f))
                    bolt.close()
                    boltBuilt = true
                }
                if (active) {
                    canvas.drawPath(bolt, fill)
                } else {
                    stroke.strokeWidth = 1.8f * d
                    canvas.drawPath(bolt, stroke)
                    stroke.strokeWidth = 2.4f * d
                }
            }
        }
    }
}
