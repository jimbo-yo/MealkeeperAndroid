package com.jimboyo.prompttopan

import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Sends the page's feedback form (see FEEDBACK_FORM in feedback.js) to the developer's Google Form, which collects
 * the answers in a Google Sheet, so feedback can be anonymous without a server of our own.
 * The page builds the form-encoded body; this only posts it, and only to a Google Forms formResponse URL.
 * The result goes back through [runJs] as window.onFeedbackSent(ok).
 */
class Feedback(private val runJs: (String) -> Unit) {
    private val executor = Executors.newSingleThreadExecutor()

    fun send(url: String, body: String) {
        if (!FORM_URL.matches(url) || body.length > MAX_BODY) return done(false)
        executor.execute {
            var conn: HttpURLConnection? = null
            val ok = try {
                conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 20_000
                    readTimeout = 30_000
                    doOutput = true
                    setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
                }
                conn.outputStream.use { it.write(body.toByteArray()) }
                conn.responseCode in 200..299
            } catch (e: Exception) {
                // Not just IOException: anything else (a bad URL, a SecurityException) must still answer the page, or it
                // would stay on "Sending…" for good.
                false
            } finally {
                conn?.disconnect()
            }
            done(ok)
        }
    }

    fun shutdown() = executor.shutdown()

    private fun done(ok: Boolean) = runJs("window.onFeedbackSent&&window.onFeedbackSent($ok)")

    companion object {
        private val FORM_URL = Regex("https://docs\\.google\\.com/forms/d/e/[\\w-]+/formResponse")
        private const val MAX_BODY = 20_000
    }
}
