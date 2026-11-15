//! The local HTTP API the React app talks to: same routes, JSON shapes, guards and headers as
//! the Node server (server/routes.ts, server/app.ts, server/security.ts), so the app and its
//! browser extension work unchanged.

use std::sync::{Arc, Mutex, MutexGuard};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, HeaderValue, Method, Request, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;
use serde_json::{Map, Value, json};

use crate::crypto::{self, KdfParams, Key};
use crate::error::{HttpError, Result};
use crate::extension::{self as ext, Pending};
use crate::session::{QuickUnlock, Session};
use crate::sharing::{self, Presence};
use crate::storage::{self, Storage};
use crate::store::Store;
use crate::validate::{self, opt_string, require_string};
use crate::vault::{self, MIN_MASTER_LENGTH, credential_label, is_short_credential, now_ms};
use crate::{audit, favicon, importexport};

/// The built React app (`npm run build` → dist/), compiled into the binary.
#[derive(RustEmbed)]
#[folder = "../../dist/"]
struct Assets;

pub struct Inner {
    pub storage: Storage,
    session: Session,
    quick: QuickUnlock,
    /// The vault the session belongs to (meta created_at): a different one appearing locks.
    vault_id: Option<String>,
    /// One password check at a time, or parallel guesses would all pass the lockout check.
    unlocking: bool,
    /// Browsers waiting for their pairing code to be typed into the app.
    pending: Vec<Pending>,
    /// "Open on this computer" marker beside a shared database (None in tests).
    presence: Option<Presence>,
    breach_running: bool,
    /// Where this Mac keeps its browser pairings (None: in memory, for tests).
    pairings_file: Option<std::path::PathBuf>,
    mem_pairings: Value,
    /// Last conflict-copy scan: when, for which file revision, and what it found.
    conflicts: Option<(std::time::Instant, String, Value)>,
}

pub struct App {
    inner: Mutex<Inner>,
    origins: Vec<String>,
    /// Where the app is, for the extension's "Open Keys" button.
    app_url: String,
    /// A newer version the Mac app found ({version, notes, state}); the sidebar shows it.
    update: Mutex<Option<Value>>,
    /// Starts installing that update (set by the Mac app; absent in the plain server).
    install: std::sync::OnceLock<Box<dyn Fn() + Send + Sync>>,
    /// Brings the Mac app's window forward (the extension's "Open Keys"); absent in the plain server.
    show: std::sync::OnceLock<Box<dyn Fn() + Send + Sync>>,
    /// The Mac app's version and update controls, for the Updates card in Settings.
    native: std::sync::OnceLock<NativeApp>,
}

pub type Shared = Arc<App>;

/// What the Mac app offers Settings: its version, a manual update check, and automatic checks.
pub struct NativeApp {
    pub version: String,
    pub check: Box<dyn Fn() + Send + Sync>,
    pub auto: Box<dyn Fn() -> bool + Send + Sync>,
    pub set_auto: Box<dyn Fn(bool) + Send + Sync>,
}

impl App {
    pub fn new(storage: Storage, port: u16) -> Shared {
        let mut inner = Inner {
            storage,
            session: Session::new(),
            quick: QuickUnlock::default(),
            vault_id: None,
            unlocking: false,
            pending: Vec::new(),
            presence: None,
            breach_running: false,
            pairings_file: None,
            mem_pairings: Value::Null,
            conflicts: None,
        };
        if inner.storage.file().as_os_str() != ":memory:" {
            inner.pairings_file = Some(storage::config_dir().join("browsers.json"));
        }
        inner.vault_id = inner.current_vault_id();
        let app_url = format!("http://localhost:{port}");
        Arc::new(App {
            inner: Mutex::new(inner),
            origins: vec![app_url.clone(), format!("http://127.0.0.1:{port}")],
            app_url,
            update: Mutex::new(None),
            install: std::sync::OnceLock::new(),
            show: std::sync::OnceLock::new(),
            native: std::sync::OnceLock::new(),
        })
    }

    pub fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Tells the app about an update (or clears it). Shown in the sidebar, above Lock.
    pub fn set_update(&self, info: Option<Value>) {
        *self.update.lock().unwrap_or_else(|p| p.into_inner()) = info;
    }

    /// What "Update & restart" in the sidebar runs.
    pub fn on_install(&self, run: impl Fn() + Send + Sync + 'static) {
        let _ = self.install.set(Box::new(run));
    }

    /// Set by the Mac app: the Updates card in Settings uses it.
    pub fn set_native(&self, native: NativeApp) {
        let _ = self.native.set(native);
    }

    /// What the extension's "Open Keys" runs in the Mac app.
    pub fn on_show(&self, run: impl Fn() + Send + Sync + 'static) {
        let _ = self.show.set(Box::new(run));
    }

    /// Locks after the idle time; the app calls this every second.
    pub fn tick(&self) {
        self.lock().session.expire_if_idle(now_ms());
    }

    /// Announces (or refreshes) this computer beside a shared database. Off until called.
    pub fn beat(&self) {
        let mut g = self.lock();
        let db = g.shared_file();
        g.presence.get_or_insert_with(Presence::new).beat(db.as_deref());
    }

    /// On quit: lock, and take this computer's marker away.
    pub fn shutdown(&self) {
        let mut g = self.lock();
        g.lock_all();
        if let Some(p) = g.presence.as_mut() {
            p.clear();
        }
    }
}

impl Inner {
    fn store(&mut self) -> Result<&mut Store> {
        self.storage.store()
    }

    /// The database file if it's one the person chose (where other computers may share it).
    fn shared_file(&self) -> Option<std::path::PathBuf> {
        (self.storage.available() && !self.storage.is_default()).then(|| self.storage.file().to_path_buf())
    }

    /// Browsers connected on *this Mac*, per vault. They live in Keys' own settings folder, never in
    /// the (possibly shared) vault file: anyone who could write to a synced folder could otherwise
    /// plant a pairing for a token they chose.
    fn read_pairings(&mut self) -> Result<Vec<Value>> {
        let vault = self.vault_key()?;
        let all = match &self.pairings_file {
            Some(f) => std::fs::read_to_string(f).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or(Value::Null),
            None => self.mem_pairings.clone(),
        };
        Ok(all.get(&vault).and_then(Value::as_array).cloned().unwrap_or_default())
    }

    fn vault_key(&mut self) -> Result<String> {
        Ok(self.store()?.get_meta("created_at")?.unwrap_or_default())
    }

