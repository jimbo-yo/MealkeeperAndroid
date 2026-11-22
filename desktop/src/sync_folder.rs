use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

const CONFIG_FILE: &str = "sync-folder.txt";
const KEEPERS_FILE: &str = "keepers.prompttopan.json";
const MEAL_ENDING: &str = ".prompttopan.json";
const MAX_SYNC_FILE_BYTES: u64 = 5_000_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPushPayload {
    pub meals: Vec<SyncMealWrite>,
    pub keepers_json: Option<String>,
    #[serde(default)]
    pub remove_files: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncMealWrite {
    pub filename: String,
    pub json: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPushResult {
    pub written: usize,
    pub removed: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFileEntry {
    pub filename: String,
    pub mtime_ms: u64,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPullResult {
    pub folder: String,
    pub files: Vec<SyncFileEntry>,
    pub keepers: Option<SyncFileEntry>,
}

pub struct SyncFolder {
    config_file: PathBuf,
    dir: Mutex<Option<PathBuf>>,
}

impl SyncFolder {
    pub fn new(config_dir: PathBuf) -> Self {
        let config_file = config_dir.join(CONFIG_FILE);
        let saved = fs::read_to_string(&config_file)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .map(PathBuf::from);
        Self {
            config_file,
            dir: Mutex::new(saved),
        }
    }

    pub fn current_path(&self) -> Option<String> {
        self.dir
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|p| p.to_string_lossy().into_owned()))
    }

    pub fn set_path(&self, path: Option<PathBuf>) -> Result<Option<String>, String> {
        if let Some(ref p) = path {
            if !p.is_dir() {
                return Err("Selected path is not a folder".into());
            }
        }
        if let Some(parent) = self.config_file.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        match &path {
            Some(p) => fs::write(&self.config_file, p.to_string_lossy().as_bytes())
                .map_err(|e| e.to_string())?,
            None => {
                let _ = fs::remove_file(&self.config_file);
            }
        }
        let out = path.as_ref().map(|p| p.to_string_lossy().into_owned());
        if let Ok(mut g) = self.dir.lock() {
            *g = path;
        }
        Ok(out)
    }

    pub fn push(&self, payload: &SyncPushPayload) -> Result<SyncPushResult, String> {
        let Some(dir) = self.dir.lock().ok().and_then(|g| g.clone()) else {
            return Ok(SyncPushResult {
                written: 0,
                removed: 0,
            });
        };
        if !dir.is_dir() {
            return Err("Sync folder is currently unavailable".into());
        }

        let mut written = 0;
        let mut removed = 0;

        for meal in &payload.meals {
            let safe = sanitize_sync_filename(&meal.filename)
                .ok_or_else(|| format!("Invalid sync filename: {}", meal.filename))?;
            if safe == KEEPERS_FILE {
                continue;
            }
            let target = dir.join(&safe);
            if write_if_changed(&target, meal.json.as_bytes())? {
                written += 1;
            }
        }

        if let Some(ref keepers) = payload.keepers_json {
            let target = dir.join(KEEPERS_FILE);
            if write_if_changed(&target, keepers.as_bytes())? {
                written += 1;
            }
        }

        for name in &payload.remove_files {
            if let Some(safe) = sanitize_sync_filename(name) {
                if safe != KEEPERS_FILE {
                    let target = dir.join(&safe);
                    if target.is_file() && fs::remove_file(&target).is_ok() {
                        removed += 1;
                    }
                }
            }
        }

        Ok(SyncPushResult { written, removed })
    }

    pub fn pull(&self) -> Result<Option<SyncPullResult>, String> {
        let Some(dir) = self.dir.lock().ok().and_then(|g| g.clone()) else {
            return Ok(None);
        };
        if !dir.is_dir() {
            return Err("Sync folder is currently unavailable".into());
        }

        let mut files = Vec::new();
        let mut keepers = None;

        let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if name.starts_with('.') || !name.ends_with(MEAL_ENDING) {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if meta.len() > MAX_SYNC_FILE_BYTES {
                continue;
            }
            let Ok(content) = fs::read_to_string(&path) else {
                continue;
            };
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let item = SyncFileEntry {
                filename: name.to_string(),
                mtime_ms,
                content,
            };
            if name == KEEPERS_FILE {
                keepers = Some(item);
            } else {
                files.push(item);
            }
        }

        files.sort_by(|a, b| a.filename.cmp(&b.filename));
        Ok(Some(SyncPullResult {
            folder: dir.to_string_lossy().into_owned(),
            files,
            keepers,
        }))
    }
}

fn sanitize_sync_filename(raw: &str) -> Option<String> {
    let name = raw.trim();
    if name.is_empty()
        || name.len() > 140
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || !name.ends_with(MEAL_ENDING)
    {
        return None;
    }
    Some(name.to_string())
}

// Only writes when bytes actually differ, keeping cloud sync folders (Google Drive, OneDrive, etc.) quiet.
fn write_if_changed(path: &Path, bytes: &[u8]) -> Result<bool, String> {
    if let Ok(existing) = fs::read(path) {
        if existing == bytes {
            return Ok(false);
        }
    }
    // Try temp file + rename first; fall back to direct write for virtual cloud filesystems where rename can fail.
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, bytes).is_ok() && fs::rename(&tmp, path).is_ok() {
        return Ok(true);
    }
    let _ = fs::remove_file(&tmp);
    fs::write(path, bytes).map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("p2p-sync-test-{tag}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rejects_unsafe_filenames() {
        assert!(sanitize_sync_filename("../evil.prompttopan.json").is_none());
        assert!(sanitize_sync_filename("sub/meal.prompttopan.json").is_none());
        assert!(sanitize_sync_filename("plain.json").is_none());
        assert_eq!(
            sanitize_sync_filename("Thanksgiving.prompttopan.json").as_deref(),
            Some("Thanksgiving.prompttopan.json")
        );
    }

    #[test]
    fn pushes_skips_unchanged_pulls_and_removes() {
        let cfg = temp_dir("cfg");
        let sync = temp_dir("folder");
        let sf = SyncFolder::new(cfg.clone());
        sf.set_path(Some(sync.clone())).unwrap();

        let payload = SyncPushPayload {
            meals: vec![SyncMealWrite {
                filename: "Thanksgiving.prompttopan.json".into(),
                json: r#"{"format":"mealkeeper-v1","meals":[{"name":"Thanksgiving"}]}"#.into(),
            }],
            keepers_json: Some(r#"{"format":"mealkeeper-keepers-v1","keepers":[]}"#.into()),
            remove_files: vec![],
        };

        let first = sf.push(&payload).unwrap();
        assert_eq!((first.written, first.removed), (2, 0));

        // Second push with identical bytes writes nothing.
        let second = sf.push(&payload).unwrap();
        assert_eq!((second.written, second.removed), (0, 0));

        let pulled = sf.pull().unwrap().unwrap();
        assert_eq!(pulled.files.len(), 1);
        assert_eq!(pulled.files[0].filename, "Thanksgiving.prompttopan.json");
        assert!(pulled.keepers.is_some());

        // Removing a deleted meal file works cleanly.
        let rm = sf
            .push(&SyncPushPayload {
                meals: vec![],
                keepers_json: None,
                remove_files: vec!["Thanksgiving.prompttopan.json".into()],
            })
            .unwrap();
        assert_eq!(rm.removed, 1);
        assert_eq!(sf.pull().unwrap().unwrap().files.len(), 0);

        let _ = fs::remove_dir_all(cfg);
        let _ = fs::remove_dir_all(sync);
    }
}
