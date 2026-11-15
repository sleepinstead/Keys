//! One database file used from several computers through a synced folder.
//!
//! Presence: each computer with Keys open keeps a small marker beside the database
//! (".Keys.sqlite.open-<device>.json": a name and a timestamp, nothing secret), refreshed every
//! minute and removed on exit, so the others can say "Also open on …".
//!
//! Conflict copies: rows are encrypted with the same vault key everywhere, so a sync app's copy of
//! the same vault merges row by row without decrypting anything; the newest version of each wins.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};

use crate::crypto::random_bytes;
use crate::error::{HttpError, Result};
use crate::storage::config_dir;
use crate::store::{APP_ID, Row, Store, Table};
use crate::vault::now_ms;

const STALE_MS: i64 = 4 * 60_000;

fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "Mac"
    } else if cfg!(windows) {
        "Windows"
    } else {
        "Linux"
    }
}

/// This computer's id, kept in the (unsynced) config folder.
fn device_id() -> String {
    let file = config_dir().join("device.json");
    if let Some(id) = fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v["id"].as_str().map(str::to_string))
        && id.len() == 16
        && id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return id;
    }
    let id: String = random_bytes::<8>().iter().map(|b| format!("{b:02x}")).collect();
    if fs::create_dir_all(config_dir()).is_ok() {
        let _ = fs::write(&file, json!({ "id": id }).to_string());
    }
    id
}

/// "Armaans-MacBook-Air.local" → "Armaans MacBook Air".
fn device_name() -> String {
    let host = gethostname::gethostname().to_string_lossy().into_owned();
    let host = host.strip_suffix(".local").unwrap_or(&host).replace(['-', '_'], " ");
    let host = host.split_whitespace().collect::<Vec<_>>().join(" ");
    let name = if host.is_empty() { platform().to_string() } else { host };
    name.chars().take(60).collect()
}

fn marker_prefix(db: &Path) -> String {
    format!(".{}.open-", db.file_name().map(|n| n.to_string_lossy()).unwrap_or_default())
}

pub struct Presence {
    id: String,
    name: String,
    marked: Option<PathBuf>,
}

impl Presence {
    pub fn new() -> Presence {
        Presence { id: device_id(), name: device_name(), marked: None }
    }

    /// Writes (or moves, after a file switch) this computer's marker. `db` is None for the
    /// built-in location, where there's no one to tell.
    pub fn beat(&mut self, db: Option<&Path>) {
        let target = db.and_then(|d| Some(d.parent()?.join(format!("{}{}.json", marker_prefix(d), self.id))));
        if self.marked.is_some() && self.marked != target {
            self.clear();
        }
        let Some(target) = target else { return };
        let marker = json!({ "device": self.id, "name": self.name, "platform": platform(), "at": now_ms() });
        if fs::write(&target, marker.to_string()).is_ok() {
            self.marked = Some(target);
        }
    }

    pub fn clear(&mut self) {
        if let Some(m) = self.marked.take() {
            let _ = fs::remove_file(m);
        }
    }

    /// Other computers that have this database open (seen in the last few minutes).
    pub fn others(&self, db: Option<&Path>) -> Vec<Value> {
        let Some(db) = db else { return vec![] };
        let (Some(dir), prefix) = (db.parent(), marker_prefix(db)) else { return vec![] };
        let Ok(names) = fs::read_dir(dir) else { return vec![] };
        let now = now_ms();
        let mut out: Vec<Value> = names
            .flatten()
            .filter_map(|e| {
                let n = e.file_name().to_string_lossy().into_owned();
                if !n.starts_with(&prefix) || !n.ends_with(".json") {
                    return None;
                }
                // Markers are tiny: anything else (a huge file, a FIFO, a link) is skipped unread.
                let meta = fs::symlink_metadata(e.path()).ok()?;
                if !meta.is_file() || meta.len() > 4096 {
                    return None;
                }
                let m: Value = serde_json::from_str(&fs::read_to_string(e.path()).ok()?).ok()?;
                let at = m["at"].as_f64()? as i64;
                let name = m["name"].as_str()?;
                if m["device"].as_str() == Some(self.id.as_str()) || now - at > STALE_MS {
                    return None;
                }
                Some(json!({
                    "name": name.chars().take(60).collect::<String>(),
                    "platform": m["platform"].as_str().unwrap_or("").chars().take(20).collect::<String>(),
                    "lastSeenAt": at,
                }))
            })
            .collect();
        out.sort_by(|a, b| b["lastSeenAt"].as_i64().cmp(&a["lastSeenAt"].as_i64()));
        out
    }
}

