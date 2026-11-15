//! Import and export. The encrypted backup format must stay stable: older backups have to keep opening.

use serde_json::{Map, Value, json};

use crate::crypto::{self, KdfParams, Key};
use crate::error::{HttpError, Result};
use crate::store::Store;
use crate::validate::{ENTRY_TYPES, sanitize_entry_input};
use crate::vault;

// Kept from the app's original name: it's bound into every encrypted export.
const EXPORT_AAD: &str = "vaultx:export:v1";

fn s<'a>(e: &'a Map<String, Value>, k: &str) -> &'a str {
    e.get(k).and_then(Value::as_str).unwrap_or("")
}

/// Everything, with categories by name so files are portable.
fn snapshot(store: &mut Store, key: &[u8; 32]) -> Result<Value> {
    let categories = vault::list_categories(store, key)?;
    let name_of = |id: &str| categories.iter().find(|c| c["id"] == id).map(|c| c["name"].clone());
    let entries: Vec<Value> = vault::list_entries(store, key)?
        .iter()
        .map(|e| {
            let category = e.get("categoryId").and_then(Value::as_str).and_then(name_of).unwrap_or(Value::Null);
            json!({
                "type": e["type"], "title": e["title"], "username": e["username"], "password": e["password"], "url": e["url"],
                "notes": e["notes"], "codes": e["codes"], "category": category, "favorite": e["favorite"], "icon": e["icon"],
                "customFields": e.get("customFields").cloned().unwrap_or(json!([])), "createdAt": e["createdAt"],
                "passwordUpdatedAt": e["passwordUpdatedAt"], "history": e.get("history").cloned().unwrap_or(json!([])),
            })
        })
        .collect();
    Ok(json!({ "categories": categories.iter().map(|c| c["name"].clone()).collect::<Vec<_>>(), "entries": entries }))
}

// ------------------------------------------------------------------ CSV

pub fn parse_csv(text: &str) -> Result<Vec<Vec<String>>> {
    let src = text.strip_prefix('\u{feff}').unwrap_or(text);
    let (mut rows, mut row, mut field, mut quoted) = (Vec::new(), Vec::new(), String::new(), false);
    let mut chars = src.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                field.push(c);
            }
        } else if c == '"' {
            quoted = true;
        } else if c == ',' {
            row.push(std::mem::take(&mut field));
        } else if c == '\n' || c == '\r' {
            if c == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            row.push(std::mem::take(&mut field));
            rows.push(std::mem::take(&mut row));
        } else {
            field.push(c);
        }
    }
    if quoted {
        return Err(HttpError::new(400, "Malformed CSV: unterminated quote"));
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    Ok(rows.into_iter().filter(|r: &Vec<String>| r.iter().any(|v| !v.trim().is_empty())).collect())
}

/// Spreadsheets run cells starting with = + - @ (or tab/return) as formulas: those get a leading
/// apostrophe, which spreadsheets hide and import strips again.
fn formula_start(v: &str) -> bool {
    v.starts_with(['=', '+', '-', '@', '\t', '\r'])
}

fn csv_cell(v: &str) -> String {
    let safe = if formula_start(v) { format!("'{v}") } else { v.to_string() };
    if safe.contains(['"', ',', '\r', '\n']) { format!("\"{}\"", safe.replace('"', "\"\"")) } else { safe }
}

pub fn to_csv(rows: &[Vec<String>]) -> String {
    rows.iter().map(|r| r.iter().map(|c| csv_cell(c)).collect::<Vec<_>>().join(",")).collect::<Vec<_>>().join("\r\n") + "\r\n"
}

const ALIASES: [(&str, &[&str]); 9] = [
    ("type", &["type"]),
    ("title", &["title", "name", "account", "site name", "item name"]),
    ("url", &["url", "login_uri", "website", "uri", "web site", "login url", "site"]),
    ("username", &["username", "login_username", "user", "user name", "login", "login name", "email", "e-mail"]),
    ("password", &["password", "login_password", "pass"]),
    ("notes", &["notes", "note", "extra", "comments", "comment"]),
    ("codes", &["codes", "recovery codes"]),
    ("category", &["category", "folder", "grouping", "group"]),
    ("favorite", &["favorite", "fav", "favourite"]),
];

fn host_title(url: &str) -> String {
    crate::audit::host_of(url)
}

