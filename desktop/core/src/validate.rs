//! Input checks, mirroring server/validate.ts, server/pin.ts, server/strength.ts and
//! shared/credential.ts. Lengths count UTF-16 units, like JavaScript's `.length`.

use serde_json::{Map, Value, json};

use crate::crypto::random_id;
use crate::error::{HttpError, Result};

pub const ENTRY_TYPES: [&str; 4] = ["login", "note", "apiKey", "recovery"];
pub const CATEGORY_COLORS: [&str; 14] =
    ["gray", "red", "orange", "amber", "yellow", "lime", "green", "teal", "cyan", "blue", "indigo", "violet", "pink", "rose"];

pub fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

fn trim(s: &str) -> String {
    s.trim().to_string()
}

fn str_field(v: Option<&Value>, max: usize, name: &str) -> Result<String> {
    match v {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(s)) if len16(s) > max => Err(HttpError::new(400, format!("{name} is too long (max {max} characters)"))),
        Some(Value::String(s)) => Ok(s.clone()),
        Some(_) => Err(HttpError::new(400, format!("{name} must be a string"))),
    }
}

/// JavaScript's Boolean(x).
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn icon(v: Option<&Value>) -> Result<String> {
    let s = str_field(v, 200_000, "Icon")?;
    if s == "none" {
        return Ok(s);
    }
    if let Some(color) = s.strip_prefix("tint:") {
        if !CATEGORY_COLORS.contains(&color) {
            return Err(HttpError::new(400, "Unknown icon colour"));
        }
        return Ok(s);
    }
    if !s.is_empty() && !is_image_data_url(&s) {
        return Err(HttpError::new(400, "Icon must be a PNG, JPEG or WebP image"));
    }
    Ok(s)
}

