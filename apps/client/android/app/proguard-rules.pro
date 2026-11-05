# ============================================================
# R8 / ProGuard 规则
# ------------------------------------------------------------
# 目前只有 MobPush 需要特殊处理。
#
# 为什么必须加：MobPush 是一个「聚合」SDK，它把华为 / 小米 / OPPO /
# vivo / 魅族的适配代码都编进同一个 AAR，但**不依赖**各家 SDK。
# 运行时靠反射判断设备品牌，只有对应厂商的类存在才启用那条通道。
#
# 结果就是编译期 R8 能看到大量「引用但不存在的类」，
# 在 AGP 8 的严格模式下直接判为错误：
#   Missing class com.vivo.push.PushClient ...
#   Missing class com.xiaomi.mipush.sdk.MiPushClient ...
#
# 这些类在真机上由厂商 SDK 或 Mob 的动态下发补齐，
# 所以正确做法是 dontwarn 掉，而不是把厂商 SDK 全引进来。
# ============================================================

# MobPush / MobTools / MobCommons
-dontwarn com.mob.**
-keep class com.mob.** { *; }
-keep interface com.mob.** { *; }

# 厂商通道（Mob 内部反射调用，缺失属正常）
-dontwarn com.huawei.**
-dontwarn com.hihonor.**
-dontwarn com.xiaomi.**
-dontwarn com.oppo.**
-dontwarn com.heytap.**
-dontwarn com.vivo.**
-dontwarn com.meizu.**
-dontwarn com.google.firebase.**
-dontwarn com.google.android.gms.**

# Kotlin 元数据（部分反射用到）
-dontwarn kotlin.**
-dontwarn kotlinx.**

# Flutter 引擎的 deferred components（我们没用 Play 特性分发，类不存在是正常的）
-dontwarn com.google.android.play.core.**

# Flutter 引擎
-keep class io.flutter.** { *; }