fn from_csv(text: &str) -> Result<Vec<Value>> {
    let rows = parse_csv(text)?;
    if rows.len() < 2 {
        return Err(HttpError::new(400, "CSV has no data rows"));
    }
    let header: Vec<String> = rows[0].iter().map(|h| h.trim().to_lowercase()).collect();
    let idx = |f: &str| {
        let names = ALIASES.iter().find(|(k, _)| *k == f).unwrap().1;
        header.iter().position(|h| names.contains(&h.as_str()))
    };
    if idx("password").is_none() && idx("notes").is_none() {
        return Err(HttpError::new(400, "Unrecognised CSV: expected at least a \"password\" or \"notes\" column"));
    }
    Ok(rows[1..]
        .iter()
        .map(|r| {
            let get = |f: &str| {
                let v = idx(f).and_then(|i| r.get(i)).cloned().unwrap_or_default();
                if v.starts_with('\'') && formula_start(&v[1..]) { v[1..].to_string() } else { v }
            };
            let raw_type = get("type").trim().to_string();
            let kind = if ENTRY_TYPES.contains(&raw_type.as_str()) {
                raw_type
            } else if get("password").is_empty() && get("username").is_empty() && !get("notes").is_empty() {
                "note".into()
            } else {
                "login".into()
            };
            let url = get("url");
            let title = Some(get("title").trim().to_string()).filter(|t| !t.is_empty()).or_else(|| Some(host_title(&url)).filter(|t| !t.is_empty())).unwrap_or_else(|| "Imported item".into());
            let category = get("category").trim().to_string();
            let favorite = ["1", "true", "yes", "y"].contains(&get("favorite").trim().to_lowercase().as_str());
            json!({
                "type": kind, "title": title, "username": get("username"), "password": get("password"), "url": url,
                "notes": get("notes"), "codes": get("codes"), "category": if category.is_empty() { Value::Null } else { category.into() },
                "favorite": favorite, "customFields": [],
            })
        })
        .collect())
}

fn from_bitwarden(data: &Map<String, Value>) -> Result<Vec<Value>> {
    if data.get("encrypted") == Some(&Value::Bool(true)) {
        return Err(HttpError::new(400, "Encrypted Bitwarden exports are not supported; export as unencrypted JSON"));
    }
    let empty = vec![];
    let folders = data.get("folders").and_then(Value::as_array).unwrap_or(&empty);
    let folder = |id: &Value| folders.iter().find(|f| f["id"] == *id).and_then(|f| f["name"].as_str()).filter(|n| !n.is_empty());
    Ok(data
        .get("items")
        .and_then(Value::as_array)
        .unwrap_or(&empty)
        .iter()
        .filter(|i| i["type"] == 1 || i["type"] == 2)
        .map(|i| {
            let st = |v: &Value| v.as_str().unwrap_or("").to_string();
            let fields: Vec<Value> =
                i["fields"].as_array().map(|a| a.iter().map(|f| json!({ "id": "", "label": st(&f["name"]), "value": st(&f["value"]), "hidden": f["type"] == 1 })).collect()).unwrap_or_default();
            json!({
                "type": if i["type"] == 2 { "note" } else { "login" },
                "title": i["name"].as_str().filter(|n| !n.is_empty()).unwrap_or("Imported item"),
                "username": st(&i["login"]["username"]),
                "password": st(&i["login"]["password"]),
                "url": st(&i["login"]["uris"][0]["uri"]),
                "notes": st(&i["notes"]),
                "codes": "",
                "category": folder(&i["folderId"]),
                "favorite": crate::validate::truthy(i.get("favorite")),
                "customFields": fields,
            })
        })
        .collect())
}

// ------------------------------------------------------------------ export

fn today_utc() -> (String, String) {
    let ms = vault::now_ms();
    let days = ms.div_euclid(86_400_000);
    // Civil date from days since 1970 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    let t = ms.rem_euclid(86_400_000);
    let stamp = format!("{y:04}-{m:02}-{d:02}");
    let iso = format!("{stamp}T{:02}:{:02}:{:02}.{:03}Z", t / 3_600_000, t / 60_000 % 60, t / 1000 % 60, t % 1000);
    (stamp, iso)
}

