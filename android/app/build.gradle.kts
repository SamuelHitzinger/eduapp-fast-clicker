// Clicker for Android (an unofficial client for ETH EduApp's clicker). Built by .github/workflows/android.yml (no Android SDK needed on the PC).
// The version follows ios/project.yml; versionCode comes from the CI run number so every build installs over the last.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val keystore: String? = System.getenv("ANDROID_KEYSTORE")

android {
    namespace = "ch.students.ethclicker"
    compileSdk = 35

    defaultConfig {
        applicationId = "ch.students.clicker"
        minSdk = 26
        targetSdk = 35
        versionCode = (project.findProperty("versionCode") as String?)?.toInt() ?: 1
        versionName = "3.5.0"
    }

    signingConfigs {
        create("release") {
            // one fixed key (GitHub secrets), so a new build installs over the old one and keeps the login
            if (keystore != null) {
                storeFile = file(keystore)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (keystore != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
}
