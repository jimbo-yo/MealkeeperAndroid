#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai_api;
mod sync_folder;

use ai_api::AiApi;
use base64::Engine;
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use sync_folder::{SyncFolder, SyncPushPayload};
use tauri::{Manager, State, Theme, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

const MAX_IMPORT_BYTES: u64 = 20_000_000;
const MAX_CLIP_CHARS: usize = 500_000;
const BRIDGE_JS: &str = include_str!("bridge.js");

struct AppState {
    ai: AiApi,
    sync: SyncFolder,
    awake: Mutex<Option<keepawake::KeepAwake>>,
    startup_file: Mutex<Option<PathBuf>>,
    clip_watch: AtomicBool,
    last_clip: Mutex<String>,
    ready: AtomicBool,
}

#[tauri::command]
fn set_ai_key(state: State<'_, AppState>, ai: String, key: String) -> Result<(), String> {
    state.ai.set_key(&ai, &key)
}

#[tauri::command]
fn clear_ai_key(state: State<'_, AppState>, ai: String) -> Result<(), String> {
    state.ai.clear_key(&ai)
}

#[tauri::command]
fn ai_request(
    window: WebviewWindow,
    state: State<'_, AppState>,
    id: String,
    ai: String,
    method: String,
    path: String,
    body: String,
    beta: String,
) {
    state.ai.request(window, id, ai, method, path, body, beta);
}

#[tauri::command]
fn ai_cancel(state: State<'_, AppState>, id: String) {
    state.ai.cancel(&id);
}

#[tauri::command]
fn save_backup_file(window: WebviewWindow, filename: String, json: String) {
    tauri::async_runtime::spawn_blocking(move || {
        let picked = rfd::FileDialog::new()
            .set_file_name(&filename)
            .add_filter("Prompt to Pan JSON", &["json"])
            .save_file();
        let Some(path) = picked else { return };
        let ok = fs::write(path, json.as_bytes()).is_ok();
        let _ = window.eval(&format!("window.onBackupSaved&&window.onBackupSaved({ok})"));
    });
}

#[tauri::command]
fn save_file(window: WebviewWindow, filename: String, _mime_type: String, base64: String) {
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(base64.trim()) else {
            return;
        };
        let picked = rfd::FileDialog::new().set_file_name(&filename).save_file();
        let Some(path) = picked else { return };
        let ok = fs::write(path, &bytes).is_ok();
        let name_js = json!(filename);
        let _ = window.eval(&format!("window.onFileSaved&&window.onFileSaved({name_js},{ok})"));
    });
}

#[tauri::command]
fn open_backup_file(window: WebviewWindow) {
    tauri::async_runtime::spawn_blocking(move || {
        let picked = rfd::FileDialog::new()
            .add_filter("Prompt to Pan files", &["json"])
            .add_filter("All files", &["*"])
            .pick_file();
        let Some(path) = picked else { return };
        let text = read_limited_text(&path);
        let script = match text {
            Some(content) => {
                let quoted = json!(content);
                format!("window.receiveBackupFile&&window.receiveBackupFile({quoted})")
            }
            None => {
                let msg = json!("Couldn't read that file. It may be too big or not a backup.");
                format!("window.notify&&window.notify({msg})")
            }
        };
        let _ = window.eval(&script);
    });
}

#[tauri::command]
fn set_keep_screen_on(state: State<'_, AppState>, enabled: bool) {
    if let Ok(mut guard) = state.awake.lock() {
        if enabled {
            if guard.is_none() {
                *guard = keepawake::Builder::default()
                    .display(true)
                    .idle(true)
                    .reason("Cooking with Prompt to Pan")
                    .app_name("Prompt to Pan")
                    .create()
                    .ok();
            }
        } else {
            *guard = None;
        }
    }
}

#[tauri::command]
fn set_appearance(window: WebviewWindow, mode: String) {
    let theme = match mode.as_str() {
        "dark" => Some(Theme::Dark),
        "light" => Some(Theme::Light),
        _ => None, // "match" follows the OS theme
    };
    let _ = window.set_theme(theme);
}

