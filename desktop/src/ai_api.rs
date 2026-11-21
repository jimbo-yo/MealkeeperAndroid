use futures_util::StreamExt;
use keyring::Entry;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::async_runtime::JoinHandle;
use tauri::WebviewWindow;

const KEYRING_SERVICE: &str = "com.jimboyo.prompttopan";
const FLUSH_INTERVAL: Duration = Duration::from_millis(60);
const ALLOWED_PATHS: &[&str] = &["/v1/messages", "/v1/responses", "/v1/chat/completions", "/v1/models"];
const PROVIDERS: &[&str] = &["gemini", "claude", "chatgpt", "grok"];

pub struct AiApi {
    client: reqwest::Client,
    active: Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
}

impl AiApi {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(180))
            .build()
            .expect("failed to build HTTP client");
        Self {
            client,
            active: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn key_status_json(&self) -> Value {
        let mut map = serde_json::Map::new();
        for &ai in PROVIDERS {
            let present = self.get_key(ai).is_some();
            map.insert(ai.to_string(), Value::Bool(present));
        }
        Value::Object(map)
    }

    pub fn set_key(&self, ai: &str, key: &str) -> Result<(), String> {
        let trimmed = key.trim();
        if !is_valid_provider(ai) || !is_valid_key(trimmed) {
            return Err("Invalid API key".into());
        }
        let entry = Entry::new(KEYRING_SERVICE, ai).map_err(|e| e.to_string())?;
        entry.set_password(trimmed).map_err(|e| e.to_string())
    }

    pub fn clear_key(&self, ai: &str) -> Result<(), String> {
        if !is_valid_provider(ai) {
            return Ok(());
        }
        let entry = Entry::new(KEYRING_SERVICE, ai).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    fn get_key(&self, ai: &str) -> Option<String> {
        let entry = Entry::new(KEYRING_SERVICE, ai).ok()?;
        entry.get_password().ok().filter(|k| !k.trim().is_empty())
    }

    pub fn request(
        &self,
        window: WebviewWindow,
        id: String,
        ai: String,
        method: String,
        path: String,
        body: String,
        beta: String,
    ) {
        if !is_valid_provider(&ai)
            || !ALLOWED_PATHS.contains(&path.as_str())
            || (method != "GET" && method != "POST")
        {
            emit_done(&window, &id, -1, Some("bad request"));
            return;
        }
        let Some(key) = self.get_key(&ai) else {
            emit_done(&window, &id, 0, None);
            return;
        };

        let client = self.client.clone();
        let active = self.active.clone();
        let task_id = id.clone();

        let handle = tauri::async_runtime::spawn(async move {
            let res = run_request(&client, &window, &task_id, &ai, &method, &path, &body, &beta, &key).await;
            if let Ok(mut map) = active.lock() {
                map.remove(&task_id);
            }
            if let Err(err) = res {
                emit_done(&window, &task_id, -1, Some(&err));
            }
        });

        if let Ok(mut map) = self.active.lock() {
            if let Some(prev) = map.insert(id, handle) {
                prev.abort();
            }
        }
    }

    pub fn cancel(&self, id: &str) {
        if let Ok(mut map) = self.active.lock() {
            if let Some(handle) = map.remove(id) {
                handle.abort();
            }
        }
    }
}

fn is_valid_provider(ai: &str) -> bool {
    PROVIDERS.contains(&ai)
}

fn is_valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 500 && key.bytes().all(|b| (33..=126).contains(&b))
}

fn provider_url(ai: &str, path: &str) -> Option<String> {
    match ai {
        "gemini" => Some(format!(
            "https://generativelanguage.googleapis.com/v1beta/openai{}",
            path.strip_prefix("/v1").unwrap_or(path)
        )),
        "claude" => Some(format!("https://api.anthropic.com{path}")),
        "chatgpt" => Some(format!("https://api.openai.com{path}")),
        "grok" => Some(format!("https://api.x.ai{path}")),
        _ => None,
    }
}

fn provider_headers(ai: &str, key: &str, beta: &str) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    match ai {
        "claude" => {
            headers.insert(
                HeaderName::from_static("x-api-key"),
                HeaderValue::from_str(key).map_err(|e| e.to_string())?,
            );
            headers.insert(
                HeaderName::from_static("anthropic-version"),
                HeaderValue::from_static("2026-10-21"),
            );
            if !beta.is_empty() {
                headers.insert(
                    HeaderName::from_static("anthropic-beta"),
                    HeaderValue::from_str(beta).map_err(|e| e.to_string())?,
                );
            }
        }
        "gemini" | "chatgpt" | "grok" => {
            headers.insert(
                reqwest::header::AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {key}")).map_err(|e| e.to_string())?,
            );
        }
        _ => return Err("unknown provider".into()),
    }
    Ok(headers)
}

