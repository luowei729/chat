plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
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
    }

    buildTypes {
        release {
            // TODO: Add your own signing config for the release build.
            // Signing with the debug keys for now, so `flutter run --release` works.
            signingConfig = signingConfigs.getByName("debug")

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
