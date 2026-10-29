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
            // 有 keystore 才签名，否则产出 unsigned apk 供内测
            if (!System.getenv("ANDROID_KEYSTORE_PATH").isNullOrBlank()) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
        debug {
            applicationIdSuffix = ".debug"
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
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
    // 官方 Android SDK：提供 LynxView 与运行时
    implementation("org.lynxsdk.lynx:lynx:4.2.0")

    // ---------- AndroidX 基础 ----------
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")

    // ---------- WebRTC ----------
    // 语音通话核心：P2P Mesh，与 coturn 配合
    implementation("io.github.webrtc-sdk:android:125.6422.07")

    // ---------- 协程 ----------
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
}
