package com.jimboyo.prompttopan

import android.app.Activity
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
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
    private var ttsStatus: Int? = null
    private var waitingText: String? = null
    private var enabled = false
    private var speaking = false
    private var speakingWords = emptySet<String>()
    private var utteranceSeq = 0
    @Volatile private var activeUtteranceId: String? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private var speakTailRunnable: Runnable? = null
    private var hasAudioFocus = false

    private val audioManager: AudioManager? by lazy {
        activity.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
    }

    private val focusRequest: AudioFocusRequest by lazy {
        AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .build()
    }

    val available: Boolean by lazy { isModelAvailable(activity) }

    fun start() {
        if (enabled) return
        enabled = true
        if (tts == null) tts = TextToSpeech(activity.applicationContext) { status ->
            mainHandler.post {
                ttsStatus = status
                if (status == TextToSpeech.SUCCESS) {
                    tts?.let { engine ->
                        val res = engine.setLanguage(Locale.getDefault())
                        if (res == TextToSpeech.LANG_MISSING_DATA || res == TextToSpeech.LANG_NOT_SUPPORTED) {
                            engine.setLanguage(Locale.US)
                        }
                    }
                    val queued = waitingText
                    waitingText = null
                    if (enabled && !queued.isNullOrBlank()) speakNow(queued)
                } else {
                    waitingText = null
                }
            }
        }.also {
            it.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {}
                override fun onDone(utteranceId: String?) = onUtteranceEnd(utteranceId, immediate = false)
                override fun onStop(utteranceId: String?, interrupted: Boolean) = onUtteranceEnd(utteranceId, immediate = true)
                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String?) = onUtteranceEnd(utteranceId, immediate = true)
                override fun onError(utteranceId: String?, errorCode: Int) = onUtteranceEnd(utteranceId, immediate = true)
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
    // own voice, so while reading, command words present in the text being read are ignored and a higher confidence
    // threshold is required to interrupt.
    fun speak(text: String) {
        if (!enabled || text.isBlank()) return
        when (ttsStatus) {
            null -> waitingText = text
            TextToSpeech.SUCCESS -> speakNow(text)
            else -> Unit
        }
    }

    private fun speakNow(text: String) {
        val engine = tts ?: return
        val max = TextToSpeech.getMaxSpeechInputLength().coerceAtLeast(1000)
        val parts = text.split(Regex("\\n+"))
            .flatMap { it.trim().chunked(max) }
            .filter { it.isNotBlank() }
        if (parts.isEmpty()) return

        cancelSpeakTail()
        speaking = true
        speakingWords = words(text)
        requestFocus()

        var lastId: String? = null
        var ok = true
        parts.forEachIndexed { index, part ->
            val id = "cook-${++utteranceSeq}"
            if (index == parts.lastIndex) {
                lastId = id
                activeUtteranceId = id
            }
            val mode = if (index == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
            if (engine.speak(part, mode, null, id) == TextToSpeech.ERROR) ok = false
        }
        if (!ok || lastId == null) {
            activeUtteranceId = null
            abandonFocus()
            doneSpeaking()
        }
    }

    fun quiet() {
        waitingText = null
        activeUtteranceId = null
        cancelSpeakTail()
        tts?.stop()
        abandonFocus()
        doneSpeaking()
    }

    fun release() {
        stop(tellPage = false)
        tts?.shutdown()
        tts = null
        ttsStatus = null
    }

    private fun onUtteranceEnd(utteranceId: String?, immediate: Boolean) {
        if (utteranceId == null || utteranceId != activeUtteranceId) return
        mainHandler.post {
            if (utteranceId != activeUtteranceId) return@post
            activeUtteranceId = null
            abandonFocus()
            if (immediate) {
                doneSpeaking()
            } else {
                // Keep echo guard briefly after TTS finishes so buffered speaker reverb doesn't self-trigger.
                cancelSpeakTail()
                val tail = Runnable {
                    speakTailRunnable = null
                    doneSpeaking()
                }
                speakTailRunnable = tail
                mainHandler.postDelayed(tail, SPEAK_TAIL_MS)
            }
        }
    }

    private fun cancelSpeakTail() {
        speakTailRunnable?.let { mainHandler.removeCallbacks(it) }
        speakTailRunnable = null
    }

    private fun requestFocus() {
        if (hasAudioFocus) return
        val result = audioManager?.requestAudioFocus(focusRequest)
        hasAudioFocus = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    private fun abandonFocus() {
        if (!hasAudioFocus) return
        audioManager?.abandonAudioFocusRequest(focusRequest)
        hasAudioFocus = false
    }

    private fun doneSpeaking() {
        speaking = false
        speakingWords = emptySet()
    }

    private fun send(event: String, text: String) =
        js("window.onCookVoice&&window.onCookVoice(${JSONObject.quote(event)},${JSONObject.quote(text)})")

    private fun words(text: String) = text.lowercase(Locale.US).split(Regex("[^a-z]+")).filter { it.isNotEmpty() }.toSet()

    // Acts on finished phrases only, and only on short, clear ones: the recognizer knows nothing but the command and
    // carrier words, so ordinary talk in the kitchen comes out as a string of [unk] with the odd word guessed between.
    private fun handle(hypothesis: String?) {
        if (!enabled) return
        val result = try { JSONObject(hypothesis ?: return) } catch (_: Exception) { return }
        val tokens = result.optString("text").trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
        val unknown = tokens.count { it == "[unk]" }
        if (tokens.size > MAX_PHRASE_WORDS || unknown > 1) return
        val minConfidence = if (speaking) MIN_CONFIDENCE_SPEAKING else MIN_CONFIDENCE
        val confident = result.optJSONArray("result")?.let { words ->
            (0 until words.length()).map { words.getJSONObject(it) }
                .filter { it.optString("word") in COMMAND_WORDS }
                .any { it.optDouble("conf", 0.0) >= minConfidence }
        } ?: false
        if (!confident) return
        val commandTokens = tokens.filter { it in COMMAND_WORDS }
        if (commandTokens.isEmpty()) return
        val text = tokens.filter { it != "[unk]" }.joinToString(" ")
        if (speaking) {
            if (commandTokens.any { it in speakingWords }) return
            quiet()
        }
        send("heard", text)
    }

    private val listener = object : RecognitionListener {
        override fun onPartialResult(hypothesis: String?) {}
        override fun onResult(hypothesis: String?) = handle(hypothesis)
        override fun onFinalResult(hypothesis: String?) = handle(hypothesis)
        override fun onError(exception: Exception?) {
            if (!enabled) return
            stop(tellPage = false)
            send("error", "mic")
        }
        override fun onTimeout() {}
    }

    companion object {
        private const val MODEL_ASSET = "model-en-us"
        private const val SAMPLE_RATE = 16000f
        // A command is a few words ("next", "go back", "show the ingredients"); longer phrases are conversation.
        private const val MAX_PHRASE_WORDS = 5
        private const val MIN_CONFIDENCE = 0.6
        private const val MIN_CONFIDENCE_SPEAKING = 0.85
        private const val SPEAK_TAIL_MS = 450L
        // Recognized words are limited to these (plus carrier words and [unk]), so "back" can't come out as "pack".
        // The page decides what they mean (parseCookCommand in cook.js).
        private val COMMAND_WORDS = setOf(
            "next", "forward", "continue", "back", "previous", "repeat", "again", "read",
            "ingredients", "ingredient", "close", "hide", "stop", "quiet", "recipe", "exit",
            "timer", "timers",
        )
        // Harmless carrier words so natural phrases ("show the ingredients", "say that again", "start the timer")
        // don't count as [unk] tokens; they never trigger commands on their own.
        private val FILLER_WORDS = setOf(
            "go", "step", "the", "show", "what", "are", "say", "that", "to", "it", "this",
            "start", "set", "a", "please", "okay", "me", "my",
        )
        private val GRAMMAR = (COMMAND_WORDS + FILLER_WORDS + setOf("[unk]")).joinToString(",", "[", "]") { "\"$it\"" }

        fun isModelAvailable(activity: Activity): Boolean =
            activity.assets.list(MODEL_ASSET)?.contains("uuid") == true

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
