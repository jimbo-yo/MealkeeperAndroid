// Feedback (Settings → Send feedback): a message with an optional name and email, posted to the developer's Google
// Form, which collects the answers in a Google Sheet. That keeps feedback anonymous unless the user adds their name
// or email, with no server of our own. On Android, MainActivity's Feedback posts it; on the web, the page does.
// Loaded before app.js, so it only uses app.js's functions when called, never at load time.

// The form's formResponse URL and each question's entry id (from the form's "Get pre-filled link"). Until the URL is
// set, Settings doesn't offer feedback.
const FEEDBACK_FORM = {
  url: '',
  message: 'entry.0',
  name: 'entry.0',
  email: 'entry.0'
};
const FEEDBACK_MAX = 5000;

let feedbackDraft = {message: '', name: '', email: ''},
  feedbackSending = false;

function feedbackPanel() {
  if (!FEEDBACK_FORM.url) return '';
  return `<div class="panel"><div class="row"><div class="recipe-icon">✉</div><div style="flex:1"><strong>Send feedback</strong><div class="muted small" style="margin-top:4px">Ideas, problems, anything. Anonymous unless you add your name or email.</div></div><button class="secondary" onclick="openFeedback()">Write</button></div></div>`
}

function openFeedback() {
  let d = feedbackDraft;
  openModal(`<h2>Send feedback</h2><p class="subhead" style="margin-bottom:12px">Tell me what you like, what's broken or what you wish Prompt to Pan did. Name and email are optional; add an email if you'd like a reply.</p><label class="field-label" for="feedback-message">Your feedback</label><textarea id="feedback-message" class="field" rows="6" maxlength="${FEEDBACK_MAX}" placeholder="What's on your mind?" oninput="feedbackDraft.message=this.value">${escapeHtml(d.message)}</textarea><label class="field-label" for="feedback-name">Name (optional)</label><input id="feedback-name" class="field" autocomplete="name" value="${escapeHtml(d.name)}" oninput="feedbackDraft.name=this.value"><label class="field-label" for="feedback-email">Email (optional)</label><input id="feedback-email" class="field" type="email" autocomplete="email" value="${escapeHtml(d.email)}" oninput="feedbackDraft.email=this.value"><div class="modal-foot"><button class="outline" onclick="closeModal()">Cancel</button><button class="primary" id="feedback-send" onclick="sendFeedback()">Send →</button></div>`)
}

function sendFeedback() {
  if (feedbackSending) return;
  let message = feedbackDraft.message.trim(), name = feedbackDraft.name.trim(), email = feedbackDraft.email.trim();
  if (!message) {
    notify('Write something first.');
    return
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    notify('That email doesn\'t look right. Fix it or leave it blank.');
    return
  }
  let body = new URLSearchParams({[FEEDBACK_FORM.message]: message, [FEEDBACK_FORM.name]: name, [FEEDBACK_FORM.email]: email}).toString();
  feedbackSending = true;
  let button = document.getElementById('feedback-send');
  if (button) button.textContent = 'Sending…';
  if (window.MealkeeperAndroid && window.MealkeeperAndroid.sendFeedback) {
    window.MealkeeperAndroid.sendFeedback(FEEDBACK_FORM.url, body);
  } else {
    // Google Forms doesn't allow cross-origin reads, so the web can't see the reply; a network error still shows.
    fetch(FEEDBACK_FORM.url, {method: 'POST', mode: 'no-cors', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body})
      .then(() => window.onFeedbackSent(true), () => window.onFeedbackSent(false));
  }
}

// Called by MainActivity's Feedback, or by the web fetch above. A failed send keeps the draft to try again.
window.onFeedbackSent = ok => {
  feedbackSending = false;
  if (ok) {
    feedbackDraft = {message: '', name: '', email: ''};
    closeModal();
    notify('Thanks! Your feedback was sent.', 3500);
  } else {
    let button = document.getElementById('feedback-send');
    if (button) button.textContent = 'Send →';
    notify('Couldn\'t send your feedback. Check your connection and try again.', 4500);
  }
};
