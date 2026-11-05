package pub.lkz.chat

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import com.mob.MobSDK
import com.mob.pushsdk.MobPush
import com.mob.pushsdk.MobPushCallback
import com.mob.pushsdk.MobPushCustomMessage
import com.mob.pushsdk.MobPushNotifyMessage
import com.mob.pushsdk.MobPushReceiver
import io.flutter.plugin.common.MethodChannel

/**
 * MobPush 桥
 * ============================================================
 * 职责：
 *   1. 初始化 MobSDK / MobPush
 *   2. 把 registrationId 交给 Dart 上报服务端
 *   3. 通知栏点击 → 带回 conversationId / callId，让 Dart 跳页
 *
 * 为什么必须在 Application 里初始化：
 *   MobPush 的本地长连接进程与 App 主进程是同一个。
 *   如果只在 Activity 里初始化，用户从通知栏冷启动（进程被杀后重建）
 *   时 Activity 还没起来，推送消息会先到 Receiver——
 *   此时 SDK 未初始化，消息直接丢失，表现为「点通知没反应」。
 *
 * 隐私合规：
 *   MobSDK 强制要求调用 submitPolicyGrantResult 明确表达「用户已同意隐私政策」，
 *   否则 SDK 会一直停在 GPP 等待状态，getRegistrationId 永远返回 null。
 *   本产品没有独立的隐私弹窗（登录即表示同意），所以在 init 后立即授权。
 */
object PushBridge {

    private const val TAG = "PushBridge"

    /** Mob 控制台申请，客户端只需 AppKey */
    private const val APP_KEY = "3d9553d870c03"

    /**
     * 为什么客户端只传 AppKey、不带 AppSecret
     * ------------------------------------------------------------
     * MobPush 的 registrationId 取号只依赖 AppKey；
     * AppSecret 只用于**服务端** REST 接口签名（sign = md5(appKey + appSecret)）。
     *
     * 把 Secret 打进 APK 有两个实际坏处：
     *   1. 任何人反编译都能拿到，等于公开；
     *   2. 一旦在控制台轮换 Secret，旧客户端会连不上，必须重新发版。
     * 所以这里用两参数 init，Secret 只存在于服务端环境变量。
     */

    /** 通知渠道 id：Android 8+ 必须自建渠道，否则通知不显示 */
    const val CHANNEL_ID = "chat_push"

    @Volatile
    private var initialized = false

    /** Dart 侧通道，切到后台时会置空 */
    @Volatile
    private var channel: MethodChannel? = null

    /** 最近一次拿到的 registrationId，Dart 连上来时直接给 */
    @Volatile
    private var registrationId: String? = null

    /** 服务端需要按 conversationId 跳转，缓存下来等 Dart 就绪 */
    @Volatile
    private var pendingConversationId: String? = null

    @Volatile
    private var pendingCallId: String? = null

    fun attach(channel: MethodChannel) {
        this.channel = channel
    }

    fun detach(channel: MethodChannel) {
        if (this.channel === channel) this.channel = null
    }

    /* ------------------------------------------------------------------ */
    /* 初始化                                                              */
    /* ------------------------------------------------------------------ */

    fun init(app: Application) {
        if (initialized) return
        initialized = true

        createNotificationChannel(app)

        try {
            // 声明这是 Flutter 宿主，Mob 后台会按渠道统计
            MobSDK.setChannel(MobProductTag(), MobSDK.CHANNEL_FLUTTER)
        } catch (t: Throwable) {
            Log.w(TAG, "setChannel 失败（忽略）", t)
        }

        try {
            MobSDK.init(app, APP_KEY)
            // 立即表达隐私授权，否则 SDK 停在 GPP 状态不工作
            MobSDK.submitPolicyGrantResult(true, null)
        } catch (t: Throwable) {
            Log.e(TAG, "MobSDK.init 失败", t)
        }

        try {
            MobPush.initMobPush()
            // 点击通知时拉起已存在的 MainActivity，而不是新建一个
            MobPush.setClickNotificationToLaunchMainActivity(true)
            MobPush.setNotifyIcon(R.mipmap.ic_launcher)
        } catch (t: Throwable) {
            Log.e(TAG, "MobPush.initMobPush 失败", t)
        }

        // 监听消息：自定义消息（透传）与通知点击都要回到 Dart
        MobPush.addPushReceiver(object : MobPushReceiver {
            override fun onCustomMessageReceive(
                context: Context?,
                message: MobPushCustomMessage?,
            ) {
                Log.d(TAG, "透传消息: ${message?.content}")
            }

            override fun onNotifyMessageReceive(
                context: Context?,
                message: MobPushNotifyMessage?,
            ) {
                Log.d(TAG, "收到通知: ${message?.title}")
            }

            override fun onNotifyMessageOpenedReceive(
                context: Context?,
                message: MobPushNotifyMessage?,
            ) {
                // 点击通知：Mob 会把业务字段放在 extras 里
                val extras = message?.extrasMap
                val conv = extras?.get("conversationId")
                val call = extras?.get("callId")
                deliverClick(conv, call)
            }

            override fun onTagsCallback(
                context: Context?,
                tags: Array<out String>?,
                action: Int,
                resultCode: Int,
            ) = Unit

            override fun onAliasCallback(
                context: Context?,
                alias: String?,
                action: Int,
                resultCode: Int,
            ) = Unit
        })

        refreshRegistrationId()
    }

