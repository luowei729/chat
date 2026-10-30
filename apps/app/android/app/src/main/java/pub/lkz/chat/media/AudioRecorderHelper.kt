package pub.lkz.chat.media

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.io.File

/**
 * ============================================================
 * 语音录制
 * ============================================================
 * 输出格式选 m4a(AAC)：体积小、各端都能直接播，
 * Web 端上传的 webm 也统一在服务端按 mime 区分，不做转码。
 *
 * 波形采集：
 *   每 100ms 读一次 MediaRecorder.maxAmplitude（0~32767），
 *   归一化成 0~100 存进数组。这样语音条不用等下载完音频
 *   就能画振幅条，和微信的表现一致。
 *
 * 只允许单实例：开始前若已在录，自动丢弃旧的，
 * 避免用户连点时出现两个 MediaRecorder 抢麦克风。
 * ============================================================
 */
object AudioRecorderHelper {

    private var recorder: MediaRecorder? = null
    private var outputFile: File? = null
    private var startedAt: Long = 0
    private val waveform = ArrayList<Int>()
    private val handler = Handler(Looper.getMainLooper())
    private var sampler: Runnable? = null

    /** 最短录音时长：低于它视为误触 */
    const val MIN_DURATION_MS = 600L

    fun start(ctx: Context): Result<Unit> {
        stopInternal(discard = true)

        val dir = File(ctx.filesDir, "media").apply { mkdirs() }
        val file = File(dir, "voice_${System.currentTimeMillis()}.m4a")

        return try {
            val r = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(ctx)
            } else {
                @Suppress("DEPRECATION")
                MediaRecorder()
            }
            r.setAudioSource(MediaRecorder.AudioSource.MIC)
            r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            // 16kHz 单声道 32kbps：语音足够清晰，1 分钟约 240KB
            r.setAudioSamplingRate(16000)
            r.setAudioChannels(1)
            r.setAudioEncodingBitRate(32000)
            r.setOutputFile(file.absolutePath)
            r.prepare()
            r.start()

            recorder = r
            outputFile = file
            startedAt = System.currentTimeMillis()
            waveform.clear()
            startSampling()
            Result.success(Unit)
        } catch (e: Throwable) {
            try {
                recorder?.release()
            } catch (_: Throwable) {
            }
            recorder = null
            outputFile = null
            file.delete()
            Result.failure(e)
        }
    }

    /**
     * 停止并返回结果
     * @return 文件、时长、波形；未在录音时返回 null
     */
    fun stop(): RecordedVoice? {
        val r = recorder ?: return null
        val file = outputFile
        recorder = null
        outputFile = null
        stopSampling()

        val durationMs = System.currentTimeMillis() - startedAt

        try {
            r.stop()
        } catch (_: Throwable) {
            // 录制过短会抛 RuntimeException，视为失败
            try {
                r.release()
            } catch (_: Throwable) {
            }
            file?.delete()
            return null
        }
        try {
            r.release()
        } catch (_: Throwable) {
        }

        if (file == null || !file.exists() || file.length() == 0L) {
            file?.delete()
            return null
        }
        if (durationMs < MIN_DURATION_MS) {
            file.delete()
            return null
        }

        return RecordedVoice(
            file = file,
            durationMs = durationMs,
            waveform = waveform.toList(),
        )
    }

    /** 取消录音：删文件、释放麦克风 */
    fun cancel() {
        stopInternal(discard = true)
    }

    fun isRecording(): Boolean = recorder != null

    /** 当前已录时长（毫秒），供 UI 显示计时 */
    fun elapsedMs(): Long = if (recorder == null) 0 else System.currentTimeMillis() - startedAt

    private fun stopInternal(discard: Boolean) {
        stopSampling()
        val r = recorder ?: return
        recorder = null
        try {
            r.stop()
        } catch (_: Throwable) {
        }
        try {
            r.release()
        } catch (_: Throwable) {
        }
        if (discard) {
            outputFile?.delete()
        }
        outputFile = null
    }

    private fun startSampling() {
        val task = object : Runnable {
            override fun run() {
                val r = recorder ?: return
                try {
                    val amp = r.maxAmplitude // 0..32767
                    // 开方压缩动态范围，人声听起来起伏更自然
                    val v = (Math.sqrt(amp.toDouble() / 32767.0) * 100).toInt()
                    waveform.add(v.coerceIn(0, 100))
                } catch (_: Throwable) {
                    waveform.add(0)
                }
                handler.postDelayed(this, 100L)
            }
        }
        sampler = task
        handler.postDelayed(task, 100L)
    }

    private fun stopSampling() {
        sampler?.let { handler.removeCallbacks(it) }
        sampler = null
    }

    /** 录音结果 */
    data class RecordedVoice(
        val file: File,
        val durationMs: Long,
        val waveform: List<Int>,
    )
}
