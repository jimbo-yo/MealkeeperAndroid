package com.jimboyo.prompttopan

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The user's own API keys for Claude, ChatGPT and Grok, and the HTTPS calls that use them (the page's chat.js
 * builds each request body; this adds the key on the way out, so keys never reach the page).
 * Keys are encrypted with an Android Keystore key and left out of backups (see res/xml/backup_rules.xml), since a
 * restored copy couldn't be decrypted on another phone anyway.
 *
 * Results go back through [runJs]: streamed replies as window.onAiEvents(id, [data, ...]) in small batches, then
 * window.onAiDone(id, status, body), where body is the response for non-streamed calls and errors, and status is 0
 * when no key is saved and -1 when the request failed or was cancelled.
 */
class AiApi(context: Context, private val runJs: (String) -> Unit) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val executor = Executors.newCachedThreadPool()
    private val open = ConcurrentHashMap<String, HttpURLConnection>()

    fun status(): String = JSONObject().apply { PROVIDERS.keys.forEach { put(it, prefs.contains(it)) } }.toString()

    fun setKey(ai: String, key: String): Boolean {
        val k = key.trim()
        if (ai !in PROVIDERS || k.isEmpty() || k.length > 500) return false
        return runCatching { prefs.edit().putString(ai, encrypt(k)).apply() }.isSuccess
    }

    fun clearKey(ai: String) = prefs.edit().remove(ai).apply()

    fun request(id: String, ai: String, method: String, path: String, body: String, beta: String) {
        val provider = PROVIDERS[ai]
        if (provider == null || path !in PATHS || method !in setOf("GET", "POST")) return done(id, -1, "bad request")
        val key = prefs.getString(ai, null)?.let { runCatching { decrypt(it) }.getOrNull() } ?: return done(id, 0, null)
        executor.execute {
            var conn: HttpURLConnection? = null
            try {
                conn = (URL(provider.baseUrl + path).openConnection() as HttpURLConnection).apply {
                    requestMethod = method
                    connectTimeout = 20_000
                    readTimeout = 180_000
                    provider.headers(key).forEach { (k, v) -> setRequestProperty(k, v) }
                    if (beta.isNotEmpty() && ai == "claude") setRequestProperty("anthropic-beta", beta)
                }
                open[id] = conn
                if (method == "POST") {
                    conn.doOutput = true
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.outputStream.use { it.write(body.toByteArray()) }
                }
                val status = conn.responseCode
                if (status in 200..299 && conn.contentType.orEmpty().startsWith("text/event-stream")) {
                    readEvents(id, conn)
                    done(id, status, null)
                } else {
                    val stream = if (status in 200..299) conn.inputStream else conn.errorStream
                    done(id, status, stream?.bufferedReader()?.use { it.readText() }.orEmpty())
                }
            } catch (e: IOException) {
                done(id, -1, e.message ?: "network error")
            } finally {
                open.remove(id)
                conn?.disconnect()
            }
        }
    }

    fun cancel(id: String) {
        open.remove(id)?.let { conn -> executor.execute { conn.disconnect() } }
    }

    fun cancelAll() {
        open.keys.toList().forEach(::cancel)
        executor.shutdown()
    }

    // Server-sent events: passes on each event's data, batched so a fast stream doesn't flood the WebView.
    private fun readEvents(id: String, conn: HttpURLConnection) {
        val batch = JSONArray()
        var lastFlush = System.currentTimeMillis()
        fun flush() {
            if (batch.length() == 0) return
            runJs("window.onAiEvents&&window.onAiEvents(${JSONObject.quote(id)},$batch)")
            while (batch.length() > 0) batch.remove(0)
            lastFlush = System.currentTimeMillis()
        }
        conn.inputStream.bufferedReader().useLines { lines ->
            for (line in lines) {
                if (!line.startsWith("data:")) continue
                val data = line.removePrefix("data:").trim()
                if (data.isEmpty() || data == "[DONE]") continue
                batch.put(data)
                if (System.currentTimeMillis() - lastFlush >= FLUSH_MS) flush()
            }
        }
        flush()
    }

    private fun done(id: String, status: Int, body: String?) {
        runJs("window.onAiDone&&window.onAiDone(${JSONObject.quote(id)},$status,${body?.let(JSONObject::quote) ?: "null"})")
    }

    private fun secretKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(
                KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build()
            )
        }.generateKey()
    }

    // Stored as base64 of the 12-byte IV followed by the ciphertext.
    private fun encrypt(text: String): String {
        val cipher = Cipher.getInstance(CIPHER).apply { init(Cipher.ENCRYPT_MODE, secretKey()) }
        return Base64.encodeToString(cipher.iv + cipher.doFinal(text.toByteArray()), Base64.NO_WRAP)
    }

    private fun decrypt(stored: String): String {
        val bytes = Base64.decode(stored, Base64.NO_WRAP)
        val cipher = Cipher.getInstance(CIPHER).apply {
            init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, bytes, 0, 12))
        }
        return String(cipher.doFinal(bytes, 12, bytes.size - 12))
    }

    private class Provider(val baseUrl: String, val headers: (String) -> Map<String, String>)

    companion object {
        private const val PREFS = "ai_keys"
        private const val KEY_ALIAS = "ai_keys"
        private const val CIPHER = "AES/GCM/NoPadding"
        private const val FLUSH_MS = 60L
        private val PATHS = setOf("/v1/messages", "/v1/responses", "/v1/models")
        // Keyed like the page's AI_GUIDES. OpenAI and xAI share the Responses API; Anthropic has the Messages API.
        private val PROVIDERS = mapOf(
            "claude" to Provider("https://api.anthropic.com") {
                mapOf("x-api-key" to it, "anthropic-version" to "2026-10-21")
            },
            "chatgpt" to Provider("https://api.openai.com") { mapOf("Authorization" to "Bearer $it") },
            "grok" to Provider("https://api.x.ai") { mapOf("Authorization" to "Bearer $it") }
        )
    }
}