#[allow(clippy::too_many_arguments)]
async fn run_request(
    client: &reqwest::Client,
    window: &WebviewWindow,
    id: &str,
    ai: &str,
    method: &str,
    path: &str,
    body: &str,
    beta: &str,
    key: &str,
) -> Result<(), String> {
    let url = provider_url(ai, path).ok_or_else(|| "unknown provider".to_string())?;
    let headers = provider_headers(ai, key, beta)?;

    let mut req = match method {
        "GET" => client.get(&url),
        "POST" => client
            .post(&url)
            .header(CONTENT_TYPE, "application/json")
            .body(body.to_string()),
        _ => return Err("bad method".into()),
    };
    req = req.headers(headers);

    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16() as i32;
    let is_sse = resp
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|ct| ct.to_ascii_lowercase().starts_with("text/event-stream"))
        .unwrap_or(false);

    if (200..=299).contains(&status) && is_sse {
        let mut stream = resp.bytes_stream();
        let mut pending_bytes: Vec<u8> = Vec::new();
        let mut batch: Vec<String> = Vec::new();
        let mut last_flush = Instant::now();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            pending_bytes.extend_from_slice(&chunk);

            while let Some(pos) = pending_bytes.iter().position(|&b| b == b'\n') {
                let mut line_bytes: Vec<u8> = pending_bytes.drain(..=pos).collect();
                if line_bytes.ends_with(b"\n") {
                    line_bytes.pop();
                }
                if line_bytes.ends_with(b"\r") {
                    line_bytes.pop();
                }
                if let Ok(line) = std::str::from_utf8(&line_bytes) {
                    if let Some(data) = parse_sse_data_line(line) {
                        batch.push(data.to_string());
                        if last_flush.elapsed() >= FLUSH_INTERVAL {
                            emit_events(window, id, &batch);
                            batch.clear();
                            last_flush = Instant::now();
                        }
                    }
                }
            }
        }

        if !pending_bytes.is_empty() {
            if let Ok(line) = std::str::from_utf8(&pending_bytes) {
                if let Some(data) = parse_sse_data_line(line.trim_end_matches('\r')) {
                    batch.push(data.to_string());
                }
            }
        }
        if !batch.is_empty() {
            emit_events(window, id, &batch);
        }
        emit_done(window, id, status, None);
    } else {
        let text = resp.text().await.unwrap_or_default();
        emit_done(window, id, status, Some(&text));
    }

    Ok(())
}

fn parse_sse_data_line(line: &str) -> Option<&str> {
    let data = line.strip_prefix("data:")?.trim();
    if data.is_empty() || data == "[DONE]" {
        None
    } else {
        Some(data)
    }
}

fn emit_events(window: &WebviewWindow, id: &str, batch: &[String]) {
    if batch.is_empty() {
        return;
    }
    let id_js = json!(id);
    let batch_js = json!(batch);
    let script = format!("window.onAiEvents&&window.onAiEvents({id_js},{batch_js})");
    let _ = window.eval(&script);
}

fn emit_done(window: &WebviewWindow, id: &str, status: i32, body: Option<&str>) {
    let id_js = json!(id);
    let body_js = match body {
        Some(b) => json!(b).to_string(),
        None => "null".to_string(),
    };
    let script = format!("window.onAiDone&&window.onAiDone({id_js},{status},{body_js})");
    let _ = window.eval(&script);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_keys_and_providers() {
        assert!(is_valid_provider("gemini"));
        assert!(is_valid_provider("claude"));
        assert!(is_valid_provider("chatgpt"));
        assert!(is_valid_provider("grok"));
        assert!(!is_valid_provider("other"));

        assert_eq!(
            provider_url("gemini", "/v1/chat/completions").as_deref(),
            Some("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions")
        );
        assert_eq!(
            provider_url("gemini", "/v1/models").as_deref(),
            Some("https://generativelanguage.googleapis.com/v1beta/openai/models")
        );

        assert!(is_valid_key("sk-ant-123456"));
        assert!(!is_valid_key(""));
        assert!(!is_valid_key("sk-has space"));
        assert!(!is_valid_key("sk-has\nnewline"));
        assert!(!is_valid_key(&"a".repeat(501)));
    }

    #[test]
    fn builds_provider_headers() {
        let h = provider_headers("claude", "sk-test", "beta-1").unwrap();
        assert_eq!(h.get("x-api-key").unwrap(), "sk-test");
        assert_eq!(h.get("anthropic-version").unwrap(), "2026-10-21");
        assert_eq!(h.get("anthropic-beta").unwrap(), "beta-1");

        let o = provider_headers("chatgpt", "sk-openai", "").unwrap();
        assert_eq!(o.get("authorization").unwrap(), "Bearer sk-openai");
    }

    #[test]
    fn parses_sse_lines() {
        assert_eq!(parse_sse_data_line("data: {\"type\":\"ping\"}"), Some("{\"type\":\"ping\"}"));
        assert_eq!(parse_sse_data_line("data: [DONE]"), None);
        assert_eq!(parse_sse_data_line("data:   "), None);
        assert_eq!(parse_sse_data_line("event: message_start"), None);
    }
}
