package com.jimboyo.prompttopan

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.provider.AlarmClock
import android.os.Looper
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import android.window.OnBackInvokedDispatcher
import org.json.JSONObject
import java.io.File

class MainActivity : Activity() {
    private lateinit var webView: WebView
    // Scripts that arrive before the page has loaded (shared text, file-picker results) run once it has.
    private val pendingScripts = mutableListOf<String>()
    private var pendingBackupJson: String? = null
    private var isPageLoaded = false
    private var safeTopDp = 44
    private var safeBottomDp = 0
    private var imeBottomDp = 0
    // Whether the page has used the mic or read-aloud yet, so Voice isn't created just to be stopped.
    private var voiceUsed = false
    // The microphone permission dialog pauses the activity; that pause mustn't end voice mode.
    private var askingForMic = false
    private val prefs: SharedPreferences by lazy { getSharedPreferences("mealkeeper", MODE_PRIVATE) }
    private val mainHandler = Handler(Looper.getMainLooper())
    private val aiApi by lazy { AiApi(this) { script -> mainHandler.post { runJs(script) } } }
    private val voice by lazy { Voice(this) { script -> mainHandler.post { runJs(script) } } }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { goBack() }
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
            val ime: Int
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                top = insets.getInsets(WindowInsets.Type.statusBars() or WindowInsets.Type.displayCutout()).top
                bottom = insets.getInsets(WindowInsets.Type.navigationBars()).bottom
                ime = insets.getInsets(WindowInsets.Type.ime()).bottom
            } else {
                @Suppress("DEPRECATION")
                top = insets.systemWindowInsetTop
                // Before Android 11 the keyboard is part of the system window inset; the stable inset is the nav bar.
                @Suppress("DEPRECATION")
                bottom = insets.stableInsetBottom
                @Suppress("DEPRECATION")
                ime = maxOf(0, insets.systemWindowInsetBottom - insets.stableInsetBottom)
            }
            val density = resources.displayMetrics.density
            safeTopDp = (top / density).toInt()
            safeBottomDp = (bottom / density).toInt()
            // Drawing edge-to-edge means the window no longer shrinks for the keyboard, so the page lifts its
            // dialogs above it using this height.
            imeBottomDp = (ime / density).toInt()
            if (isPageLoaded) applySafeInsets()
            insets
        }

        setContentView(webView)
        setUpSystemBars()
        handleIncomingIntent(intent)
        webView.loadUrl("file:///android_asset/index.html")
    }

    // The mic and read-aloud replies are only for while the chat is on screen.
    override fun onPause() {
        super.onPause()
        if (voiceUsed && !askingForMic) voice.stop(tellPage = true)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_MICROPHONE) return
        askingForMic = false
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) voice.listen()
        else runJs("window.onVoice&&window.onVoice('error','denied')")
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) offerCopiedMeal()
    }

    // When the user copies a meal in ChatGPT or Claude and comes back, hand it to the page to offer an import.
    // Android only lets the focused app read the clipboard and shows a "pasted" notice on each read, so read
    // only clips we haven't seen (the description and its timestamp can be checked without reading), skip
    // ones marked sensitive, and pass on only text that looks like a meal export.
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
        // A short pause so the offer doesn't pop up the instant the user comes back. (Android's copy preview and
        // "pasted" notice can last longer than this; the page shows the offer mid-screen to stay clear of them.)
        val script = "window.receiveClipboardText&&window.receiveClipboardText(${JSONObject.quote(text)})"
        mainHandler.postDelayed({ runJs(script) }, CLIP_OFFER_DELAY_MS)
    }

    private fun copyToClipboard(text: String) {
        val clipboard = getSystemService(ClipboardManager::class.java) ?: return
        clipboard.setPrimaryClip(ClipData.newPlainText("Prompt to Pan", text))
        // The app's own copies (prompts, setup instructions, shopping list) shouldn't come back as import offers.
        clipboard.primaryClipDescription?.let { markClipSeen(it) }
    }

    private fun startOther(intent: Intent): Boolean = try {
        startActivity(intent)
        true
    } catch (e: ActivityNotFoundException) {
        false
    }

    private fun launchAiApp(ai: String): Boolean {
        val launch = AI_APPS[ai]?.let { packageManager.getLaunchIntentForPackage(it.packageName) } ?: return false
        return startOther(launch)
    }

    // Claude's share handler has occasionally finished without opening a chat. If the app still has focus once
    // the AI app should be in front, copy the prompt and open the app so the user can paste it. The toast is
    // Android's rather than the page's so it stays visible over the AI app.
    private fun checkAiAppOpened(ai: String, text: String) {
        mainHandler.postDelayed({
            if (!hasWindowFocus()) return@postDelayed
            val name = AI_APPS[ai]?.name ?: return@postDelayed
            copyToClipboard(text)
            val opened = launchAiApp(ai)
            val message = if (opened) "$name didn't pick up the prompt. It's copied: paste it into a new chat."
            else "Couldn't open $name. The prompt is copied."
            Toast.makeText(this, message, Toast.LENGTH_LONG).show()
        }, AI_LAUNCH_CHECK_MS)
    }

    private fun markClipSeen(description: ClipDescription) {
        prefs.edit().putLong(PREF_LAST_CLIP, description.timestamp).apply()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingIntent(intent)
    }

    // Shared text, or a meal file shared to the app or opened from another app (see shareMeal). Either way the page
    // gets the text and offers to import it.
    private fun handleIncomingIntent(intent: Intent?) {
        intent ?: return
        val file: Uri? = when (intent.action) {
            Intent.ACTION_VIEW -> intent.data
            Intent.ACTION_SEND -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
            } else {
                @Suppress("DEPRECATION")
                intent.getParcelableExtra(Intent.EXTRA_STREAM)
            }
            else -> null
        }
        val text = file?.let { readSharedFile(it) }
            ?: if (intent.action == Intent.ACTION_SEND) intent.getStringExtra(Intent.EXTRA_TEXT) else null
        if (!text.isNullOrBlank()) {
            runJs("if(window.receiveSharedText){window.receiveSharedText(${JSONObject.quote(text)});}")
        }
    }

    private fun readSharedFile(uri: Uri): String? = runCatching {
        contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() }
    }.getOrNull()?.takeIf { it.length <= MAX_CLIP_CHARS }

    // Draw behind transparent status and navigation bars on every version (Android 15 forces this anyway);
    // the page pads itself using the insets from applySafeInsets().
    @Suppress("DEPRECATION")
    private fun setUpSystemBars() {
        val night = isDarkAppearance()
        // Linen or olive behind the page, so there's no white or black flash while it loads.
        val background = getColor(if (night) R.color.appearance_dark else R.color.appearance_light)
        window.setBackgroundDrawable(ColorDrawable(background))
        webView.setBackgroundColor(background)
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

    // Settings > Appearance: the page picks Light (linen), Dark (olive) or the phone's mode; the bars and window follow.
    private fun isDarkAppearance(): Boolean = when (prefs.getString(PREF_APPEARANCE, "light")) {
        "dark" -> true
        "match" -> (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        else -> false
    }

    private fun applySafeInsets() {
        runJs(
            "document.documentElement.style.setProperty('--android-safe-top','${safeTopDp}px');" +
                "document.documentElement.style.setProperty('--android-safe-bottom','${safeBottomDp}px');" +
                "document.documentElement.style.setProperty('--android-ime-bottom','${imeBottomDp}px')"
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

    private fun launchMealShare(fileName: String, json: String, text: String, subject: String, chooserTitle: String) {
        runOnUiThread {
            val dir = SharedMealProvider.sharedDir(this@MainActivity)
            // Keep recent files available if an email draft attaches them later, but don't let them pile up.
            dir.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > SHARED_FILE_MAX_AGE_MS }?.forEach { it.delete() }
            val file = File(dir, fileName.replace(Regex("[^A-Za-z0-9 ._()&'-]"), "_").take(100))
            file.writeText(json)
            val uri = SharedMealProvider.uriFor(this@MainActivity, file)
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "application/json"
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_TEXT, text)
                putExtra(Intent.EXTRA_SUBJECT, subject)
                clipData = ClipData.newRawUri(subject, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            val chooser = Intent.createChooser(send, chooserTitle)
                .putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS, arrayOf(ComponentName(this@MainActivity, MainActivity::class.java)))
            startOther(chooser)
        }
    }

    inner class MealkeeperBridge {
        @JavascriptInterface
        fun copyText(text: String) {
            runOnUiThread { copyToClipboard(text) }
        }

        // Sends a meal to another person: a file Prompt to Pan can import, plus a readable version (EXTRA_TEXT) for
        // anyone without the app. The file is served by SharedMealProvider.
        @JavascriptInterface
        fun shareMeal(fileName: String, json: String, text: String, title: String) {
            launchMealShare(fileName, json, text, title, "Share $title")
        }

        @JavascriptInterface
        fun emailMeal(fileName: String, json: String, body: String, subject: String) {
            launchMealShare(fileName, json, body, subject, "Email $subject")
        }

        @JavascriptInterface
        fun setAppearance(mode: String) {
            if (mode !in setOf("light", "dark", "match")) return
            prefs.edit().putString(PREF_APPEARANCE, mode).apply()
            runOnUiThread { setUpSystemBars() }
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
                    shareText(json, "Save Prompt to Pan backup", "")
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
            val app = AI_APPS[ai] ?: return "missing"
            // NEW_TASK: otherwise the AI app's screen joins this app's task, and returning here shows it again.
            val share = Intent(Intent.ACTION_SEND).setPackage(app.packageName).setType("text/plain")
                .putExtra(Intent.EXTRA_TEXT, text).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (share.resolveActivity(packageManager) == null) return if (launchAiApp(ai)) "opened" else "missing"
            if (!app.shareFillsMessageBox) {
                // Claude sometimes opens with an empty message box (seen when it was already open in the background),
                // so the prompt goes on the clipboard too, with a toast that stays visible over Claude.
                runOnUiThread {
                    copyToClipboard(text)
                    Toast.makeText(this@MainActivity, "Prompt copied. If the message box is empty, paste it.", Toast.LENGTH_LONG).show()
                }
            }
            if (startOther(share)) {
                checkAiAppOpened(ai, text)
                return "shared"
            }
            return if (launchAiApp(ai)) "opened" else "missing"
        }

        @JavascriptInterface
        fun openAiApp(ai: String): Boolean = launchAiApp(ai)

        // Chatting through the user's own API keys; see AiApi and the page's chat.js.
        @JavascriptInterface
        fun aiKeys(): String = aiApi.status()

        @JavascriptInterface
        fun setAiKey(ai: String, key: String): Boolean = aiApi.setKey(ai, key)

        @JavascriptInterface
        fun clearAiKey(ai: String) = aiApi.clearKey(ai)

        @JavascriptInterface
        fun aiRequest(id: String, ai: String, method: String, path: String, body: String, beta: String) =
            aiApi.request(id, ai, method, path, body, beta)

        @JavascriptInterface
        fun aiCancel(id: String) = aiApi.cancel(id)

        // Talking with the chat; see Voice and the voice section of chat.js. The first listen asks for the microphone.
        @JavascriptInterface
        fun voiceAvailable(): Boolean = voice.available

        @JavascriptInterface
        fun voiceListen() {
            runOnUiThread {
                voiceUsed = true
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) voice.listen()
                else {
                    askingForMic = true
                    requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_MICROPHONE)
                }
            }
        }

        @JavascriptInterface
        fun voiceFinishListening() = runOnUiThread { voice.finishListening() }

        @JavascriptInterface
        fun voiceSpeak(text: String) = runOnUiThread {
            voiceUsed = true
            voice.speak(text)
        }

        @JavascriptInterface
        fun voiceStop() = runOnUiThread { if (voiceUsed) voice.stop(tellPage = false) }

        // Opens the Clock app's new-alarm screen filled in, so the user confirms it there. Returns false if no clock
        // app takes the request. Clock apps set it for the next time the clock shows that time.
        @JavascriptInterface
        fun setAlarm(hour: Int, minutes: Int, label: String): Boolean = startOther(
            Intent(AlarmClock.ACTION_SET_ALARM)
                .putExtra(AlarmClock.EXTRA_HOUR, hour)
                .putExtra(AlarmClock.EXTRA_MINUTES, minutes)
                .putExtra(AlarmClock.EXTRA_MESSAGE, label)
                .putExtra(AlarmClock.EXTRA_SKIP_UI, false)
        )

        // subject, if any, becomes an email's subject line.
        @JavascriptInterface
        fun shareText(text: String, title: String, subject: String) {
            runOnUiThread {
                try {
                    val sendIntent = Intent(Intent.ACTION_SEND).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        putExtra(Intent.EXTRA_TEXT, text)
                        if (subject.isNotEmpty()) putExtra(Intent.EXTRA_SUBJECT, subject)
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

    // Android 13+ (and every version once the app targets 36) delivers back through onBackInvokedDispatcher instead
    // of onBackPressed; see the callback registered in onCreate. Lint can't see that, hence the suppression.
    @SuppressLint("GestureBackNavigation")
    @Deprecated("Only called before Android 13")
    override fun onBackPressed() = goBack()

    private fun goBack() {
        if (!::webView.isInitialized || !isPageLoaded) {
            leave()
            return
        }
        // The page is a single-document app, so let it close modals / pop its own page stack first.
        webView.evaluateJavascript("(window.handleBack&&window.handleBack())===true") { handled ->
            if (handled != "true") leave()
        }
    }

    // The system's own back behaviour: send the app to the background (or finish it if it isn't the task root).
    @Suppress("DEPRECATION")
    private fun leave() = super.onBackPressed()

    override fun onDestroy() {
        mainHandler.removeCallbacksAndMessages(null)
        aiApi.cancelAll()
        if (voiceUsed) voice.release()
        if (::webView.isInitialized) {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            webView.destroy()
        }
        super.onDestroy()
    }

    companion object {
        private const val REQUEST_EXPORT_BACKUP = 41
        private const val REQUEST_RESTORE_BACKUP = 42
        private const val REQUEST_MICROPHONE = 43
        private const val PREF_CLIPBOARD_WATCH = "clipboardWatch"
        private const val PREF_APPEARANCE = "appearance"
        private const val SHARED_FILE_MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000
        private const val PREF_LAST_CLIP = "lastClipTimestamp"
        private const val MAX_CLIP_CHARS = 500_000
        // The page refers to the AI apps by these keys; the packages are also listed under <queries> in the manifest.
        private val AI_APPS = mapOf(
            "chatgpt" to AiApp("com.openai.chatgpt", "ChatGPT", shareFillsMessageBox = true),
            "claude" to AiApp("com.anthropic.claude", "Claude", shareFillsMessageBox = false),
            "grok" to AiApp("ai.x.grok", "Grok", shareFillsMessageBox = false)
        )
        private const val AI_LAUNCH_CHECK_MS = 2500L
        private const val CLIP_OFFER_DELAY_MS = 1000L
    }
}

private class AiApp(val packageName: String, val name: String, val shareFillsMessageBox: Boolean)