/// ^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$
fn is_image_data_url(s: &str) -> bool {
    let Some(rest) = ["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,"].iter().find_map(|p| s.strip_prefix(p)) else {
        return false;
    };
    let body = rest.trim_end_matches('=');
    !body.is_empty() && body.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

fn custom_fields(v: Option<&Value>) -> Result<Vec<Value>> {
    let list = match v {
        None | Some(Value::Null) => return Ok(vec![]),
        Some(Value::Array(a)) => a,
        Some(_) => return Err(HttpError::new(400, "customFields must be an array")),
    };
    if list.len() > 50 {
        return Err(HttpError::new(400, "Too many custom fields (max 50)"));
    }
    list.iter()
        .map(|f| {
            let empty = Map::new();
            let o = f.as_object().unwrap_or(&empty);
            let id = o.get("id").and_then(Value::as_str).filter(|s| !s.is_empty() && len16(s) <= 64).map(str::to_string).unwrap_or_else(random_id);
            Ok(json!({
                "id": id,
                "label": trim(&str_field(o.get("label"), 100, "Field label")?),
                "value": str_field(o.get("value"), 10_000, "Field value")?,
                "hidden": truthy(o.get("hidden")),
            }))
        })
        .collect()
}

/// The fields a client may set on an entry, checked. Same keys and order as EntryInput.
pub fn sanitize_entry_input(raw: &Value) -> Result<Map<String, Value>> {
    let o = raw.as_object().ok_or_else(|| HttpError::new(400, "Invalid entry"))?;
    let kind = o.get("type").and_then(Value::as_str).filter(|t| ENTRY_TYPES.contains(t)).ok_or_else(|| HttpError::new(400, "Invalid entry type"))?;
    let title = trim(&str_field(o.get("title"), 200, "Title")?);
    if title.is_empty() {
        return Err(HttpError::new(400, "Title is required"));
    }
    let category = match o.get("categoryId") {
        None | Some(Value::Null) => Value::Null,
        Some(Value::String(s)) if s.is_empty() => Value::Null,
        Some(Value::String(s)) if len16(s) <= 64 => Value::String(s.clone()),
        Some(_) => return Err(HttpError::new(400, "Invalid category")),
    };
    let mut m = Map::new();
    m.insert("type".into(), kind.into());
    m.insert("title".into(), title.into());
    m.insert("username".into(), trim(&str_field(o.get("username"), 512, "Username")?).into());
    m.insert("password".into(), str_field(o.get("password"), 4096, "Password")?.into());
    m.insert("url".into(), trim(&str_field(o.get("url"), 2048, "URL")?).into());
    m.insert("notes".into(), str_field(o.get("notes"), 100_000, "Notes")?.into());
    m.insert("codes".into(), str_field(o.get("codes"), 20_000, "Recovery codes")?.into());
    m.insert("categoryId".into(), category);
    m.insert("favorite".into(), truthy(o.get("favorite")).into());
    m.insert("icon".into(), icon(o.get("icon"))?.into());
    m.insert("customFields".into(), Value::Array(custom_fields(o.get("customFields"))?));
    Ok(m)
}

pub fn sanitize_category_name(raw: Option<&Value>) -> Result<String> {
    let name = trim(&str_field(raw, 60, "Category name")?);
    if name.is_empty() {
        return Err(HttpError::new(400, "Category name is required"));
    }
    Ok(name)
}

pub fn require_string(v: Option<&Value>, name: &str, max: usize) -> Result<String> {
    match v.and_then(Value::as_str) {
        Some(s) if !s.is_empty() && len16(s) <= max => Ok(s.to_string()),
        Some(s) if !s.is_empty() => Err(HttpError::new(400, format!("{name} is too long"))),
        _ => Err(HttpError::new(400, format!("{name} is required"))),
    }
}

/// An optional string field cut to `max` UTF-16 units (like JS `.slice(0, max)`), '' if absent.
pub fn opt_string(v: Option<&Value>, max: usize) -> String {
    let s = v.and_then(Value::as_str).unwrap_or("");
    String::from_utf16_lossy(&s.encode_utf16().take(max).collect::<Vec<_>>())
}

// ------------------------------------------------------------------ settings

pub fn default_generator() -> Value {
    json!({
        "mode": "random", "length": 20, "lowercase": true, "uppercase": true, "digits": true, "symbols": true,
        "excludeAmbiguous": false, "words": 5, "separator": "-", "capitalize": true, "includeNumber": true, "pinLength": 6
    })
}

pub fn default_settings() -> Value {
    json!({
        "autoLockMinutes": 5,
        "clipboardClearSeconds": 30,
        "outdatedDays": 365,
        "breachCheckEnabled": false,
        "lockOnHiddenSeconds": 0,
        "generator": default_generator(),
        "appearance": "system",
        "hideIcons": { "login": false, "note": true, "apiKey": true, "recovery": true },
        "categoriesEnabled": true
    })
}

/// JS: Number(value), then clamp and round; non-finite keeps the fallback.
fn int_in(v: Option<&Value>, min: i64, max: i64, fallback: i64) -> i64 {
    let n = match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() { Some(0.0) } else { t.parse::<f64>().ok() }
        }
        Some(Value::Bool(b)) => Some(if *b { 1.0 } else { 0.0 }),
        Some(Value::Null) => Some(0.0),
        _ => None,
    };
    match n {
        Some(f) if f.is_finite() => ((f + 0.5).floor() as i64).clamp(min, max),
        _ => fallback,
    }
}

fn generator_options(raw: Option<&Value>, current: &Value) -> Value {
    let empty = Map::new();
    let o = raw.and_then(Value::as_object).unwrap_or(&empty);
    let mut base = default_generator().as_object().unwrap().clone();
    if let Some(c) = current.as_object() {
        base.extend(c.clone());
    }
    let flag = |k: &str| if o.contains_key(k) { truthy(o.get(k)) } else { base.get(k).and_then(Value::as_bool).unwrap_or(false) };
    let num = |k: &str, min: i64, max: i64| {
        let fallback = base.get(k).and_then(Value::as_i64).unwrap_or(min);
        if o.contains_key(k) { int_in(o.get(k), min, max, fallback) } else { fallback }
    };
    let mode = o.get("mode").and_then(Value::as_str).filter(|m| ["random", "passphrase", "pin"].contains(m)).map(Value::from).unwrap_or_else(|| base["mode"].clone());
    let separator =
        o.get("separator").and_then(Value::as_str).filter(|s| ["-", ".", "_", " ", ",", ""].contains(s)).map(Value::from).unwrap_or_else(|| base["separator"].clone());
    let mut next = json!({
        "mode": mode,
        "length": num("length", 8, 128),
        "lowercase": flag("lowercase"),
        "uppercase": flag("uppercase"),
        "digits": flag("digits"),
        "symbols": flag("symbols"),
        "excludeAmbiguous": flag("excludeAmbiguous"),
        "words": num("words", 3, 12),
        "separator": separator,
        "capitalize": flag("capitalize"),
        "includeNumber": flag("includeNumber"),
        "pinLength": num("pinLength", 4, 12),
    });
    if !["lowercase", "uppercase", "digits", "symbols"].iter().any(|k| next[*k] == true) {
        for k in ["lowercase", "uppercase", "digits", "symbols"] {
            next[k] = base.get(k).cloned().unwrap_or(Value::Bool(false));
        }
    }
    next
}