/// The export, given the export key already derived (for "encrypted") with `kdf`.
pub fn export(store: &mut Store, key: &[u8; 32], format: &str, export_key: Option<(&Key, &KdfParams)>) -> Result<Value> {
    let data = snapshot(store, key)?;
    let (stamp, created) = today_utc();
    match format {
        "encrypted" => {
            let (ek, kdf) = export_key.ok_or_else(|| HttpError::new(400, "An export password is required"))?;
            let blob = crypto::encrypt_json(ek, &data, EXPORT_AAD);
            let file = json!({ "format": "keys-export", "version": 1, "createdAt": created, "kdf": kdf, "data": crypto::b64_encode(&blob) });
            Ok(json!({ "filename": format!("keys-{stamp}.keys.json"), "mime": "application/json", "content": serde_json::to_string_pretty(&file).unwrap() }))
        }
        "json" => {
            let mut file = json!({ "format": "keys-plain", "version": 1, "createdAt": created });
            file["categories"] = data["categories"].clone();
            file["entries"] = data["entries"].clone();
            Ok(json!({ "filename": format!("keys-{stamp}-UNENCRYPTED.json"), "mime": "application/json", "content": serde_json::to_string_pretty(&file).unwrap() }))
        }
        "csv" => {
            let header = ["type", "title", "username", "password", "url", "notes", "codes", "category", "favorite"].map(String::from).to_vec();
            let mut rows = vec![header];
            for e in data["entries"].as_array().unwrap() {
                let e = e.as_object().unwrap();
                let mut r: Vec<String> = ["type", "title", "username", "password", "url", "notes", "codes", "category"].iter().map(|k| s(e, k).to_string()).collect();
                r.push(if e["favorite"] == true { "1".into() } else { "0".into() });
                rows.push(r);
            }
            Ok(json!({ "filename": format!("keys-{stamp}-UNENCRYPTED.csv"), "mime": "text/csv", "content": to_csv(&rows) }))
        }
        _ => Err(HttpError::new(400, "Unknown export format")),
    }
}

// ------------------------------------------------------------------ import

/// An encrypted backup needs its password: returns its KDF settings and ciphertext to derive with.
pub enum Parsed {
    Ready { source: &'static str, data: Value },
    Encrypted { kdf: KdfParams, blob: Vec<u8> },
}

pub fn parse_import(content: &str, has_password: bool) -> Result<Parsed> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err(HttpError::new(400, "File is empty"));
    }
    if !trimmed.starts_with('{') {
        return Ok(Parsed::Ready { source: "CSV", data: json!({ "categories": [], "entries": from_csv(content)? }) });
    }
    let json: Map<String, Value> = serde_json::from_str(trimmed).map_err(|_| HttpError::new(400, "File is not valid JSON or CSV"))?;
    let format = json.get("format").and_then(Value::as_str).unwrap_or("");
    // 'vaultx-*' formats are files exported before the app was renamed to Keys.
    if format == "keys-export" || format == "vaultx-export" {
        if !has_password {
            return Err(HttpError::coded(400, "This export is encrypted; enter its password", "NEEDS_PASSWORD"));
        }
        let kdf: KdfParams = json
            .get("kdf")
            .and_then(|k| serde_json::from_value(k.clone()).ok())
            .filter(crypto::is_valid_kdf)
            .ok_or_else(|| HttpError::new(400, "Export file has invalid key-derivation parameters"))?;
        let blob = json.get("data").and_then(Value::as_str).and_then(crypto::b64_decode).unwrap_or_default();
        return Ok(Parsed::Encrypted { kdf, blob });
    }
    if format == "keys-plain" || format == "vaultx-plain" {
        return Ok(Parsed::Ready { source: "Keys JSON", data: Value::Object(json) });
    }
    if json.get("items").is_some_and(Value::is_array) {
        return Ok(Parsed::Ready { source: "Bitwarden JSON", data: json!({ "categories": [], "entries": from_bitwarden(&json)? }) });
    }
    Err(HttpError::new(400, "Unrecognised JSON format"))
}

pub fn open_backup(export_key: &Key, blob: &[u8]) -> Result<Value> {
    crypto::decrypt_json(export_key, blob, EXPORT_AAD).map_err(|_| HttpError::coded(400, "Wrong password for this export", "BAD_PASSWORD"))
}

fn finite(v: Option<&Value>) -> Option<i64> {
    v.and_then(Value::as_f64).filter(|f| f.is_finite()).map(|f| f as i64)
}

