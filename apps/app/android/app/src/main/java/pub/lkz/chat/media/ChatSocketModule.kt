package pub.lkz.chat.media

import android.content.Context
import com.lynx.jsbridge.LynxMethod
import com.lynx.jsbridge.LynxModule
import com.lynx.react.bridge.Callback
import com.lynx.react.bridge.JavaOnlyMap
import org.json.JSONObject

/**
 * ============================================================
 * WebSocket 原生模块（ChatSocket）
 * ============================================================
 * 与前端 src/platform/socket.ts 的方法名一一对应。
 * 其余端按同一契约实现即可，业务代码零改动。
 *
 * 接口：
 *   connect(urlJson, callback)  urlJson = {"url":"wss://...","headers":{...}}
 *                               → {ok:true} / {ok:false,message}
 *   send(text, callback)        → {ok:true, sent:true|false}
 *   close(callback)             → {ok:true}
 *   isConnected(callback)       → true | false
 *
 * 事件（原生 → JS，全局事件名 'chatSocket'）：
 *   {event:'open'}
 *   {event:'message', data:'<原始文本>'}
 *   {event:'closed', code:1000, reason:'...'}
 *   {event:'failure', message:'...', status:0}
 *
 * 参数统一用 String / Boolean / Callback，
 * 绝不出现 Object/Any 形参 —— 那会让 Lynx 反射失败并导致
 * 整个模块注册不上（ChatHost 已经踩过一次）。
 * ============================================================
 */
class ChatSocketModule : LynxModule {

    constructor(context: Context) : super(context)
    constructor(context: Context, param: Any?) : super(context, param)

    init {
        // 把底层事件转成全局事件发给 JS
        SocketHelper.onEvent = { name, payloadJson ->
            try {
                val map = JavaOnlyMap()
                map.putString("event", name)
                when (name) {
                    "message" -> map.putString("data", payloadJson)
                    else -> {
                        // payload 是 JSON 字符串，拆开塞进 map 便于 JS 直接读字段
                        try {
                            val obj = JSONObject(payloadJson)
                            val keys = obj.keys()
                            while (keys.hasNext()) {
                                val k = keys.next()
                                when (val v = obj.get(k)) {
                                    is Int -> map.putInt(k, v)
                                    is Long -> map.putDouble(k, v.toDouble())
                                    is Double -> map.putDouble(k, v)
                                    is Boolean -> map.putBoolean(k, v)
                                    else -> map.putString(k, v.toString())
                                }
                            }
                        } catch (_: Throwable) {
                            // payload 不是 JSON 就忽略，只要 event 名对
                        }
                    }
                }
                pub.lkz.chat.MainActivity.current?.sendSocketEvent(map)
            } catch (_: Throwable) {
                // 页面已销毁，丢弃
            }
        }
    }

    /**
     * 建立连接
     * @param optsJson {"url":"wss://...","headers":{"k":"v"}}
     */
    @LynxMethod
    fun connect(optsJson: String, callback: Callback) {
        val url: String
        val headers = mutableMapOf<String, String>()

        try {
            val o = JSONObject(optsJson)
            url = o.optString("url", "")
            o.optJSONObject("headers")?.let { h ->
                val keys = h.keys()
                while (keys.hasNext()) {
                    val k = keys.next()
                    headers[k] = h.optString(k, "")
                }
            }
        } catch (e: Throwable) {
            MediaBridge.fail(callback, "参数解析失败: ${e.message}")
            return
        }

        if (url.isEmpty()) {
            MediaBridge.fail(callback, "缺少 url")
            return
        }

        SocketHelper.connect(url, headers)
            .onSuccess { MediaBridge.ok(callback) }
            .onFailure { MediaBridge.fail(callback, it.message ?: "连接失败") }
    }

    /** 发送一帧文本 */
    @LynxMethod
    fun send(text: String, callback: Callback) {
        val sent = SocketHelper.send(text)
        MediaBridge.ok(callback, mapOf("sent" to sent))
    }

    /** 主动关闭 */
    @LynxMethod
    fun close(callback: Callback) {
        SocketHelper.close()
        MediaBridge.ok(callback)
    }

    /** 查询连接状态（同步语义，但要走回调，Lynx 方法必须回调） */
    @LynxMethod
    fun isConnected(callback: Callback) {
        callback.invoke(SocketHelper.isConnected())
    }
}
