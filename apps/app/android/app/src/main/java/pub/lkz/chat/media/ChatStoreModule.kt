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

    /**
     * 写入
     * ------------------------------------------------------------
     * 用 commit() 而不是 apply()：
     * apply() 是纯异步落盘，令牌刚写入时用户立刻划掉 App，
     * 进程被系统回收，数据就丢了 —— 表现就是「退出后登录失效」。
     * 存储的都是小字段（令牌、主题），commit 的同步开销可以忽略。
     * 仍然放在后台线程执行（LynxModule 本身就在后台线程），不卡 UI。
     */
    @LynxMethod
    fun setItem(key: String, value: String) {
        try {
            prefs.edit().putString(key, value).commit()
        } catch (_: Throwable) {
            // 磁盘满等极端情况，静默失败即可，不能影响业务流程
        }
    }

    /** 删除 */
    @LynxMethod
    fun removeItem(key: String) {
        try {
            prefs.edit().remove(key).commit()
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
     * 全量导出（返回 JSON 字符串）
     * ------------------------------------------------------------
     * 为什么不用 JavaOnlyMap：
     * JavaOnlyMap 跨 JNI → JS 的转换在不同 ROM / 不同 Lynx 版本上
     * 表现不一致，真机上出现过「回调收到了但 JS 侧拿到空对象」，
     * 结果就是启动时读不到令牌、被判定为未登录。
     *
     * 字符串是桥接层最稳的类型（必然按原样传递），
     * 由 JS 侧 JSON.parse 还原，代价可忽略（只有几个键）。
     */
    @LynxMethod
    fun dump(callback: Callback) {
        val json = try {
            val obj = org.json.JSONObject()
            for ((k, v) in prefs.all) {
                if (k != null && v is String && v.isNotEmpty()) {
                    obj.put(k, v)
                }
            }
            obj.toString()
        } catch (_: Throwable) {
            "{}"
        }
        callback.invoke(json)
    }

    /** 键数量，前端可用于判断存储是否真的写进去了（诊断用） */
    @LynxMethod
    fun count(callback: Callback) {
        val n = try {
            prefs.all.size
        } catch (_: Throwable) {
            0
        }
        callback.invoke(n)
    }
}
