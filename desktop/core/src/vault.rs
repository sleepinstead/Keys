//! The key hierarchy and encrypted records (server/vault.ts):
//!
//!   master credential --Argon2id--> KEK --AES-GCM unwrap--> DEK (random 256-bit vault key)
//!   DEK --AES-GCM--> every entry and category, each bound to its row id via AAD.
//!
//! Entries are kept as JSON maps, so fields this version doesn't know about survive a save.

use serde_json::{Map, Value, json};

use crate::crypto::{self, KEY_BYTES, KdfParams, Key};
use crate::error::{HttpError, Result};
use crate::store::{Row, Store, Table};
use crate::validate::{default_settings, sanitize_settings};

// These labels keep the app's original name on purpose: they are authenticated into every
// ciphertext already on disk, so renaming them would make existing vaults undecryptable.
pub const DEK_AAD: &str = "vaultx:dek:v1";
const PIN_AAD: &str = "vaultx:pin:v1";
fn entry_aad(id: &str) -> String {
    format!("vaultx:entry:{id}")
}
fn category_aad(id: &str) -> String {
    format!("vaultx:category:{id}")
}

const HISTORY_LIMIT: usize = 20;
const FREE_ATTEMPTS: i64 = 5;
const MAX_LOCKOUT_MS: i64 = 15 * 60 * 1000;
pub const MIN_MASTER_LENGTH: usize = 10;
const DEFAULT_CATEGORIES: [&str; 5] = ["Personal", "Work", "Finance", "Social", "Development"];

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn credential_label(credential: &Value) -> &'static str {
    match credential.get("type").and_then(Value::as_str) {
        Some("passphrase") => "passphrase",
        Some("pin") => "PIN",
        Some("pattern") => "pattern",
        _ => "master password",
    }
}

pub fn is_short_credential(credential: &Value) -> bool {
    matches!(credential.get("type").and_then(Value::as_str), Some("pin" | "pattern"))
}

type K = [u8; KEY_BYTES];

// ------------------------------------------------------------------ keys

pub fn is_initialized(store: &mut Store) -> Result<bool> {
    Ok(store.get_meta("wrapped_key")?.is_some())
}

/// Password, passphrase, PIN or pattern. Not secret; the lock screen needs it.
pub fn credential(store: &mut Store) -> Result<Value> {
    Ok(store.get_meta("credential")?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_else(|| json!({ "type": "password" })))
}

pub fn lockout_until(store: &mut Store) -> Result<Option<i64>> {
    let until = store.get_meta("lockout_until")?.and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0) as i64;
    Ok((until > now_ms()).then_some(until))
}

/// What a password check needs from the file: the KDF settings and the wrapped vault key.
pub fn unlock_material(store: &mut Store) -> Result<(KdfParams, Vec<u8>)> {
    let kdf: KdfParams =
        store.get_meta("kdf")?.and_then(|s| serde_json::from_str(&s).ok()).filter(crypto::is_valid_kdf).ok_or_else(|| HttpError::new(400, "This database has invalid key settings"))?;
    let wrapped = store.get_meta("wrapped_key")?.and_then(|s| crypto::b64_decode(&s)).ok_or_else(|| HttpError::new(400, "This database has invalid key settings"))?;
    Ok((kdf, wrapped))
}

/// The vault key, if `kek` (from the right password) opens it.
pub fn unwrap_dek(kek: &K, wrapped: &[u8]) -> Option<Key> {
    unwrap_dek_with(kek, wrapped, DEK_AAD)
}

pub fn unwrap_dek_with(kek: &K, wrapped: &[u8], aad: &str) -> Option<Key> {
    let plain = crypto::decrypt(kek, wrapped, aad).ok()?;
    let mut dek = zeroize::Zeroizing::new([0u8; KEY_BYTES]);
    (plain.len() == KEY_BYTES).then(|| {
        dek.copy_from_slice(&plain);
        dek
    })
}

