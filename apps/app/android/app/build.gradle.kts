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
        versionCode = 200
        versionName = "2.0.0"

        // 只保留中文与英文资源，减小包体积
        resourceConfigurations += listOf("zh", "en")
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
            )
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
}
