// Stand-in for MainActivity's MealkeeperBridge. Loaded before app.js; records each call so tests can check them.
window.MealkeeperAndroid = {
  calls: [],
  setKeepScreenOn(enabled) {
    this.calls.push(['setKeepScreenOn', enabled]);
  },
  saveBackupFile(filename, json) {
    this.calls.push(['saveBackupFile', filename, json]);
  },
  openBackupFile() {
    this.calls.push(['openBackupFile']);
  },
  shareText(text, title) {
    this.calls.push(['shareText', text, title]);
  },
  // Whether a clock app takes setAlarm (tests set this).
  alarmResult: true,
  setAlarm(hour, minutes, label) {
    this.calls.push(['setAlarm', hour, minutes, label]);
    return this.alarmResult;
  },
  // What sendToAiApp reports: 'shared', 'opened' or 'missing' (tests set this).
  aiAppResult: 'shared',
  sendToAiApp(ai, text) {
    this.calls.push(['sendToAiApp', ai, text]);
    return this.aiAppResult;
  },
  openAiApp(ai) {
    this.calls.push(['openAiApp', ai]);
    return this.aiAppResult !== 'missing';
  },
  copyText(text) {
    this.calls.push(['copyText', text]);
  },
  shareMeal(fileName, json, text, title) {
    this.calls.push(['shareMeal', fileName, json, text, title]);
  },
  setAppearance(mode) {
    this.calls.push(['setAppearance', mode]);
  },
  setClipboardWatch(enabled) {
    this.calls.push(['setClipboardWatch', enabled]);
  },
  // API keys: which AIs have one (tests set this; the keys themselves aren't kept).
  keys: {},
  aiKeys() {
    return JSON.stringify(this.keys);
  },
  setAiKey(ai, key) {
    this.calls.push(['setAiKey', ai, key]);
    if (!key.trim()) return false;
    this.keys[ai] = true;
    return true;
  },
  clearAiKey(ai) {
    this.calls.push(['clearAiKey', ai]);
    delete this.keys[ai];
  },
  // Recorded with the body parsed; tests answer through window.onAiEvents / window.onAiDone.
  aiRequest(id, ai, method, path, body, beta) {
    this.calls.push(['aiRequest', id, ai, method, path, body ? JSON.parse(body) : null, beta]);
  },
  aiCancel(id) {
    this.calls.push(['aiCancel', id]);
  }
};
