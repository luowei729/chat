package pub.lkz.chat.media

import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * ============================================================
 * WebSocket 客户端（OkHttp）
 * ============================================================
 * 【为什么必须自己实现】
 * Lynx 引擎**不提供 WebSocket**：
 *   - `lynx-service-http` 里只有 LynxHttpService（HTTP），
 *     整个 aar 只有 4 个 class，没有任何 socket 相关实现；
 *   - 前端 `new WebSocket(url)` 不会抛异常，但 onopen 永远不触发，
 *     也没有错误日志 —— 这是最坑的一类失败。
 *
 * 后果（用户能感知的全部症状）：
 *   · 对方发来消息，自己端不刷新 →「消息没有立即推送」
 *   · 点语音通话，对方毫无反应 →「打电话没反应」
 *   · 未读红点不实时增长
 *   这些其实都是同一个根因：WS 从来没连上过。
 *
 * 【设计】
 *   - OkHttp 的 WebSocket：与项目已有的网络栈一致，支持 wss；
 *   - 事件（open/message/closed/failure）通过全局事件推给 JS，
 *     而不是 Callback（Callback 一次性，见 ChatMedia 的教训）；
 *   - 心跳由 JS 侧驱动（它已有 25s ping 逻辑），原生不重复实现；
 *   - 断线重连由 JS 侧调度，原生只负责「如实上报关闭原因」。
 *
 * 各端对照：
 *   iOS       → NSURLSessionWebSocketTask
 *   HarmonyOS → @ohos.net.webSocket
 *   Win/mac   → 浏览器原生 WebSocket（无需实现）
 * ============================================================
 */
object SocketHelper {

    private var client: OkHttpClient? = null
    private var socket: WebSocket? = null
    private val connected = AtomicBoolean(false)
    private val main = Handler(Looper.getMainLooper())

    /** 事件回调：由 ChatSocketModule 注入，负责转成全局事件 */
    var onEvent: ((name: String, payloadJson: String) -> Unit)? = null

    /**
     * 建立连接
     * @param url wss://... 地址
     * @param headers 额外请求头（目前不用，保留给未来的 token 头鉴权）
     */
    fun connect(url: String, headers: Map<String, String>): Result<Unit> {
        close()

        return try {
            val c = OkHttpClient.Builder()
                // WebSocket 是长连接，读超时必须给足或干脆不限
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .pingInterval(0, TimeUnit.MILLISECONDS) // 心跳交给 JS
                .connectTimeout(15, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true)
                .build()
            client = c

            val builder = Request.Builder().url(url)
            for ((k, v) in headers) builder.header(k, v)

            val ws = c.newWebSocket(
                builder.build(),
                object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        connected.set(true)
                        emit("open", "{}")
                    }

                    override fun onMessage(webSocket: WebSocket, text: String) {
                        // 原样透传，解析交给 JS（协议全在 TS 里定义）
                        emit("message", text)
                    }

                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                        connected.set(false)
                        webSocket.close(1000, null)
                        emit("closed", """{"code":$code,"reason":${jsonStr(reason)}}""")
                    }

                    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                        connected.set(false)
                        emit("closed", """{"code":$code,"reason":${jsonStr(reason)}}""")
                    }

                    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                        connected.set(false)
                        val msg = t.message ?: t.javaClass.simpleName
                        emit(
                            "failure",
                            """{"message":${jsonStr(msg)},"status":${response?.code ?: 0}}""",
                        )
                    }
                },
            )

            socket = ws
            Result.success(Unit)
        } catch (e: Throwable) {
            Result.failure(e)
        }
    }

    /** 发送一帧文本；返回 false 表示当前不可发（未连接） */
    fun send(text: String): Boolean {
        val ws = socket ?: return false
        if (!connected.get()) return false
        return try {
            ws.send(text)
        } catch (_: Throwable) {
            false
        }
    }

    /** 主动关闭 */
    fun close() {
        val ws = socket
        socket = null
        connected.set(false)
        if (ws != null) {
            try {
                ws.close(1000, "client close")
            } catch (_: Throwable) {
            }
        }
        try {
            client?.dispatcher?.executorService?.shutdown()
        } catch (_: Throwable) {
        }
        client = null
    }

    fun isConnected(): Boolean = connected.get()

    /**
     * 事件外发
     * OkHttp 的回调在网络线程，切到主线程再发事件，
     * 避免 Lynx 在非指定线程被调用（某些版本会崩）。
     */
    private fun emit(name: String, payloadJson: String) {
        val cb = onEvent ?: return
        main.post { cb(name, payloadJson) }
    }

    /** 极简 JSON 字符串转义（避免为一行转义引入依赖） */
    private fun jsonStr(s: String): String {
        val sb = StringBuilder("\"")
        for (ch in s) {
            when (ch) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (ch < ' ') sb.append("\\u%04x".format(ch.code)) else sb.append(ch)
            }
        }
        return sb.append('"').toString()
    }
}
