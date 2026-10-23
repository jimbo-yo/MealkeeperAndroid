package com.example.mealkeeper

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ApplicationInfo
import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
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
    private var safeBottomDp = 0
    private val prefs: SharedPreferences by lazy { getSharedPreferences("mealkeeper", MODE_PRIVATE) }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }

        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            // Bundled assets load without file access; keep the page from reading other files or content URIs.
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            webChromeClient = WebChromeClient()
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    isPageLoaded = true
                    // Insets usually arrive before the page loads, so re-apply them here.
                    applySafeInsets()
                    pendingScripts.forEach { runJs(it) }
                    pendingScripts.clear()
                    offerCopiedMeal()
                }

                // Only the bundled page runs inside the app (it has the JS bridge); links open in the browser.
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val url = request.url
                    if (url.scheme == "file" && url.path.orEmpty().startsWith("/android_asset/")) return false
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    } catch (e: ActivityNotFoundException) {
                        e.printStackTrace()
                    }
                    return true
                }
            }
            addJavascriptInterface(MealkeeperBridge(), "MealkeeperAndroid")
        }

        webView.setOnApplyWindowInsetsListener { _, insets ->
            val top: Int
            val bottom: Int
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                top = insets.getInsets(WindowInsets.Type.statusBars() or WindowInsets.Type.displayCutout()).top
                bottom = insets.getInsets(WindowInsets.Type.navigationBars()).bottom
            } else {
                @Suppress("DEPRECATION")
                top = insets.systemWindowInsetTop
                @Suppress("DEPRECATION")
                bottom = insets.systemWindowInsetBottom
            }
            val density = resources.displayMetrics.density
            safeTopDp = (top / density).toInt()
            safeBottomDp = (bottom / density).toInt()
            if (isPageLoaded) applySafeInsets()
            insets
        }

        setContentView(webView)
        setUpSystemBars()
        handleIncomingIntent(intent)
        webView.loadUrl("file:///android_asset/index.html")
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) offerCopiedMeal()
    }

    // When the user copies a meal in ChatGPT or Claude and comes back, hand it to the page to offer an import.
    // Android only lets the focused app read the clipboard and shows a "pasted" notice on each read, so read
    // only clips we haven't seen (the description and its timestamp can be checked without reading), skip
    // ones marked sensitive, and pass on only text that looks like a Mealkeeper export.
    private fun offerCopiedMeal() {
        if (!isPageLoaded || !prefs.getBoolean(PREF_CLIPBOARD_WATCH, true)) return
        val clipboard = getSystemService(ClipboardManager::class.java) ?: return
        val description = clipboard.primaryClipDescription ?: return
        if (description.timestamp == prefs.getLong(PREF_LAST_CLIP, 0L)) return
        markClipSeen(description)
        if (!description.hasMimeType("text/*")) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            description.extras?.getBoolean(ClipDescription.EXTRA_IS_SENSITIVE) == true
        ) return
        val text = clipboard.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString() ?: return
        if (text.length > MAX_CLIP_CHARS || !(text.contains("\"meals\"") || text.contains("\"recipes\""))) return
        runJs("window.receiveClipboardText&&window.receiveClipboardText(${JSONObject.quote(text)})")
    }

    private fun markClipSeen(description: ClipDescription) {
        prefs.edit().putLong(PREF_LAST_CLIP, description.timestamp).apply()
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

    // Draw behind transparent status and navigation bars on every version (Android 15 forces this anyway);
    // the page pads itself using the insets from applySafeInsets().
    @Suppress("DEPRECATION")
    private fun setUpSystemBars() {
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            val lightBars = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
                WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            window.insetsController?.setSystemBarsAppearance(if (night) 0 else lightBars, lightBars)
        } else {
            val lightBars = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                (if (night) 0 else lightBars)
        }
    }

    private fun applySafeInsets() {
        runJs(
            "document.documentElement.style.setProperty('--android-safe-top','${safeTopDp}px');" +
                "document.documentElement.style.setProperty('--android-safe-bottom','${safeBottomDp}px')"
        )
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
        fun copyText(text: String) {
            runOnUiThread {
                val clipboard = getSystemService(ClipboardManager::class.java) ?: return@runOnUiThread
                clipboard.setPrimaryClip(ClipData.newPlainText("Mealkeeper", text))
                // The app's own copies (setup instructions, shopping list) shouldn't come back as import offers.
                clipboard.primaryClipDescription?.let { markClipSeen(it) }
            }
        }

        @JavascriptInterface
        fun setClipboardWatch(enabled: Boolean) {
            prefs.edit().putBoolean(PREF_CLIPBOARD_WATCH, enabled).apply()
        }

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

        // Hands text to the ChatGPT or Claude app as a share, which opens a new chat in the app with the text in
        // the message box. Web links would open the browser (the ChatGPT app doesn't claim chatgpt.com links).
        // Returns "shared", "opened" (the app was launched without the text), or "missing" (not installed).
        @JavascriptInterface
        fun sendToAiApp(ai: String, text: String): String {
            val pkg = AI_APPS[ai] ?: return "missing"
            // NEW_TASK: otherwise the AI app's screen joins Mealkeeper's task, and returning to Mealkeeper shows it again.
            val share = Intent(Intent.ACTION_SEND).setPackage(pkg).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (share.resolveActivity(packageManager) != null && start(share)) return "shared"
            return if (openAiApp(ai)) "opened" else "missing"
        }

        @JavascriptInterface
        fun openAiApp(ai: String): Boolean {
            val launch = AI_APPS[ai]?.let { packageManager.getLaunchIntentForPackage(it) } ?: return false
            return start(launch)
        }

        private fun start(intent: Intent): Boolean = try {
            startActivity(intent)
            true
        } catch (e: ActivityNotFoundException) {
            false
        }

        @JavascriptInterface
        fun shareText(text: String, title: String) {
            runOnUiThread {
                try {
                    val sendIntent = Intent(Intent.ACTION_SEND).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
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
        private const val PREF_CLIPBOARD_WATCH = "clipboardWatch"
        private const val PREF_LAST_CLIP = "lastClipTimestamp"
        private const val MAX_CLIP_CHARS = 500_000
        // The page refers to the AI apps by these keys; the packages are also listed under <queries> in the manifest.
        private val AI_APPS = mapOf("chatgpt" to "com.openai.chatgpt", "claude" to "com.anthropic.claude")
    }
}
