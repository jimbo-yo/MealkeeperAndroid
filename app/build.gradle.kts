import java.util.Properties

plugins {
    id("com.android.application")
}

// The upload key for Play releases lives outside git; see "Release builds" in README.md.
val keystoreProperties = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "com.jimboyo.prompttopan"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.jimboyo.prompttopan"
        minSdk = 26
        targetSdk = 36
        versionCode = 3
        // Raise versionCode for every upload to Play; versionName is what the store shows.
        versionName = "1.1"
        manifestPlaceholders["appLabel"] = "Prompt to Pan"
    }

    signingConfigs {
        if (keystoreProperties.isNotEmpty()) {
            create("upload") {
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        // Test builds install beside the Play version (their own app ID, name and data), so trying one never needs
        // the real app uninstalled: back up meals there and restore them here.
        getByName("debug") {
            applicationIdSuffix = ".test"
            versionNameSuffix = "-test"
            manifestPlaceholders["appLabel"] = "Prompt to Pan (test)"
        }
        release {
            // Without keystore.properties, release builds come out unsigned.
            signingConfig = signingConfigs.findByName("upload")
            isMinifyEnabled = true
            isShrinkResources = true
            // The default optimize rules keep @JavascriptInterface methods, which the page calls by name.
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
