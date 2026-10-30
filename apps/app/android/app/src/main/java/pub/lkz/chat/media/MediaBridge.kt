package pub.lkz.chat.media

import android.app.Activity
import android.content.ContentResolver
import android.content.Intent
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.OpenableColumns
import com.lynx.react.bridge.Callback
import com.lynx.react.bridge.JavaOnlyMap
import java.io.File

/**
 * ============================================================
 * 媒体能力的公共支撑（选图/拍照/录像/选文件 的请求中转）
 * ============================================================
 * 为什么要有这一层：
 * 1. LynxModule 拿不到 ActivityResult 回调，必须由 Activity 转发；
 * 2. 同一时刻只允许一个选择流程在跑，用单槽 pending 即可，
 *    这样即使前端连点也不会造成回调错配；
 * 3. 各端（iOS/HarmonyOS）只需按同样的「成功/取消/失败」三元组
 *    回给 JS，前端逻辑完全复用。
 * ============================================================
 */
object MediaBridge {

    /** 请求码：与 MainActivity 的 1001（权限）错开 */
    const val REQ_PICK_IMAGE = 2001
    const val REQ_PICK_FILE = 2002
    const val REQ_CAMERA = 2003

    private var pendingCode: Int = 0
    private var pendingCallback: Callback? = null

    /** 记录本次请求的用途，结果回来时决定怎么解析 */
    private var pendingKind: String = ""

    fun hasPending(): Boolean = pendingCallback != null

    /**
     * 发起系统选择/拍摄界面
     * ------------------------------------------------------------
     * 【关键】必须切主线程！
     * LynxModule 的 @LynxMethod 全部在 Lynx 的后台线程（TASM 线程）
     * 上执行，而 startActivityForResult 是 UI 操作。在后台线程调用
     * 时 Android 不会抛异常，只是 Activity 根本不会被拉起 ——
     * 表现就是「点了相册/文件，什么都没发生」，日志也干净。
     * 这是本项目里最隐蔽的一类 bug，必须 runOnUiThread。
     */
    fun launch(activity: Activity, intent: Intent, code: Int, kind: String, cb: Callback) {
        if (pendingCallback != null) {
            fail(cb, "上一个操作还没结束，请稍候")
            return
        }
        pendingCode = code
        pendingKind = kind
        pendingCallback = cb

        activity.runOnUiThread {
            try {
                activity.startActivityForResult(intent, code)
            } catch (e: Throwable) {
                clear()
                fail(cb, e.message ?: "无法打开系统界面")
            }
        }
    }

