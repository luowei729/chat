package pub.lkz.chat.media

import android.net.Uri
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
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

    fun upload(optsJson: String): Result<Pair<Int, String>> {
        return try {
            val opts = JSONObject(optsJson)
            val url = opts.getString("url")
            val name = opts.optString("name", "file")
            val mime = opts.optString("mime", "application/octet-stream")
            val uri = opts.getString("uri")

            val body = openStreamBody(uri, mime)
                ?: return Result.failure(IllegalStateException("无法读取文件：$uri"))

            val builder = MultipartBody.Builder().setType(MultipartBody.FORM)
            builder.addFormDataPart("file", name, body)

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