    fn write_pairings(&mut self, list: &[Value]) -> Result<()> {
        let vault = self.vault_key()?;
        let Some(file) = self.pairings_file.clone() else {
            if !self.mem_pairings.is_object() {
                self.mem_pairings = json!({});
            }
            self.mem_pairings[&vault] = Value::Array(list.to_vec());
            return Ok(());
        };
        let mut all = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}));
        all[&vault] = Value::Array(list.to_vec());
        let failed = || HttpError::new(500, "Keys couldn’t save the browser connection");
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|_| failed())?;
        }
        let tmp = file.with_extension("json.tmp");
        std::fs::write(&tmp, all.to_string()).map_err(|_| failed())?;
        let _ = std::fs::set_permissions(&tmp, std::os::unix::fs::PermissionsExt::from_mode(0o600));
        std::fs::rename(&tmp, &file).map_err(|_| failed())
    }

    fn sweep(&mut self) {
        let now = now_ms();
        self.pending.retain(|p| now - p.created_at <= ext::PAIR_TTL_MS);
    }

    fn current_vault_id(&mut self) -> Option<String> {
        self.storage.store().ok()?.get_meta("created_at").ok().flatten()
    }

    fn key_for(&mut self, token: Option<&str>, touch: bool) -> Result<Key> {
        self.session.authorize(token, touch, now_ms()).ok_or_else(HttpError::locked)
    }

    fn settings(&mut self) -> Result<Value> {
        let s = vault::get_settings(self.store()?)?;
        self.session.idle_ms = s["autoLockMinutes"].as_i64().unwrap_or(5) * 60_000;
        Ok(s)
    }

    fn lock_all(&mut self) {
        self.session.lock();
        self.quick.disarm();
    }

    /// After every request: if another device replaced the vault itself, the key no longer fits.
    fn after(&mut self) {
        let Ok(store) = self.storage.store() else { return };
        store.reloaded = false;
        // Another computer replaced the vault itself: this session's key doesn't fit it.
        if std::mem::take(&mut store.swapped) {
            self.lock_all();
        }
        self.vault_id = self.current_vault_id();
    }

    fn pin_status(&mut self) -> Result<Value> {
        let length = if vault::is_initialized(self.store()?)? { vault::pin_length(self.store()?)? } else { None };
        Ok(match length {
            Some(length) => json!({ "length": length, "available": self.quick.armed(), "attemptsLeft": self.quick.attempts_left }),
            None => Value::Null,
        })
    }

    fn status(&mut self, token: Option<&str>) -> Result<Value> {
        if !self.storage.available() {
            return Ok(json!({
                "storage": self.storage.info(), "initialized": false, "unlocked": false, "lockoutUntil": null,
                "expiresAt": null, "settings": null, "appearance": "system", "pin": null, "credential": { "type": "password" },
            }));
        }
        let unlocked = self.session.authorize(token, false, now_ms()).is_some();
        let initialized = vault::is_initialized(self.store()?)?;
        let settings = if initialized { Some(self.settings()?) } else { None };
        Ok(json!({
            "storage": self.storage.info(),
            "initialized": initialized,
            "unlocked": unlocked,
            "lockoutUntil": vault::lockout_until(self.store()?)?,
            "expiresAt": if unlocked { self.session.expires_at() } else { None },
            "settings": if unlocked { settings.clone() } else { None },
            "appearance": settings.as_ref().map_or(json!("system"), |s| s["appearance"].clone()),
            "pin": self.pin_status()?,
            "credential": if initialized { vault::credential(self.store()?)? } else { json!({ "type": "password" }) },
        }))
    }

    /// A successful unlock or setup: a new session, and the status the app expects.
    fn opened(&mut self, key: Key) -> Result<Value> {
        self.vault_id = self.current_vault_id();
        let settings = self.settings()?;
        let token = self.session.open(key, now_ms());
        let mut s = self.status(Some(&token))?;
        s["sessionToken"] = token.into();
        s["unlocked"] = true.into();
        s["expiresAt"] = self.session.expires_at().into();
        s["settings"] = settings;
        Ok(s)
    }
}

// ------------------------------------------------------------------ slow key work, off the async threads

/// One Argon2 derivation at a time: each takes 128–512 MB, so several at once could exhaust memory.
static KDF_SLOT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

async fn derive(password: String, kdf: KdfParams) -> Result<Key> {
    let _slot = KDF_SLOT.acquire().await.map_err(|_| HttpError::new(500, "Internal error"))?;
    tokio::task::spawn_blocking(move || crypto::derive_key(&password, &kdf)).await.map_err(|_| HttpError::new(500, "Internal error"))?.map_err(|e| HttpError::new(400, e))
}

/// Clears a busy flag when dropped, so a request that fails, panics or is cancelled half-way
/// (the client went away during a slow key derivation) can't leave Keys refusing every later try.
struct Busy<'a> {
    app: &'a App,
    flag: fn(&mut Inner) -> &mut bool,
}

impl<'a> Busy<'a> {
    /// Sets the flag (the caller has checked it was clear, under the same lock).
    fn set(app: &'a App, g: &mut Inner, flag: fn(&mut Inner) -> &mut bool) -> Busy<'a> {
        *flag(g) = true;
        Busy { app, flag }
    }
}

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        *(self.flag)(&mut self.app.lock()) = false;
    }
}

/// Runs a password check with the lockout rules. Ok(Some(dek)) for the right password; a wrong
/// one counts towards the lockout and gives Ok(None).
async fn check_password(app: &App, password: &str) -> Result<Option<Key>> {
    let ((kdf, wrapped), busy) = {
        let mut g = app.lock();
        if vault::lockout_until(g.store()?)?.is_some() {
            return Err(HttpError::coded(429, "Too many failed attempts. Try again later.", "LOCKED_OUT"));
        }
        if g.unlocking {
            return Err(HttpError::new(429, "An unlock is already in progress"));
        }
        let material = vault::unlock_material(g.store()?)?;
        (material, Busy::set(app, &mut g, |i| &mut i.unlocking))
    };
    let kek = derive(password.to_string(), kdf).await;
    drop(busy); // before taking the lock again
    let mut g = app.lock();
    let kek = kek?;
    let dek = vault::unwrap_dek(&kek, &wrapped);
    let store = g.store()?;
    match dek {
        Some(dek) => {
            vault::reset_failures(store)?;
            Ok(Some(dek))
        }
        None => {
            vault::record_failure(store)?;
            Ok(None)
        }
    }
}

/// The raw (encrypted) item rows and the session key, taken under the lock; decrypting happens after.
fn rows_and_key(app: &App, token: Option<&str>) -> Result<(Vec<crate::store::Row>, Key)> {
    let mut g = app.lock();
    let key = g.key_for(token, true)?;
    Ok((g.store()?.all(crate::store::Table::Entries)?, key))
}

/// Changing which file Keys uses, erasing, purging: needs the current credential.
async fn require_current(app: &App, body: &Value) -> Result<()> {
    let label = {
        let mut g = app.lock();
        if !g.storage.available() || !vault::is_initialized(g.store()?)? {
            return Ok(());
        }
        credential_label(&vault::credential(g.store()?)?)
    };
    let current = opt_string(body.get("current"), 1024);
    if current.is_empty() {
        return Err(HttpError::new(400, format!("Enter your {label} to change the database")));
    }
    if check_password(app, &current).await?.is_none() {
        return Err(HttpError::coded(401, format!("Incorrect {label}"), "BAD_PASSWORD"));
    }
    Ok(())
}

fn check_credential(value: &str, kind: Option<&Value>) -> Result<Value> {
    match kind.and_then(Value::as_str) {
        Some("pin") => {
            let pin = validate::validate_pin(Some(&Value::String(value.into())), &[4, 6])?;
            Ok(json!({ "type": "pin", "length": pin.len() }))
        }
        Some("pattern") => match validate::pattern_problem(value) {
            Some(p) => Err(HttpError::coded(400, p, "WEAK_PATTERN")),
            None => Ok(json!({ "type": "pattern" })),
        },
        Some("passphrase") => {
            if let Some(p) = validate::passphrase_problem(value) {
                return Err(HttpError::coded(400, p, "WEAK_PASSPHRASE"));
            }
            if validate::strength_score(value) < 3 {
                return Err(HttpError::new(400, "That passphrase is too easy to guess. Use less common words."));
            }
            Ok(json!({ "type": "passphrase" }))
        }
        _ => {
            if validate::len16(value) < MIN_MASTER_LENGTH {
                return Err(HttpError::new(400, format!("Master password must be at least {MIN_MASTER_LENGTH} characters")));
            }
            if validate::strength_score(value) < 3 {
                return Err(HttpError::new(400, "Master password is too easy to guess. Use a longer passphrase."));
            }
            Ok(json!({ "type": "password" }))
        }
    }
}

fn item_ids(raw: Option<&Value>) -> Result<Vec<String>> {
    let bad = || HttpError::new(400, "Choose some items first");
    let list = raw.and_then(Value::as_array).filter(|a| !a.is_empty() && a.len() <= 10_000).ok_or_else(bad)?;
    list.iter().map(|x| x.as_str().filter(|s| validate::len16(s) <= 64).map(str::to_string).ok_or_else(bad)).collect()
}

