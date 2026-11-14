//! The security audit and breach checks (server/audit.ts): strength, reuse, age, exact
//! duplicates, and Have I Been Pwned lookups that only send a 5-character hash prefix.

use std::collections::HashMap;

use base64::Engine;
use serde_json::{Map, Value, json};
use sha1::Sha1;
use sha2::{Digest, Sha256};

use crate::validate::check_strength;

const DAY: i64 = 86_400_000;

fn s<'a>(e: &'a Map<String, Value>, k: &str) -> &'a str {
    e.get(k).and_then(Value::as_str).unwrap_or("")
}

/// A URL's host without "www.", like `new URL(...).hostname` in the Node server.
pub fn host_of(url: &str) -> String {
    let text = if url.contains("://") { url.to_string() } else { format!("https://{url}") };
    url::Url::parse(&text).ok().and_then(|u| u.host_str().map(|h| h.strip_prefix("www.").unwrap_or(h).to_string())).unwrap_or_default()
}

fn b64_sha256(text: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(Sha256::digest(text.as_bytes()))
}

/// What a strength rating depends on: the password and the hints it's checked against.
pub fn strength_key(e: &Map<String, Value>) -> String {
    let text = serde_json::to_string(&json!([s(e, "password"), s(e, "username"), s(e, "title"), host_of(s(e, "url"))])).unwrap();
    b64_sha256(&text)[..22].to_string()
}

fn audited(e: &Map<String, Value>) -> bool {
    s(e, "type") == "login" && !s(e, "password").is_empty()
}

/// Rates every login without an up-to-date rating. Returns (id, rating) for the new ones and
/// updates `entries` in place, so the report uses them.
pub fn rate_logins(entries: &mut [Map<String, Value>]) -> Vec<(String, Value)> {
    let mut fresh = Vec::new();
    for e in entries.iter_mut().filter(|e| audited(e)) {
        let key = strength_key(e);
        if e.get("strength").and_then(|v| v.get("key")).and_then(Value::as_str) == Some(key.as_str()) {
            continue;
        }
        let r = check_strength(s(e, "password"), &[s(e, "username").to_string(), s(e, "title").to_string(), host_of(s(e, "url"))]);
        let rating = json!({ "key": key, "score": r["score"], "crackTime": r["crackTime"] });
        fresh.push((s(e, "id").to_string(), rating.clone()));
        e.insert("strength".into(), rating);
    }
    fresh
}

const ISSUES: [(&str, f64); 4] = [("breached", 1.0), ("weak", 0.6), ("reused", 0.5), ("outdated", 0.2)];

fn weight(issues: &[&str]) -> f64 {
    issues.iter().map(|i| ISSUES.iter().find(|(n, _)| n == i).map_or(0.0, |(_, w)| *w)).sum()
}

