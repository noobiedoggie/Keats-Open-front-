plugins {
    id("com.android.application")
}

// The app ships the exact same brain as the Tampermonkey script: the
// userscript at the repo root is copied into the APK's assets at build time.
val userScriptDir = layout.buildDirectory.dir("generated/userscript")
val copyUserScript by tasks.registering(Copy::class) {
    from(rootProject.file("../openfront-autopilot.user.js"))
    into(userScriptDir)
}
tasks.matching { it.name == "preBuild" }.configureEach { dependsOn(copyUserScript) }

android {
    namespace = "io.keats.openfrontautopilot"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.keats.openfrontautopilot"
        minSdk = 26
        targetSdk = 35
        versionCode = 9
        versionName = "3.2.1"
    }

    // A fixed key, so every new build installs over the previous one.
    signingConfigs {
        getByName("debug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        getByName("debug") {
            signingConfig = signingConfigs.getByName("debug")
        }
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets["main"].assets.srcDir(userScriptDir)

    lint {
        checkReleaseBuilds = false
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
}