impl Default for Presence {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for Presence {
    fn drop(&mut self) {
        self.clear();
    }
}

// ------------------------------------------------------------------ conflict copies

fn last_touched(r: &Row) -> i64 {
    r.updated_at.max(r.deleted_at.unwrap_or(0))
}

/// Rows in `other` that are missing here or newer than ours.
/// Opens a possible conflict copy read-only and defensively: it could be a planted file, so no
/// views or triggers, no trusted schema, and every query gives up after a few seconds.
fn open_copy(path: &std::path::Path) -> Option<Connection> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).ok()?;
    db.execute_batch("PRAGMA trusted_schema = OFF;").ok()?;
    db.set_db_config(rusqlite::config::DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true).ok()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    db.progress_handler(10_000, Some(move || std::time::Instant::now() > deadline));
    let tricks: i64 = db.query_row("SELECT count(*) FROM sqlite_master WHERE type IN ('view', 'trigger')", [], |r| r.get(0)).ok()?;
    (tricks == 0).then_some(db)
}

fn diff(store: &mut Store, other: &Connection) -> Result<Vec<(Table, Row)>> {
    let mut rows = Vec::new();
    let purged = crate::vault::purged_ids(store)?;
    for (table, sql) in [(Table::Categories, "SELECT id, blob, created_at, updated_at, NULL FROM categories"), (Table::Entries, "SELECT id, blob, created_at, updated_at, deleted_at FROM entries")] {
        let mut stmt = other.prepare(sql)?;
        let theirs = stmt.query_map([], |r| Ok(Row { id: r.get(0)?, blob: r.get(1)?, created_at: r.get(2)?, updated_at: r.get(3)?, deleted_at: r.get(4)? }))?.collect::<rusqlite::Result<Vec<_>>>()?;
        for row in theirs {
            let mine = store.get(table, &row.id)?;
            if mine.is_none() && purged.contains(&row.id) {
                continue; // deleted for good here: the copy's older version stays gone
            }
            if mine.as_ref().is_none_or(|m| last_touched(&row) > last_touched(m)) {
                rows.push((table, row));
            }
        }
    }
    Ok(rows)
}

fn vault_id(db: &Connection) -> Option<String> {
    db.query_row("SELECT value FROM meta WHERE key = 'created_at'", [], |r| r.get(0)).ok()
}

/// Copies of this database the sync app left beside it: same folder, name starting with this
/// file's name, a Keys database of the same vault, with something new in it.
pub fn find_conflicts(store: &mut Store) -> Vec<Value> {
    let file = store.file.clone();
    if file.as_os_str() == ":memory:" {
        return vec![];
    }
    let (Some(dir), Some(base)) = (file.parent(), file.file_name().map(|n| n.to_string_lossy().into_owned())) else { return vec![] };
    let stem = base.strip_suffix(".sqlite").or_else(|| base.strip_suffix(".SQLITE")).unwrap_or(&base).to_string();
    let Ok(Some(ours)) = store.get_meta("created_at") else { return vec![] };
    let Ok(names) = fs::read_dir(dir) else { return vec![] };
    let mut out = Vec::new();
    for entry in names.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == base || !name.starts_with(&stem) || !name.to_lowercase().ends_with(".sqlite") || name.starts_with('.') {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() || meta.len() == 0 {
            continue;
        }
        let Some(db) = open_copy(&entry.path()) else { continue };
        let app: i64 = db.query_row("PRAGMA application_id", [], |r| r.get(0)).unwrap_or(0);
        if app != APP_ID || vault_id(&db).as_deref() != Some(ours.as_str()) {
            continue;
        }
        let Ok(changes) = diff(store, &db).map(|d| d.len()) else { continue };
        if changes == 0 {
            continue;
        }
        let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64() * 1000.0);
        out.push(json!({ "path": entry.path(), "name": name, "modifiedAt": modified, "changes": changes }));
    }
    out.sort_by(|a, b| b["modifiedAt"].as_f64().partial_cmp(&a["modifiedAt"].as_f64()).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// Merges a conflict copy (newest version of each item wins; items only in the copy are added),
/// then removes it. Only paths that `find_conflicts` reported are accepted.
pub fn merge_conflict(store: &mut Store, file: &str) -> Result<Value> {
    let known = find_conflicts(store).iter().any(|c| c["path"].as_str() == Some(file));
    if !known {
        return Err(HttpError::new(409, "That copy is no longer there, or has nothing new"));
    }
    let db = open_copy(std::path::Path::new(file)).ok_or_else(|| HttpError::new(409, "That copy can’t be read"))?;
    let rows = diff(store, &db)?;
    drop(db);
    store.transaction(|s| rows.iter().try_for_each(|(t, r)| s.put_raw(*t, r)))?;
    // Kept, renamed so it isn't offered again: it might be someone's own backup.
    let _ = fs::rename(file, format!("{file}.merged"));
    Ok(json!({ "merged": rows.len() }))
}