pub fn record_failure(store: &mut Store) -> Result<()> {
    let attempts = store.get_meta("failed_attempts")?.and_then(|s| s.parse::<i64>().ok()).unwrap_or(0) + 1;
    store.set_meta("failed_attempts", &attempts.to_string())?;
    if attempts >= FREE_ATTEMPTS {
        let delay = MAX_LOCKOUT_MS.min(5000 * 2i64.saturating_pow((attempts - FREE_ATTEMPTS).min(20) as u32));
        store.set_meta("lockout_until", &(now_ms() + delay).to_string())?;
    }
    Ok(())
}

pub fn reset_failures(store: &mut Store) -> Result<()> {
    store.set_meta("failed_attempts", "0")?;
    store.set_meta("lockout_until", "0")
}

/// Writes a new vault: key settings, wrapped key, default settings and categories.
pub fn commit_setup(store: &mut Store, dek: &K, kdf: &KdfParams, wrapped: &[u8], credential: &Value) -> Result<()> {
    let now = now_ms();
    store.transaction(|s| {
        // Checked again here: a second setup may have finished during key derivation.
        if is_initialized(s)? {
            return Err(HttpError::new(409, "Setup is already done"));
        }
        s.set_meta("kdf", &serde_json::to_string(kdf).unwrap())?;
        s.set_meta("wrapped_key", &crypto::b64_encode(wrapped))?;
        s.set_meta("credential", &credential.to_string())?;
        s.set_meta("settings", &default_settings().to_string())?;
        s.set_meta("created_at", &now.to_string())?;
        for (i, name) in DEFAULT_CATEGORIES.iter().enumerate() {
            insert_category(s, dek, name, now + i as i64)?;
        }
        Ok(())
    })
}

/// Re-wraps the vault key under a new credential. Entries are untouched.
pub fn commit_new_credential(store: &mut Store, kdf: &KdfParams, wrapped: &[u8], credential: &Value) -> Result<()> {
    store.transaction(|s| {
        s.set_meta("kdf", &serde_json::to_string(kdf).unwrap())?;
        s.set_meta("wrapped_key", &crypto::b64_encode(wrapped))?;
        s.set_meta("credential", &credential.to_string())?;
        // A vault opened by a PIN has no use for a second, quick-unlock PIN.
        if is_short_credential(credential) {
            s.delete_meta("pin")?;
        }
        Ok(())
    })
}

// ------------------------------------------------------------------ quick-unlock PIN

pub fn pin_length(store: &mut Store) -> Result<Option<u64>> {
    Ok(store.get_meta("pin")?.and_then(|s| serde_json::from_str::<Value>(&s).ok()).and_then(|v| v["length"].as_u64()))
}

/// Stored only encrypted under the vault key, so the database alone never reveals it.
pub fn save_pin(store: &mut Store, key: &K, pin: &str) -> Result<()> {
    let blob = crypto::b64_encode(&crypto::encrypt_json(key, &json!({ "pin": pin }), PIN_AAD));
    store.set_meta("pin", &json!({ "length": pin.encode_utf16().count(), "blob": blob }).to_string())
}

pub fn read_pin(store: &mut Store, key: &K) -> Result<Option<String>> {
    let Some(raw) = store.get_meta("pin")? else { return Ok(None) };
    let blob = serde_json::from_str::<Value>(&raw).ok().and_then(|v| v["blob"].as_str().and_then(crypto::b64_decode));
    Ok(blob.and_then(|b| crypto::decrypt_json(key, &b, PIN_AAD).ok()).and_then(|v| v["pin"].as_str().map(str::to_string)))
}

// ------------------------------------------------------------------ settings

pub fn get_settings(store: &mut Store) -> Result<Value> {
    let raw = store.get_meta("settings")?.and_then(|s| serde_json::from_str::<Value>(&s).ok()).unwrap_or_else(|| json!({}));
    Ok(sanitize_settings(&raw, &default_settings()))
}

pub fn update_settings(store: &mut Store, patch: &Value) -> Result<Value> {
    let next = sanitize_settings(patch, &get_settings(store)?);
    store.set_meta("settings", &next.to_string())?;
    Ok(next)
}

// ------------------------------------------------------------------ entries