/// Adds everything new from `data` (an exact copy of an item already here is skipped).
pub fn import(store: &mut Store, key: &[u8; 32], source: &str, data: &Value) -> Result<Value> {
    let entries = data.get("entries").and_then(Value::as_array).ok_or_else(|| HttpError::new(400, "Import file has no entries"))?;
    if entries.len() > 100_000 {
        return Err(HttpError::new(413, "That file has more than 100,000 items. Split it and import each part."));
    }
    let categories = data.get("categories").and_then(Value::as_array).cloned().unwrap_or_default();
    if categories.len() > 1000 {
        return Err(HttpError::new(413, "That file has more than 1,000 categories"));
    }
    let fingerprint = |e: &Map<String, Value>| serde_json::to_string(&json!([s(e, "type"), s(e, "title").trim(), s(e, "username").trim(), s(e, "password"), s(e, "url").trim()])).unwrap();
    let mut existing: std::collections::HashSet<String> = vault::list_entries(store, key)?.iter().map(fingerprint).collect();
    let mut ids: Vec<(String, String)> = vault::list_categories(store, key)?.iter().map(|c| (c["name"].as_str().unwrap_or("").to_lowercase(), c["id"].as_str().unwrap_or("").to_string())).collect();
    let (mut imported, mut skipped, mut created_count) = (0usize, 0usize, 0usize);

    store.transaction(|st| {
        let mut category_for = |st: &mut Store, name: Option<&Value>| -> Result<Value> {
            let Some(name) = name.and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty()) else { return Ok(Value::Null) };
            let units: Vec<u16> = name.encode_utf16().take(60).collect();
            let norm = String::from_utf16_lossy(&units);
            if let Some((_, id)) = ids.iter().find(|(n, _)| *n == norm.to_lowercase()) {
                return Ok(id.clone().into());
            }
            if created_count >= 1000 {
                return Ok(Value::Null); // a file can't flood the sidebar
            }
            let (c, created) = vault::find_or_create_category(st, key, &norm)?;
            if created {
                created_count += 1;
            }
            ids.push((norm.to_lowercase(), c["id"].as_str().unwrap_or("").to_string()));
            Ok(c["id"].clone())
        };
        for name in &categories {
            category_for(st, Some(name))?;
        }
        for raw in entries {
            let mut obj = raw.as_object().cloned().unwrap_or_default();
            obj.insert("categoryId".into(), Value::Null);
            let Ok(mut input) = sanitize_entry_input(&Value::Object(obj)) else {
                skipped += 1;
                continue;
            };
            let fp = fingerprint(&input);
            if existing.contains(&fp) {
                skipped += 1;
                continue;
            }
            input.insert("categoryId".into(), category_for(st, raw.get("category"))?);
            let history: Vec<Value> = raw
                .get("history")
                .and_then(Value::as_array)
                .map(|h| {
                    h.iter()
                        .filter_map(|x| {
                            let pw = x.get("password")?.as_str()?;
                            let at = finite(x.get("changedAt"))?;
                            Some(json!({ "password": String::from_utf16_lossy(&pw.encode_utf16().take(4096).collect::<Vec<_>>()), "changedAt": at }))
                        })
                        .collect()
                })
                .unwrap_or_default();
            vault::create_entry_with(st, key, input, finite(raw.get("createdAt")), finite(raw.get("passwordUpdatedAt")), history)?;
            existing.insert(fp);
            imported += 1;
        }
        Ok(())
    })?;
    Ok(json!({ "imported": imported, "skipped": skipped, "categoriesCreated": created_count, "source": source }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_round_trip_and_formula_guard() {
        let csv = to_csv(&[vec!["title".into(), "password".into()], vec!["=cmd|x".into(), "a,\"b\"\nc".into()]]);
        assert_eq!(csv, "title,password\r\n'=cmd|x,\"a,\"\"b\"\"\nc\"\r\n");
        let rows = parse_csv(&csv).unwrap();
        assert_eq!(rows[1], vec!["'=cmd|x".to_string(), "a,\"b\"\nc".to_string()]);
        let entries = from_csv(&csv).unwrap();
        assert_eq!(entries[0]["title"], "=cmd|x", "import strips the guard");
    }

    #[test]
    fn chrome_style_csv() {
        let e = from_csv("name,url,username,password\nGitHub,https://github.com,me,pw\n,https://www.figma.com/login,me,pw2\n").unwrap();
        assert_eq!(e[0]["title"], "GitHub");
        assert_eq!(e[1]["title"], "figma.com");
        assert_eq!(e[1]["type"], "login");
    }
}
