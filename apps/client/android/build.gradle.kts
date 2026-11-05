allprojects {
    repositories {
        google()
        mavenCentral()
        /**
         * Mob 官方私有仓库（不在 Maven Central）
         * ------------------------------------------------------------
         * 必须用 artifact() 元数据源：
         *   Mob 的发布不规范——MobTools 根本没有 .pom，
         *   MobPush 的 .pom 又没写 <packaging>aar</packaging>。
         * 默认的 pom 元数据走法会直接报“找不到 Xxx-x.y.z.pom”而失败。
         * 改成按文件名直取产物后，配合依赖里显式 @jar / @aar 即可。
         */
        maven {
            url = uri("https://mvn.mob.com/android")
            metadataSources { artifact() }
        }
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