#[tauri::command]
fn set_clipboard_watch(state: State<'_, AppState>, enabled: bool) {
    state.clip_watch.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
fn copy_text(state: State<'_, AppState>, text: String) -> Result<(), String> {
    if let Ok(mut last) = state.last_clip.lock() {
        *last = text.clone();
    }
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.set_text(text).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:") {
        open::that(&url).map_err(|e| e.to_string())
    } else {
        Err("unsupported url scheme".into())
    }
}

// ---- Local Sync Folder (works with Google Drive for Desktop, OneDrive, Dropbox, Syncthing) ----

#[tauri::command]
fn pick_sync_folder(window: WebviewWindow) {
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new().set_title("Choose Prompt to Pan sync folder");
        if let Some(cur) = app.state::<AppState>().sync.current_path() {
            let p = PathBuf::from(cur);
            if p.is_dir() {
                dialog = dialog.set_directory(p);
            }
        }
        let Some(picked) = dialog.pick_folder() else {
            return;
        };
        let state = app.state::<AppState>();
        match state.sync.set_path(Some(picked)) {
            Ok(Some(path_str)) => {
                let p_js = json!(path_str);
                let _ = window.eval(&format!(
                    "window.onSyncFolderChanged&&window.onSyncFolderChanged({p_js})"
                ));
                trigger_sync_pull(&window, &state, true);
            }
            Ok(None) => {}
            Err(err) => {
                let msg = json!(format!("Could not use that folder: {err}"));
                let _ = window.eval(&format!("window.notify&&window.notify({msg})"));
            }
        }
    });
}

#[tauri::command]
fn clear_sync_folder(window: WebviewWindow, state: State<'_, AppState>) {
    let _ = state.sync.set_path(None);
    let _ = window.eval("window.onSyncFolderChanged&&window.onSyncFolderChanged('')");
}

#[tauri::command]
fn open_sync_folder(state: State<'_, AppState>) -> Result<(), String> {
    let Some(path) = state.sync.current_path() else {
        return Err("No sync folder configured".into());
    };
    open::that(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn sync_folder_push(window: WebviewWindow, payload_json: String) {
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(payload) = serde_json::from_str::<SyncPushPayload>(&payload_json) else {
            return;
        };
        let state = app.state::<AppState>();
        if let Err(err) = state.sync.push(&payload) {
            let msg = json!(format!("Sync folder write paused: {err}"));
            let _ = window.eval(&format!("window.notify&&window.notify({msg})"));
        }
    });
}

#[tauri::command]
fn sync_folder_pull(window: WebviewWindow, notify_empty: bool) {
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        trigger_sync_pull(&window, &state, notify_empty);
    });
}

fn trigger_sync_pull(window: &WebviewWindow, state: &AppState, notify_empty: bool) {
    match state.sync.pull() {
        Ok(Some(result)) => {
            if let Ok(payload) = serde_json::to_string(&result) {
                let _ = window.eval(&format!(
                    "window.receiveSyncFolder&&window.receiveSyncFolder({payload},{notify_empty})"
                ));
            }
        }
        Ok(None) => {}
        Err(err) => {
            if notify_empty {
                let msg = json!(format!("Couldn't read sync folder: {err}"));
                let _ = window.eval(&format!("window.notify&&window.notify({msg})"));
            }
        }
    }
}

fn check_clipboard_on_focus(window: &WebviewWindow, state: &AppState) {
    if !state.ready.load(Ordering::Relaxed) || !state.clip_watch.load(Ordering::Relaxed) {
        return;
    }
    let Ok(mut clipboard) = arboard::Clipboard::new() else {
        return;
    };
    let Ok(text) = clipboard.get_text() else {
        return;
    };
    if text.is_empty() || text.len() > MAX_CLIP_CHARS {
        return;
    }
    {
        let Ok(mut last) = state.last_clip.lock() else {
            return;
        };
        if *last == text {
            return;
        }
        *last = text.clone();
    }
    if !(text.contains("\"meals\"") || text.contains("\"recipes\"")) {
        return;
    }
    let quoted = json!(text);
    let _ = window.eval(&format!(
        "window.receiveClipboardText&&window.receiveClipboardText({quoted})"
    ));
}

