// 必须显式 import：Kotlin DSL 里 `java` 是 Gradle 的 java 扩展，
// 直接写 java.util.Properties() 会报 "Unresolved reference: util"。
import java.util.Properties

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

/**
 * 读取签名配置
 * ------------------------------------------------------------
 * key.properties 与 chat-release.jks 都不进版本库：
 *   本地开发时放在 android/key.properties；
 *   CI 上由 workflow 从 GitHub Secrets 还原这两个文件。
 *
 * 读不到时回退到 debug 签名 —— 这样没配密钥的人
 * （或 fork 仓库的贡献者）也能直接 flutter run，不会一上来就报错。
 */
val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("key.properties")
val hasReleaseSigning = keystorePropertiesFile.exists()

if (hasReleaseSigning) {
    keystorePropertiesFile.inputStream().use { keystoreProperties.load(it) }
}

android {
    namespace = "pub.lkz.chat"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_11.toString()
    }

    defaultConfig {
        applicationId = "pub.lkz.chat"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName

        /**
         * 双开联调开关
         * ------------------------------------------------------------
         * 同一台设备要同时登录两个账号才能测「互发消息 / 互打电话」。
         *
         *   ./gradlew assembleDebug -PdualApp     → 包名 pub.lkz.chat.b
         *
         * 只在 debug 用；发布包永远是 pub.lkz.chat。
         */
        if (project.hasProperty("dualApp")) {
            applicationIdSuffix = ".b"
        }

        /**
         * 按 ABI 出包必须用 --split-per-abi
         * ------------------------------------------------------------
         * media_kit / flutter_webrtc 的 AAR 预置了
         * x86_64 + arm64-v8a + armeabi-v7a 三套 .so。
         *
         * 这里**不能**用 defaultConfig.ndk.abiFilters 裁剪：
         * Flutter 的 Gradle 插件在 afterEvaluate 阶段会执行
         *   buildType.ndk.abiFilters.clear()
         *   + 把 DEFAULT_PLATFORMS（全部 3 个）重新加回去，
         * 于是我们的设置被无声覆盖，arm64 包里塞进三种架构（43MB→92MB）。
         *
         * 正确做法：flutter build apk --release --split-per-abi
         * 走 splits.abi 分支，产出真正按 ABI 裁剪的独立 APK。
         */
    }

    /**
     * 签名配置
     * ------------------------------------------------------------
     * 必须写在 buildTypes 之前：Kotlin DSL 里 buildTypes 求值时
     * 会 getByName("release")，此时 signingConfigs 必须已经注册好，
     * 否则报 "SigningConfig with name 'release' not found"。
     */
    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = rootProject.file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
                // V1 兼容 Android 6 及以下；V2/V3 供 7+ 使用（校验更快更安全）
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        release {
            /**
             * 固定签名
             * ------------------------------------------------------------
             * 用同一个 keystore 签所有 release 包，
             * 用户才能覆盖安装而不必卸载（卸载会丢本地缓存）。
             *
             * 之前用 debug 签名的问题：GitHub Actions 每次是全新 runner，
             * ~/.android/debug.keystore 由工具链**随机生成**，
             * 导致每次 CI 出包的签名都不同，互相装不上。
             */
            signingConfig = if (hasReleaseSigning) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }

            // MobPush 把各厂商适配代码编进同一个 AAR 但不带依赖，
            // 不加这行 R8 会因「引用不存在的类」直接失败。
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }
}

flutter {
    source = "../.."
}

dependencies {
    /**
     * MobPush 3.x（Mob 官方聚合推送）
     * ------------------------------------------------------------
     * MobCommons 是 Mob SDK 的公共底座（含 com.mob.MobSDK 初始化入口），
     * 它只发布 jar 包，没有 aar；MobPush 才是推送主体。
     * 两者版本互相绑定，升级时必须一起动。
     *
     * 为什么用 MobPush 而不是自己接厂商通道：
     *   Mob 控制台里一次配置好华为/小米/OPPO/vivo/魅族的通道，
     *   服务端只需调一个 Mob REST 接口，由 Mob 负责路由到各厂商。
     */
    implementation("com.mob:MobCommons:2021.0601.1533@jar")
    /**
     * MobTools 是 Mob 系列的公共底层（含 com.mob.tools.proguard.ClassKeeper 等）
     * 不显式引入会报：Cannot access 'com.mob.tools.proguard.ClassKeeper'，
     * 因为 MobPush / MobCommons 的类都实现了这个接口，而它只在 MobTools 里。
     * 它没有发布 POM，必须写 @jar 直取产物。
     */
    implementation("com.mob:MobTools:2021.0601.1530@jar")
    /**
     * 注意必须显式写 @aar
     * ------------------------------------------------------------
     * Mob 发布的 MobPush POM 里没有 <packaging>aar</packaging>，
     * Gradle 会按默认值 jar 去拉 MobPush-x.y.z.jar —— 该文件根本不存在，
     * 于是报 "Could not find MobPush-3.3.9.jar"。
     * 加上 @aar 强制按 AAR 产物解析即可。
     */
    implementation("com.mob:MobPush:3.3.9@aar")
}
