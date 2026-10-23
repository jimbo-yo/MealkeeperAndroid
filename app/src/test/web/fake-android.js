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
  openInChatGPT(prompt) {
    this.calls.push(['openInChatGPT', prompt]);
  },
  copyText(text) {
    this.calls.push(['copyText', text]);
  },
  setClipboardWatch(enabled) {
    this.calls.push(['setClipboardWatch', enabled]);
  }
};
