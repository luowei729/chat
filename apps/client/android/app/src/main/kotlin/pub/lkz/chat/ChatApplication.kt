package pub.lkz.chat

import android.app.Application

/**
 * 应用级入口
 * ============================================================
 * 为什么推送必须在 Application 里初始化，而不是 MainActivity：
 *
 * 用户被杀进程后点通知栏进入 App 时，启动顺序是
 *   Application.onCreate → 推送 Service/Receiver → MainActivity.onCreate
 *
 * 如果 MobSDK 等到 MainActivity 才 init，那么 Receiver 先收到消息时
 * SDK 还没准备好，通知点进来的 conversationId 会被直接丢掉，
 * 表现为「点通知只是打开了首页，没进对应会话」。
 *
 * 放在 Application 里可以保证任何入口（冷启动 / 点击通知 / 后台唤醒）
 * 都先完成 SDK 初始化。
 */
class ChatApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        PushBridge.init(this)
    }
}
