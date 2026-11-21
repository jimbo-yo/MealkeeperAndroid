#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai_api;

use ai_api::AiApi;
use base64::Engine;
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{State, Theme, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const MAX_IMPORT_BYTES: u64 = 20_000_000;
const BRIDGE_JS: &str = include_str!("bridge.js");

struct AppState {
    ai: AiApi,
    awake: Mutex<Option<keepawake::KeepAwake>>,
    startup_file: Mutex<Option<PathBuf>>,
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
fn copy_text(text: String) -> Result<(), String> {
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

#[tauri::command]
fn frontend_ready(window: WebviewWindow, state: State<'_, AppState>) {
    let path = state.startup_file.lock().ok().and_then(|mut g| g.take());
    if let Some(p) = path {
        if let Some(text) = read_limited_text(&p) {
            let quoted = json!(text);
            let _ = window.eval(&format!(
                "window.receiveSharedText&&window.receiveSharedText({quoted})"
            ));
        }
    }
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
        "http" | "https" => matches!(url.host_str(), Some("tauri.localhost" | "localhost" | "127.0.0.1")),
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
    let init_script = format!("window.__INITIAL_AI_KEYS__={initial_keys};\n{BRIDGE_JS}");

    let state = AppState {
        ai,
        awake: Mutex::new(None),
        startup_file: Mutex::new(startup_file),
    };

    tauri::Builder::default()
        .manage(state)
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
            copy_text,
            open_external_url,
            frontend_ready,
        ])
        .setup(move |app| {
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
            let _ = win.show();
            let _ = win.set_focus();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Prompt to Pan desktop");
}
