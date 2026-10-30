// ============================================================
// Android 应用模块构建脚本
// ------------------------------------------------------------
// 关键点：
// 1. Lynx SDK 来自 Maven Central（org.lynxsdk.lynx:lynx:4.2.0）
// 2. Lynx bundle 由 CI 从 apps/app/dist 拷贝到 assets/chat.lynx.bundle
// 3. minSdk 24：Lynx 官方要求 Android 5.0+，但 WebRTC 建议 24+
// 4. 开启 WebView 调试 + 录音权限
// ============================================================

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "pub.lkz.chat"
    compileSdk = 34

    defaultConfig {
        applicationId = "pub.lkz.chat"
        minSdk = 24
        targetSdk = 34
        versionCode = 220
        versionName = "2.2.0"

        // 只保留中文与英文资源，减小包体积
        resourceConfigurations += listOf("zh", "en")

        /**
         * 只打包真机需要的 CPU 架构
         * ============================================================
         * WebRTC 的 libjingle_peerconnection_so.so 单个架构就有 6-12MB，
         * Lynx 的 liblynx.so 也有 6-7MB。
         * 打包全部 4 个架构（含模拟器用的 x86/x86_64）会让 APK 达到 109MB，
         * 而真机 99% 以上都是 arm64-v8a / armeabi-v7a。
         *
         * 结果：APK 从 109MB 降到约 47MB。
         *
         * 如果需要在 Android 模拟器上调试，用命令行覆盖：
         *   ./gradlew assembleDebug -PabiFilters=x86_64
         */
        val abiOverride = project.findProperty("abiFilters") as String?
        if (abiOverride != null) {
            ndk {
                abiFilters += abiOverride.split(",")
            }
        } else {
            ndk {
                abiFilters += listOf("arm64-v8a", "armeabi-v7a")
            }
        }
    }

    // ---------- 签名配置 ----------
    // 由 CI 通过环境变量注入 keystore；未配置时产出未签名包
    signingConfigs {
        create("release") {
            val storePath = System.getenv("ANDROID_KEYSTORE_PATH")
            if (!storePath.isNullOrBlank()) {
                storeFile = file(storePath)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            /**
             * 签名策略：
             * - 配置了 keystore（CI 有 Secret）→ 用正式密钥签名
             * - 没配置 → 退回 debug 密钥签名
             *
             * 为什么要退回 debug 签名而不是产出 unsigned：
             * unsigned APK 根本无法安装，内测时毫无意义；
             * 用 debug 密钥签名后至少能装上真机验证功能，
             * 只是不能上架应用市场（上架必须用正式密钥）。
             */
            signingConfig = if (!System.getenv("ANDROID_KEYSTORE_PATH").isNullOrBlank()) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
        debug {
            // 去掉后缀：避免与 release 包同时安装时冲突
            // 如果需要在同一台设备同时装两个包，可把下面一行改回 ".debug"
            applicationIdSuffix = ""
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    /**
     * AGP 8 起 BuildConfig 默认关闭，必须显式开启。
     * 代码里用 BuildConfig.DEBUG 判断调试模式，不开会编译失败。
     */
    buildFeatures {
        buildConfig = true
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    // 关闭 lint 阻断，避免 CI 因警告失败
    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }

    packaging {
        resources {
            excludes += setOf(
                "META-INF/AL2.0",
                "META-INF/LGPL2.1",
                "META-INF/*.kotlin_module",
                // Fresco / OkHttp 的重复许可证文件
                "META-INF/DEPENDENCIES",
                "META-INF/LICENSE",
                "META-INF/LICENSE.txt",
                "META-INF/NOTICE",
                "META-INF/NOTICE.txt",
                "META-INF/versions/9/previous-compilation-data.bin",
            )
        }
        /**
         * 不压缩 .so 的旧行为（useLegacyPackaging）保持关闭：
         * 现代 Android 会直接从 APK 中 mmap 加载未压缩的 .so，
         * 既省安装空间又加快启动。
         */
        jniLibs {
            useLegacyPackaging = false
        }
    }
}

dependencies {
    // ---------- Lynx 引擎 ----------
    // 核心包已传递依赖 primjs(4.2.1) / lynx-jssdk / lynx-trace / service-api，
    // 无需重复声明，否则版本冲突
    implementation("org.lynxsdk.lynx:lynx:4.2.0")

    // 图片服务：Lynx 的 <image> 元素依赖它渲染图片，缺了图片会白屏
    implementation("org.lynxsdk.lynx:lynx-service-image:4.2.0")
    // 日志服务：把前端 console 输出转到 Logcat，排查问题必备
    implementation("org.lynxsdk.lynx:lynx-service-log:4.2.0")

    // HTTP 服务（关键）：Lynx 引擎自身不实现网络请求，
    // fetch / XMLHttpRequest 全部由宿主 App 提供实现。
    // 不加这个依赖，所有网络请求都会立即失败且报「网络连接失败」。
    implementation("org.lynxsdk.lynx:lynx-service-http:4.2.0")

    // 扩展元素：input / textarea / webview / video 等原生组件
    // 注意：不加这个，<input> 会渲染失败（登录页直接不可用）
    implementation("org.lynxsdk.lynx:xelement:4.2.0")

    // ---------- 图片加载 ----------
    // LynxImageService 依赖 Fresco，版本必须与官方示例一致（2.3.0）
    implementation("com.facebook.fresco:fresco:2.3.0")
    implementation("com.facebook.fresco:animated-gif:2.3.0")
    implementation("com.facebook.fresco:animated-webp:2.3.0")
    implementation("com.facebook.fresco:webpsupport:2.3.0")

    // ---------- 网络 ----------
    // Lynx 内部 HTTP 服务使用 OkHttp
    implementation("com.squareup.okhttp3:okhttp:4.9.0")

    // ---------- AndroidX 基础 ----------
    implementation("androidx.core:core-ktx:1.12.0")
    // AppCompatActivity 需要 appcompat；主题必须用 Theme.AppCompat 系
    implementation("androidx.appcompat:appcompat:1.6.1")

    // ---------- WebRTC ----------
    // 语音通话核心：P2P Mesh，与 coturn 配合
    implementation("io.github.webrtc-sdk:android:125.6422.07")

    // ---------- 协程 ----------
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")

    // ---------- CameraX ----------
    // 微信式相机（短按拍照 / 长按录像 / 闪光灯开关）需要
    // 实时预览 + 拍照 + 录像三件套，Camera2 手写太易错，
    // 用 CameraX 的 Preview/ImageCapture/VideoCapture 组合。
    implementation("androidx.camera:camera-core:1.3.4")
    implementation("androidx.camera:camera-camera2:1.3.4")
    implementation("androidx.camera:camera-lifecycle:1.3.4")
    implementation("androidx.camera:camera-video:1.3.4")
    implementation("androidx.camera:camera-view:1.3.4")
    // CameraX 的异步 API 返回 ListenableFuture，Kotlin 编译需要 Guava 在
    // classpath 上，否则报 "Cannot access class ListenableFuture"。
    implementation("com.google.guava:guava:32.1.3-android")
}
