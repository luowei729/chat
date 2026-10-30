package pub.lkz.chat.media

import android.content.Context
import android.content.Intent
import android.provider.MediaStore
import com.lynx.jsbridge.LynxMethod
import com.lynx.jsbridge.LynxModule
import com.lynx.react.bridge.Callback
import com.lynx.react.bridge.JavaOnlyMap

/**
 * ============================================================
 * 媒体能力原生模块（ChatMedia）
 * ============================================================
 * 与前端 src/platform/media.ts 的方法名/参数一一对应，
 * iOS / HarmonyOS / Windows / macOS 按同一份契约实现即可，
 * 前端业务代码零改动 —— 这是「全平台可用」的关键约束。
 *
 * 参数约定：
 *   - 复杂参数统一传 JSON 字符串（避免各端 Map 类型差异）；
 *   - 回调统一回 JavaOnlyMap：
 *       {ok:true, ...}                     成功
 *       {ok:false, cancelled:true}         用户取消
 *       {ok:false, message:'...'}           失败
 *
 * 所有方法最后都必须 invoke 一次回调，否则前端 Promise 永远挂起。
 * ============================================================
 */
class ChatMediaModule : LynxModule {

    constructor(context: Context) : super(context)
    constructor(context: Context, param: Any?) : super(context, param)

    /* ------------------------------------------------------------------ */
    /* 相册 / 文件选择                                                      */
    /* ------------------------------------------------------------------ */

    /**
     * 相册选图（可多选）
     * opts: { multiple: boolean }
     */
    @LynxMethod
    fun pickImage(optsJson: String?, callback: Callback) {
        val activity = ActivityHolder.get()
        if (activity == null) {
            MediaBridge.fail(callback, "应用不在前台")
            return
        }
        val multiple = Json.optBool(optsJson, "multiple", true)

        val intent = Intent(Intent.ACTION_PICK, MediaStore.Images.Media.EXTERNAL_CONTENT_URI).apply {
            type = "image/*"
            if (multiple) {
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                action = Intent.ACTION_GET_CONTENT
            }
            addCategory(Intent.CATEGORY_OPENABLE)
        }
        MediaBridge.launch(activity, intent, MediaBridge.REQ_PICK_IMAGE, "image", callback)
    }

    /**
     * 系统文件选择器（任意文件）
     * opts: { mimeFilter: string }
     */
    @LynxMethod
    fun pickFile(optsJson: String?, callback: Callback) {
        val activity = ActivityHolder.get()
        if (activity == null) {
            MediaBridge.fail(callback, "应用不在前台")
            return
        }
        val mime = Json.optString(optsJson, "mimeFilter", "*/*")

        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mime
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        MediaBridge.launch(activity, intent, MediaBridge.REQ_PICK_FILE, "file", callback)
    }

    /* ------------------------------------------------------------------ */
    /* 相机（微信式：短按拍照 / 长按录像 / 闪光灯）                          */
    /* ------------------------------------------------------------------ */

    /**
     * 打开相机页
     * opts: { flash: boolean }  —— flash 为初始闪光灯状态
     *
     * 页面内：轻触拍照、长按录像、右上角切换闪光灯。
     * 手势在原生实现，前端不需要关心按下时长。
     */
    @LynxMethod
    fun openCamera(optsJson: String?, callback: Callback) {
        val activity = ActivityHolder.get()
        if (activity == null) {
            MediaBridge.fail(callback, "应用不在前台")
            return
        }

        val intent = Intent(activity, CameraActivity::class.java).apply {
            putExtra("flash", Json.optBool(optsJson, "flash", false))
        }
        MediaBridge.launch(activity, intent, MediaBridge.REQ_CAMERA, "camera", callback)
    }

    /* ------------------------------------------------------------------ */
    /* 语音录制                                                             */
    /* ------------------------------------------------------------------ */

