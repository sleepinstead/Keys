//! One SQLite file, its schema and rules. Only ciphertext, ids, timestamps and
//! non-secret settings reach this layer.

use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};

use crate::error::{HttpError, Result};

/// Stamped into every Keys database (PRAGMA application_id). 'KEYS'.
pub const APP_ID: i64 = 0x4b45_5953;

const MIGRATIONS: [&str; 2] = [
    "CREATE TABLE meta (
       key   TEXT PRIMARY KEY,
       value TEXT NOT NULL
     );
     CREATE TABLE entries (
       id         TEXT PRIMARY KEY,
       blob       BLOB NOT NULL,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     );
     CREATE TABLE categories (
       id         TEXT PRIMARY KEY,
       blob       BLOB NOT NULL,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     );",
    "ALTER TABLE entries ADD COLUMN deleted_at INTEGER;",
];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Table {
    Entries,
    Categories,
}

impl Table {
    fn name(self) -> &'static str {
        match self {
            Table::Entries => "entries",
            Table::Categories => "categories",
        }
    }
    fn columns(self) -> &'static str {
        match self {
            Table::Entries => "id, blob, created_at, updated_at, deleted_at",
            Table::Categories => "id, blob, created_at, updated_at, NULL",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Row {
    pub id: String,
    pub blob: Vec<u8>,
    pub created_at: i64,
    pub updated_at: i64,
    /// Entries only: when it was moved to Recently deleted.
    pub deleted_at: Option<i64>,
}

fn row_of(r: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    Ok(Row { id: r.get(0)?, blob: r.get(1)?, created_at: r.get(2)?, updated_at: r.get(3)?, deleted_at: r.get(4)? })
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Seen {
    ino: u64,
    dev: u64,
    size: u64,
    mtime_ns: i128,
}

/// Checks that a file is safe to open as a Keys database without changing it: an empty file,
/// a fresh SQLite file with no tables, or one with Keys' tables. Returns a readable message otherwise.
pub fn inspect_database(file: &Path) -> std::result::Result<bool, String> {
    let meta = fs::metadata(file).map_err(|_| "That file doesn’t exist, or this app can’t see it".to_string())?;
    if !meta.is_file() {
        return Err("That’s a folder, not a database file".into());
    }
    if fs::OpenOptions::new().read(true).write(true).open(file).is_err() {
        return Err("Keys can’t read and write that file. Check its permissions".into());
    }
    if meta.len() == 0 {
        return Ok(true);
    }
    let mut head = [0u8; 16];
    {
        use std::io::Read;
        let mut f = fs::File::open(file).map_err(|_| "That file can’t be read".to_string())?;
        if f.read_exact(&mut head).is_err() || &head != b"SQLite format 3\0" {
            return Err("That isn’t a SQLite database. If it’s in iCloud or Google Drive, make sure it’s downloaded to this device".into());
        }
    }
    let damaged = || "That database file is damaged or still syncing".to_string();
    let db = Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_| damaged())?;
    let tables: Vec<String> = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").and_then(|mut s| s.query_map([], |r| r.get(0))?.collect()).map_err(|_| damaged())?;
    if tables.is_empty() {
        return Ok(true);
    }
    if !["meta", "entries", "categories"].iter().all(|t| tables.iter().any(|x| x == t)) {
        return Err("That SQLite file isn’t a Keys database".into());
    }
    let tricks: i64 = db.query_row("SELECT count(*) FROM sqlite_master WHERE type IN ('view', 'trigger')", [], |r| r.get(0)).map_err(|_| damaged())?;
    if tricks > 0 {
        return Err("That SQLite file isn’t a Keys database".into());
    }
    let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(|_| damaged())?;
    if version > MIGRATIONS.len() as i64 {
        return Err("That database was made by a newer version of Keys".into());
    }
    let check: String = db.query_row("PRAGMA quick_check", [], |r| r.get(0)).map_err(|_| damaged())?;
    if check != "ok" {
        return Err("That database file is damaged".into());
    }
    Ok(false)
}

pub struct Store {
    conn: Connection,
    pub file: PathBuf,
    /// Bumped every time the file is re-read because another device changed it.
    pub revision: u64,
    /// Set when `refresh` re-read the file; the app checks and clears it.
    pub reloaded: bool,
    /// Set when the file was replaced by a *different* vault (another computer erased it or connected
    /// another one). Writes are refused until the app has locked, so nothing lands under the old key.
    pub swapped: bool,
    seen: Option<Seen>,
}

impl Store {
    /// Opens (creating if needed) a Keys database. `":memory:"` is for tests.
    pub fn open(file: impl Into<PathBuf>) -> Result<Store> {
        let file = file.into();
        let conn = Self::connect(&file)?;
        let mut store = Store { conn, file, revision: 0, reloaded: false, swapped: false, seen: None };
        store.migrate()?;
        let app_id: i64 = store.conn.query_row("PRAGMA application_id", [], |r| r.get(0))?;
        if app_id != APP_ID {
            store.conn.execute_batch(&format!("PRAGMA application_id = {APP_ID}"))?;
        }
        if !store.in_memory() {
            // Some synced folders don't support permissions; the contents are encrypted anyway.
            let _ = fs::set_permissions(&store.file, fs::Permissions::from_mode(0o600));
        }
        store.remember();
        Ok(store)
    }

    fn connect(file: &Path) -> Result<Connection> {
        let conn = Connection::open(file)?;
        // Wait (up to 5 s) for another program holding the file briefly, instead of failing at once.
        conn.busy_timeout(Duration::from_secs(5))?;
        // Rollback journal, not WAL: committed data lives only in the .sqlite file (sync apps
        // handle -wal/-shm side files badly).
        conn.execute_batch(
            "PRAGMA journal_mode = DELETE;
             PRAGMA synchronous = FULL;
             PRAGMA foreign_keys = ON;
             PRAGMA secure_delete = ON;
             PRAGMA trusted_schema = OFF;",
        )?;
        // A file from a shared folder may be hostile: no schema tricks, no writable sqlite_master.
        conn.set_db_config(rusqlite::config::DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)?;
        Ok(conn)
    }

    fn in_memory(&self) -> bool {
        self.file.as_os_str() == ":memory:"
    }

    // ------------------------------------------------------------ shared files

    fn stat(&self) -> Option<Seen> {
        if self.in_memory() {
            return None;
        }
        let m = fs::metadata(&self.file).ok()?;
        Some(Seen { ino: m.ino(), dev: m.dev(), size: m.size(), mtime_ns: m.mtime() as i128 * 1_000_000_000 + m.mtime_nsec() as i128 })
    }

    fn remember(&mut self) {
        self.seen = self.stat();
    }

    pub fn changed_on_disk(&self) -> bool {
        match (self.stat(), self.seen) {
            (Some(now), Some(seen)) => now != seen,
            _ => false,
        }
    }

    fn in_transaction(&self) -> bool {
        !self.conn.is_autocommit()
    }

    /// Re-reads the file if another device changed it. Every read and save checks first.
    pub fn refresh(&mut self) -> bool {
        if self.in_memory() || self.in_transaction() || !self.changed_on_disk() {
            return false;
        }
        let Ok(next) = Self::connect(&self.file) else { return false };
        // A half-synced file fails here, and so does one with views or triggers (Keys never makes
        // any): keep the old connection.
        let tricks: rusqlite::Result<i64> = next.query_row("SELECT count(*) FROM sqlite_master WHERE type IN ('view', 'trigger')", [], |r| r.get(0));
        if next.query_row("SELECT count(*) FROM meta", [], |r| r.get::<_, i64>(0)).is_err() || tricks.map_or(true, |n| n > 0) {
            return false;
        }
        let vault_of = |c: &Connection| c.query_row("SELECT value FROM meta WHERE key = 'created_at'", [], |r| r.get::<_, String>(0)).ok();
        let (before, after) = (vault_of(&self.conn), vault_of(&next));
        if before.is_some() && before != after {
            self.swapped = true;
        }
        self.conn = next;
        self.remember(); // first: migrating saves, and a save checks for changes again
        let _ = self.migrate(); // the other computer may run an older Keys
        self.remember();
        self.revision += 1;
        self.reloaded = true;
        true
    }

    /// Before a save: pick up other devices' changes first. After: note the file as ours.
    fn write<T>(&mut self, run: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T> {
        let outer = !self.in_transaction();
        if outer {
            self.refresh();
        }
        if self.swapped {
            return Err(HttpError::locked());
        }
        let before = self.stat();
        let result = run(&self.conn)?;
        if outer {
            self.after_write(before)?;
        }
        Ok(result)
    }

    /// After a save: if the sync app replaced the file while it was being written, the save went into
    /// the old copy. Pick up the new one and ask for the change again, instead of carrying on with
    /// the stale copy.
    fn after_write(&mut self, before: Option<Seen>) -> Result<()> {
        let now = self.stat();
        if let (Some(b), Some(n)) = (before, now)
            && (b.ino, b.dev) != (n.ino, n.dev)
        {
            self.refresh();
            return Err(HttpError::coded(409, "Your database just changed on another device. Try that again.", "DB_CHANGED"));
        }
        self.remember();
        Ok(())
    }

    fn migrate(&mut self) -> Result<()> {
        let version: i64 = self.conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        for (v, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            self.conn.execute_batch("BEGIN IMMEDIATE")?;
            let done = self.conn.execute_batch(sql).and_then(|_| self.conn.execute_batch(&format!("PRAGMA user_version = {}", v + 1)));
            match done {
                Ok(()) => self.conn.execute_batch("COMMIT")?,
                Err(e) => {
                    if self.in_transaction() {
                        let _ = self.conn.execute_batch("ROLLBACK");
                    }
                    return Err(e.into());
                }
            }
        }
        Ok(())
    }

    /// Runs `f` inside one IMMEDIATE transaction: all of it lands, or none of it.
    pub fn transaction<T>(&mut self, f: impl FnOnce(&mut Store) -> Result<T>) -> Result<T> {
        self.refresh();
        if self.swapped {
            return Err(HttpError::locked());
        }
        let before = self.stat();
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        match f(self) {
            Ok(v) => {
                self.conn.execute_batch("COMMIT")?;
                self.after_write(before)?;
                Ok(v)
            }
            Err(e) => {
                // SQLite may already have rolled back (disk full, I/O error); keep the real error.
                if self.in_transaction() {
                    let _ = self.conn.execute_batch("ROLLBACK");
                }
                Err(e)
            }
        }
    }

    pub fn get_meta(&mut self, key: &str) -> Result<Option<String>> {
        self.refresh();
        Ok(self.conn.query_row("SELECT value FROM meta WHERE key = ?", [key], |r| r.get(0)).optional()?)
    }

    pub fn set_meta(&mut self, key: &str, value: &str) -> Result<()> {
        self.write(|c| c.execute("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, value]))?;
        Ok(())
    }

    pub fn delete_meta(&mut self, key: &str) -> Result<()> {
        self.write(|c| c.execute("DELETE FROM meta WHERE key = ?", [key]))?;
        Ok(())
    }

    pub fn all(&mut self, table: Table) -> Result<Vec<Row>> {
        self.refresh();
        let mut stmt = self.conn.prepare(&format!("SELECT {} FROM {} ORDER BY created_at", table.columns(), table.name()))?;
        let rows = stmt.query_map([], row_of)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn get(&mut self, table: Table, id: &str) -> Result<Option<Row>> {
        self.refresh();
        Ok(self.conn.query_row(&format!("SELECT {} FROM {} WHERE id = ?", table.columns(), table.name()), [id], row_of).optional()?)
    }

    pub fn set_deleted(&mut self, id: &str, at: Option<i64>) -> Result<bool> {
        Ok(self.write(|c| c.execute("UPDATE entries SET deleted_at = ? WHERE id = ?", params![at, id]))? > 0)
    }

    pub fn insert(&mut self, table: Table, row: &Row) -> Result<()> {
        let sql = format!("INSERT INTO {} (id, blob, created_at, updated_at) VALUES (?, ?, ?, ?)", table.name());
        self.write(|c| c.execute(&sql, params![row.id, row.blob, row.created_at, row.updated_at]))?;
        Ok(())
    }

    /// Writes a row exactly as given (merging a conflict copy).
    pub fn put_raw(&mut self, table: Table, row: &Row) -> Result<()> {
        self.write(|c| match table {
            Table::Entries => c.execute(
                "INSERT OR REPLACE INTO entries (id, blob, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?)",
                params![row.id, row.blob, row.created_at, row.updated_at, row.deleted_at],
            ),
            Table::Categories => c.execute("INSERT OR REPLACE INTO categories (id, blob, created_at, updated_at) VALUES (?, ?, ?, ?)", params![row.id, row.blob, row.created_at, row.updated_at]),
        })?;
        Ok(())
    }

    pub fn update(&mut self, table: Table, id: &str, blob: &[u8], updated_at: i64) -> Result<bool> {
        let sql = format!("UPDATE {} SET blob = ?, updated_at = ? WHERE id = ?", table.name());
        Ok(self.write(|c| c.execute(&sql, params![blob, updated_at, id]))? > 0)
    }

    pub fn delete(&mut self, table: Table, id: &str) -> Result<bool> {
        let sql = format!("DELETE FROM {} WHERE id = ?", table.name());
        Ok(self.write(|c| c.execute(&sql, [id]))? > 0)
    }

    /// Removes every item, category, setting and key, then compacts the file so nothing lingers.
    pub fn wipe(&mut self) -> Result<()> {
        self.transaction(|s| {
            s.conn.execute_batch("DELETE FROM entries; DELETE FROM categories; DELETE FROM meta;")?;
            Ok(())
        })?;
        self.conn.execute_batch("VACUUM")?;
        self.remember();
        Ok(())
    }

    /// Writes a compact, consistent copy of the whole database to `file` (which must not exist).
    pub fn copy_to(&self, file: &Path) -> Result<()> {
        let path = file.to_str().ok_or_else(|| HttpError::new(400, "That location isn’t valid"))?;
        self.conn.execute("VACUUM INTO ?", [path])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_schema_and_round_trips_rows() {
        let mut s = Store::open(":memory:").unwrap();
        s.insert(Table::Entries, &Row { id: "a".into(), blob: vec![1, 2], created_at: 1, updated_at: 2, deleted_at: None }).unwrap();
        assert_eq!(s.all(Table::Entries).unwrap()[0].blob, vec![1, 2]);
        assert!(s.set_deleted("a", Some(5)).unwrap());
        assert_eq!(s.get(Table::Entries, "a").unwrap().unwrap().deleted_at, Some(5));
        s.set_meta("k", "v").unwrap();
        assert_eq!(s.get_meta("k").unwrap().as_deref(), Some("v"));
    }
}
