package com.jimboyo.prompttopan

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import org.json.JSONObject

// Talking with the chat: the phone's speech recognizer for the mic button and text-to-speech for the replies (see
// the voice section of chat.js). Call everything on the main thread, which SpeechRecognizer requires. The page hears
// back through window.onVoice(event, text): "listening", "partial" and "result" with what was heard, "error" with a
// reason ("silence", "denied", "network", "busy" or "other"), "spoken" when a reply has been read out, and
// "stopped" when the app stopped everything itself (see stop).
class Voice(private val activity: Activity, private val js: (String) -> Unit) {
    private var recognizer: SpeechRecognizer? = null
    private var tts: TextToSpeech? = null
    // TextToSpeech's status once it has started up (null until then).
    private var ttsStatus: Int? = null
    // A reply that arrived while text-to-speech was still starting up.
    private var waitingText: String? = null
    // The last part of the reply being read; UtteranceProgressListener calls back on another thread.
    @Volatile private var lastUtterance: String? = null
    private var utteranceCount = 0

    val available: Boolean by lazy { SpeechRecognizer.isRecognitionAvailable(activity) }

    fun listen() {
        stopSpeaking()
        val r = recognizer ?: SpeechRecognizer.createSpeechRecognizer(activity).also {
            it.setRecognitionListener(listener)
            recognizer = it
        }
        r.cancel()
        r.startListening(
            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, activity.packageName)
        )
    }

    // Stops listening and sends what was heard so far as the result.
    fun finishListening() {
        recognizer?.stopListening()
    }

    fun speak(text: String) {
        recognizer?.cancel()
        when {
            tts == null -> {
                waitingText = text
                tts = TextToSpeech(activity) { status ->
                    ttsStatus = status
                    val waiting = waitingText ?: return@TextToSpeech
                    waitingText = null
                    if (status == TextToSpeech.SUCCESS) speakNow(waiting) else send("spoken")
                }.apply { setOnUtteranceProgressListener(progress) }
            }
            ttsStatus == null -> waitingText = text
            ttsStatus == TextToSpeech.SUCCESS -> speakNow(text)
            // Text-to-speech didn't start, so the reply just isn't read out.
            else -> send("spoken")
        }
    }

    // Long replies are read a paragraph at a time: each piece has to fit TextToSpeech's input limit.
    private fun speakNow(text: String) {
        val t = tts ?: return
        val max = TextToSpeech.getMaxSpeechInputLength()
        val parts = text.split(Regex("\\n+")).map { it.trim().take(max) }.filter { it.isNotEmpty() }
        if (parts.isEmpty()) {
            send("spoken")
            return
        }
        t.stop()
        parts.forEachIndexed { i, part ->
            val id = "reply${++utteranceCount}"
            if (i == parts.lastIndex) lastUtterance = id
            t.speak(part, if (i == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD, null, id)
        }
    }

    fun stopSpeaking() {
        waitingText = null
        lastUtterance = null
        tts?.stop()
    }

    // Leaving the app or the chat: stop listening and talking.
    fun stop(tellPage: Boolean) {
        recognizer?.cancel()
        stopSpeaking()
        if (tellPage) send("stopped")
    }

    fun release() {
        recognizer?.destroy()
        recognizer = null
        tts?.shutdown()
        tts = null
    }

    private fun send(event: String, text: String = "") =
        js("window.onVoice&&window.onVoice('$event',${JSONObject.quote(text)})")

    private fun heard(results: Bundle?): String =
        results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) = send("listening")
        override fun onPartialResults(partialResults: Bundle?) = send("partial", heard(partialResults))
        override fun onResults(results: Bundle?) {
            val text = heard(results)
            if (text.isBlank()) send("error", "silence") else send("result", text)
        }

        override fun onError(error: Int) = send(
            "error", when (error) {
                SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "silence"
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "denied"
                SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT, SpeechRecognizer.ERROR_SERVER -> "network"
                SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "busy"
                else -> "other"
            }
        )

        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    private val progress = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) {}
        override fun onDone(utteranceId: String?) = finished(utteranceId)
        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String?) = finished(utteranceId)
        override fun onError(utteranceId: String?, errorCode: Int) = finished(utteranceId)

        private fun finished(utteranceId: String?) {
            if (utteranceId == null || utteranceId != lastUtterance) return
            lastUtterance = null
            send("spoken")
        }
    }
}
