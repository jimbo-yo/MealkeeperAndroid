package com.example.mealkeeper

import android.annotation.SuppressLint
import android.app.Activity
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
    private var pendingSharedText: String? = null
    private var isPageLoaded = false

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
                    pendingSharedText?.let { text ->
                        dispatchSharedTextToWeb(text)
                        pendingSharedText = null
                    }
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
            val safeTop = if (topDp > 0) topDp else 44
            webView.post {
                webView.evaluateJavascript(
                    "document.documentElement.style.setProperty('--android-safe-top', '${safeTop}px')",
                    null
                )
            }
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
                if (isPageLoaded) {
                    dispatchSharedTextToWeb(sharedText)
                } else {
                    pendingSharedText = sharedText
                }
            }
        }
    }

    private fun dispatchSharedTextToWeb(text: String) {
        val quoted = JSONObject.quote(text)
        webView.post {
            webView.evaluateJavascript(
                "if(window.receiveSharedText){window.receiveSharedText($quoted);}",
                null
            )
        }
    }

    inner class MealkeeperBridge {
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
        if (::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        if (::webView.isInitialized) {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            webView.destroy()
        }
        super.onDestroy()
    }
}