/// Re-arms PIN unlock after a master-password unlock, when a PIN is set.
async fn rearm_pin(app: &App, dek: &Key) -> Result<()> {
    let pin = {
        let mut g = app.lock();
        let store = g.store()?;
        vault::read_pin(store, dek)?
    };
    if let Some(pin) = pin {
        let kdf = crypto::new_kdf_params(false);
        let pin_key = derive(pin.clone(), kdf.clone()).await?;
        app.lock().quick.arm(dek, &pin_key, kdf, pin.len());
    }
    Ok(())
}

/// The audit, rating new or changed passwords off the async threads and remembering each rating
/// inside its (encrypted) item so the next audit doesn't redo it.
async fn audit_report(app: &App, token: Option<&str>) -> Result<Value> {
    let entries = {
        let mut g = app.lock();
        let key = g.key_for(token, true)?;
        vault::list_entries(g.store()?, &key)?
    };
    let (entries, fresh) = tokio::task::spawn_blocking(move || {
        let mut entries = entries;
        let fresh = audit::rate_logins(&mut entries);
        (entries, fresh)
    })
    .await
    .map_err(|_| HttpError::new(500, "Internal error"))?;
    let mut g = app.lock();
    let key = g.key_for(token, false)?; // the session may have locked while rating
    if !fresh.is_empty() {
        g.store()?.transaction(|s| {
            for (id, rating) in &fresh {
                // Skip anything edited while it was rated: the rating would be for the old password.
                let pw = entries.iter().find(|e| e["id"] == id.as_str()).and_then(|e| e["password"].as_str()).unwrap_or("").to_string();
                vault::patch_entry(s, &key, id, json!({ "strength": rating }), move |d| d.get("password").and_then(Value::as_str) == Some(pw.as_str()))?;
            }
            Ok(())
        })?;
    }
    let settings = g.settings()?;
    Ok(audit::build_report(&entries, &settings, now_ms()))
}

