package com.example.mealkeeper

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject

class MainActivity : Activity() {
    private lateinit var webView: WebView
    // Scripts that arrive before the page has loaded (shared text, file-picker results) run once it has.
    private val pendingScripts = mutableListOf<String>()
    private var pendingBackupJson: String? = null
    private var isPageLoaded = false
    private var safeTopDp = 44

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }

        window.statusBarColor = android.graphics.Color.rgb(247, 246, 240)
        window.navigationBarColor = android.graphics.Color.rgb(247, 246, 240)
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or
            View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        )

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = true
            settings.allowContentAccess = true
            webChromeClient = WebChromeClient()
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    isPageLoaded = true
                    // Insets usually arrive before the page loads, so re-apply them here.
                    applySafeTop()
                    pendingScripts.forEach { runJs(it) }
                    pendingScripts.clear()
                }
            }
            addJavascriptInterface(MealkeeperBridge(), "MealkeeperAndroid")
        }

        webView.setOnApplyWindowInsetsListener { _, insets ->
            val rawTopInset = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                insets.getInsets(
                    WindowInsets.Type.statusBars() or WindowInsets.Type.displayCutout()
                ).top
            } else {
                @Suppress("DEPRECATION")
                insets.systemWindowInsetTop
            }
            val density = resources.displayMetrics.density
            val topDp = (rawTopInset / density).toInt()
            safeTopDp = if (topDp > 0) topDp else 44
            if (isPageLoaded) applySafeTop()
            insets
        }

        setContentView(webView)
        handleIncomingIntent(intent)
        webView.loadUrl("file:///android_asset/index.html")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingIntent(intent)
    }

    private fun handleIncomingIntent(intent: Intent?) {
        if (intent?.action == Intent.ACTION_SEND && intent.type == "text/plain") {
            val sharedText = intent.getStringExtra(Intent.EXTRA_TEXT)
            if (!sharedText.isNullOrBlank()) {
                runJs("if(window.receiveSharedText){window.receiveSharedText(${JSONObject.quote(sharedText)});}")
            }
        }
    }

    private fun applySafeTop() {
        webView.post {
            webView.evaluateJavascript(
                "document.documentElement.style.setProperty('--android-safe-top', '${safeTopDp}px')",
                null
            )
        }
    }

    private fun runJs(script: String) {
        if (!isPageLoaded) {
            pendingScripts.add(script)
            return
        }
        webView.post { webView.evaluateJavascript(script, null) }
    }

    @Deprecated("Plain Activity has no Activity Result API; this is the framework callback.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        val uri = data?.data
        when (requestCode) {
            REQUEST_EXPORT_BACKUP -> {
                val json = pendingBackupJson
                pendingBackupJson = null
                if (resultCode != RESULT_OK || uri == null) return
                // json is null if the process died while the picker was open.
                val saved = json != null && runCatching {
                    contentResolver.openOutputStream(uri, "wt")!!.use { it.write(json.toByteArray()) }
                }.isSuccess
                runJs("window.onBackupSaved&&window.onBackupSaved($saved)")
            }
            REQUEST_RESTORE_BACKUP -> {
                if (resultCode != RESULT_OK || uri == null) return
                val text = runCatching {
                    contentResolver.openInputStream(uri)!!.bufferedReader().use { it.readText() }
                }.getOrDefault("")
                runJs("window.receiveBackupFile&&window.receiveBackupFile(${JSONObject.quote(text)})")
            }
        }
    }

    inner class MealkeeperBridge {
        @JavascriptInterface
        fun saveBackupFile(filename: String, json: String) {
            runOnUiThread {
                pendingBackupJson = json
                val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "application/json"
                    putExtra(Intent.EXTRA_TITLE, filename)
                }
                try {
                    @Suppress("DEPRECATION")
                    startActivityForResult(intent, REQUEST_EXPORT_BACKUP)
                } catch (e: ActivityNotFoundException) {
                    pendingBackupJson = null
                    shareText(json, "Save Mealkeeper backup")
                }
            }
        }

        @JavascriptInterface
        fun openBackupFile() {
            runOnUiThread {
                // JSON files are often typed application/octet-stream by file providers, so accept anything.
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                }
                try {
                    @Suppress("DEPRECATION")
                    startActivityForResult(intent, REQUEST_RESTORE_BACKUP)
                } catch (e: ActivityNotFoundException) {
                    runJs("window.notify&&window.notify('No file picker available on this device')")
                }
            }
        }

        @JavascriptInterface
        fun setKeepScreenOn(enabled: Boolean) {
            runOnUiThread {
                if (enabled) {
                    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                } else {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
            }
        }

        @JavascriptInterface
        fun openInChatGPT(prompt: String) {
            runOnUiThread {
                try {
                    val encoded = Uri.encode(prompt)
                    val url = "https://chatgpt.com/?q=$encoded"
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    startActivity(intent)
                } catch (e: Exception) {
                    shareText(prompt, "Send prompt to AI assistant")
                }
            }
        }

        @JavascriptInterface
        fun shareText(text: String, title: String) {
            runOnUiThread {
                try {
                    val sendIntent = Intent(Intent.ACTION_SEND).apply {
                        putExtra(Intent.EXTRA_TEXT, text)
                        type = "text/plain"
                    }
                    val shareIntent = Intent.createChooser(sendIntent, title.ifEmpty { "Share via" })
                    startActivity(shareIntent)
                } catch (e: Exception) {
                    e.printStackTrace()
                }
            }
        }
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (!::webView.isInitialized || !isPageLoaded) {
            super.onBackPressed()
            return
        }
        // The page is a single-document app, so let it close modals / pop its own page stack first.
        webView.evaluateJavascript("(window.handleBack&&window.handleBack())===true") { handled ->
            if (handled != "true") super@MainActivity.onBackPressed()
        }
    }

    override fun onDestroy() {
        if (::webView.isInitialized) {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            webView.destroy()
        }
        super.onDestroy()
    }

    companion object {
        private const val REQUEST_EXPORT_BACKUP = 41
        private const val REQUEST_RESTORE_BACKUP = 42
    }
}