    /** 主动拉一次 registrationId（异步，可能稍后才拿到） */
    private fun refreshRegistrationId() {
        try {
            MobPush.getRegistrationId(object : MobPushCallback<String> {
                override fun onCallback(id: String?) {
                    if (!id.isNullOrEmpty()) {
                        registrationId = id
                        Log.i(TAG, "registrationId = $id")
                        channel?.let { ch ->
                            MainHandler.post {
                                ch.invokeMethod("onPushToken", id)
                            }
                        }
                    } else {
                        Log.w(TAG, "registrationId 为空（未联网或厂商通道未配置）")
                    }
                }
            })
        } catch (t: Throwable) {
            Log.e(TAG, "getRegistrationId 失败", t)
        }
    }

    /* ------------------------------------------------------------------ */
    /* 通知点击                                                            */
    /* ------------------------------------------------------------------ */

    /** 处理来自 Intent 的跳转参数（冷启动场景） */
    fun handleIntent(intent: Intent?) {
        val i = intent ?: return
        deliverClick(
            i.getStringExtra("conversationId"),
            i.getStringExtra("callId"),
        )
    }

    private fun deliverClick(conversationId: String?, callId: String?) {
        if (conversationId.isNullOrEmpty() && callId.isNullOrEmpty()) return
        pendingConversationId = conversationId
        pendingCallId = callId
        val ch = channel
        if (ch == null) {
            // Dart 还没就绪，等 consumePendingClick 来取
            return
        }
        MainHandler.post {
            ch.invokeMethod(
                "onNotificationClick",
                mapOf("conversationId" to conversationId, "callId" to callId),
            )
        }
        pendingConversationId = null
        pendingCallId = null
    }

    /** Dart 首帧后调用一次，取走「App 被杀期间」积压的点击事件 */
    fun consumePendingClick(): Map<String, String?>? {
        val conv = pendingConversationId
        val call = pendingCallId
        if (conv.isNullOrEmpty() && call.isNullOrEmpty()) return null
        pendingConversationId = null
        pendingCallId = null
        return mapOf("conversationId" to conv, "callId" to call)
    }

    /* ------------------------------------------------------------------ */
    /* 其他查询                                                            */
    /* ------------------------------------------------------------------ */

    fun getToken(): String? {
        if (registrationId.isNullOrEmpty()) refreshRegistrationId()
        return registrationId
    }

    /** 通知权限是否开启（Android 13+ 需要运行时授权） */
    fun notificationsEnabled(context: Context): Boolean {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            ?: return false
        return nm.areNotificationsEnabled()
    }

    fun openNotificationSettings(context: Context) {
        try {
            val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                    putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                }
            } else {
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.parse("package:${context.packageName}")
                }
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
        } catch (_: Throwable) {
        }
    }

    private fun createNotificationChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            ?: return
        val existing = nm.getNotificationChannel(CHANNEL_ID)
        if (existing != null) return
        val ch = NotificationChannel(
            CHANNEL_ID,
            "消息通知",
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "新消息与语音来电提醒"
            enableVibration(true)
            enableLights(true)
            setShowBadge(true)
        }
        nm.createNotificationChannel(ch)
    }
}

/**
 * Mob 的 setChannel 需要一个 MobProduct 实现，
 * 目的是让 Mob 后台能把数据归属到「Flutter 渠道」。
 */
private class MobProductTag : com.mob.commons.MobProduct {
    override fun getProductTag(): String = "flutter"
    override fun getSdkver(): Int = 1
}

/** 简易主线程投递（避免额外依赖 Handler 的 Looper 检查） */
private object MainHandler {
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    fun post(block: () -> Unit) = handler.post(block)
}