pub fn sanitize_settings(raw: &Value, current: &Value) -> Value {
    let empty = Map::new();
    let o = raw.as_object().unwrap_or(&empty);
    let cur = |k: &str| current.get(k).cloned().unwrap_or_else(|| default_settings()[k].clone());
    let cur_i = |k: &str| cur(k).as_i64().unwrap_or(0);
    let int = |k: &str, min, max| if o.contains_key(k) { json!(int_in(o.get(k), min, max, cur_i(k))) } else { cur(k) };
    let mut hide = cur("hideIcons");
    if let Some(b) = o.get("hideLoginIcons").and_then(Value::as_bool) {
        hide["login"] = b.into();
    }
    if let Some(raw) = o.get("hideIcons").and_then(Value::as_object) {
        for t in ENTRY_TYPES {
            if let Some(b) = raw.get(t).and_then(Value::as_bool) {
                hide[t] = b.into();
            }
        }
    }
    json!({
        "autoLockMinutes": int("autoLockMinutes", 1, 240),
        "clipboardClearSeconds": int("clipboardClearSeconds", 0, 600),
        "outdatedDays": int("outdatedDays", 30, 3650),
        "breachCheckEnabled": if o.contains_key("breachCheckEnabled") { truthy(o.get("breachCheckEnabled")).into() } else { cur("breachCheckEnabled") },
        "lockOnHiddenSeconds": int("lockOnHiddenSeconds", 0, 3600),
        "generator": if o.contains_key("generator") { generator_options(o.get("generator"), &cur("generator")) } else { cur("generator") },
        "appearance": o.get("appearance").and_then(Value::as_str).filter(|a| ["system", "light", "dark"].contains(a)).map(Value::from).unwrap_or_else(|| cur("appearance")),
        "hideIcons": hide,
        "categoriesEnabled": if o.contains_key("categoriesEnabled") { truthy(o.get("categoriesEnabled")).into() } else { current.get("categoriesEnabled").cloned().unwrap_or(Value::Bool(true)) },
    })
}

// ------------------------------------------------------------------ credentials

/// One digit repeated, runs like 1234/9876, or a repeated pair like 1212.
fn is_obvious_pin(pin: &str) -> bool {
    let d: Vec<i32> = pin.bytes().map(|b| (b - b'0') as i32).collect();
    if d.len() >= 2 && d.iter().all(|&x| x == d[0]) {
        return true;
    }
    if d.len() >= 2 {
        let step = d[1] - d[0];
        if (step == 1 || step == -1) && d.windows(2).all(|w| w[1] - w[0] == step) {
            return true;
        }
    }
    pin.len() % 2 == 0 && pin.len() >= 2 && pin == pin[..2].repeat(pin.len() / 2)
}

const COMMON_PINS: [&str; 16] =
    ["1004", "2000", "2001", "6969", "1122", "1313", "2580", "0852", "1357", "2468", "5683", "0007", "112233", "123321", "696969", "159753"];

pub fn is_weak_pin(pin: &str) -> bool {
    let half = &pin[..pin.len() / 2];
    is_obvious_pin(pin)
        || COMMON_PINS.contains(&pin)
        || (pin.len() == 4 && (pin.starts_with("19") || pin.starts_with("20")))
        || (pin.len() % 2 == 0 && format!("{half}{half}") == pin)
}