/// Decrypted entry data plus id/createdAt/updatedAt, as the API returns it.
fn read_entry(key: &K, row: &Row) -> Result<Map<String, Value>> {
    let data = crypto::decrypt_json(key, &row.blob, &entry_aad(&row.id)).map_err(|_| HttpError::new(500, "An item couldn’t be decrypted"))?;
    let mut m = match data {
        Value::Object(m) => m,
        _ => return Err(HttpError::new(500, "An item couldn’t be decrypted")),
    };
    // Items saved before icons existed have no icon field.
    m.entry("icon").or_insert_with(|| "".into());
    m.insert("id".into(), row.id.clone().into());
    m.insert("createdAt".into(), row.created_at.into());
    m.insert("updatedAt".into(), row.updated_at.into());
    Ok(m)
}

fn strip_ids(mut m: Map<String, Value>) -> Map<String, Value> {
    m.remove("id");
    m.remove("createdAt");
    m.remove("updatedAt");
    m
}

/// What the list shows: no password, notes or history.
fn summary(e: &Map<String, Value>) -> Value {
    json!({
        "id": e["id"], "type": e["type"], "title": e["title"], "username": e["username"], "url": e["url"],
        "categoryId": e.get("categoryId").cloned().unwrap_or(Value::Null), "favorite": e["favorite"], "icon": e["icon"],
        "hasPassword": e.get("password").and_then(Value::as_str).is_some_and(|p| !p.is_empty()),
        "createdAt": e["createdAt"], "updatedAt": e["updatedAt"],
    })
}

/// Live items only: Recently deleted is left out everywhere except the bin itself.
pub fn list_entries(store: &mut Store, key: &K) -> Result<Vec<Map<String, Value>>> {
    store.all(Table::Entries)?.iter().filter(|r| r.deleted_at.is_none()).map(|r| read_entry(key, r)).collect()
}

pub fn list_summaries(store: &mut Store, key: &K) -> Result<Vec<Value>> {
    Ok(list_entries(store, key)?.iter().map(summary).collect())
}

pub fn list_trash(store: &mut Store, key: &K) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    for r in store.all(Table::Entries)?.iter().filter(|r| r.deleted_at.is_some()) {
        let mut s = summary(&read_entry(key, r)?);
        s["deletedAt"] = r.deleted_at.into();
        out.push(s);
    }
    out.sort_by(|a, b| b["deletedAt"].as_i64().cmp(&a["deletedAt"].as_i64()));
    Ok(out)
}

/// Puts items back. One whose category was deleted meanwhile comes back uncategorised.
pub fn restore_entries(store: &mut Store, key: &K, ids: &[String]) -> Result<()> {
    store.transaction(|s| {
        for id in ids {
            let row = s.get(Table::Entries, id)?.filter(|r| r.deleted_at.is_some()).ok_or_else(|| HttpError::new(404, "That item isn’t in Recently deleted"))?;
            s.set_deleted(id, None)?;
            let category = read_entry(key, &row)?.get("categoryId").and_then(Value::as_str).map(str::to_string);
            if let Some(c) = category
                && s.get(Table::Categories, &c)?.is_none()
            {
                patch_entry(s, key, id, json!({ "categoryId": null }), |_| true)?;
            }
        }
        Ok(())
    })
}

/// Deletes for good. Only items already in Recently deleted can be purged.
pub fn purge_entries(store: &mut Store, ids: &[String]) -> Result<()> {
    store.transaction(|s| {
        for id in ids {
            if s.get(Table::Entries, id)?.and_then(|r| r.deleted_at).is_none() {
                return Err(HttpError::new(404, "That item isn’t in Recently deleted"));
            }
            s.delete(Table::Entries, id)?;
        }
        Ok(())
    })
}

pub fn get_entry(store: &mut Store, key: &K, id: &str) -> Result<Map<String, Value>> {
    let row = store.get(Table::Entries, id)?.filter(|r| r.deleted_at.is_none()).ok_or_else(|| HttpError::new(404, "Entry not found"))?;
    read_entry(key, &row)
}

fn check_category(store: &mut Store, input: &mut Map<String, Value>) -> Result<()> {
    if let Some(id) = input.get("categoryId").and_then(Value::as_str).map(str::to_string)
        && store.get(Table::Categories, &id)?.is_none()
    {
        input.insert("categoryId".into(), Value::Null);
    }
    Ok(())
}

