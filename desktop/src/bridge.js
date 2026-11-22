// Injected by Tauri before any script in app/src/main/assets/index.html runs.
// Implements the same bridge surface as Android's MainActivity (MealkeeperAndroid) so the shared web UI gets
// OS-keychain AI chat, native Save/Open dialogs, local Sync Folder, clipboard auto-import, keep-screen-awake,
// and desktop theme sync with zero duplication.
(function() {
  const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args || {});
  const keys = Object.assign({gemini: false, claude: false, chatgpt: false, grok: false}, window.__INITIAL_AI_KEYS__ || {});
  let syncFolder = typeof window.__INITIAL_SYNC_FOLDER__ === 'string' ? window.__INITIAL_SYNC_FOLDER__ : '';

  function validApiKey(key) {
    if (typeof key !== 'string') return false;
    const k = key.trim();
    if (!k || k.length > 500) return false;
    for (let i = 0; i < k.length; i++) {
      const c = k.charCodeAt(i);
      if (c < 33 || c > 126) return false;
    }
    return true;
  }

  let pendingCopy = Promise.resolve();

  window.MealkeeperDesktop = true;
  window.MealkeeperAndroid = {
    copyText(text) {
      pendingCopy = invoke('copy_text', {text: String(text || '')}).catch(() => {});
    },
    setClipboardWatch(enabled) {
      invoke('set_clipboard_watch', {enabled: !!enabled}).catch(() => {});
    },

    // ---- Encrypted AI keys & streaming HTTPS (desktop/src/ai_api.rs) ----
    aiKeys() {
      return JSON.stringify(keys);
    },
    setAiKey(ai, key) {
      if (!(ai in keys) || !validApiKey(key)) return false;
      keys[ai] = true;
      invoke('set_ai_key', {ai, key: key.trim()}).catch(err => {
        keys[ai] = false;
        if (window.notify) window.notify('Could not save API key to OS keychain: ' + err);
        if (window.render) window.render();
      });
      return true;
    },
    clearAiKey(ai) {
      if (ai in keys) keys[ai] = false;
      invoke('clear_ai_key', {ai}).catch(() => {});
    },
    aiRequest(id, ai, method, path, body, beta) {
      invoke('ai_request', {
        id: String(id),
        ai: String(ai),
        method: String(method),
        path: String(path),
        body: body ? String(body) : '',
        beta: beta ? String(beta) : ''
      }).catch(err => {
        if (window.onAiDone) window.onAiDone(String(id), -1, String(err));
      });
    },
    aiCancel(id) {
      invoke('ai_cancel', {id: String(id)}).catch(() => {});
    },

    // ---- Native Save/Open file dialogs ----
    saveBackupFile(filename, json) {
      invoke('save_backup_file', {filename: String(filename), json: String(json)}).catch(() => {
        if (window.onBackupSaved) window.onBackupSaved(false);
      });
    },
    saveFile(filename, mimeType, base64) {
      invoke('save_file', {
        filename: String(filename),
        mimeType: String(mimeType || 'application/octet-stream'),
        base64: String(base64 || '')
      }).catch(() => {
        if (window.onFileSaved) window.onFileSaved(String(filename), false);
      });
    },
    openBackupFile() {
      invoke('open_backup_file').catch(() => {});
    },

    // ---- Local Sync Folder (Google Drive / OneDrive / Dropbox / Syncthing) ----
    syncFolderPath() {
      return syncFolder;
    },
    _setSyncFolderCache(p) {
      syncFolder = p || '';
    },
    pickSyncFolder() {
      invoke('pick_sync_folder').catch(() => {});
    },
    clearSyncFolder() {
      syncFolder = '';
      invoke('clear_sync_folder').catch(() => {});
    },
    openSyncFolder() {
      invoke('open_sync_folder').catch(() => {});
    },
    syncFolderPush(payloadJson) {
      invoke('sync_folder_push', {payloadJson: String(payloadJson || '{}')}).catch(() => {});
    },
    syncFolderPull(notifyEmpty) {
      invoke('sync_folder_pull', {notifyEmpty: !!notifyEmpty}).catch(() => {});
    },

    // ---- Keep screen awake, native window theme, external links ----
    setKeepScreenOn(enabled) {
      invoke('set_keep_screen_on', {enabled: !!enabled}).catch(() => {});
    },
    setAppearance(mode) {
      invoke('set_appearance', {mode: String(mode || 'light')}).catch(() => {});
    },
    openExternalUrl(url) {
      // Wait for any in-flight clipboard copy so the prompt is ready to paste as soon as the browser opens.
      pendingCopy.finally(() => {
        invoke('open_external_url', {url: String(url || '')}).catch(() => {});
      });
    }
  };

  window.addEventListener('DOMContentLoaded', () => {
    invoke('frontend_ready').catch(() => {});
  });
})();
