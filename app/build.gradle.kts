import java.net.URI
import java.util.Properties
import java.util.zip.ZipInputStream

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
        // Cook mode's speech recognizer (Vosk) is native code: phones (arm64) and the x86_64 emulator only.
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
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
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets {
        getByName("main") {
            // Keep the Android-only Vosk model outside src/main/assets so web builds and web tests never copy it.
            assets.directories.add("vosk-assets")
        }
    }
}

dependencies {
    // Cook mode voice commands, offline (see CookVoice.kt).
    implementation("com.alphacephei:vosk-android:0.3.75")
}

// Cook mode's offline speech model (about 41 MB zip, Apache 2.0), downloaded on the first build into app/vosk-assets
// rather than src/main/assets or git; see .gitignore.
val voskAssetsDir = file("vosk-assets")
val voskModelDir = file("vosk-assets/model-en-us")
val downloadVoskModel = tasks.register("downloadVoskModel") {
    val out = voskModelDir
    val staging = File(voskAssetsDir, "model-en-us.tmp")
    outputs.dir(out)
    onlyIf { !File(out, "uuid").exists() }
    doLast {
        val url = URI("https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip").toURL()
        staging.deleteRecursively()
        staging.mkdirs()
        val stagingRoot = staging.canonicalFile.toPath()
        try {
            ZipInputStream(url.openStream().buffered()).use { zip ->
                var entry = zip.nextEntry
                while (entry != null) {
                    val relative = entry.name.substringAfter('/')   // drop the zip's top-level folder
                    if (relative.isNotEmpty()) {
                        val target = File(staging, relative).canonicalFile
                        require(target.toPath().startsWith(stagingRoot)) { "Unexpected path in model zip: ${entry.name}" }
                        if (entry.isDirectory) target.mkdirs()
                        else { target.parentFile.mkdirs(); target.outputStream().use { zip.copyTo(it) } }
                    }
                    entry = zip.nextEntry
                }
            }
            File(staging, "uuid").writeText("vosk-model-small-en-us-0.15\n")
            out.deleteRecursively()
            check(staging.renameTo(out)) { "Failed to move unpacked Vosk model into $out" }
        } catch (e: Exception) {
            staging.deleteRecursively()
            throw e
        }
    }
}
tasks.named("preBuild") { dependsOn(downloadVoskModel) }