pub fn create_entry(store: &mut Store, key: &K, input: Map<String, Value>) -> Result<Map<String, Value>> {
    create_entry_with(store, key, input, None, None, vec![])
}

/// Imports keep an item's original dates and password history.
pub fn create_entry_with(store: &mut Store, key: &K, mut input: Map<String, Value>, created_at: Option<i64>, password_updated_at: Option<i64>, mut history: Vec<Value>) -> Result<Map<String, Value>> {
    let id = crypto::random_id();
    let now = now_ms();
    check_category(store, &mut input)?;
    history.truncate(HISTORY_LIMIT);
    input.insert("passwordUpdatedAt".into(), password_updated_at.unwrap_or(now).into());
    input.insert("history".into(), Value::Array(history));
    input.insert("breach".into(), Value::Null);
    let created = created_at.unwrap_or(now);
    let data = Value::Object(input);
    store.insert(Table::Entries, &Row { id: id.clone(), blob: crypto::encrypt_json(key, &data, &entry_aad(&id)), created_at: created, updated_at: now, deleted_at: None })?;
    let mut out = data.as_object().unwrap().clone();
    out.insert("id".into(), id.into());
    out.insert("createdAt".into(), created.into());
    out.insert("updatedAt".into(), now.into());
    Ok(out)
}

pub fn update_entry(store: &mut Store, key: &K, id: &str, mut input: Map<String, Value>) -> Result<Map<String, Value>> {
    let existing = get_entry(store, key, id)?;
    let now = now_ms();
    let old_pw = existing.get("password").and_then(Value::as_str).unwrap_or("").to_string();
    let changed = input.get("password").and_then(Value::as_str) != Some(old_pw.as_str());
    let mut history = existing.get("history").and_then(Value::as_array).cloned().unwrap_or_default();
    if changed && !old_pw.is_empty() {
        history.insert(0, json!({ "password": old_pw, "changedAt": now }));
        history.truncate(HISTORY_LIMIT);
    }
    check_category(store, &mut input)?;
    input.insert("passwordUpdatedAt".into(), if changed { now.into() } else { existing.get("passwordUpdatedAt").cloned().unwrap_or(now.into()) });
    input.insert("history".into(), Value::Array(history));
    input.insert("breach".into(), if changed { Value::Null } else { existing.get("breach").cloned().unwrap_or(Value::Null) });
    // Kept: its key says whether it still applies, so a stale one is simply re-rated.
    if let Some(s) = existing.get("strength") {
        input.insert("strength".into(), s.clone());
    }
    // Fields this version doesn't know about are kept as they were.
    let before = strip_ids(existing.clone());
    for (k, v) in &before {
        input.entry(k.clone()).or_insert_with(|| v.clone());
    }
    // Starring or filing an item isn't editing it: "Last edited" and the Recent order stay put.
    let strip = |m: &Map<String, Value>| {
        let mut m = m.clone();
        m.remove("favorite");
        m.remove("categoryId");
        Value::Object(m)
    };
    let created = existing["createdAt"].as_i64().unwrap_or(now);
    let updated_at = if strip(&before) == strip(&input) { existing["updatedAt"].as_i64().unwrap_or(now) } else { now };
    let data = Value::Object(input);
    store.update(Table::Entries, id, &crypto::encrypt_json(key, &data, &entry_aad(id)), updated_at)?;
    let mut out = data.as_object().unwrap().clone();
    out.insert("id".into(), id.into());
    out.insert("createdAt".into(), created.into());
    out.insert("updatedAt".into(), updated_at.into());
    Ok(out)
}

/// An update that isn't a user edit (caching breach results, an icon): updated_at stays.
pub fn patch_entry(store: &mut Store, key: &K, id: &str, patch: Value, only_if: impl Fn(&Map<String, Value>) -> bool) -> Result<()> {
    let Some(row) = store.get(Table::Entries, id)? else { return Ok(()) };
    let mut data = strip_ids(read_entry(key, &row)?);
    if !only_if(&data) {
        return Ok(());
    }
    if let Value::Object(p) = patch {
        data.extend(p);
    }
    store.update(Table::Entries, id, &crypto::encrypt_json(key, &Value::Object(data), &entry_aad(id)), row.updated_at)?;
    Ok(())
}