#[tauri::command]
fn frontend_ready(window: WebviewWindow, state: State<'_, AppState>) {
    state.ready.store(true, Ordering::Relaxed);
    let path = state.startup_file.lock().ok().and_then(|mut g| g.take());
    if let Some(p) = path {
        if let Some(text) = read_limited_text(&p) {
            let quoted = json!(text);
            let _ = window.eval(&format!(
                "window.receiveSharedText&&window.receiveSharedText({quoted})"
            ));
        }
    }
    // Pull any updates from the configured sync folder on startup.
    let app = window.app_handle().clone();
    let win = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        trigger_sync_pull(&win, &state, false);
    });
}

fn read_limited_text(path: &PathBuf) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if meta.len() > MAX_IMPORT_BYTES {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn is_internal_url(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" | "about" | "data" | "blob" => true,
        "http" | "https" => matches!(
            url.host_str(),
            Some("tauri.localhost" | "localhost" | "127.0.0.1")
        ),
        _ => false,
    }
}

fn main() {
    let startup_file = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .filter(|p| p.is_file());

    let ai = AiApi::new();
    let initial_keys = ai.key_status_json();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            set_ai_key,
            clear_ai_key,
            ai_request,
            ai_cancel,
            save_backup_file,
            save_file,
            open_backup_file,
            set_keep_screen_on,
            set_appearance,
            set_clipboard_watch,
            copy_text,
            open_external_url,
            pick_sync_folder,
            clear_sync_folder,
            open_sync_folder,
            sync_folder_push,
            sync_folder_pull,
            frontend_ready,
        ])
        .setup(move |app| {
            let config_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("prompt-to-pan"));
            let sync = SyncFolder::new(config_dir);
            let initial_sync = sync.current_path().unwrap_or_default();
            let init_script = format!(
                "window.__INITIAL_AI_KEYS__={initial_keys};\nwindow.__INITIAL_SYNC_FOLDER__={};\n{BRIDGE_JS}",
                json!(initial_sync)
            );

            // Seed last_clip with whatever is already on the clipboard at startup so we don't offer stale clips.
            let initial_clip = arboard::Clipboard::new()
                .ok()
                .and_then(|mut c| c.get_text().ok())
                .unwrap_or_default();

            app.manage(AppState {
                ai,
                sync,
                awake: Mutex::new(None),
                startup_file: Mutex::new(startup_file),
                clip_watch: AtomicBool::new(true),
                last_clip: Mutex::new(initial_clip),
                ready: AtomicBool::new(false),
            });

            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Prompt to Pan")
                .inner_size(1120.0, 780.0)
                .min_inner_size(420.0, 600.0)
                .visible(true)
                .initialization_script(&init_script)
                .on_navigation(|url| {
                    if is_internal_url(url) {
                        true
                    } else {
                        if matches!(url.scheme(), "http" | "https" | "mailto") {
                            let _ = open::that(url.as_str());
                        }
                        false
                    }
                })
                .build()?;

            let focus_win = win.clone();
            win.on_window_event(move |event| {
                if let WindowEvent::Focused(true) = event {
                    let w = focus_win.clone();
                    let handle = focus_win.app_handle().clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        let state = handle.state::<AppState>();
                        check_clipboard_on_focus(&w, &state);
                        if state.ready.load(Ordering::Relaxed) {
                            trigger_sync_pull(&w, &state, false);
                        }
                    });
                }
            });

            let _ = win.show();
            let _ = win.set_focus();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Prompt to Pan desktop");
}
