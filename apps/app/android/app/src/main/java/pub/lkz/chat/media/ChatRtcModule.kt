package pub.lkz.chat.media

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioManager
import androidx.core.content.ContextCompat
import com.lynx.jsbridge.LynxMethod
import com.lynx.jsbridge.LynxModule
import com.lynx.react.bridge.Callback
import com.lynx.react.bridge.JavaOnlyMap
import org.json.JSONObject
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import pub.lkz.chat.ChatApplication
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * ============================================================
 * 语音通话原生桥（ChatRtc）
 * ============================================================
 * 为什么必须有它：
 *   Lynx 引擎没有 WebRTC 实现，前端 engine.ts 的 registerWebRtc()
 *   只在浏览器/Chromium 里能注册成功（globalThis.RTCPeerConnection）。
 *   在 Android 原生端 rtcProvider 恒为 null，
 *   startLocalAudio() 直接返回 false，表现为：
 *     · 主叫：一直「正在呼叫…」，对方永远收不到实质媒体
 *     · 被叫：点「接听」弹「当前设备不支持语音通话」
 *   —— 这就是「语音通话没反应」的根因。
 *
 * 设计（与 ChatSocket 同哲学：原生只做能力原子）：
 *   - PeerConnection 的多对象状态全部按 peerId 建索引，
 *     方法签名只用 String / Boolean / Callback，
 *     复杂结构（SDP / ICE / iceServers）走 JSON 字符串；
 *   - 异步事件（远端 ICE / 连接状态）走全局事件 'chatRtc'，
 *     不用 Callback（一次性，收第二次就丢）；
 *   - 远端音频由 WebRTC 的 AudioDeviceModule 自动播放，
 *     无需 JS 干预；静音只开关本地轨道。
 *
 * 前端契约（见 src/rtc/engine.ts registerNativeRtc）：
 *   ensureAudio(cb)                          → {ok:true} / {ok:false,message,code}
 *   createPeer(peerId, iceJson, cb)          → {ok:true}
 *   createOffer(peerId, cb)                  → {ok:true,type,sdp}
 *   setLocal(peerId, descJson, cb)           → {ok:true}
 *   setRemote(peerId, descJson, cb)          → {ok:true}
 *   createAnswer(peerId, cb)                 → {ok:true,type,sdp}
 *   addIce(peerId, candJson, cb)             → {ok:true}
 *   setMuted(muted, cb)                      → {ok:true,muted}
 *   disposePeer(peerId, cb)                  → {ok:true}
 *   disposeAll(cb)                           → {ok:true}
 *
 * 全局事件 'chatRtc'（JavaOnlyMap）：
 *   {event:'ice', peerId, sdp, sdpMLineIndex, sdpMid}
 *   {event:'conn', peerId, state}
 * ============================================================
 */
class ChatRtcModule : LynxModule {

    constructor(context: Context) : super(context)
    constructor(context: Context, param: Any?) : super(context, param)

    companion object {
        private const val TAG = "ChatRtc"
        private const val AUDIO_TRACK_ID = "ARDAMSa0"
        private const val STREAM_ID = "ARDAMS"

        /** WebRTC 操作必须在同一线程：信令/媒体状态机不是线程安全的 */
        private val rtcThread = Executors.newSingleThreadExecutor { r ->
            Thread(r, "chat-rtc").apply { isDaemon = true }
        }

        private var audioSource: AudioSource? = null
        private var localTrack: AudioTrack? = null

        private data class RtcPeer(
            val pc: PeerConnection,
        )

        private val peers = ConcurrentHashMap<String, RtcPeer>()

        private fun log(msg: String) {
            android.util.Log.i(TAG, msg)
        }

        private fun emitEvent(map: JavaOnlyMap) {
            try {
                pub.lkz.chat.MainActivity.current?.sendRtcEvent(map)
            } catch (_: Throwable) {
            }
        }

        private fun emitIce(peerId: String, c: IceCandidate) {
            val map = JavaOnlyMap()
            map.putString("event", "ice")
            map.putString("peerId", peerId)
            map.putString("sdp", c.sdp)
            map.putInt("sdpMLineIndex", c.sdpMLineIndex)
            map.putString("sdpMid", c.sdpMid ?: "")
            emitEvent(map)
        }

        private fun emitConn(peerId: String, state: String) {
            val map = JavaOnlyMap()
            map.putString("event", "conn")
            map.putString("peerId", peerId)
            map.putString("state", state)
            emitEvent(map)
        }
    }

