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
  setAppearance(mode) {
    this.calls.push(['setAppearance', mode]);
  },
  setClipboardWatch(enabled) {
    this.calls.push(['setClipboardWatch', enabled]);
  }
};
