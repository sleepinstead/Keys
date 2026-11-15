//! Which SQLite file Keys uses (server/storage.ts). Only the file's path is remembered, in a
//! pointer file in the per-user config folder; the Node app and this app share it.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::error::{HttpError, Result};
use crate::store::{Store, inspect_database};

/// ~/Library/Application Support/Keys on macOS (the same folder the Node server uses).
pub fn config_dir() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"));
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Keys")
    } else if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| home.join("AppData/Roaming")).join("Keys")
    } else {
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".config")).join("keys")
    }
}

pub fn default_db_file() -> PathBuf {
    config_dir().join("Keys.sqlite")
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    pub path: String,
    pub is_default: bool,
    pub available: bool,
    pub error: Option<String>,
    pub size: Option<u64>,
    pub can_browse: bool,
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

/// Lexical normalisation like Node's path.normalize (no filesystem access).
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Accepts ~/…, quoted paths and file:// URLs pasted from Finder. Always returns an absolute path.
pub fn normalize_path(raw: Option<&str>) -> Result<PathBuf> {
    let raw = raw.map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| HttpError::new(400, "Enter the database file’s location"))?;
    let mut p = raw.to_string();
    for q in ['"', '\''] {
        if p.len() >= 2 && p.starts_with(q) && p.ends_with(q) {
            p = p[1..p.len() - 1].to_string();
        }
    }
    if let Some(rest) = p.strip_prefix("file://") {
        let path = rest.strip_prefix("localhost").unwrap_or(rest);
        p = percent_decode(path).ok_or_else(|| HttpError::new(400, "That location isn’t valid"))?;
    }
    if p == "~" || p.starts_with("~/") {
        p = home().join(p.trim_start_matches('~').trim_start_matches('/')).to_string_lossy().into_owned();
    }
    let path = PathBuf::from(&p);
    if !path.is_absolute() {
        return Err(HttpError::new(400, "Use the full location, starting with / or ~/"));
    }
    if p.len() > 4096 || p.contains('\0') {
        return Err(HttpError::new(400, "That location isn’t valid"));
    }
    Ok(normalize(&path))
}

pub struct Storage {
    current: Option<Store>,
    file: PathBuf,
    error: Option<String>,
    pointer: Option<PathBuf>,
    default_file: PathBuf,
}

impl Storage {
    /// In memory (tests): never reads or writes the pointer or any file.
    pub fn memory() -> Result<Storage> {
        Ok(Storage { current: Some(Store::open(":memory:")?), file: ":memory:".into(), error: None, pointer: None, default_file: ":memory:".into() })
    }

    /// The file the pointer names, else the default location.
    pub fn open(pointer: Option<PathBuf>, default_file: PathBuf) -> Storage {
        let mut s = Storage { current: None, file: default_file.clone(), error: None, pointer, default_file };
        if let Some(p) = s.read_pointer() {
            s.file = p;
        }
        s.reopen();
        s
    }

    pub fn store(&mut self) -> Result<&mut Store> {
        let err = self.error.clone();
        self.current.as_mut().ok_or_else(|| HttpError::coded(503, err.unwrap_or_else(|| "The database isn’t available".into()), "NO_DATABASE"))
    }

    pub fn available(&self) -> bool {
        self.current.is_some()
    }

    pub fn file(&self) -> &Path {
        &self.file
    }

    pub fn is_default(&self) -> bool {
        self.file == self.default_file || self.file.as_os_str() == ":memory:"
    }

    /// Changes each time the data was re-read from another device (or the file was switched).
    pub fn revision(&self) -> String {
        format!("{}#{}", self.file.display(), self.current.as_ref().map_or(0, |s| s.revision))
    }

    pub fn check_for_changes(&mut self) -> bool {
        self.current.as_mut().is_some_and(Store::refresh)
    }

    pub fn info(&self) -> StorageInfo {
        let size = if self.file.as_os_str() == ":memory:" { None } else { fs::metadata(&self.file).ok().map(|m| m.len()) };
        StorageInfo {
            path: self.file.to_string_lossy().into_owned(),
            is_default: self.is_default(),
            available: self.available(),
            error: self.error.clone(),
            size,
            can_browse: cfg!(target_os = "macos"),
        }
    }

    pub fn retry(&mut self) -> Result<StorageInfo> {
        if self.current.is_none() {
            self.reopen();
        }
        if self.current.is_none() {
            return Err(HttpError::coded(503, self.error.clone().unwrap_or_default(), "NO_DATABASE"));
        }
        Ok(self.info())
    }

    pub fn connect(&mut self, raw: Option<&str>) -> Result<StorageInfo> {
        let file = normalize_path(raw)?;
        if file == self.file && self.current.is_some() {
            return Ok(self.info());
        }
        inspect_database(&file).map_err(|e| HttpError::new(400, e))?;
        self.switch_to(file)?;
        Ok(self.info())
    }

    pub fn create(&mut self, raw: Option<&str>) -> Result<StorageInfo> {
        let file = self.new_file_path(raw)?;
        Store::open(&file).map_err(|_| HttpError::new(400, "Keys couldn’t create a file there. Check the folder’s permissions"))?;
        self.switch_to(file)?;
        Ok(self.info())
    }