    @LynxMethod
    fun startRecord(callback: Callback) {
        val ctx = AppContext.get()
        if (ctx == null) {
            MediaBridge.fail(callback, "上下文丢失")
            return
        }
        AudioRecorderHelper.start(ctx)
            .onSuccess { MediaBridge.ok(callback) }
            .onFailure { MediaBridge.fail(callback, it.message ?: "无法开始录音") }
    }

    @LynxMethod
    fun stopRecord(callback: Callback) {
        val result = AudioRecorderHelper.stop()
        if (result == null) {
            MediaBridge.fail(callback, "录音时间太短")
            return
        }
        MediaBridge.ok(
            callback,
            mapOf(
                "file" to JavaOnlyMap.from(
                    mapOf(
                        "uri" to result.file.absolutePath,
                        "name" to result.file.name,
                        "mime" to "audio/mp4",
                        "size" to result.file.length(),
                        "durationMs" to result.durationMs,
                        "waveform" to result.waveform,
                    ),
                ),
            ),
        )
    }

    @LynxMethod
    fun cancelRecord(callback: Callback) {
        AudioRecorderHelper.cancel()
        MediaBridge.ok(callback)
    }

    /* ------------------------------------------------------------------ */
    /* 音频播放                                                             */
    /* ------------------------------------------------------------------ */

    @LynxMethod
    fun playAudio(uri: String?, callback: Callback) {
        if (uri.isNullOrEmpty()) {
            MediaBridge.fail(callback, "缺少音频地址")
            return
        }
        AudioPlayerHelper.play(uri)
            .onSuccess { duration ->
                MediaBridge.ok(callback, mapOf("durationMs" to duration))
            }
            .onFailure { MediaBridge.fail(callback, it.message ?: "播放失败") }
    }

    @LynxMethod
    fun stopAudio(callback: Callback) {
        AudioPlayerHelper.stop()
        MediaBridge.ok(callback)
    }

    /* ------------------------------------------------------------------ */
    /* 上传                                                                 */
    /* ------------------------------------------------------------------ */

    /**
     * 流式上传（OkHttp）
     * opts: { uri, name, mime, url, headers:{}, fields:{} }
     */
    @LynxMethod
    fun uploadFile(optsJson: String?, callback: Callback) {
        if (optsJson.isNullOrEmpty()) {
            MediaBridge.fail(callback, "缺少上传参数")
            return
        }
        // 进度回调：同一个 callback 多次 invoke，JS 侧按字段区分
        // {progress:0.x} 是进度，{ok:true/false} 是最终结果。
        // Lynx 的 Callback 支持多次调用，JS 端用回调式 API 接收。
        val onProgress: (Double) -> Unit = { p ->
            try {
                callback.invoke(
                    JavaOnlyMap.from(
                        mapOf(
                            "progress" to p,
                            "ok" to false,
                            "pending" to true,
                        ),
                    ),
                )
            } catch (_: Throwable) {
                // JS 侧已销毁（用户退出会话），忽略
            }
        }

        UploadHelper.upload(optsJson, onProgress)
            .onSuccess { (status, body) ->
                MediaBridge.ok(
                    callback,
                    mapOf(
                        "status" to status,
                        "body" to body,
                    ),
                )
            }
            .onFailure { MediaBridge.fail(callback, it.message ?: "上传失败") }
    }
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** JSON 参数读取（各端入参统一为 JSON 字符串） */
internal object Json {
    fun optBool(json: String?, key: String, def: Boolean): Boolean {
        if (json.isNullOrEmpty()) return def
        return try {
            val obj = org.json.JSONObject(json)
            if (obj.has(key)) obj.optBoolean(key, def) else def
        } catch (_: Throwable) {
            def
        }
    }

    fun optString(json: String?, key: String, def: String): String {
        if (json.isNullOrEmpty()) return def
        return try {
            val obj = org.json.JSONObject(json)
            obj.optString(key, def).ifEmpty { def }
        } catch (_: Throwable) {
            def
        }
    }
}

/** 当前前台 Activity（相机/选择器必须由 Activity 发起） */
internal object ActivityHolder {
    fun get(): android.app.Activity? = pub.lkz.chat.MainActivity.current
}
