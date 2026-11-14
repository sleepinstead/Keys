//! Rules for the browser extension (server/extension.ts): where a login may fill, pairing codes,
//! and stored pairings (only a SHA-256 of each token, in the database, bound to the extension).

use base64::Engine;
use rand::Rng;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use url::Url;

pub const PAIRINGS_META: &str = "browser_pairings";
pub const PAIR_TTL_MS: i64 = 3 * 60_000;
pub const MAX_PENDING: usize = 5;
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L

/// chrome-extension://<32 letters a–p>
pub fn is_extension_origin(origin: &str) -> bool {
    origin.strip_prefix("chrome-extension://").is_some_and(|id| id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b)))
}

pub fn hash_token(token: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(Sha256::digest(token.as_bytes()))
}

pub fn new_code() -> String {
    let mut rng = rand::rngs::OsRng;
    (0..6).map(|_| CODE_ALPHABET[rng.gen_range(0..CODE_ALPHABET.len())] as char).collect()
}

pub fn normalize_code(raw: Option<&Value>) -> String {
    raw.and_then(Value::as_str).unwrap_or("").to_uppercase().chars().filter(char::is_ascii_alphanumeric).collect()
}

pub fn clean_name(raw: Option<&Value>) -> String {
    let name: String = raw.and_then(Value::as_str).unwrap_or("").chars().filter(|c| (*c as u32) > 0x1f && *c != '\u{7f}').collect();
    let units: Vec<u16> = name.trim().encode_utf16().take(40).collect();
    let name = String::from_utf16_lossy(&units);
    if name.is_empty() { "Browser".into() } else { name }
}

fn has_scheme(text: &str) -> bool {
    text.find("://").is_some_and(|i| {
        let sch = &text[..i];
        sch.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) && sch.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    })
}

/// A web address, or None. `assume_scheme` adds https:// to a bare "example.com".
pub fn site_of(raw: &str, assume_scheme: bool) -> Option<Url> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    let url = Url::parse(&if assume_scheme && !has_scheme(text) { format!("https://{text}") } else { text.to_string() }).ok()?;
    matches!(url.scheme(), "https" | "http").then_some(url)
}

pub fn bare_host(url: &Url) -> String {
    let h = url.host_str().unwrap_or("").to_lowercase();
    h.strip_prefix("www.").map(str::to_string).unwrap_or(h)
}

/// Whether a saved login belongs on a page: same host (ignoring "www."), or a subdomain of the
/// saved host. A plain-http page only matches a login saved with an explicit http:// address, and
/// a saved port has to match.
pub fn matches_site(entry_url: &str, page_url: &str) -> bool {
    let (Some(page), Some(saved)) = (site_of(page_url, false), site_of(entry_url, true)) else { return false };
    if page.scheme() == "http" && !entry_url.trim().to_ascii_lowercase().starts_with("http://") {
        return false;
    }
    if saved.port().is_some() && saved.port() != page.port() {
        return false;
    }
    let (want, host) = (bare_host(&saved), bare_host(&page));
    host == want || (want.contains('.') && host.ends_with(&format!(".{want}")))
}

/// A pairing as the app's Settings shows it (no hash, no origin).
pub fn public_pairing(p: &Value) -> Value {
    json!({ "id": p["id"], "name": p["name"], "createdAt": p["createdAt"], "lastUsedAt": p.get("lastUsedAt").cloned().unwrap_or(Value::Null) })
}

pub struct Pending {
    pub id: String,
    pub code: String,
    pub origin: String,
    pub name: String,
    pub created_at: i64,
    pub token: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn site_matching_like_node() {
        assert!(matches_site("github.com", "https://github.com/login"));
        assert!(matches_site("example.com", "https://accounts.example.com/"));
        assert!(matches_site("https://www.example.com", "https://example.com/"));
        assert!(!matches_site("example.com", "https://notexample.com/"));
        assert!(!matches_site("example.com", "https://example.com.evil.io/"));
        assert!(!matches_site("example.com", "http://example.com/"), "http page needs an http login");
        assert!(matches_site("http://intranet.test", "http://intranet.test/x"));
        assert!(!matches_site("example.com:8443", "https://example.com/"), "port must match");
        assert!(matches_site("example.com:8443", "https://example.com:8443/"));
        assert!(!matches_site("localhost", "https://sub.localhost/"), "single-label hosts don't match subdomains");
        assert!(!matches_site("", "https://example.com/"));
        assert!(!matches_site("example.com", "javascript:alert(1)"));
    }

    #[test]
    fn origins_and_codes() {
        assert!(is_extension_origin("chrome-extension://abcdefghijklmnopabcdefghijklmnop"));
        assert!(!is_extension_origin("chrome-extension://abcdefghijklmnopabcdefghijklmnoz"));
        assert!(!is_extension_origin("https://evil.com"));
        let c = new_code();
        assert_eq!(c.len(), 6);
        assert_eq!(normalize_code(Some(&json!(" ab-c d2 "))), "ABCD2");
    }
}
