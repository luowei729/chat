// ============================================================
// Android 工程根配置
// ------------------------------------------------------------
// 仓库顺序说明：
// GitHub Actions 的机器在海外，google()/mavenCentral() 访问快，
// 所以放前面；腾讯/阿里镜像作为兜底（本地国内开发时命中）。
// ============================================================

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
        // 国内镜像兜底
        maven { url = uri("https://maven.aliyun.com/repository/public") }
        maven { url = uri("https://mirrors.cloud.tencent.com/nexus/repository/maven-public/") }
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories {
        google()
        mavenCentral()
        // 国内镜像兜底
        maven { url = uri("https://maven.aliyun.com/repository/public") }
        maven { url = uri("https://mirrors.cloud.tencent.com/nexus/repository/maven-public/") }
    }
}

rootProject.name = "chat"
include(":app")
