# ============================================================
# ProGuard 规则
# ------------------------------------------------------------
# Lynx 与 WebRTC 大量使用反射与 JNI，必须保留类名与成员，
# 否则 release 包会在运行时崩溃（debug 包不会暴露这个问题）。
# ============================================================

# ---------- Lynx ----------
-keep class com.lynx.** { *; }
-keep interface com.lynx.** { *; }
-keep class org.lynxsdk.** { *; }
-dontwarn com.lynx.**

# Lynx 的 native 方法与 JNI 回调
-keepclasseswithmembernames class * {
    native <methods>;
}

# Lynx 通过反射创建的自定义组件
-keep public class * extends com.lynx.tasm.behavior.ui.LynxUI
-keep public class * extends com.lynx.tasm.behavior.LynxContext

# ---------- WebRTC ----------
-keep class org.webrtc.** { *; }
-dontwarn org.webrtc.**

# ---------- Kotlin 协程 ----------
-keepclassmembers class kotlinx.coroutines.** { volatile <fields>; }
-dontwarn kotlinx.coroutines.**

# ---------- 保留行号，便于线上崩溃定位 ----------
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# ---------- 序列化 ----------
-keepattributes *Annotation*
-keepclassmembers class * {
    @androidx.annotation.Keep *;
}