    /** MainActivity.onActivityResult 转发入口 */
    fun handleActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != pendingCode) return
        val cb = pendingCallback ?: return
        val kind = pendingKind
        clear()

        if (resultCode != Activity.RESULT_OK || data == null) {
            // 用户返回（含相机页取消）统一按「已取消」处理，UI 不提示错误
            cancel(cb)
            return
        }

        try {
            when (kind) {
                "camera" -> emitCameraResult(cb, data)
                "image" -> emitUris(cb, collectUris(data))
                "file" -> emitUris(cb, collectUris(data))
                else -> cancel(cb)
            }
        } catch (e: Throwable) {
            fail(cb, e.message ?: "读取结果失败")
        }
    }

    /* ---------------- 结果组装 ---------------- */

    private fun collectUris(data: Intent): List<Uri> {
        val clip = data.clipData
        if (clip != null) {
            val list = ArrayList<Uri>(clip.itemCount)
            for (i in 0 until clip.itemCount) list.add(clip.getItemAt(i).uri)
            return list
        }
        val single = data.data
        return if (single != null) listOf(single) else emptyList()
    }

    private fun emitUris(cb: Callback, uris: List<Uri>) {
        if (uris.isEmpty()) {
            cancel(cb)
            return
        }
        val app = AppContext.get() ?: run {
            fail(cb, "上下文丢失")
            return
        }
        val files = ArrayList<Any>(uris.size)
        for (u in uris) {
            val meta = describe(app.contentResolver, u)
            files.add(meta)
        }
        cb.invoke(
            JavaOnlyMap.from(
                mapOf(
                    "ok" to true,
                    "files" to files,
                ),
            ),
        )
    }

    /**
     * 相机页返回：Intent 里带 uri/name/mime/size/width/height/durationMs
     * 用 file 字段返回，与 JS 层 capturePhoto/captureVideo 的契约一致。
     */
    private fun emitCameraResult(cb: Callback, data: Intent) {
        val path = data.getStringExtra("path") ?: run {
            cancel(cb)
            return
        }
        val file = File(path)
        if (!file.exists()) {
            fail(cb, "文件不存在")
            return
        }
        val isVideo = data.getBooleanExtra("isVideo", false)
        val map = HashMap<String, Any>()
        map["ok"] = true
        map["file"] = JavaOnlyMap.from(
            mapOf(
                "uri" to file.absolutePath,
                "name" to file.name,
                "mime" to (data.getStringExtra("mime")
                    ?: if (isVideo) "video/mp4" else "image/jpeg"),
                "size" to file.length(),
                "width" to data.getIntExtra("width", 0),
                "height" to data.getIntExtra("height", 0),
                "durationMs" to data.getLongExtra("durationMs", 0L),
                "waveform" to emptyList<Int>(),
            ),
        )
        cb.invoke(JavaOnlyMap.from(map))
    }

    /* ---------------- Uri → 文件描述 ---------------- */

    fun describe(resolver: ContentResolver, uri: Uri): JavaOnlyMap {
        var name = uri.lastPathSegment ?: "file"
        var size = 0L
        try {
            resolver.query(uri, null, null, null, null)?.use { c ->
                val nameIdx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIdx = c.getColumnIndex(OpenableColumns.SIZE)
                if (c.moveToFirst()) {
                    if (nameIdx >= 0) c.getString(nameIdx)?.let { name = it }
                    if (sizeIdx >= 0 && !c.isNull(sizeIdx)) size = c.getLong(sizeIdx)
                }
            }
        } catch (_: Throwable) {
            // 部分 provider 不支持 query，用兜底值
        }

        val mime = resolver.getType(uri) ?: guessMime(name)
        val map = HashMap<String, Any>()
        map["uri"] = uri.toString()
        map["name"] = name
        map["mime"] = mime
        map["size"] = size
        return JavaOnlyMap.from(map)
    }

    fun guessMime(name: String): String {
        val lower = name.lowercase()
        val ext = lower.substringAfterLast('.', "")
        return when (ext) {
            "jpg", "jpeg" -> "image/jpeg"
            "png" -> "image/png"
            "gif" -> "image/gif"
            "webp" -> "image/webp"
            "heic", "heif" -> "image/heic"
            "mp4", "m4v" -> "video/mp4"
            "mov" -> "video/quicktime"
            "m4a", "aac" -> "audio/mp4"
            "mp3" -> "audio/mpeg"
            "amr" -> "audio/amr"
            "wav" -> "audio/wav"
            "pdf" -> "application/pdf"
            "zip" -> "application/zip"
            "doc" -> "application/msword"
            "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            "xls" -> "application/vnd.ms-excel"
            "xlsx" -> "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            "ppt" -> "application/vnd.ms-powerpoint"
            "pptx" -> "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            "txt" -> "text/plain"
            else -> "application/octet-stream"
        }
    }

    /** 读图片尺寸（只解边界，不占内存） */
    fun imageSize(file: File): Pair<Int, Int> {
        val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, opts)
        return opts.outWidth to opts.outHeight
    }

    /** 读视频时长（毫秒） */
    fun videoDuration(file: File): Long {
        val retriever = MediaMetadataRetriever()
        return try {
            retriever.setDataSource(file.absolutePath)
            retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                ?.toLongOrNull() ?: 0L
        } catch (_: Throwable) {
            0L
        } finally {
            try {
                retriever.release()
            } catch (_: Throwable) {
            }
        }
    }

    /* ---------------- 结果回传 ---------------- */

    fun cancel(cb: Callback) {
        cb.invoke(JavaOnlyMap.from(mapOf("ok" to false, "cancelled" to true)))
    }

    fun fail(cb: Callback, message: String) {
        cb.invoke(JavaOnlyMap.from(mapOf("ok" to false, "message" to message)))
    }

    fun ok(cb: Callback, extra: Map<String, Any?> = emptyMap()) {
        val m = HashMap<String, Any>()
        m["ok"] = true
        for ((k, v) in extra) if (v != null) m[k] = v
        cb.invoke(JavaOnlyMap.from(m))
    }

    private fun clear() {
        pendingCode = 0
        pendingKind = ""
        pendingCallback = null
    }
}
