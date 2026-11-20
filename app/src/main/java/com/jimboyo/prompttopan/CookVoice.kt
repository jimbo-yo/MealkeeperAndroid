package com.jimboyo.prompttopan

import android.app.Activity
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import org.json.JSONObject
import org.vosk.LibVosk
import org.vosk.LogLevel
import org.vosk.Model
import org.vosk.Recognizer
import org.vosk.android.RecognitionListener
import org.vosk.android.SpeechService
import org.vosk.android.StorageService
import java.util.Locale

// Hands-free Cook mode (cook.js): an offline recognizer (Vosk, with the model bundled in assets/model-en-us) that
// listens continuously for a few command words, and text-to-speech for reading steps aloud. Unlike the chat's Voice,
// nothing leaves the phone and the phone's own recognizer (which beeps every time it restarts) isn't used.
// The page hears back through window.onCookVoice(event, text): "listening", "heard" with the words, "error" with a
// reason ("model" or "mic"), and "stopped" when the app stopped it itself (see stop). Call everything on the main thread.
class CookVoice(private val activity: Activity, private val js: (String) -> Unit) {
    private var recognizer: Recognizer? = null
    private var service: SpeechService? = null
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var enabled = false
    private var speaking = false
    private var speakingWords = emptySet<String>()

    val available: Boolean by lazy { activity.assets.list(MODEL_ASSET)?.contains("uuid") == true }

    fun start() {
        if (enabled) return
        enabled = true
        if (tts == null) tts = TextToSpeech(activity.applicationContext) { status ->
            activity.runOnUiThread {
                ttsReady = status == TextToSpeech.SUCCESS
                if (ttsReady) tts?.language = Locale.getDefault()
            }
        }.also {
            it.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {}
                override fun onDone(utteranceId: String?) = activity.runOnUiThread { doneSpeaking() }
                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String?) = activity.runOnUiThread { doneSpeaking() }
            })
        }
        loadModel { model ->
            if (!enabled) return@loadModel
            if (model == null) {
                enabled = false
                send("error", "model")
                return@loadModel
            }
            try {
                val rec = Recognizer(model, SAMPLE_RATE, GRAMMAR).also { it.setWords(true) }   // confidence per word
                recognizer = rec
                service = SpeechService(rec, SAMPLE_RATE).also { it.startListening(listener) }
                send("listening", "")
            } catch (e: Exception) {
                stop(tellPage = false)
                send("error", "mic")
            }
        }
    }

    // tellPage: the app stopped it (it went to the background), so the page should show voice as off.
    fun stop(tellPage: Boolean) {
        val wasOn = enabled
        enabled = false
        service?.stop()
        service?.shutdown()
        service = null
        recognizer?.close()
        recognizer = null
        quiet()
        if (tellPage && wasOn) send("stopped", "")
    }

    // Reads text aloud while still listening, so a command can interrupt it. The microphone also hears the phone's
    // own voice, so while reading, a command word that appears in the text being read is ignored.
    fun speak(text: String) {
        if (!ttsReady) return
        speaking = true
        speakingWords = words(text)
        tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "cook-step")
    }

    fun quiet() {
        tts?.stop()
        doneSpeaking()
    }

    fun release() {
        stop(tellPage = false)
        tts?.shutdown()
        tts = null
    }

    private fun doneSpeaking() {
        speaking = false
        speakingWords = emptySet()
    }

    private fun send(event: String, text: String) =
        js("window.onCookVoice&&window.onCookVoice(${JSONObject.quote(event)},${JSONObject.quote(text)})")

    private fun words(text: String) = text.lowercase(Locale.US).split(Regex("[^a-z]+")).filter { it.isNotEmpty() }.toSet()

    // Acts on finished phrases only, and only on short, clear ones: the recognizer knows nothing but the command words,
    // so ordinary talk in the kitchen comes out as a string of [unk] with the odd command word guessed in between.
    private fun handle(hypothesis: String?) {
        val result = try { JSONObject(hypothesis ?: return) } catch (_: Exception) { return }
        val tokens = result.optString("text").trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
        val unknown = tokens.count { it == "[unk]" }
        if (tokens.size > MAX_PHRASE_WORDS || unknown > 1) return
        val confident = result.optJSONArray("result")?.let { words ->
            (0 until words.length()).map { words.getJSONObject(it) }
                .filter { it.optString("word") in COMMAND_WORDS }
                .any { it.optDouble("conf", 0.0) >= MIN_CONFIDENCE }
        } ?: false
        if (!confident) return
        val text = tokens.filter { it != "[unk]" }.joinToString(" ")
        if (speaking) {
            if (words(text).any { it in speakingWords }) return
            quiet()
        }
        send("heard", text)
    }

    private val listener = object : RecognitionListener {
        override fun onPartialResult(hypothesis: String?) {}
        override fun onResult(hypothesis: String?) = handle(hypothesis)
        override fun onFinalResult(hypothesis: String?) = handle(hypothesis)
        override fun onError(exception: Exception?) {
            stop(tellPage = false)
            send("error", "mic")
        }
        override fun onTimeout() {}
    }

    companion object {
        private const val MODEL_ASSET = "model-en-us"
        private const val SAMPLE_RATE = 16000f
        // A command is a few words ("next", "go back", "show the ingredients"); longer phrases are conversation.
        private const val MAX_PHRASE_WORDS = 4
        private const val MIN_CONFIDENCE = 0.6
        // Recognized words are limited to these (plus [unk] for anything else), so "back" can't come out as "pack".
        // The page decides what they mean (parseCookCommand in cook.js); "go" and "step" only appear in phrases.
        private val COMMAND_WORDS = setOf(
            "next", "forward", "continue", "back", "previous", "repeat", "again", "read",
            "ingredients", "ingredient", "close", "hide", "stop", "quiet", "recipe", "exit",
        )
        private val GRAMMAR = (COMMAND_WORDS + setOf("go", "step", "[unk]")).joinToString(",", "[", "]") { "\"$it\"" }

        // The model is unpacked from assets once and kept for the life of the process (it takes a moment to load).
        private var model: Model? = null
        private var loading = false
        private val waiting = mutableListOf<(Model?) -> Unit>()

        private fun loadModel(context: Activity, done: (Model?) -> Unit) {
            model?.let { done(it); return }
            waiting += done
            if (loading) return
            loading = true
            LibVosk.setLogLevel(LogLevel.WARNINGS)
            StorageService.unpack(context.applicationContext, MODEL_ASSET, "model",
                { m -> model = m; finish(m) },
                { _ -> finish(null) })
        }

        private fun finish(m: Model?) {
            loading = false
            val callbacks = waiting.toList()
            waiting.clear()
            callbacks.forEach { it(m) }
        }
    }

    private fun loadModel(done: (Model?) -> Unit) = loadModel(activity, done)
}
