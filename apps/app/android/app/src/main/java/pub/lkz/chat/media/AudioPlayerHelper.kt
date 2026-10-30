package pub.lkz.chat.media

import android.media.AudioAttributes
import android.media.MediaPlayer
import java.io.File

/**
 * ============================================================
 * 语音播放（单实例）
 * ============================================================
 * 设计要点：
 * 1. 同一时刻只播一条：点第二条时自动停掉第一条，
 *    避免多条语音叠在一起听不清；
 * 2. 支持本地文件路径、content:// 与 http(s) 流；
 * 3. 静音模式下也出声（STREAM_MUSIC + 不请求音频焦点），
 *    这是聊天语音条的通用行为。
 * ============================================================
 */
object AudioPlayerHelper {

    private var player: MediaPlayer? = null
    private var currentUri: String? = null

    /** 播放进度回调：由模块层转成 JS 事件，UI 用来画进度 */
    var onProgress: ((positionMs: Int, durationMs: Int) -> Unit)? = null
    var onComplete: (() -> Unit)? = null

    fun play(uri: String): Result<Int> {
        stop()
        return try {
            val p = MediaPlayer()
            p.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )

            when {
                uri.startsWith("content://") -> {
                    val ctx = AppContext.get()
                        ?: return Result.failure(IllegalStateException("上下文丢失"))
                    ctx.contentResolver.openFileDescriptor(android.net.Uri.parse(uri), "r")
                        ?.use { p.setDataSource(it.fileDescriptor) }
                }

                uri.startsWith("http://") || uri.startsWith("https://") -> {
                    p.setDataSource(uri)
                }

                else -> {
                    val path = uri.removePrefix("file://")
                    p.setDataSource(File(path).absolutePath)
                }
            }

            p.setOnCompletionListener {
                onComplete?.invoke()
                stop()
            }
            p.prepare()
            p.start()

            player = p
            currentUri = uri
            Result.success(p.duration)
        } catch (e: Throwable) {
            try {
                player?.release()
            } catch (_: Throwable) {
            }
            player = null
            currentUri = null
            Result.failure(e)
        }
    }

    fun stop() {
        val p = player ?: return
        player = null
        currentUri = null
        try {
            if (p.isPlaying) p.stop()
        } catch (_: Throwable) {
        }
        try {
            p.release()
        } catch (_: Throwable) {
        }
    }

    fun isPlaying(): Boolean = try {
        player?.isPlaying == true
    } catch (_: Throwable) {
        false
    }

    fun currentPosition(): Int = try {
        player?.currentPosition ?: 0
    } catch (_: Throwable) {
        0
    }

    fun playingUri(): String? = currentUri
}
