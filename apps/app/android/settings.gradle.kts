// ============================================================
// Android 工程根配置
// 说明：使用 Gradle 8.7 + AGP 8.2.2（与 Lynx SDK 4.2.0 兼容）
//      国内网络用腾讯云镜像加速依赖下载
// ============================================================

pluginManagement {
    repositories {
        // 腾讯云镜像：国内构建速度快很多
        maven { url = uri("https://mirrors.cloud.tencent.com/nexus/repository/maven-public/") }
        // 阿里云镜像作为备用
        maven { url = uri("https://maven.aliyun.com/repository/public") }
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories {
        maven { url = uri("https://mirrors.cloud.tencent.com/nexus/repository/maven-public/") }
        maven { url = uri("https://maven.aliyun.com/repository/public") }
        google()
        mavenCentral()
    }
}

rootProject.name = "chat"
include(":app")
