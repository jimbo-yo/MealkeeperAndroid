plugins {
    id("com.android.application")
}

android {
    namespace = "com.example.mealkeeper"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.example.mealkeeper"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
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
