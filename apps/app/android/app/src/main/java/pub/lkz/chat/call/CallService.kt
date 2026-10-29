package pub.lkz.chat.call

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import pub.lkz.chat.MainActivity
import pub.lkz.chat.R

/**
 * ============================================================
 * 通话前台服务（锁屏不断线的关键）
 * ============================================================
 * 为什么必须有它：
 * Android 8+ 之后，App 切到后台约 1 分钟就会被系统冻结，
 * WebRTC 的音频采集与网络连接会中断。只有前台服务能让
 * 进程在后台保持运行，从而支撑「锁屏通话」。
 *
 * Android 版本差异（必须逐版本处理，否则崩溃）：
 *   API 26+  必须创建 NotificationChannel
 *   API 29+  startForeground 支持第三个参数（服务类型）
 *   API 30+  才有 FOREGROUND_SERVICE_TYPE_MICROPHONE 常量
 *   API 34+  必须在清单声明 foregroundServiceType 且持有对应权限
 *
 * 使用流程：
 *   ChatHostModule.startCallService()  -> startForegroundService
 *   ChatHostModule.stopCallService()   -> stopSelf
 * ============================================================
 */
class CallService : Service() {

    companion object {
        private const val CHANNEL_ID = "chat_call"
        private const val NOTIFICATION_ID = 2001

        /**
         * 通话中继类型：麦克风
         * 说明：API 30 才有这个常量，所以用局部常量避免
         *      在低版本设备上引用不存在的字段（NoSuchFieldError）。
         */
        private const val TYPE_MICROPHONE = 0x00000080

        /** 通话开始：启动前台服务 */
        fun start(context: Context) {
            val intent = Intent(context, CallService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        /** 通话结束：停止服务 */
        fun stop(context: Context) {
            context.stopService(Intent(context, CallService::class.java))
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 必须在 5 秒内调用 startForeground，否则系统抛 ANR
        val notification = buildNotification()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // API 30+：可以声明服务类型，Android 14 起必须
            startForeground(NOTIFICATION_ID, notification, TYPE_MICROPHONE)
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // API 29：三参数重载存在，但麦克风类型常量还没有，
            // 传 0 表示不限定类型（系统按清单声明处理）
            startForeground(NOTIFICATION_ID, notification, 0)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        // 被系统杀掉后不自动重启：通话已中断，重启也无意义
        return START_NOT_STICKY
    }

    /** 创建通知渠道（Android 8+ 必须） */
    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val channel = NotificationChannel(
            CHANNEL_ID,
            "语音通话",
            // HIGH：通话通知必须能响铃与弹窗
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "通话进行中的常驻通知"
            setShowBadge(false)
            enableVibration(false)
        }

        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(channel)
    }

    /** 构建常驻通知：点击可回到通话界面 */
    private fun buildNotification(): Notification {
        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            // Android 12+ 必须指定 FLAG_IMMUTABLE
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("正在通话")
            .setContentText("点击返回通话界面")
            .setSmallIcon(R.drawable.ic_call)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            // 通话中不显示时间戳，避免误解为通话时长
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .build()
    }

    override fun onDestroy() {
        super.onDestroy()
        // 移除常驻通知
        val manager = getSystemService(NotificationManager::class.java)
        manager.cancel(NOTIFICATION_ID)
    }
}