pub fn build_report(entries: &[Map<String, Value>], settings: &Value, now: i64) -> Value {
    let logins: Vec<&Map<String, Value>> = entries.iter().filter(|e| audited(e)).collect();

    // Identical passwords. Compared in memory only; nothing is persisted.
    let mut groups: Vec<(String, Vec<String>)> = Vec::new();
    for e in &logins {
        let fp = b64_sha256(s(e, "password"));
        match groups.iter_mut().find(|(k, _)| *k == fp) {
            Some((_, ids)) => ids.push(s(e, "id").into()),
            None => groups.push((fp, vec![s(e, "id").into()])),
        }
    }
    let mut reuse_of: HashMap<String, usize> = HashMap::new();
    let mut reused_groups = Vec::new();
    for (_, ids) in &groups {
        if ids.len() < 2 {
            continue;
        }
        reused_groups.push(json!(ids));
        for id in ids {
            reuse_of.insert(id.clone(), ids.len());
        }
    }

    // Exact copies: same site (or title, without one), username and password.
    let mut copies: Vec<(String, Vec<&Map<String, Value>>)> = Vec::new();
    for e in &logins {
        let site = { let h = host_of(s(e, "url")); if h.is_empty() { s(e, "title").trim().to_lowercase() } else { h } };
        let key = b64_sha256(&serde_json::to_string(&json!([site, s(e, "username").trim().to_lowercase(), s(e, "password")])).unwrap());
        match copies.iter_mut().find(|(k, _)| *k == key) {
            Some((_, list)) => list.push(e),
            None => copies.push((key, vec![e])),
        }
    }
    let extras = |e: &Map<String, Value>| {
        let fields: Vec<Value> = e.get("customFields").and_then(Value::as_array).map(|a| a.iter().map(|f| json!([f["label"], f["value"]])).collect()).unwrap_or_default();
        serde_json::to_string(&json!([s(e, "notes").trim(), s(e, "codes").trim(), fields])).unwrap()
    };
    let empty_extras = serde_json::to_string(&json!(["", "", []])).unwrap();
    let mut duplicate_groups: Vec<Value> = copies
        .into_iter()
        .filter(|(_, g)| g.len() > 1)
        .map(|(_, mut g)| {
            g.sort_by(|a, b| b["updatedAt"].as_i64().cmp(&a["updatedAt"].as_i64()));
            let kept = extras(g[0]);
            let site = { let h = host_of(s(g[0], "url")); if h.is_empty() { s(g[0], "title").to_string() } else { h } };
            json!({
                "username": s(g[0], "username"),
                "site": site,
                "items": g.iter().enumerate().map(|(i, e)| {
                    let x = extras(e);
                    json!({ "id": e["id"], "title": e["title"], "updatedAt": e["updatedAt"], "extra": i > 0 && x != kept && x != empty_extras })
                }).collect::<Vec<_>>(),
            })
        })
        .collect();
    duplicate_groups.sort_by(|a, b| {
        let (la, lb) = (a["items"].as_array().unwrap().len(), b["items"].as_array().unwrap().len());
        lb.cmp(&la).then_with(|| s(a.as_object().unwrap(), "site").to_lowercase().cmp(&s(b.as_object().unwrap(), "site").to_lowercase()))
    });

    let outdated_days = settings["outdatedDays"].as_i64().unwrap_or(365);
    let mut items: Vec<(Value, Vec<&str>)> = logins
        .iter()
        .map(|e| {
            let key = strength_key(e);
            let cached = e.get("strength").filter(|v| v.get("key").and_then(Value::as_str) == Some(key.as_str())).cloned();
            let strength = cached.unwrap_or_else(|| check_strength(s(e, "password"), &[s(e, "username").to_string(), s(e, "title").to_string(), host_of(s(e, "url"))]));
            let score = strength["score"].as_i64().unwrap_or(0);
            let changed = e.get("passwordUpdatedAt").and_then(Value::as_f64).unwrap_or(now as f64) as i64;
            let age = ((now - changed) as f64 / DAY as f64).floor().max(0.0) as i64;
            let breach = e.get("breach").filter(|b| b.is_object());
            let mut issues = Vec::new();
            if breach.is_some_and(|b| b["count"].as_i64().unwrap_or(0) > 0) {
                issues.push("breached");
            }
            if score <= 2 {
                issues.push("weak");
            }
            if reuse_of.contains_key(s(e, "id")) {
                issues.push("reused");
            }
            if age >= outdated_days {
                issues.push("outdated");
            }
            let item = json!({
                "id": e["id"], "title": e["title"], "icon": e.get("icon").cloned().unwrap_or("".into()), "username": e["username"], "url": e["url"],
                "score": score, "crackTime": strength["crackTime"], "ageDays": age,
                "reuseCount": reuse_of.get(s(e, "id")).copied().unwrap_or(0),
                "breachCount": breach.map_or(Value::Null, |b| b["count"].clone()),
                "breachCheckedAt": breach.map_or(Value::Null, |b| b["checkedAt"].clone()),
                "issues": issues,
            });
            (item, issues)
        })
        .collect();

    let count = |issue: &str| items.iter().filter(|(_, i)| i.contains(&issue)).count();
    let penalty: f64 = items.iter().map(|(_, i)| weight(i).min(1.0)).sum();
    let health = if items.is_empty() { 100 } else { (100.0 * (1.0 - penalty / items.len() as f64)).round() as i64 };
    let totals = json!({
        "logins": items.len(),
        "weak": count("weak"),
        "reused": count("reused"),
        "outdated": count("outdated"),
        "breached": count("breached"),
        "unchecked": items.iter().filter(|(i, _)| i["breachCheckedAt"].is_null()).count(),
        "duplicates": duplicate_groups.iter().map(|g| g["items"].as_array().unwrap().len() - 1).sum::<usize>(),
    });
    items.sort_by(|(a, ia), (b, ib)| {
        weight(ib)
            .partial_cmp(&weight(ia))
            .unwrap()
            .then_with(|| a["score"].as_i64().cmp(&b["score"].as_i64()))
            .then_with(|| a["title"].as_str().unwrap_or("").to_lowercase().cmp(&b["title"].as_str().unwrap_or("").to_lowercase()))
    });
    json!({
        "generatedAt": now,
        "health": health,
        "totals": totals,
        "items": items.into_iter().map(|(i, _)| i).collect::<Vec<_>>(),
        "reusedGroups": reused_groups,
        "duplicateGroups": duplicate_groups,
        "breachCheckEnabled": settings["breachCheckEnabled"],
    })
}