pub fn clear_history(store: &mut Store, key: &K, id: &str) -> Result<Map<String, Value>> {
    get_entry(store, key, id)?;
    patch_entry(store, key, id, json!({ "history": [] }), |_| true)?;
    get_entry(store, key, id)
}

/// Moves an item to Recently deleted.
pub fn delete_entry(store: &mut Store, id: &str) -> Result<()> {
    if store.get(Table::Entries, id)?.filter(|r| r.deleted_at.is_none()).is_none() {
        return Err(HttpError::new(404, "Entry not found"));
    }
    store.set_deleted(id, Some(now_ms()))?;
    Ok(())
}

// ------------------------------------------------------------------ categories

fn insert_category(store: &mut Store, key: &K, name: &str, created_at: i64) -> Result<Value> {
    let id = crypto::random_id();
    let blob = crypto::encrypt_json(key, &json!({ "name": name, "color": null }), &category_aad(&id));
    store.insert(Table::Categories, &Row { id: id.clone(), blob, created_at, updated_at: created_at, deleted_at: None })?;
    Ok(json!({ "id": id, "name": name, "color": null, "createdAt": created_at }))
}

pub fn list_categories(store: &mut Store, key: &K) -> Result<Vec<Value>> {
    store
        .all(Table::Categories)?
        .iter()
        .map(|r| {
            let d = crypto::decrypt_json(key, &r.blob, &category_aad(&r.id)).map_err(|_| HttpError::new(500, "A category couldn’t be decrypted"))?;
            Ok(json!({ "id": r.id, "name": d["name"], "color": d.get("color").cloned().unwrap_or(Value::Null), "createdAt": r.created_at }))
        })
        .collect()
}

fn same_name(c: &Value, name: &str) -> bool {
    c["name"].as_str().is_some_and(|n| n.to_lowercase() == name.to_lowercase())
}

/// The category with this name (any case), created if missing. Returns (category, created).
pub fn find_or_create_category(store: &mut Store, key: &K, name: &str) -> Result<(Value, bool)> {
    if let Some(c) = list_categories(store, key)?.into_iter().find(|c| same_name(c, name)) {
        return Ok((c, false));
    }
    Ok((insert_category(store, key, name, now_ms())?, true))
}

pub fn create_category(store: &mut Store, key: &K, name: &str) -> Result<Value> {
    if list_categories(store, key)?.iter().any(|c| same_name(c, name)) {
        return Err(HttpError::new(409, "A category with that name already exists"));
    }
    insert_category(store, key, name, now_ms())
}

/// Renames and/or recolours. `color`: None keeps it, Some(Null) clears it.
pub fn update_category(store: &mut Store, key: &K, id: &str, name: Option<String>, color: Option<Value>) -> Result<Value> {
    let all = list_categories(store, key)?;
    let current = all.iter().find(|c| c["id"] == id).ok_or_else(|| HttpError::new(404, "Category not found"))?;
    let name = name.unwrap_or_else(|| current["name"].as_str().unwrap_or("").to_string());
    let color = color.unwrap_or_else(|| current["color"].clone());
    if all.iter().any(|c| c["id"] != id && same_name(c, &name)) {
        return Err(HttpError::new(409, "A category with that name already exists"));
    }
    let created = current["createdAt"].clone();
    store.update(Table::Categories, id, &crypto::encrypt_json(key, &json!({ "name": name, "color": color }), &category_aad(id)), now_ms())?;
    Ok(json!({ "id": id, "name": name, "color": color, "createdAt": created }))
}

/// Deletes a category; its items become uncategorised.
pub fn delete_category(store: &mut Store, key: &K, id: &str) -> Result<()> {
    store.transaction(|s| {
        if !s.delete(Table::Categories, id)? {
            return Err(HttpError::new(404, "Category not found"));
        }
        for e in list_entries(s, key)? {
            if e.get("categoryId").and_then(Value::as_str) == Some(id) {
                let eid = e["id"].as_str().unwrap().to_string();
                patch_entry(s, key, &eid, json!({ "categoryId": null }), |_| true)?;
            }
        }
        Ok(())
    })
}
