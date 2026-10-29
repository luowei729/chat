package pub.lkz.chat.call

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import pub.lkz.chat.MainActivity
import pub.lkz.chat.R

/**
 * ============================================================
 * 通话前台服务（锁屏不断线的关键）
 * ------------------------------------------------------------
 * 为什么必须有它：
 * Android 8+ 之后，App 切到后台约 1 分钟就会被系统冻结，
 * WebRTC 的音频采集与网络连接会中断。只有前台服务能让
 * 进程在后台保持运行，从而支撑「锁屏通话」。
 *
 * Android 14 强制要求：
 * - 必须声明 foregroundServiceType="microphone"
 * - 必须持有 RECORD_AUDIO 与 FOREGROUND_SERVICE_MICROPHONE 权限
 * - 启动服务时必须在 5 秒内调用 startForeground
 *
 * 使用流程：
 *   onCallStarted() → startForegroundService
 *   onCallEnded()   → stopSelf
 * ============================================================
 */
class CallService : Service() {

    companion object {
        private const val CHANNEL_ID = "chat_call"
        private const val NOTIFICATION_ID = 2001

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
        // 必须在 5 秒内调用，否则系统抛异常
        val notification = buildNotification()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            )
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