// ------------------------------------------------------------------ breaches

pub fn sha1_upper(password: &str) -> String {
    Sha1::digest(password.as_bytes()).iter().map(|b| format!("{b:02X}")).collect()
}

pub fn parse_range(body: &str) -> HashMap<String, i64> {
    body.lines()
        .filter_map(|l| {
            let mut p = l.trim().split(':');
            let (suffix, count) = (p.next()?, p.next()?);
            (!suffix.is_empty() && !count.is_empty()).then(|| (suffix.to_uppercase(), count.trim().parse().unwrap_or(0)))
        })
        .collect()
}

/// Have I Been Pwned "range" API (k-anonymity): only the first 5 hex characters of the SHA-1 hash
/// leave the computer, and responses are padded so their size doesn't give the prefix away.
async fn fetch_range(client: &reqwest::Client, prefix: &str) -> Result<String, String> {
    let res = client
        .get(format!("https://api.pwnedpasswords.com/range/{prefix}"))
        .header("Add-Padding", "true")
        .header("User-Agent", "Keys-Password-Manager")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| "Couldn’t reach the breach service".to_string())?;
    if !res.status().is_success() {
        return Err(format!("Breach service responded with {}", res.status().as_u16()));
    }
    res.text().await.map_err(|_| "Couldn’t read the breach service’s answer".to_string())
}

/// Breach counts by entry id. Lookups for the same prefix are shared; 4 run at a time.
pub async fn check_breaches(targets: &[(String, String)]) -> Result<HashMap<String, i64>, String> {
    let mut by_prefix: Vec<(String, Vec<(String, String)>)> = Vec::new();
    for (id, pw) in targets.iter().filter(|(_, p)| !p.is_empty()) {
        let hash = sha1_upper(pw);
        let (prefix, suffix) = (hash[..5].to_string(), hash[5..].to_string());
        match by_prefix.iter_mut().find(|(p, _)| *p == prefix) {
            Some((_, list)) => list.push((id.clone(), suffix)),
            None => by_prefix.push((prefix, vec![(id.clone(), suffix)])),
        }
    }
    let client = reqwest::Client::new();
    let mut results = HashMap::new();
    for chunk in by_prefix.chunks(4) {
        let ranges = futures_util::future::join_all(chunk.iter().map(|(p, _)| fetch_range(&client, p))).await;
        for ((_, list), range) in chunk.iter().zip(ranges) {
            let range = parse_range(&range?);
            for (id, suffix) in list {
                results.insert(id.clone(), range.get(suffix).copied().unwrap_or(0));
            }
        }
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn login(id: &str, pw: &str, url: &str, updated: i64) -> Map<String, Value> {
        json!({ "id": id, "type": "login", "title": id, "username": "me", "password": pw, "url": url, "notes": "", "codes": "",
                "customFields": [], "icon": "", "passwordUpdatedAt": updated, "updatedAt": updated, "breach": null })
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn reuse_duplicates_age_and_health() {
        let now = 1_000 * DAY;
        let entries = vec![
            login("a", "hunter2", "github.com", now),
            login("b", "hunter2", "https://www.github.com/login", now - 400 * DAY),
            login("c", "x8$Kq!vZ2m#Lp9wR", "example.com", now),
        ];
        let r = build_report(&entries, &json!({ "outdatedDays": 365, "breachCheckEnabled": false }), now);
        assert_eq!(r["totals"]["reused"], 2);
        assert_eq!(r["totals"]["outdated"], 1);
        assert_eq!(r["totals"]["duplicates"], 1, "same site, user and password");
        assert_eq!(r["items"][0]["id"], "b", "worst first");
        assert!(r["health"].as_i64().unwrap() < 100);
    }

    #[test]
    fn hibp_hash_and_range() {
        assert_eq!(sha1_upper("password"), "5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8");
        let r = parse_range("1E4C9B93F3F0682250B6CF8331B7EE68FD8:9545824\r\n0018A45C4D1DEF81644B54AB7F969B88D65:0\n");
        assert_eq!(r["1E4C9B93F3F0682250B6CF8331B7EE68FD8"], 9545824);
    }
}
