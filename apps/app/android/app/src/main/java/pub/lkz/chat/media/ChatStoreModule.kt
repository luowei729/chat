package pub.lkz.chat.media

import android.content.Context
import com.lynx.jsbridge.LynxMethod
import com.lynx.jsbridge.LynxModule
import com.lynx.react.bridge.Callback
import com.lynx.react.bridge.JavaOnlyMap

/**
 * ============================================================
 * 键值存储原生模块（ChatStore）
 * ============================================================
 * 为什么需要它：
 * Lynx 引擎**没有提供** Storage API（types 包里搜不到
 * setStorageItem / getStorageItem），前端 storage.ts 里那些
 * `lynx.setStorageItem` 调用全是空转 —— 令牌只存在内存里，
 * App 一重启就要重新登录。
 *
 * 实现选 SharedPreferences：
 *   - 同步读写、无依赖、进程内安全；
 *   - 数据量小（令牌、主题、草稿），不需要数据库。
 *
 * 接口设计：
 *   - setItem / removeItem：无回调，fire-and-forget（写入即生效于内存缓存）；
 *   - getItem：单键读，回调返回字符串（不存在返回空串）；
 *   - dump：一次性把全部键值读给 JS，前端启动时用它预热内存缓存，
 *           这样后续所有同步读都不用等原生。
 *
 * 各端对照实现：
 *   iOS      → NSUserDefaults
 *   HarmonyOS → preferences
 *   Win/mac  → localStorage
 * ============================================================
 */
class ChatStoreModule : LynxModule {

    constructor(context: Context) : super(context)

    constructor(context: Context, param: Any?) : super(context, param)

    private val prefs by lazy {
        mContext.getSharedPreferences("chat_store", Context.MODE_PRIVATE)
    }

    /** 写入（无回调：调用方不等结果，UI 不应因存储阻塞） */
    @LynxMethod
    fun setItem(key: String, value: String) {
        try {
            prefs.edit().putString(key, value).apply()
        } catch (_: Throwable) {
            // 磁盘满等极端情况，静默失败即可，不能影响业务流程
        }
    }

    /** 删除 */
    @LynxMethod
    fun removeItem(key: String) {
        try {
            prefs.edit().remove(key).apply()
        } catch (_: Throwable) {
        }
    }

    /** 单键读取：不存在时返回空串，前端把空串当 null */
    @LynxMethod
    fun getItem(key: String, callback: Callback) {
        val v = try {
            prefs.getString(key, "") ?: ""
        } catch (_: Throwable) {
            ""
        }
        callback.invoke(v)
    }

    /**
     * 全量导出
     * 返回 JavaOnlyMap（Lynx 桥接层能直接序列化成 JS 对象），
     * 前端在启动时预热缓存，避免逐个 key 异步读取。
     */
    @LynxMethod
    fun dump(callback: Callback) {
        val map = JavaOnlyMap()
        try {
            for ((k, v) in prefs.all) {
                if (k != null && v is String) map.putString(k, v)
            }
        } catch (_: Throwable) {
        }
        callback.invoke(map)
    }
}