/// Every /api route. Returns (status, JSON body).
async fn route(app: &App, method: &Method, path: &str, token: Option<&str>, body: &Value) -> Result<(u16, Value)> {
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    let m = method.as_str();
    let ok = |v: Value| Ok((200, v));

    // Small, synchronous routes run under one lock. The closure scopes `?` to the route's body.
    macro_rules! with {
        (|$g:ident| $body:expr) => {{
            let mut $g = app.lock();
            #[allow(clippy::redundant_closure_call)]
            let out: Result<Value> = (|| $body)();
            out.map(|v| (200, v))
        }};
    }

    match (m, parts.as_slice()) {
        ("GET", ["status"]) => with!(|g| g.status(token)),

        // ------------------------------------------------------------ storage
        ("POST", ["storage", "connect" | "create" | "default"]) => {
            require_current(app, body).await?;
            let mut g = app.lock();
            match parts[1] {
                "connect" => g.storage.connect(body.get("path").and_then(Value::as_str))?,
                "create" => g.storage.create(body.get("path").and_then(Value::as_str))?,
                _ => g.storage.use_default()?,
            };
            g.lock_all();
            g.vault_id = g.current_vault_id();
            ok(g.status(token)?)
        }
        ("POST", ["storage", "retry"]) => with!(|g| {
            g.storage.retry()?;
            g.vault_id = g.current_vault_id();
            g.status(token)
        }),
        ("POST", ["storage", "move"]) => {
            app.lock().key_for(token, true)?;
            require_current(app, body).await?;
            let mut g = app.lock();
            g.storage.move_to(body.get("path").and_then(Value::as_str))?;
            ok(g.status(token)?)
        }
        ("POST", ["storage", "wipe"]) => {
            app.lock().key_for(token, true)?;
            require_current(app, body).await?;
            let mut g = app.lock();
            g.store()?.wipe()?;
            g.lock_all();
            g.vault_id = None;
            ok(g.status(token)?)
        }
        ("GET", ["storage", "template"]) => ok(json!({ "filename": "Keys.sqlite", "data": crypto::b64_encode(&Storage::template()?) })),
        ("POST", ["storage", "browse"]) => {
            // Opening a Finder dialog is for this app's own unlocked window (or before there's a vault).
            {
                let mut g = app.lock();
                if g.storage.available() && vault::is_initialized(g.store()?)? {
                    g.key_for(token, true)?;
                }
            }
            ok(json!({ "path": storage::browse(body.get("mode").and_then(Value::as_str) == Some("save")).await? }))
        }

        // ------------------------------------------------------------ setup / unlock
        ("POST", ["setup"]) => {
            let password = require_string(body.get("password"), "Master password", 1024)?;
            let credential = check_credential(&password, body.get("type"))?;
            if vault::is_initialized(app.lock().store()?)? {
                return Err(HttpError::new(409, "Setup is already done"));
            }
            let dek = crypto::random_key();
            let kdf = crypto::new_kdf_params(is_short_credential(&credential));
            let file = app.lock().storage.file().to_path_buf();
            let kek = derive(password, kdf.clone()).await?;
            let wrapped = crypto::encrypt(&kek, dek.as_ref(), vault::DEK_AAD);
            let mut g = app.lock();
            if g.storage.file() != file {
                return Err(HttpError::new(409, "The database changed during setup. Start again."));
            }
            vault::commit_setup(g.store()?, &dek, &kdf, &wrapped, &credential)?;
            ok(g.opened(dek)?)
        }
        ("POST", ["unlock"]) => {
            let password = require_string(body.get("password"), "Master password", 1024)?;
            let label = {
                let mut g = app.lock();
                if !vault::is_initialized(g.store()?)? {
                    return Err(HttpError::new(409, "Setup isn’t finished yet"));
                }
                credential_label(&vault::credential(g.store()?)?)
            };
            let dek = check_password(app, &password).await?.ok_or_else(|| HttpError::coded(401, format!("Incorrect {label}"), "BAD_PASSWORD"))?;
            rearm_pin(app, &dek).await?;
            ok(app.lock().opened(dek)?)
        }
        ("POST", ["unlock", "pin"]) => {
            let pin = opt_string(body.get("pin"), 16);
            let (kdf, busy) = {
                let mut g = app.lock();
                if !vault::is_initialized(g.store()?)? {
                    return Err(HttpError::new(409, "Setup isn’t finished yet"));
                }
                let Some(kdf) = g.quick.kdf.clone() else {
                    return Err(HttpError::coded(409, "PIN unlock isn’t available right now. Use your master password.", "PIN_UNAVAILABLE"));
                };
                if g.quick.busy {
                    return Err(HttpError::new(429, "An unlock is already in progress"));
                }
                (kdf, Busy::set(app, &mut g, |i| &mut i.quick.busy))
            };
            let pin_key = derive(pin, kdf).await;
            drop(busy);
            let mut g = app.lock();
            match g.quick.try_key(&pin_key?) {
                Some(dek) => ok(g.opened(dek)?),
                None if !g.quick.armed() => Err(HttpError::coded(401, "Too many wrong PINs. Use your master password to unlock.", "PIN_EXHAUSTED")),
                None => {
                    let left = g.quick.attempts_left;
                    Err(HttpError::coded(401, format!("Wrong PIN. {left} {} left before the master password is needed.", if left == 1 { "try" } else { "tries" }), "BAD_PIN"))
                }
            }
        }

        // ------------------------------------------------------------ PIN
        ("POST", ["pin"]) => {
            {
                let mut g = app.lock();
                g.key_for(token, true)?;
                if is_short_credential(&vault::credential(g.store()?)?) {
                    return Err(HttpError::coded(409, "You already unlock with a PIN.", "PIN_VAULT"));
                }
            }
            let pin = validate::validate_pin(body.get("pin"), &[4, 6])?;
            let master = require_string(body.get("masterPassword"), "Master password", 1024)?;
            if check_password(app, &master).await?.is_none() {
                return Err(HttpError::coded(401, "Incorrect master password", "BAD_PASSWORD"));
            }
            let kdf = crypto::new_kdf_params(false);
            let pin_key = derive(pin.clone(), kdf.clone()).await?;
            let mut g = app.lock();
            let key = g.key_for(token, false)?;
            vault::save_pin(g.store()?, &key, &pin)?;
            g.quick.arm(&key, &pin_key, kdf, pin.len());
            ok(json!({ "pin": g.pin_status()? }))
        }
        ("DELETE", ["pin"]) => with!(|g| {
            g.key_for(token, true)?;
            g.store()?.delete_meta("pin")?;
            g.quick.disarm();
            Ok(json!({ "pin": null }))
        }),
        ("POST", ["lock"]) => with!(|g| {
            g.session.lock();
            Ok(json!({ "ok": true }))
        }),
        ("POST", ["session", "ping"]) => with!(|g| {
            g.key_for(token, true)?;
            Ok(json!({ "expiresAt": g.session.expires_at() }))
        }),

        // ------------------------------------------------------------ sharing
        ("GET", ["sync"]) => with!(|g| {
            g.key_for(token, false)?; // looking doesn't count as activity
            g.storage.check_for_changes();
            let db = g.shared_file();
            let devices = g.presence.as_ref().map(|p| p.others(db.as_deref())).unwrap_or_default();
            // Conflict copies are looked for at most once a minute, or right after the file changed.
            let revision = g.storage.revision();
            let fresh = g.conflicts.as_ref().is_some_and(|(at, rev, _)| *rev == revision && at.elapsed() < std::time::Duration::from_secs(60));
            if !fresh {
                let found = Value::Array(sharing::find_conflicts(g.store()?));
                g.conflicts = Some((std::time::Instant::now(), revision, found));
            }
            let conflicts = g.conflicts.as_ref().map(|(_, _, c)| c.clone()).unwrap_or(json!([]));
            g.settings()?; // picks up an auto-lock time changed on another computer
            let update = app.update.lock().unwrap_or_else(|p| p.into_inner()).clone();
            Ok(json!({ "revision": g.storage.revision(), "devices": devices, "conflicts": conflicts, "update": update }))
        }),
        ("POST", ["sync", "merge"]) => with!(|g| {
            g.key_for(token, true)?;
            let file = require_string(body.get("path"), "Copy", 4096)?;
            sharing::merge_conflict(g.store()?, &file)
        }),

        // ------------------------------------------------------------ the Mac app (Settings → Updates)
        ("GET", ["app"]) => {
            app.lock().key_for(token, false)?;
            ok(match app.native.get() {
                Some(n) => json!({ "native": true, "version": n.version, "autoUpdate": (n.auto)() }),
                None => json!({ "native": false }),
            })
        }
        ("POST", ["update", "check"]) => {
            app.lock().key_for(token, true)?;
            let n = app.native.get().ok_or_else(|| HttpError::new(404, "Updates come through the Mac app"))?;
            (n.check)();
            ok(json!({ "ok": true }))
        }
        ("PUT", ["update", "auto"]) => {
            app.lock().key_for(token, true)?;
            let n = app.native.get().ok_or_else(|| HttpError::new(404, "Updates come through the Mac app"))?;
            let on = body.get("on").and_then(Value::as_bool).ok_or_else(|| HttpError::new(400, "Say on or off"))?;
            (n.set_auto)(on);
            ok(json!({ "autoUpdate": (n.auto)() }))
        }

        // ------------------------------------------------------------ app updates (Mac app only)
        ("POST", ["update", "install"]) => {
            app.lock().key_for(token, true)?;
            let run = app.install.get().ok_or_else(|| HttpError::new(404, "Updates come through the Mac app"))?;
            if app.update.lock().unwrap_or_else(|p| p.into_inner()).is_none() {
                return Err(HttpError::new(409, "There’s no update to install"));
            }
            run();
            ok(json!({ "ok": true }))
        }

        // ------------------------------------------------------------ tools
        ("POST", ["tools", "strength"]) => {
            let password = opt_string(body.get("password"), 1024);
            let inputs: Vec<String> =
                body.get("userInputs").and_then(Value::as_array).map(|a| a.iter().filter_map(|s| s.as_str()).map(|s| opt_string(Some(&Value::from(s)), 200)).collect()).unwrap_or_default();
            ok(validate::check_strength(&password, &inputs))
        }

        // ------------------------------------------------------------ entries
        ("GET", ["entries"]) => {
            let (rows, key) = rows_and_key(app, token)?;
            let list = tokio::task::spawn_blocking(move || vault::entries_from(&rows, &key)).await.map_err(|_| HttpError::new(500, "Internal error"))?;
            ok(Value::Array(list.iter().map(vault::summary).collect()))
        }
        ("GET", ["entries", id]) => with!(|g| {
            let key = g.key_for(token, true)?;
            Ok(Value::Object(vault::get_entry(g.store()?, &key, id)?))
        }),
        ("POST", ["entries"]) => {
            let mut g = app.lock();
            let key = g.key_for(token, true)?;
            let input = validate::sanitize_entry_input(body)?;
            let out = vault::create_entry(g.store()?, &key, input)?;
            g.after();
            Ok((201, Value::Object(out)))
        }
        ("PUT", ["entries", id]) => with!(|g| {
            let key = g.key_for(token, true)?;
            // The editor says which version it started from, so a save never silently undoes a change
            // that arrived meanwhile (from another computer, or the browser extension).
            if let Some(base) = body.get("baseUpdatedAt").and_then(Value::as_i64)
                && vault::get_entry(g.store()?, &key, id)?["updatedAt"].as_i64() != Some(base)
            {
                return Err(HttpError::coded(409, "This item changed elsewhere after you opened it. Close it and open it again to see the latest, then make your change.", "CHANGED"));
            }
            let input = validate::sanitize_entry_input(body)?;
            Ok(Value::Object(vault::update_entry(g.store()?, &key, id, input)?))
        }),
        ("DELETE", ["entries", id]) => with!(|g| {
            g.key_for(token, true)?;
            vault::delete_entry(g.store()?, id)?;
            Ok(json!({ "ok": true }))
        }),
        ("POST", ["entries", "delete"]) => with!(|g| {
            g.key_for(token, true)?;
            let ids = item_ids(body.get("ids"))?;
            g.store()?.transaction(|s| ids.iter().try_for_each(|id| vault::delete_entry(s, id)))?;
            Ok(json!({ "deleted": ids.len() }))
        }),
        ("POST", ["entries", "update"]) => with!(|g| {
            let key = g.key_for(token, true)?;
            let ids = item_ids(body.get("ids"))?;
            let favorite = body.get("favorite");
            let moving = body.as_object().is_some_and(|o| o.contains_key("categoryId"));
            let category = body.get("categoryId").cloned().unwrap_or(Value::Null);
            if favorite.is_some_and(|f| !f.is_boolean()) {
                return Err(HttpError::new(400, "Invalid favourite value"));
            }
            if moving && !category.is_null() && !category.as_str().is_some_and(|c| validate::len16(c) <= 64) {
                return Err(HttpError::new(400, "Invalid category"));
            }
            if favorite.is_none() && !moving {
                return Err(HttpError::new(400, "Nothing to change"));
            }
            g.store()?.transaction(|s| {
                for id in &ids {
                    let mut input = validate::sanitize_entry_input(&Value::Object(vault::get_entry(s, &key, id)?))?;
                    if let Some(f) = favorite {
                        input.insert("favorite".into(), f.clone());
                    }
                    if moving {
                        input.insert("categoryId".into(), category.clone());
                    }
                    vault::update_entry(s, &key, id, input)?;
                }
                Ok(())
            })?;
            Ok(json!({ "updated": ids.len() }))
        }),
        ("PUT", ["entries", id, "icon"]) => with!(|g| {
            let key = g.key_for(token, true)?;
            let icon = validate::sanitize_entry_input(&json!({ "type": "login", "title": "x", "icon": body.get("icon") }))?["icon"].clone();
            vault::get_entry(g.store()?, &key, id)?;
            // The background website-icon fetch only fills a missing icon, never one the person chose meanwhile.
            let only_if_empty = body.get("onlyIfEmpty") == Some(&Value::Bool(true));
            vault::patch_entry(g.store()?, &key, id, json!({ "icon": icon }), |d| !only_if_empty || d.get("icon").and_then(Value::as_str).unwrap_or("").is_empty())?;
            Ok(Value::Object(vault::get_entry(g.store()?, &key, id)?))
        }),
        ("DELETE", ["entries", id, "history"]) => with!(|g| {
            let key = g.key_for(token, true)?;
            Ok(Value::Object(vault::clear_history(g.store()?, &key, id)?))
        }),

        // ------------------------------------------------------------ recently deleted
        ("GET", ["trash"]) => with!(|g| {
            let key = g.key_for(token, true)?;
            Ok(Value::Array(vault::list_trash(g.store()?, &key)?))
        }),
        ("POST", ["trash", "restore"]) => with!(|g| {
            let key = g.key_for(token, true)?;
            let ids = item_ids(body.get("ids"))?;
            vault::restore_entries(g.store()?, &key, &ids)?;
            Ok(json!({ "restored": ids.len() }))
        }),
        ("POST", ["trash", "purge"]) => {
            let label = {
                let mut g = app.lock();
                g.key_for(token, true)?;
                credential_label(&vault::credential(g.store()?)?)
            };
            let current = opt_string(body.get("current"), 1024);
            if current.is_empty() {
                return Err(HttpError::new(400, format!("Enter your {label} to delete permanently")));
            }
            let ids = if body.get("all") == Some(&Value::Bool(true)) { None } else { Some(item_ids(body.get("ids"))?) };
            if check_password(app, &current).await?.is_none() {
                return Err(HttpError::coded(401, format!("Incorrect {label}"), "BAD_PASSWORD"));
            }
            let mut g = app.lock();
            let key = g.key_for(token, false)?; // the session may have locked during the check
            let targets = match ids {
                Some(ids) => ids,
                None => vault::list_trash(g.store()?, &key)?.iter().filter_map(|e| e["id"].as_str().map(str::to_string)).collect(),
            };
            if !targets.is_empty() {
                vault::purge_entries(g.store()?, &targets)?;
            }
            ok(json!({ "purged": targets.len() }))
        }

        // ------------------------------------------------------------ categories
        ("GET", ["categories"]) => with!(|g| {
            let key = g.key_for(token, true)?;
            Ok(Value::Array(vault::list_categories(g.store()?, &key)?))
        }),
        ("POST", ["categories"]) => {
            let mut g = app.lock();
            let key = g.key_for(token, true)?;
            let name = validate::sanitize_category_name(body.get("name"))?;
            Ok((201, vault::create_category(g.store()?, &key, &name)?))
        }
        ("PUT", ["categories", id]) => with!(|g| {
            let key = g.key_for(token, true)?;
            let color = body.get("color").cloned();
            if let Some(c) = &color
                && !c.is_null()
                && !c.as_str().is_some_and(|c| validate::CATEGORY_COLORS.contains(&c))
            {
                return Err(HttpError::new(400, "Unknown folder colour"));
            }
            let name = match body.get("name") {
                None => None,
                Some(n) => Some(validate::sanitize_category_name(Some(n))?),
            };
            vault::update_category(g.store()?, &key, id, name, color)
        }),
        ("DELETE", ["categories", id]) => with!(|g| {
            let key = g.key_for(token, true)?;
            vault::delete_category(g.store()?, &key, id)?;
            Ok(json!({ "ok": true }))
        }),

        // ------------------------------------------------------------ settings
        ("GET", ["settings"]) => with!(|g| {
            g.key_for(token, true)?;
            g.settings()
        }),
        ("PUT", ["settings"]) => with!(|g| {
            g.key_for(token, true)?;
            vault::update_settings(g.store()?, body)?;
            let settings = g.settings()?;
            Ok(json!({ "settings": settings, "expiresAt": g.session.expires_at() }))
        }),
        ("POST", ["account", "change-password"]) => {
            app.lock().key_for(token, true)?;
            let current = require_string(body.get("current"), "Current password", 1024)?;
            let next = require_string(body.get("next"), "New password", 1024)?;
            let credential = check_credential(&next, body.get("type"))?;
            if current == next {
                return Err(HttpError::new(400, "The new one must be different"));
            }
            let label = credential_label(&vault::credential(app.lock().store()?)?);
            let dek = check_password(app, &current).await?.ok_or_else(|| HttpError::coded(401, format!("Current {label} is incorrect"), "BAD_PASSWORD"))?;
            let kdf = crypto::new_kdf_params(is_short_credential(&credential));
            let file = app.lock().storage.file().to_path_buf();
            let kek = derive(next, kdf.clone()).await?;
            let wrapped = crypto::encrypt(&kek, dek.as_ref(), vault::DEK_AAD);
            let mut g = app.lock();
            if g.storage.file() != file {
                return Err(HttpError::new(409, "The database changed while changing the password. Try again."));
            }
            vault::commit_new_credential(g.store()?, &kdf, &wrapped, &credential)?;
            if is_short_credential(&credential) {
                g.quick.disarm();
            }
            ok(json!({ "ok": true, "credential": credential }))
        }

        // ------------------------------------------------------------ website icons
        // Only for logins without an icon, or "Use website icon". It contacts that website directly.
        ("POST", ["tools", "site-icon"]) => {
            app.lock().key_for(token, true)?;
            let url = opt_string(body.get("url"), 2048);
            ok(json!({ "icon": favicon::fetch_site_icon(&url).await? }))
        }

        // ------------------------------------------------------------ audit
        ("GET", ["audit"]) => ok(audit_report(app, token).await?),
        ("POST", ["audit", "breaches"]) => {
            let (targets, busy): (Vec<(String, String)>, Busy<'_>) = {
                let mut g = app.lock();
                let key = g.key_for(token, true)?;
                if g.settings()?["breachCheckEnabled"] != true {
                    return Err(HttpError::coded(400, "Breach checking is turned off. Enable it in Settings first.", "DISABLED"));
                }
                if g.breach_running {
                    return Err(HttpError::new(429, "A breach check is already running"));
                }
                let only: Option<Vec<&str>> = body.get("ids").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect());
                let list = vault::list_entries(g.store()?, &key)?
                    .into_iter()
                    .filter(|e| e["type"] == "login" && e["password"].as_str().is_some_and(|p| !p.is_empty()))
                    .filter(|e| only.as_ref().is_none_or(|o| o.contains(&e["id"].as_str().unwrap_or(""))))
                    .map(|e| (e["id"].as_str().unwrap_or("").to_string(), e["password"].as_str().unwrap_or("").to_string()))
                    .collect();
                (list, Busy::set(app, &mut g, |i| &mut i.breach_running))
            };
            let results = audit::check_breaches(&targets).await;
            drop(busy);
            let results = results.map_err(|e| HttpError::coded(502, format!("Breach check failed: {e}"), "NETWORK"))?;
            {
                let mut g = app.lock();
                let key = g.key_for(token, false)?; // the session may have locked while waiting on the network
                let checked_at = now_ms();
                g.store()?.transaction(|s| {
                    for (id, pw) in &targets {
                        // Skip items deleted, or whose password changed, while the lookup was in flight.
                        if s.get(crate::store::Table::Entries, id)?.is_none_or(|r| r.deleted_at.is_some()) {
                            continue;
                        }
                        if let Some(count) = results.get(id) {
                            let pw = pw.clone();
                            vault::patch_entry(s, &key, id, json!({ "breach": { "count": count, "checkedAt": checked_at } }), move |d| d.get("password").and_then(Value::as_str) == Some(pw.as_str()))?;
                        }
                    }
                    Ok(())
                })?;
            }
            ok(audit_report(app, token).await?)
        }

        // ------------------------------------------------------------ import / export
        ("POST", ["export"]) => {
            let short = {
                let mut g = app.lock();
                g.key_for(token, true)?;
                is_short_credential(&vault::credential(g.store()?)?)
            };
            let format = body.get("format").and_then(Value::as_str).unwrap_or("").to_string();
            if !["encrypted", "json", "csv"].contains(&format.as_str()) {
                return Err(HttpError::new(400, "Unknown export format"));
            }
            let master = require_string(body.get("masterPassword"), "Master password", 1024)?;
            if check_password(app, &master).await?.is_none() {
                return Err(HttpError::coded(401, "Incorrect master password", "BAD_PASSWORD"));
            }
            let given = opt_string(body.get("exportPassword"), 1024);
            let mut export_key = None;
            if format == "encrypted" {
                if given.is_empty() && short {
                    // A backup protected only by a short PIN or pattern would be trivial to open once copied.
                    return Err(HttpError::coded(400, "Choose a file password for the backup (at least 10 characters).", "NEEDS_EXPORT_PASSWORD"));
                }
                let password = if given.is_empty() { master.clone() } else { given };
                // A PIN or pattern is far too short to protect a file that may be copied anywhere.
                if (password != master || short) && validate::len16(&password) < MIN_MASTER_LENGTH {
                    return Err(HttpError::new(400, format!("Export password must be at least {MIN_MASTER_LENGTH} characters")));
                }
                let kdf = crypto::new_kdf_params(false);
                export_key = Some((derive(password, kdf.clone()).await?, kdf));
            }
            let mut g = app.lock();
            let key = g.key_for(token, false)?;
            ok(importexport::export(g.store()?, &key, &format, export_key.as_ref().map(|(k, d)| (k, d)))?)
        }
        ("POST", ["import"]) => {
            app.lock().key_for(token, true)?;
            let content = require_string(body.get("content"), "File content", 90_000_000)?;
            let password = body.get("password").and_then(Value::as_str).filter(|p| !p.is_empty()).map(str::to_string);
            let (source, data) = match importexport::parse_import(&content, password.is_some())? {
                importexport::Parsed::Ready { source, data } => (source, data),
                importexport::Parsed::Encrypted { kdf, blob } => {
                    let key = derive(password.unwrap_or_default(), kdf).await?;
                    ("Keys encrypted export", importexport::open_backup(&key, &blob)?)
                }
            };
            let mut g = app.lock();
            let key = g.key_for(token, false)?; // the session may have locked during key derivation
            ok(importexport::import(g.store()?, &key, source, &data)?)
        }

        // ------------------------------------------------------------ browsers (from the app's Settings)
        ("GET", ["browsers"]) => with!(|g| {
            g.key_for(token, true)?;
            Ok(Value::Array(g.read_pairings()?.iter().map(ext::public_pairing).collect()))
        }),
        ("POST", ["browsers", "approve"]) => with!(|g| {
            g.key_for(token, true)?;
            g.sweep();
            let code = ext::normalize_code(body.get("code"));
            let found = g.pending.iter().position(|p| p.token.is_none() && code.len() == 6 && crypto::safe_equal(&p.code, &code));
            let i = found.ok_or_else(|| HttpError::coded(404, "That code doesn’t match. Check the code in the extension, or start again there", "BAD_CODE"))?;
            let token = crypto::random_token();
            let (name, origin) = (g.pending[i].name.clone(), g.pending[i].origin.clone());
            let pairing = json!({ "id": crypto::random_id(), "name": name, "createdAt": now_ms(), "lastUsedAt": null, "hash": ext::hash_token(&token), "origin": origin });
            let mut list = g.read_pairings()?;
            list.push(pairing.clone());
            g.write_pairings(&list)?;
            g.pending[i].token = Some(token);
            Ok(ext::public_pairing(&pairing))
        }),
        ("DELETE", ["browsers", id]) => with!(|g| {
            g.key_for(token, true)?;
            let list = g.read_pairings()?;
            if !list.iter().any(|p| p["id"] == *id) {
                return Err(HttpError::new(404, "That browser isn’t connected"));
            }
            let rest: Vec<Value> = list.into_iter().filter(|p| p["id"] != *id).collect();
            g.write_pairings(&rest)?;
            Ok(json!({ "ok": true }))
        }),

        _ => Ok((404, json!({ "error": "Not found" }))),
    }
}

