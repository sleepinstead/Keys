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
use crate::session::{QuickUnlock, Session};
use crate::storage::{self, Storage};
use crate::store::Store;
use crate::validate::{self, opt_string, require_string};
use crate::vault::{self, MIN_MASTER_LENGTH, credential_label, is_short_credential, now_ms};

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
}

pub struct App {
    inner: Mutex<Inner>,
    origins: Vec<String>,
}

pub type Shared = Arc<App>;

impl App {
    pub fn new(storage: Storage, port: u16) -> Shared {
        let mut inner = Inner { storage, session: Session::new(), quick: QuickUnlock::default(), vault_id: None, unlocking: false };
        inner.vault_id = inner.current_vault_id();
        Arc::new(App { inner: Mutex::new(inner), origins: vec![format!("http://localhost:{port}"), format!("http://127.0.0.1:{port}")] })
    }

    pub fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Locks after the idle time; the app calls this every second.
    pub fn tick(&self) {
        self.lock().session.expire_if_idle(now_ms());
    }
}

impl Inner {
    fn store(&mut self) -> Result<&mut Store> {
        self.storage.store()
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
        if !std::mem::take(&mut store.reloaded) {
            return;
        }
        let now = self.current_vault_id();
        if self.vault_id.is_some() && now != self.vault_id {
            self.lock_all();
        }
        self.vault_id = now;
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

async fn derive(password: String, kdf: KdfParams) -> Result<Key> {
    tokio::task::spawn_blocking(move || crypto::derive_key(&password, &kdf))
        .await
        .map_err(|_| HttpError::new(500, "Internal error"))?
        .map_err(|e| HttpError::new(400, e))
}

/// Runs a password check with the lockout rules. Ok(Some(dek)) for the right password; a wrong
/// one counts towards the lockout and gives Ok(None).
async fn check_password(app: &App, password: &str) -> Result<Option<Key>> {
    let (kdf, wrapped) = {
        let mut g = app.lock();
        if vault::lockout_until(g.store()?)?.is_some() {
            return Err(HttpError::coded(429, "Too many failed attempts. Try again later.", "LOCKED_OUT"));
        }
        if g.unlocking {
            return Err(HttpError::new(429, "An unlock is already in progress"));
        }
        let material = vault::unlock_material(g.store()?)?;
        g.unlocking = true;
        material
    };
    let kek = derive(password.to_string(), kdf).await;
    let mut g = app.lock();
    g.unlocking = false;
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

const NOT_YET: &str = "That isn’t in the Mac app yet. Use Keys in the browser (npm start) for it for now.";

/// Every /api route. Returns (status, JSON body).
async fn route(app: &App, method: &Method, path: &str, token: Option<&str>, body: &Value) -> Result<(u16, Value)> {
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    let m = method.as_str();
    let ok = |v: Value| Ok((200, v));

    // Small, synchronous routes run under one lock.
    macro_rules! with {
        (|$g:ident| $body:expr) => {{
            let mut $g = app.lock();
            let out: Result<Value> = (|| $body)();
            $g.after();
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
        ("POST", ["storage", "browse"]) => ok(json!({ "path": storage::browse(body.get("mode").and_then(Value::as_str) == Some("save")).await? })),

        // ------------------------------------------------------------ setup / unlock
        ("POST", ["setup"]) => {
            let password = require_string(body.get("password"), "Master password", 1024)?;
            let credential = check_credential(&password, body.get("type"))?;
            if vault::is_initialized(app.lock().store()?)? {
                return Err(HttpError::new(409, "Setup is already done"));
            }
            let dek = crypto::random_key();
            let kdf = crypto::new_kdf_params(is_short_credential(&credential));
            let kek = derive(password, kdf.clone()).await?;
            let wrapped = crypto::encrypt(&kek, dek.as_ref(), vault::DEK_AAD);
            let mut g = app.lock();
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
            let kdf = {
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
                g.quick.busy = true;
                kdf
            };
            let pin_key = derive(pin, kdf).await;
            let mut g = app.lock();
            g.quick.busy = false;
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
            Ok(json!({ "revision": g.storage.revision(), "devices": [], "conflicts": [] }))
        }),

        // ------------------------------------------------------------ tools
        ("POST", ["tools", "strength"]) => {
            let password = opt_string(body.get("password"), 1024);
            let inputs: Vec<String> = body.get("userInputs").and_then(Value::as_array).map(|a| a.iter().filter_map(|s| s.as_str()).map(|s| opt_string(Some(&Value::from(s)), 200)).collect()).unwrap_or_default();
            ok(validate::check_strength(&password, &inputs))
        }

        // ------------------------------------------------------------ entries
        ("GET", ["entries"]) => with!(|g| {
            let key = g.key_for(token, true)?;
            Ok(Value::Array(vault::list_summaries(g.store()?, &key)?))
        }),
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
            vault::patch_entry(g.store()?, &key, id, json!({ "icon": icon }), |_| true)?;
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
            if let Some(c) = &color {
                if !c.is_null() && !c.as_str().is_some_and(|c| validate::CATEGORY_COLORS.contains(&c)) {
                    return Err(HttpError::new(400, "Unknown folder colour"));
                }
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
            let kek = derive(next, kdf.clone()).await?;
            let wrapped = crypto::encrypt(&kek, dek.as_ref(), vault::DEK_AAD);
            let mut g = app.lock();
            vault::commit_new_credential(g.store()?, &kdf, &wrapped, &credential)?;
            if is_short_credential(&credential) {
                g.quick.disarm();
            }
            ok(json!({ "ok": true, "credential": credential }))
        }

        // ------------------------------------------------------------ not ported yet
        ("GET", ["audit"]) | ("POST", ["audit", "breaches"]) | ("POST", ["export"]) | ("POST", ["import"]) | ("POST", ["tools", "site-icon"]) | ("POST", ["sync", "merge"]) => {
            Err(HttpError::coded(501, NOT_YET, "NOT_YET"))
        }
        ("GET", ["browsers"]) => with!(|g| {
            g.key_for(token, true)?;
            Ok(json!([]))
        }),
        (_, ["browsers", ..]) => Err(HttpError::coded(501, NOT_YET, "NOT_YET")),

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
    let Some(host) = headers.get(header::HOST).and_then(|h| h.to_str().ok()) else { return false };
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
        api(&app, &parts.method, path, &parts.headers, body).await
    } else if parts.uri.path() == "/api" {
        json_response(404, json!({ "error": "Not found" }))
    } else {
        static_file(&parts.uri)
    };
    security_headers(&mut res);
    res
}

async fn api(app: &App, method: &Method, path: &str, headers: &HeaderMap, body: Body) -> Response {
    if path.starts_with("extension/") {
        return json_response(501, json!({ "error": NOT_YET, "code": "NOT_YET" }));
    }
    // CSRF / cross-origin protection: a custom header, our exact Origin, and same-origin fetches only.
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    let site = headers.get("sec-fetch-site").and_then(|v| v.to_str().ok());
    if method == Method::OPTIONS {
        return json_response(403, json!({ "error": "Cross-origin requests are not allowed" }));
    }
    if headers.get("x-keys-request").and_then(|v| v.to_str().ok()) != Some("1")
        || origin.is_some_and(|o| !app.origins.iter().any(|a| a == o))
        || site.is_some_and(|s| s != "same-origin")
    {
        return json_response(403, json!({ "error": "Request blocked", "code": "FORBIDDEN" }));
    }
    let bytes: Bytes = match axum::body::to_bytes(body, 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => return json_response(413, json!({ "error": "Request is too large" })),
    };
    let value: Value = if bytes.is_empty() {
        Value::Object(Map::new())
    } else {
        match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(_) => return json_response(400, json!({ "error": "Malformed JSON" })),
        }
    };
    let token = headers.get("x-keys-session").and_then(|v| v.to_str().ok());
    let out = route(app, method, path, token, &value).await;
    app.lock().after();
    match out {
        Ok((status, v)) => json_response(status, v),
        Err(e) => {
            let mut res = e.into_response();
            res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            res
        }
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
    let cache = if name.starts_with("assets/") { "public, max-age=31536000, immutable" } else if name == "index.html" { "no-cache" } else { "public, max-age=3600" };
    ([(header::CONTENT_TYPE, mime.as_ref().to_string()), (header::CACHE_CONTROL, cache.to_string())], file.data.into_owned()).into_response()
}

pub fn router(app: Shared) -> Router {
    Router::new().fallback(handle).layer(DefaultBodyLimit::disable()).with_state(app)
}

/// Serves Keys on 127.0.0.1:`port` until the process ends. Locks idle sessions every second.
pub async fn serve(storage: Storage, port: u16) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    serve_on(storage, port, listener).await
}

/// Same, on a socket the caller already bound (the Mac app binds before opening its window).
pub async fn serve_on(storage: Storage, port: u16, listener: tokio::net::TcpListener) -> std::io::Result<()> {
    let app = App::new(storage, port);
    let ticker = app.clone();
    tokio::spawn(async move {
        let mut every = tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            every.tick().await;
            ticker.tick();
        }
    });
    axum::serve(listener, router(app)).await
}