pub fn validate_pin(pin: Option<&Value>, lengths: &[usize]) -> Result<String> {
    let pin = pin.and_then(Value::as_str).filter(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    let pin = pin.ok_or_else(|| HttpError::new(400, "A PIN can only contain digits"))?;
    if !lengths.contains(&pin.len()) {
        let (last, rest) = lengths.split_last().unwrap();
        let rest = rest.iter().map(usize::to_string).collect::<Vec<_>>().join(", ");
        let msg = if rest.is_empty() { format!("A PIN must be {last} digits") } else { format!("A PIN must be {rest} or {last} digits") };
        return Err(HttpError::new(400, msg));
    }
    if is_weak_pin(pin) {
        return Err(HttpError::coded(400, "That PIN is one of the first an attacker would try. Pick a less predictable one.", "WEAK_PIN"));
    }
    Ok(pin.to_string())
}

/// Dots 0–8, stored as "0-4-8-5".
fn decode_pattern(v: &str) -> Option<Vec<u8>> {
    let parts: Vec<&str> = v.split('-').collect();
    let mut points = Vec::new();
    for p in parts {
        if p.len() != 1 {
            return None;
        }
        let d = p.as_bytes()[0].checked_sub(b'0').filter(|d| *d <= 9)?;
        if d >= 9 || points.contains(&d) {
            return None;
        }
        points.push(d);
    }
    Some(points)
}

pub fn pattern_problem(v: &str) -> Option<String> {
    let Some(points) = decode_pattern(v) else { return Some("That isn’t a valid pattern".into()) };
    if points.len() < 4 {
        return Some("Connect at least 4 dots".into());
    }
    None // straight lines are at most 3 dots, already refused above
}

pub fn passphrase_problem(v: &str) -> Option<String> {
    let words: Vec<&str> = v.trim().split(|c: char| c.is_whitespace() || "-._,".contains(c)).filter(|w| !w.is_empty()).collect();
    if words.len() < 4 {
        return Some("Use at least 4 words".into());
    }
    if words.iter().any(|w| len16(w) < 3) {
        return Some("Each word needs at least 3 letters".into());
    }
    let mut lower: Vec<String> = words.iter().map(|w| w.to_lowercase()).collect();
    lower.sort();
    lower.dedup();
    if lower.len() < words.len() {
        return Some("Don’t repeat words".into());
    }
    None
}

/// zxcvbn strength, in the same shape the app expects (StrengthResult).
pub fn check_strength(password: &str, user_inputs: &[String]) -> Value {
    if password.is_empty() {
        return json!({ "score": 0, "guessesLog10": 0, "crackTime": "instantly", "warning": null, "suggestions": [] });
    }
    let analysed: String = password.chars().take(100).collect();
    let inputs: Vec<&str> = user_inputs.iter().filter(|s| !s.is_empty()).take(10).map(String::as_str).collect();
    let r = zxcvbn::zxcvbn(&analysed, &inputs);
    let feedback = r.feedback();
    json!({
        "score": u8::from(r.score()),
        "guessesLog10": (r.guesses_log10() * 10.0).round() / 10.0,
        "crackTime": r.crack_times().offline_slow_hashing_1e4_per_second().to_string(),
        "warning": feedback.and_then(|f| f.warning()).map(|w| w.to_string()),
        "suggestions": feedback.map(|f| f.suggestions().iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap_or_default(),
    })
}

pub fn strength_score(password: &str) -> u8 {
    check_strength(password, &[])["score"].as_u64().unwrap_or(0) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pins() {
        for weak in ["1111", "1234", "9876", "1212", "1990", "2580", "123123"] {
            assert!(is_weak_pin(weak), "{weak}");
        }
        for ok in ["4829", "482913"] {
            assert!(!is_weak_pin(ok), "{ok}");
        }
    }

    #[test]
    fn patterns_and_passphrases() {
        assert!(pattern_problem("0-4-8").is_some());
        assert!(pattern_problem("0-4-8-5").is_none());
        assert!(pattern_problem("0-0-1-2").is_some());
        assert!(passphrase_problem("violet anchor tundra quill").is_none());
        assert!(passphrase_problem("violet anchor violet quill").is_some());
    }

    #[test]
    fn settings_clamp_and_keep() {
        let s = sanitize_settings(&json!({ "autoLockMinutes": 999, "appearance": "neon" }), &default_settings());
        assert_eq!(s["autoLockMinutes"], 240);
        assert_eq!(s["appearance"], "system");
        assert_eq!(s["generator"]["length"], 20);
    }
}
