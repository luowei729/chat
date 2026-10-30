package pub.lkz.chat.media

import android.content.Context
import pub.lkz.chat.ChatApplication

/**
 * 极简应用上下文持有者
 * ============================================================
 * LynxModule 在部分调用时机拿到的 Context 可能不是 Application，
 * 而查询 ContentResolver、取 filesDir 只需要 Application 上下文。
 * 集中在这里取一次，避免每个工具类都传参。
 *
 * 注意：ChatApplication.instance 是 lateinit，未初始化时访问会
 * 抛 UninitializedPropertyAccessException，所以必须 try/catch，
 * 不能直接判断 != null。
 * ============================================================
 */
object AppContext {
    fun get(): Context? {
        return try {
            ChatApplication.instance
        } catch (_: Throwable) {
            null
        }
    }
}
