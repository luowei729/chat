package pub.lkz.chat.media

import android.net.Uri
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.buffer
import org.json.JSONObject
import pub.lkz.chat.ChatApplication
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * ============================================================
 * 文件上传（OkHttp 流式直传）
 * ============================================================
 * 为什么上传要下沉到原生：
 * 1. Lynx 的 FormData 实现只支持 Blob，而原生端拿到的是
 *    content:// 或文件路径，没有 Blob 可用；
 * 2. 200MB 视频走 JS 内存会把 Lynx 运行时撑爆，
 *    OkHttp 的 asRequestBody 是流式读盘，内存占用恒定；
 * 3. Web/桌面端仍走 fetch+FormData，两端返回同一份 JSON，
 *    业务层无感知 —— 这是「全平台可用」的落地方式。
 *
 * 调用方（JS）传 opts JSON：
 *   { uri, name, mime, url, headers:{...}, fields:{...} }
 * 返回 { ok, status, body }
 * ============================================================
 */
object UploadHelper {

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS)
            .writeTimeout(120, TimeUnit.SECONDS)
            .build()
    }

    /**
     * @param onProgress 上传进度 0..1，回调在 OkHttp 的工作线程上触发，
     *                   调用方负责切到合适线程再抛给 JS。
     */
    fun upload(
        optsJson: String,
        onProgress: ((Double) -> Unit)? = null,
    ): Result<Pair<Int, String>> {
        return try {
            val opts = JSONObject(optsJson)
            val url = opts.getString("url")
            val name = opts.optString("name", "file")
            val mime = opts.optString("mime", "application/octet-stream")
            val uri = opts.getString("uri")

            val body = openStreamBody(uri, mime)
                ?: return Result.failure(IllegalStateException("无法读取文件：$uri"))

            val builder = MultipartBody.Builder().setType(MultipartBody.FORM)
            builder.addFormDataPart(
                "file",
                name,
                ProgressRequestBody(body, onProgress),
            )

            opts.optJSONObject("fields")?.let { fields ->
                for (key in fields.keys()) {
                    builder.addFormDataPart(key, fields.optString(key, ""))
                }
            }

            val reqBuilder = Request.Builder().url(url).post(builder.build())
            opts.optJSONObject("headers")?.let { headers ->
                for (key in headers.keys()) {
                    reqBuilder.header(key, headers.optString(key, ""))
                }
            }

            client.newCall(reqBuilder.build()).execute().use { resp ->
                val text = resp.body?.string() ?: ""
                Result.success(resp.code to text)
            }
        } catch (e: Throwable) {
            Result.failure(e)
        }
    }

    /**
     * 把不同来源的 uri 统一包成 RequestBody
     * - content:// 走 ContentResolver
     * - 其他按文件路径处理（自动去掉 file:// 前缀）
     */
    private fun openStreamBody(uri: String, mime: String): RequestBody? {
        val mediaType = mime.toMediaTypeOrNull()

        if (uri.startsWith("content://")) {
            val ctx = AppContext.get() ?: return null
            val parsed = Uri.parse(uri)
            val size = try {
                ctx.contentResolver.openAssetFileDescriptor(parsed, "r")?.use { it.length }
            } catch (_: Throwable) {
                null
            } ?: -1L

            val bytes = try {
                ctx.contentResolver.openInputStream(parsed)?.use { it.readBytes() }
            } catch (_: Throwable) {
                null
            } ?: return null

            return bytes.toRequestBody(mediaType)
        }

        val file = File(uri.removePrefix("file://"))
        if (!file.exists()) return null
        val type = if (mime == "application/octet-stream") {
            MediaBridge.guessMime(file.name)
        } else {
            mime
        }
        return file.asRequestBody(type.toMediaTypeOrNull())
    }

    /** 供调试：当前是否已初始化（ChatApplication 未初始化时上传一定失败） */
    fun ready(): Boolean = AppContext.get() != null && ChatApplication::class.java != null
}

/**
 * 带进度回调的 RequestBody
 * ============================================================
 * OkHttp 不会主动汇报上传进度，标准做法是包一层 RequestBody，
 * 在 writeTo 里把 sink 换成会统计字节数的 ForwardingSink。
 *
 * 注意：
 * 1. contentLength() 必须如实返回，否则 multipart 边界计算错误，
 *    服务端会解析失败（表现为 400 且没有明确错误信息）。
 * 2. 进度要限流（每 1% 或每 100ms 报一次），
 *    否则大文件会产生成千上万次跨线程回调，把 JS 线程打满。
 * 3. 回调可能早于 JS 侧注册监听，调用方自行兜底（null 安全）。
 */
private class ProgressRequestBody(
    private val delegate: RequestBody,
    private val onProgress: ((Double) -> Unit)?,
) : RequestBody() {

    override fun contentType() = delegate.contentType()

    override fun contentLength(): Long = delegate.contentLength()

    override fun writeTo(sink: okio.BufferedSink) {
        val total = contentLength()
        val report = onProgress
        if (report == null || total <= 0) {
            delegate.writeTo(sink)
            return
        }

        var written = 0L
        var lastPercent = -1

        // ForwardingSink 只重写 write 即可统计写入量，其余原样透传。
        // 注意 okio 3.x 的 write 返回 Unit（okio 2.x 返回 Long），
        // 所以不能 return super.write(...)。
        val counting = object : okio.ForwardingSink(sink) {
            override fun write(source: okio.Buffer, byteCount: Long) {
                written += byteCount
                val percent = ((written * 100) / total).toInt().coerceIn(0, 100)
                // 按百分比限流，避免大文件产生上万次回调
                if (percent != lastPercent) {
                    lastPercent = percent
                    report(percent / 100.0)
                }
                super.write(source, byteCount)
            }
        }

        val buffered = counting.buffer()
        delegate.writeTo(buffered)
        buffered.flush()
    }
}