// ------------------------------------------------------------------ HTTP plumbing

const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

fn security_headers(res: &mut Response) {
    let h = res.headers_mut();
    for (k, v) in [
        ("content-security-policy", CSP),
        ("x-content-type-options", "nosniff"),
        ("x-frame-options", "DENY"),
        ("referrer-policy", "no-referrer"),
        ("cross-origin-opener-policy", "same-origin"),
        ("cross-origin-resource-policy", "same-origin"),
        ("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()"),
    ] {
        h.insert(k, HeaderValue::from_static(v));
    }
}

/// Blocks DNS rebinding: the Host header must be a loopback name.
fn loopback_host(headers: &HeaderMap) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|h| h.to_str().ok()).map(str::to_ascii_lowercase) else { return false };
    let name = if host.starts_with('[') { host.split(']').next().map(|s| format!("{s}]")) } else { host.split(':').next().map(str::to_string) };
    matches!(name.as_deref(), Some("localhost" | "127.0.0.1" | "[::1]"))
}

fn json_response(status: u16, body: Value) -> Response {
    let mut res = (StatusCode::from_u16(status).unwrap_or(StatusCode::OK), axum::Json(body)).into_response();
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

async fn handle(State(app): State<Shared>, req: Request<Body>) -> Response {
    let (parts, body) = req.into_parts();
    let mut res = if !loopback_host(&parts.headers) {
        (StatusCode::MISDIRECTED_REQUEST, [(header::CONTENT_TYPE, "text/plain")], "Keys only answers on localhost").into_response()
    } else if let Some(path) = parts.uri.path().strip_prefix("/api/") {
        api(&app, &parts.method, path, parts.uri.query(), &parts.headers, body).await
    } else if parts.uri.path() == "/api" {
        json_response(404, json!({ "error": "Not found" }))
    } else {
        static_file(&parts.uri)
    };
    security_headers(&mut res);
    res
}

async fn read_json(body: Body, limit: usize) -> std::result::Result<Value, Box<Response>> {
    let bytes: Bytes = axum::body::to_bytes(body, limit).await.map_err(|_| Box::new(json_response(413, json!({ "error": "Request is too large" }))))?;
    if bytes.is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    serde_json::from_slice(&bytes).map_err(|_| Box::new(json_response(400, json!({ "error": "Malformed JSON" }))))
}

fn respond(out: Result<(u16, Value)>) -> Response {
    match out {
        Ok((status, v)) => json_response(status, v),
        Err(e) => {
            let mut res = e.into_response();
            res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            res
        }
    }
}

async fn api(app: &App, method: &Method, path: &str, query: Option<&str>, headers: &HeaderMap, body: Body) -> Response {
    if let Some(rest) = path.strip_prefix("extension/") {
        // Web pages can't call these: the custom header forces a CORS preflight, never granted.
        // An Origin, when sent, has to be an extension's.
        let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
        if method == Method::OPTIONS || headers.get("x-keys-extension").and_then(|v| v.to_str().ok()) != Some("1") || origin.is_some_and(|o| !ext::is_extension_origin(o)) {
            return json_response(403, json!({ "error": "Request blocked", "code": "FORBIDDEN" }));
        }
        let value = match read_json(body, 64 * 1024).await {
            Ok(v) => v,
            Err(res) => return *res,
        };
        let token = headers.get("x-keys-extension-token").and_then(|v| v.to_str().ok());
        let out = extension_route(app, method, rest, query, origin, token, &value).await;
        app.lock().after();
        return respond(out);
    }
    // CSRF / cross-origin protection: a custom header, our exact Origin, and same-origin fetches only.
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    let site = headers.get("sec-fetch-site").and_then(|v| v.to_str().ok());
    if method == Method::OPTIONS {
        return json_response(403, json!({ "error": "Cross-origin requests are not allowed" }));
    }
    if headers.get("x-keys-request").and_then(|v| v.to_str().ok()) != Some("1") || origin.is_some_and(|o| !app.origins.iter().any(|a| a == o)) || site.is_some_and(|s| s != "same-origin") {
        return json_response(403, json!({ "error": "Request blocked", "code": "FORBIDDEN" }));
    }
    // Backups carry each item's icon, so imports may be large: only for an unlocked session.
    let token = headers.get("x-keys-session").and_then(|v| v.to_str().ok());
    if path == "import"
        && let Err(e) = app.lock().key_for(token, false)
    {
        return respond(Err(e));
    }
    let limit = if path == "import" { 100 * 1024 * 1024 } else { 1024 * 1024 };
    let value = match read_json(body, limit).await {
        Ok(v) => v,
        Err(res) => return *res,
    };
    let out = route(app, method, path, token, &value).await;
    app.lock().after();
    respond(out)
}

/// The paired browser making this request, or a 401 that tells the extension to pair again.
fn pairing_of(g: &mut Inner, token: Option<&str>, origin: Option<&str>) -> Result<Value> {
    let not_paired = || HttpError::coded(401, "This browser isn’t connected to Keys", "NOT_PAIRED");
    let token = token.filter(|t| !t.is_empty()).ok_or_else(not_paired)?;
    let hash = ext::hash_token(token);
    let mut list = g.read_pairings()?;
    let i = list.iter().position(|p| p["hash"].as_str().is_some_and(|h| crypto::safe_equal(h, &hash))).ok_or_else(not_paired)?;
    // A token copied out of the extension doesn't work from anywhere else. Chrome leaves Origin off
    // some extension requests (plain GETs), so only a different one is refused.
    let Some(bound) = list[i]["origin"].as_str() else { return Err(not_paired()) };
    if origin.is_some_and(|o| o != bound) {
        return Err(not_paired());
    }
    // Remembered roughly, so a busy page doesn't write to the database on every request.
    let now = now_ms();
    if list[i]["lastUsedAt"].as_i64().is_none_or(|t| now - t > 60_000) {
        list[i]["lastUsedAt"] = now.into();
        g.write_pairings(&list)?;
    }
    Ok(list[i].clone())
}

/// The vault key, if Keys is unlocked. Filling counts as activity, so Keys stays unlocked while used.
fn ext_key(g: &mut Inner, touch: bool) -> Result<Key> {
    g.session.peek(touch, now_ms()).ok_or_else(|| HttpError::coded(401, "Keys is locked", "LOCKED"))
}

/// The saved login a submitted one would update: same username, saved for exactly this site
/// (filling also works on subdomains, but a subdomain must never overwrite its parent's password).
fn login_for(entries: &[Map<String, Value>], url: &str, username: &str) -> Option<Map<String, Value>> {
    let page = ext::site_of(url, false)?;
    entries
        .iter()
        .find(|e| {
            let saved_url = e["url"].as_str().unwrap_or("");
            e["type"] == "login"
                && ext::site_of(saved_url, true).is_some_and(|saved| ext::bare_host(&saved) == ext::bare_host(&page) && saved.port() == page.port())
                && ext::matches_site(saved_url, url)
                && e["username"].as_str().unwrap_or("").trim().to_lowercase() == username.trim().to_lowercase()
        })
        .cloned()
}

struct SaveInput {
    url: String,
    site: url::Url,
    username: String,
    password: String,
}

fn save_input(body: &Value) -> Result<SaveInput> {
    let url = require_string(body.get("url"), "Page address", 4096)?;
    let site = ext::site_of(&url, false).ok_or_else(|| HttpError::new(400, "Only websites can be saved"))?;
    let password = require_string(body.get("password"), "Password", 4096)?;
    let username = opt_string(body.get("username"), 512);
    Ok(SaveInput { url, site, username, password })
}

async fn extension_route(app: &App, method: &Method, path: &str, query: Option<&str>, origin: Option<&str>, token: Option<&str>, body: &Value) -> Result<(u16, Value)> {
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    let ok = |v: Value| Ok((200, v));
    let q = |name: &str| query.and_then(|q| url::form_urlencoded::parse(q.as_bytes()).find(|(k, _)| k == name).map(|(_, v)| v.into_owned()));

    match (method.as_str(), parts.as_slice()) {
        // "Open Keys" from the extension: the Mac app shows its window instead of a browser tab opening.
        // Harmless to anyone (it only brings Keys forward), so it works before pairing too.
        ("POST", ["show"]) => match app.show.get() {
            Some(show) => {
                show();
                ok(json!({ "shown": true }))
            }
            None => ok(json!({ "shown": false })),
        },
        ("POST", ["pair"]) => {
            let mut g = app.lock();
            g.sweep();
            if !g.storage.available() || !vault::is_initialized(g.store()?)? {
                return Err(HttpError::coded(409, "Set up Keys first, then connect this browser", "NO_VAULT"));
            }
            // Only an extension can ask, and each gets one open request, so no one can use up the slots.
            let origin = origin.filter(|o| ext::is_extension_origin(o)).ok_or_else(|| HttpError::coded(403, "Request blocked", "FORBIDDEN"))?;
            g.pending.retain(|p| !(p.origin == origin && p.token.is_none()));
            if g.pending.len() >= ext::MAX_PENDING {
                return Err(HttpError::new(429, "Too many connection requests. Try again in a few minutes"));
            }
            let (id, code, now) = (crypto::random_id(), ext::new_code(), now_ms());
            g.pending.push(Pending { id: id.clone(), code: code.clone(), origin: origin.to_string(), name: ext::clean_name(body.get("name")), created_at: now, token: None });
            ok(json!({ "requestId": id, "code": code, "expiresAt": now + ext::PAIR_TTL_MS, "appUrl": app.app_url }))
        }
        ("GET", ["pair", id]) => {
            let mut g = app.lock();
            g.sweep();
            let Some(i) = g.pending.iter().position(|p| p.id == *id) else { return ok(json!({ "status": "expired" })) };
            if g.pending[i].token.is_some() {
                let p = g.pending.remove(i); // the token is handed over exactly once
                return ok(json!({ "status": "approved", "token": p.token }));
            }
            ok(json!({ "status": "pending" }))
        }
        ("GET", ["status"]) => {
            let mut g = app.lock();
            let pairing = pairing_of(&mut g, token, origin)?;
            let unlocked = g.session.peek(false, now_ms()).is_some();
            let credential = vault::credential(g.store()?)?;
            let clear = g.settings()?["clipboardClearSeconds"].clone();
            ok(json!({ "unlocked": unlocked, "credential": credential, "appUrl": app.app_url, "browser": pairing["name"], "clipboardClearSeconds": clear }))
        }
        // Logins for the page (or all of them, for the popup's search). Never includes passwords.
        ("GET", ["logins"]) => {
            let (rows, key) = {
                let mut g = app.lock();
                pairing_of(&mut g, token, origin)?;
                let key = ext_key(&mut g, false)?;
                (g.store()?.all(crate::store::Table::Entries)?, key)
            };
            let url = q("url").unwrap_or_default();
            let all = q("all").as_deref() == Some("1");
            // Runs on every page load: decrypt away from the app lock.
            let entries = tokio::task::spawn_blocking(move || vault::entries_from(&rows, &key)).await.map_err(|_| HttpError::new(500, "Internal error"))?;
            let mut logins: Vec<Value> = entries
                .iter()
                .filter(|e| e["type"] == "login" && (e["username"].as_str().is_some_and(|u| !u.is_empty()) || e["password"].as_str().is_some_and(|p| !p.is_empty())))
                .map(|e| {
                    let matches = !url.is_empty() && ext::matches_site(e["url"].as_str().unwrap_or(""), &url);
                    json!({ "id": e["id"], "title": e["title"], "username": e["username"], "url": e["url"], "icon": e["icon"], "matches": matches })
                })
                .filter(|e| all || e["matches"] == true)
                .collect();
            logins.sort_by(|a, b| {
                (b["matches"] == true).cmp(&(a["matches"] == true)).then_with(|| a["title"].as_str().unwrap_or("").to_lowercase().cmp(&b["title"].as_str().unwrap_or("").to_lowercase()))
            });
            ok(json!({ "logins": logins }))
        }
        // A login's username and password, but only for a page it belongs to.
        ("POST", ["fill"]) => {
            let mut g = app.lock();
            pairing_of(&mut g, token, origin)?;
            let key = ext_key(&mut g, true)?;
            let id = require_string(body.get("id"), "Item", 64)?;
            let url = require_string(body.get("url"), "Page address", 4096)?;
            let e = vault::get_entry(g.store()?, &key, &id)?;
            if e["type"] != "login" || !ext::matches_site(e["url"].as_str().unwrap_or(""), &url) {
                return Err(HttpError::coded(403, "That login isn’t for this site", "WRONG_SITE"));
            }
            ok(json!({ "username": e["username"], "password": e["password"] }))
        }
        // What saving would do; nothing is written.
        ("POST", ["save", "check"]) => {
            let mut g = app.lock();
            pairing_of(&mut g, token, origin)?;
            let key = ext_key(&mut g, false)?;
            let input = save_input(body)?;
            let entries = vault::list_entries(g.store()?, &key)?;
            let existing = login_for(&entries, &input.url, &input.username);
            let status = match &existing {
                None => "new",
                Some(e) if e["password"].as_str() == Some(input.password.as_str()) => "same",
                Some(_) => "update",
            };
            ok(json!({ "status": status, "title": existing.map_or(Value::Null, |e| e["title"].clone()) }))
        }
        // Needs the person's click on the prompt, which the extension enforces.
        ("POST", ["save"]) => {
            let mut g = app.lock();
            pairing_of(&mut g, token, origin)?;
            let key = ext_key(&mut g, true)?;
            let input = save_input(body)?;
            let entries = vault::list_entries(g.store()?, &key)?;
            if let Some(existing) = login_for(&entries, &input.url, &input.username) {
                let id = existing["id"].as_str().unwrap_or("").to_string();
                if existing["password"].as_str() == Some(input.password.as_str()) {
                    return ok(json!({ "status": "same", "id": id }));
                }
                let mut next = existing.clone();
                next.insert("password".into(), input.password.clone().into());
                let sanitized = validate::sanitize_entry_input(&Value::Object(next))?;
                vault::update_entry(g.store()?, &key, &id, sanitized)?;
                return ok(json!({ "status": "updated", "id": id }));
            }
            let host = ext::bare_host(&input.site);
            let host_units: Vec<u16> = host.encode_utf16().take(200).collect();
            let host_title = String::from_utf16_lossy(&host_units);
            let url = if input.site.scheme() == "https" {
                match input.site.port() {
                    Some(p) => format!("{host}:{p}"),
                    None => host.clone(),
                }
            } else {
                input.site.origin().ascii_serialization()
            };
            let entry = validate::sanitize_entry_input(&json!({
                "type": "login", "title": host_title, "username": input.username.trim(), "password": input.password, "url": url,
                "notes": "", "codes": "", "categoryId": null, "favorite": false, "icon": "", "customFields": [],
            }))?;
            let created = vault::create_entry(g.store()?, &key, entry)?;
            ok(json!({ "status": "saved", "id": created["id"] }))
        }
        // For the popup's copy buttons, which the person presses themselves.
        ("POST", ["secret"]) => {
            let mut g = app.lock();
            pairing_of(&mut g, token, origin)?;
            let key = ext_key(&mut g, true)?;
            let id = require_string(body.get("id"), "Item", 64)?;
            let e = vault::get_entry(g.store()?, &key, &id)?;
            if e["type"] != "login" {
                return Err(HttpError::new(400, "Only logins can be copied here"));
            }
            ok(json!({ "username": e["username"], "password": e["password"] }))
        }
        // Unlocks Keys from the extension, with the same checks and lockout as the app.
        ("POST", ["unlock"]) => {
            let label = {
                let mut g = app.lock();
                pairing_of(&mut g, token, origin)?;
                if g.session.unlocked() {
                    return ok(json!({ "unlocked": true }));
                }
                if !vault::is_initialized(g.store()?)? {
                    return Err(HttpError::new(409, "Setup isn’t finished yet"));
                }
                credential_label(&vault::credential(g.store()?)?)
            };
            let secret = require_string(body.get("secret"), "Password", 1024)?;
            let dek = check_password(app, &secret).await?.ok_or_else(|| HttpError::coded(401, format!("Incorrect {label}"), "BAD_PASSWORD"))?;
            rearm_pin(app, &dek).await?;
            let mut g = app.lock();
            g.vault_id = g.current_vault_id();
            g.settings()?;
            g.session.open(dek, now_ms());
            ok(json!({ "unlocked": true }))
        }
        ("POST", ["lock"]) => {
            let mut g = app.lock();
            pairing_of(&mut g, token, origin)?;
            g.session.lock();
            ok(json!({ "unlocked": false }))
        }
        // The extension forgetting itself ("Disconnect" in its settings).
        ("POST", ["disconnect"]) => {
            let mut g = app.lock();
            let pairing = pairing_of(&mut g, token, origin)?;
            let rest: Vec<Value> = g.read_pairings()?.into_iter().filter(|p| p["id"] != pairing["id"]).collect();
            g.write_pairings(&rest)?;
            ok(json!({ "ok": true }))
        }
        _ => Ok((404, json!({ "error": "Not found" }))),
    }
}

fn static_file(uri: &Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let (file, name) = match Assets::get(path).filter(|_| !path.is_empty()) {
        Some(f) => (f, path),
        None => match Assets::get("index.html") {
            Some(f) => (f, "index.html"),
            None => return (StatusCode::NOT_FOUND, "The app isn’t built: run npm run build").into_response(),
        },
    };
    let mime = mime_guess::from_path(name).first_or_octet_stream();
    // Built files have content hashes in their names: cache them for good. The page revalidates.
    let cache = if name.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else if name == "index.html" {
        "no-cache"
    } else {
        "public, max-age=3600"
    };
    ([(header::CONTENT_TYPE, mime.as_ref().to_string()), (header::CACHE_CONTROL, cache.to_string())], file.data.into_owned()).into_response()
}

pub fn router(app: Shared) -> Router {
    Router::new().fallback(handle).layer(DefaultBodyLimit::disable()).with_state(app)
}

/// Serves an existing App (the Mac app keeps a handle to it, to clean up on quit). Locks idle
/// sessions every second and refreshes the "open on this computer" marker every minute.
pub async fn serve_app(app: Shared, listener: tokio::net::TcpListener) -> std::io::Result<()> {
    let ticker = app.clone();
    tokio::spawn(async move {
        let mut every = tokio::time::interval(std::time::Duration::from_secs(1));
        let mut n = 0u64;
        loop {
            every.tick().await;
            ticker.tick();
            if n.is_multiple_of(60) {
                ticker.beat();
            }
            n += 1;
        }
    });
    axum::serve(listener, router(app)).await
}