    /* ---------------- 本地麦克风 ---------------- */

    /**
     * 准备本地音频（幂等，可重复调用）
     * 必须在用户手势（接听/呼叫）后调用，权限在 App 启动时已申请。
     */
    @LynxMethod
    fun ensureAudio(callback: Callback) {
        val ctx = AppContext.get()
        if (ctx == null) {
            MediaBridge.fail(callback, "上下文丢失")
            return
        }
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            val m = JavaOnlyMap()
            m.putBoolean("ok", false)
            m.putString("code", "no-permission")
            m.putString("message", "需要麦克风权限，请在系统设置中开启后重试")
            callback.invoke(m)
            return
        }
        val factory = ChatApplication.peerConnectionFactory
        if (factory == null) {
            MediaBridge.fail(callback, "通话组件初始化中，请稍后重试")
            return
        }
        rtcThread.execute {
            try {
                if (localTrack == null) {
                    val constraints = MediaConstraints().apply {
                        optional.add(MediaConstraints.KeyValuePair("googEchoCancellation", "true"))
                        optional.add(MediaConstraints.KeyValuePair("googNoiseSuppression", "true"))
                        optional.add(MediaConstraints.KeyValuePair("googAutoGainControl", "true"))
                    }
                    audioSource = factory.createAudioSource(constraints)
                    localTrack = factory.createAudioTrack(AUDIO_TRACK_ID, audioSource)
                    log("本地音频轨道已创建")
                }
                localTrack?.setEnabled(true)
                // 通话音量模式：回声消除 + 听筒/扬声器按系统路由
                try {
                    val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
                    am.mode = AudioManager.MODE_IN_COMMUNICATION
                } catch (_: Throwable) {
                }
                MediaBridge.ok(callback)
            } catch (e: Throwable) {
                android.util.Log.e(TAG, "ensureAudio 失败", e)
                MediaBridge.fail(callback, e.message ?: "无法启动麦克风")
            }
        }
    }

    /* ---------------- PeerConnection ---------------- */

    /** iceJson: {"iceServers":[{"urls":[...]|"url","username":?,"credential":?}]} */
    @LynxMethod
    fun createPeer(peerId: String, iceJson: String, callback: Callback) {
        val factory = ChatApplication.peerConnectionFactory
        if (factory == null) {
            MediaBridge.fail(callback, "通话组件初始化中，请稍后重试")
            return
        }
        rtcThread.execute {
            try {
                peers[peerId]?.pc?.close()
                peers.remove(peerId)

                val servers = parseIceServers(iceJson)
                val config = PeerConnection.RTCConfiguration(servers).apply {
                    sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
                }
                val observer = object : PeerConnection.Observer {
                    override fun onIceCandidate(c: IceCandidate) {
                        emitIce(peerId, c)
                    }
                    override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
                        emitConn(peerId, newState.name.lowercase())
                    }
                    override fun onIceConnectionChange(s: PeerConnection.IceConnectionState) {
                        log("ice $peerId -> $s")
                    }
                    override fun onSignalingChange(s: PeerConnection.SignalingState) {}
                    override fun onIceConnectionReceivingChange(b: Boolean) {}
                    override fun onIceGatheringChange(s: PeerConnection.IceGatheringState) {}
                    override fun onAddStream(s: org.webrtc.MediaStream) {}
                    override fun onRemoveStream(s: org.webrtc.MediaStream) {}
                    override fun onDataChannel(d: org.webrtc.DataChannel) {}
                    override fun onRenegotiationNeeded() {}
                    override fun onAddTrack(r: org.webrtc.RtpReceiver, s: Array<out org.webrtc.MediaStream>) {
                        // 远端音频由 AudioDeviceModule 自动播放，这里只上报状态
                        emitConn(peerId, "track")
                    }
                }
                val pc = factory.createPeerConnection(config, observer)
                if (pc == null) {
                    MediaBridge.fail(callback, "创建通话连接失败")
                    return@execute
                }
                localTrack?.let { pc.addTrack(it, listOf(STREAM_ID)) }
                peers[peerId] = RtcPeer(pc)
                log("peer 已创建: $peerId")
                MediaBridge.ok(callback)
            } catch (e: Throwable) {
                android.util.Log.e(TAG, "createPeer 失败", e)
                MediaBridge.fail(callback, e.message ?: "创建通话连接失败")
            }
        }
    }

    @LynxMethod
    fun createOffer(peerId: String, callback: Callback) {
        rtcThread.execute {
            val peer = peers[peerId]
            if (peer == null) {
                MediaBridge.fail(callback, "连接不存在，请重试")
                return@execute
            }
            try {
                peer.pc.createOffer(
                    object : SdpAdapter(callback) {
                        override fun onCreateSuccess(desc: SessionDescription) {
                            peer.pc.setLocalDescription(
                                object : SdpAdapter(null) {
                                    override fun onSetSuccess() {
                                        MediaBridge.ok(
                                            callback,
                                            mapOf("type" to desc.type.canonicalForm(), "sdp" to desc.description),
                                        )
                                    }
                                },
                                desc,
                            )
                        }
                    },
                    MediaConstraints(),
                )
            } catch (e: Throwable) {
                MediaBridge.fail(callback, e.message ?: "发起通话协商失败")
            }
        }
    }

    @LynxMethod
    fun setLocal(peerId: String, descJson: String, callback: Callback) {
        rtcThread.execute {
            val peer = peers[peerId]
            if (peer == null) {
                MediaBridge.fail(callback, "连接不存在，请重试")
                return@execute
            }
            try {
                val desc = parseSession(descJson) ?: run {
                    MediaBridge.fail(callback, "SDP 格式错误")
                    return@execute
                }
                peer.pc.setLocalDescription(
                    object : SdpAdapter(null) {
                        override fun onSetSuccess() {
                            MediaBridge.ok(callback)
                        }
                    },
                    desc,
                )
            } catch (e: Throwable) {
                MediaBridge.fail(callback, e.message ?: "设置本地描述失败")
            }
        }
    }

    @LynxMethod
    fun setRemote(peerId: String, descJson: String, callback: Callback) {
        rtcThread.execute {
            val peer = peers[peerId]
            if (peer == null) {
                MediaBridge.fail(callback, "连接不存在，请重试")
                return@execute
            }
            try {
                val desc = parseSession(descJson) ?: run {
                    MediaBridge.fail(callback, "SDP 格式错误")
                    return@execute
                }
                peer.pc.setRemoteDescription(
                    object : SdpAdapter(null) {
                        override fun onSetSuccess() {
                            MediaBridge.ok(callback)
                        }
                    },
                    desc,
                )
            } catch (e: Throwable) {
                MediaBridge.fail(callback, e.message ?: "设置远端描述失败")
            }
        }
    }

    @LynxMethod
    fun createAnswer(peerId: String, callback: Callback) {
        rtcThread.execute {
            val peer = peers[peerId]
            if (peer == null) {
                MediaBridge.fail(callback, "连接不存在，请重试")
                return@execute
            }
            try {
                peer.pc.createAnswer(
                    object : SdpAdapter(callback) {
                        override fun onCreateSuccess(desc: SessionDescription) {
                            peer.pc.setLocalDescription(
                                object : SdpAdapter(null) {
                                    override fun onSetSuccess() {
                                        MediaBridge.ok(
                                            callback,
                                            mapOf("type" to desc.type.canonicalForm(), "sdp" to desc.description),
                                        )
                                    }
                                },
                                desc,
                            )
                        }
                    },
                    MediaConstraints(),
                )
            } catch (e: Throwable) {
                MediaBridge.fail(callback, e.message ?: "应答通话协商失败")
            }
        }
    }

    /** candJson: {"sdp":...,"sdpMLineIndex":0,"sdpMid":"0"} */
    @LynxMethod
    fun addIce(peerId: String, candJson: String, callback: Callback) {
        rtcThread.execute {
            val peer = peers[peerId]
            if (peer == null) {
                // 候选先于连接到达很常见，直接忽略，ICE 会重传补齐
                MediaBridge.ok(callback)
                return@execute
            }
            try {
                val o = JSONObject(candJson)
                val cand = IceCandidate(
                    o.optString("sdpMid", "0"),
                    o.optInt("sdpMLineIndex", 0),
                    o.optString("sdp", ""),
                )
                peer.pc.addIceCandidate(cand)
                MediaBridge.ok(callback)
            } catch (e: Throwable) {
                MediaBridge.fail(callback, e.message ?: "添加网络候选失败")
            }
        }
    }

    /* ---------------- 通话控制 ---------------- */

    @LynxMethod
    fun setMuted(muted: Boolean, callback: Callback) {
        rtcThread.execute {
            try {
                localTrack?.setEnabled(!muted)
                MediaBridge.ok(callback, mapOf("muted" to muted))
            } catch (e: Throwable) {
                MediaBridge.fail(callback, e.message ?: "切换静音失败")
            }
        }
    }

    @LynxMethod
    fun disposePeer(peerId: String, callback: Callback) {
        rtcThread.execute {
            try {
                peers.remove(peerId)?.pc?.close()
                MediaBridge.ok(callback)
            } catch (e: Throwable) {
                MediaBridge.fail(callback, e.message ?: "释放连接失败")
            }
        }
    }

    @LynxMethod
    fun disposeAll(callback: Callback) {
        rtcThread.execute {
            try {
                for ((_, p) in peers) {
                    try {
                        p.pc.close()
                    } catch (_: Throwable) {
                    }
                }
                peers.clear()
                try {
                    localTrack?.setEnabled(false)
                } catch (_: Throwable) {
                }
                try {
                    val ctx = AppContext.get()
                    val am = ctx?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
                    am?.mode = AudioManager.MODE_NORMAL
                } catch (_: Throwable) {
                }
                MediaBridge.ok(callback)
            } catch (e: Throwable) {
                MediaBridge.fail(callback, e.message ?: "结束通话失败")
            }
        }
    }

    /* ---------------- 内部工具 ---------------- */

    private open class SdpAdapter(private val callback: Callback?) : SdpObserver {
        override fun onCreateSuccess(desc: SessionDescription) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(msg: String) {
            callback?.let { MediaBridge.fail(it, msg.ifEmpty { "SDP 协商失败" }) }
        }
        override fun onSetFailure(msg: String) {
            callback?.let { MediaBridge.fail(it, msg.ifEmpty { "SDP 应用失败" }) }
        }
    }

    private fun parseIceServers(iceJson: String): List<PeerConnection.IceServer> {
        val out = ArrayList<PeerConnection.IceServer>()
        try {
            val root = JSONObject(iceJson)
            val arr = root.optJSONArray("iceServers") ?: return out
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val urls = ArrayList<String>()
                // 兼容 urls 数组 / urls 字符串 / url 字符串三种写法
                val arrUrls = o.optJSONArray("urls")
                if (arrUrls != null) {
                    for (j in 0 until arrUrls.length()) urls.add(arrUrls.optString(j))
                } else {
                    val single = o.optString("urls", o.optString("url", ""))
                    if (single.isNotEmpty()) urls.add(single)
                }
                if (urls.isEmpty()) continue
                val username = o.optString("username", "")
                val credential = o.optString("credential", "")
                val builder = PeerConnection.IceServer.builder(urls)
                if (username.isNotEmpty()) builder.setUsername(username)
                if (credential.isNotEmpty()) builder.setPassword(credential)
                out.add(builder.createIceServer())
            }
        } catch (e: Throwable) {
            android.util.Log.w(TAG, "ICE 解析失败，用空列表: ${e.message}")
        }
        return out
    }

    private fun parseSession(descJson: String): SessionDescription? {
        return try {
            val o = JSONObject(descJson)
            val type = SessionDescription.Type.fromCanonicalForm(o.optString("type", "offer"))
            SessionDescription(type, o.optString("sdp", ""))
        } catch (_: Throwable) {
            null
        }
    }
}