    pub fn move_to(&mut self, raw: Option<&str>) -> Result<StorageInfo> {
        let file = self.new_file_path(raw)?;
        let copied = self.store().and_then(|s| s.copy_to(&file)).and_then(|_| inspect_database(&file).map(|_| ()).map_err(|e| HttpError::new(400, e)));
        if let Err(err) = copied {
            let _ = fs::remove_file(&file);
            return Err(if err.status == 400 || err.status == 503 { err } else { HttpError::new(400, "Keys couldn’t write the copy there. Check the folder and free space") });
        }
        self.switch_to(file)?;
        Ok(self.info())
    }

    pub fn use_default(&mut self) -> Result<StorageInfo> {
        let file = self.default_file.clone();
        self.switch_to(file)?;
        Ok(self.info())
    }

    /// A brand-new, empty Keys database as bytes, for "Download a new database".
    pub fn template() -> Result<Vec<u8>> {
        let dir = std::env::temp_dir().join(format!("keys-{}", crate::crypto::random_id()));
        fs::create_dir_all(&dir).map_err(|_| HttpError::new(500, "Couldn’t make a new database"))?;
        let file = dir.join("keys.sqlite");
        let out = Store::open(&file).and_then(|s| {
            drop(s);
            fs::read(&file).map_err(|_| HttpError::new(500, "Couldn’t make a new database"))
        });
        let _ = fs::remove_dir_all(&dir);
        out
    }

    fn new_file_path(&self, raw: Option<&str>) -> Result<PathBuf> {
        let mut file = normalize_path(raw)?;
        let ext = file.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
        if !matches!(ext.as_deref(), Some("sqlite" | "sqlite3" | "db")) {
            let mut s = file.into_os_string();
            s.push(".sqlite");
            file = s.into();
        }
        if file.exists() {
            return Err(HttpError::new(409, "A file with that name already exists there. Pick another name, or connect it instead"));
        }
        if !file.parent().is_some_and(Path::is_dir) {
            return Err(HttpError::new(400, "That folder doesn’t exist"));
        }
        Ok(file)
    }

    fn reopen(&mut self) {
        self.current = None;
        self.error = None;
        if self.file == self.default_file {
            if let Some(dir) = self.file.parent() {
                let _ = fs::create_dir_all(dir);
                let _ = fs::set_permissions(dir, std::os::unix::fs::PermissionsExt::from_mode(0o700));
            }
        } else if let Err(e) = inspect_database(&self.file) {
            self.error = Some(format!("{e}. If it’s in iCloud Drive or Google Drive, check it’s downloaded to this device."));
            return;
        }
        match Store::open(&self.file) {
            Ok(s) => self.current = Some(s),
            Err(e) => self.error = Some(e.message),
        }
    }

    fn switch_to(&mut self, file: PathBuf) -> Result<()> {
        if file == self.default_file
            && let Some(dir) = file.parent()
        {
            let _ = fs::create_dir_all(dir);
        }
        let next = Store::open(&file)?; // fails before anything changes if it can't be opened
        // Remembered first: if that fails, keep using the current file.
        let pointer = if file == self.default_file { None } else { Some(file.clone()) };
        self.write_pointer(pointer.as_deref()).map_err(|_| HttpError::new(500, "Keys couldn’t remember the new location: its settings folder isn’t writable"))?;
        self.current = Some(next);
        self.file = file;
        self.error = None;
        Ok(())
    }

    fn read_pointer(&self) -> Option<PathBuf> {
        let text = fs::read_to_string(self.pointer.as_ref()?).ok()?;
        let v: serde_json::Value = serde_json::from_str(&text).ok()?;
        let p = PathBuf::from(v.get("path")?.as_str()?);
        p.is_absolute().then_some(p)
    }

    fn write_pointer(&self, file: Option<&Path>) -> std::io::Result<()> {
        let Some(pointer) = &self.pointer else { return Ok(()) };
        let Some(file) = file else {
            return match fs::remove_file(pointer) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
                _ => Ok(()),
            };
        };
        if let Some(dir) = pointer.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = pointer.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_string_pretty(&serde_json::json!({ "path": file }))?)?;
        fs::set_permissions(&tmp, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
        fs::rename(&tmp, pointer)
    }
}

/// Native macOS file dialogs via AppleScript (Finder, iCloud Drive and Google Drive included).
/// Returns None if the person cancels.
pub async fn browse(save: bool) -> Result<Option<String>> {
    if !cfg!(target_os = "macos") {
        return Err(HttpError::new(501, "Browsing is only available on macOS. Paste the file’s location instead"));
    }
    let script = if save {
        "POSIX path of (choose file name with prompt \"Save the Keys database as\" default name \"Keys.sqlite\")"
    } else {
        "POSIX path of (choose file with prompt \"Choose your Keys database\")"
    };
    let out = tokio::process::Command::new("osascript")
        .args(["-e", "tell application \"System Events\" to activate", "-e", script])
        .output()
        .await
        .map_err(|_| HttpError::new(500, "The file dialog couldn’t be opened"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        if err.contains("-128") || err.contains("User canceled") {
            return Ok(None);
        }
        return Err(HttpError::new(500, "The file dialog couldn’t be opened"));
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok((!path.is_empty()).then_some(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_paths_like_node() {
        assert_eq!(normalize_path(Some("'/a/b/../c.sqlite'")).unwrap(), PathBuf::from("/a/c.sqlite"));
        assert_eq!(normalize_path(Some("file:///Users/x/My%20Drive/Keys.sqlite")).unwrap(), PathBuf::from("/Users/x/My Drive/Keys.sqlite"));
        assert!(normalize_path(Some("relative/path")).is_err());
        assert!(normalize_path(None).is_err());
    }
}
