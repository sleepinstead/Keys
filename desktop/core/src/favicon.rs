//! Fetches a website's own icon, only when asked (server/favicon.ts). The request goes straight
//! to that site, and private, loopback and link-local addresses are refused, both when checking
//! the name and when connecting (a DNS resolver that drops them), so this can't probe the local
//! network or be tricked by DNS rebinding. Redirects are followed by hand, each hop checked.

use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use futures_util::StreamExt;
use url::{Host, Url};

use crate::error::{HttpError, Result};

const MAX_HTML: usize = 512 * 1024;
const MAX_ICON: usize = 512 * 1024;
const MAX_REDIRECTS: usize = 3;

pub fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            a == 0
                || a == 10
                || a == 127
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 168)
                || (a == 192 && b == 0 && c == 0)
                || (a == 198 && (b == 18 || b == 19))
                || a >= 224
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_private(IpAddr::V4(v4));
            }
            let s = v6.segments();
            // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) can wrap any IPv4 address, private ones included.
            if (s[0] == 0x64 && s[1] == 0xff9b) || s[0] == 0x2002 {
                return true;
            }
            v6.is_unspecified() || v6.is_loopback() || (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80 || (s[0] & 0xff00) == 0xff00
        }
    }
}

/// Resolves names for the connection itself and refuses private addresses there.
struct PublicOnly;

impl reqwest::dns::Resolve for PublicOnly {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs: Vec<SocketAddr> =
                tokio::task::spawn_blocking(move || (host.as_str(), 0).to_socket_addrs().map(|a| a.collect())).await.map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)??;
            if addrs.is_empty() || addrs.iter().any(|a| is_private(a.ip())) {
                return Err("That address is on your own network".into());
            }
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .dns_resolver(Arc::new(PublicOnly))
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(6))
        .user_agent("Mozilla/5.0 (compatible; Keys-Password-Manager)")
        .build()
        .expect("HTTP client")
}

fn own_network() -> HttpError {
    HttpError::new(400, "That address is on your own network")
}

/// Refuses non-web addresses, local names and private IP literals before connecting.
fn assert_public(url: &Url) -> Result<()> {
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err(HttpError::new(400, "Only web addresses are supported"));
    }
    match url.host() {
        None => Err(own_network()),
        Some(Host::Ipv4(ip)) => {
            if is_private(IpAddr::V4(ip)) {
                Err(own_network())
            } else {
                Ok(())
            }
        }
        Some(Host::Ipv6(ip)) => {
            if is_private(IpAddr::V6(ip)) {
                Err(own_network())
            } else {
                Ok(())
            }
        }
        Some(Host::Domain(d)) => {
            let d = d.to_ascii_lowercase();
            if d == "localhost" || d.ends_with(".localhost") || d.ends_with(".local") || d.ends_with(".internal") { Err(own_network()) } else { Ok(()) }
        }
    }
}

/// "github.com" or "https://github.com/login" → the site's origin.
pub fn site_url(raw: &str) -> Result<Url> {
    let text = raw.trim();
    if text.is_empty() {
        return Err(HttpError::new(400, "Add a website first"));
    }
    let has_scheme = text.find("://").is_some_and(|i| {
        let scheme = &text[..i];
        scheme.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) && scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    });
    let bad = || HttpError::new(400, "That doesn’t look like a website address");
    let url = Url::parse(&if has_scheme { text.to_string() } else { format!("https://{text}") }).map_err(|_| bad())?;
    if url.host().is_none() {
        return Err(bad());
    }
    Url::parse(&url.origin().ascii_serialization()).map_err(|_| bad())
}

async fn get(client: &reqwest::Client, url: Url) -> Result<(reqwest::Response, Url)> {
    let mut current = url;
    for _ in 0..=MAX_REDIRECTS {
        assert_public(&current)?;
        let res = client.get(current.clone()).send().await.map_err(|e| {
            if e.to_string().contains("own network") || std::error::Error::source(&e).is_some_and(|s| s.to_string().contains("own network")) {
                own_network()
            } else {
                HttpError::new(502, "The website didn’t answer")
            }
        })?;
        if res.status().is_redirection()
            && let Some(next) = res.headers().get("location").and_then(|l| l.to_str().ok()).and_then(|l| current.join(l).ok())
        {
            current = next;
            continue;
        }
        return Ok((res, current));
    }
    Err(HttpError::new(502, "The website redirected too many times"))
}

async fn read_limited(res: reqwest::Response, max: usize) -> Result<Vec<u8>> {
    let too_big = || HttpError::new(502, "The icon is too large");
    if res.content_length().is_some_and(|n| n as usize > max) {
        return Err(too_big());
    }
    let mut out = Vec::new();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| HttpError::new(502, "The website stopped answering"))?;
        out.extend_from_slice(&chunk);
        if out.len() > max {
            return Err(too_big());
        }
    }
    Ok(out)
}

/// The value of attribute `name` in a tag like `<link rel="icon" href=/x.png>`.
fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find(name).map(|i| i + from) {
        from = i + name.len();
        let before_ok = i == 0 || !lower.as_bytes()[i - 1].is_ascii_alphanumeric() && lower.as_bytes()[i - 1] != b'-';
        let rest = tag[from..].trim_start();
        if !before_ok || !rest.starts_with('=') {
            continue;
        }
        let v = rest[1..].trim_start();
        return Some(match v.chars().next() {
            Some(q @ ('"' | '\'')) => v[1..].split(q).next().unwrap_or("").to_string(),
            _ => v.split(|c: char| c.is_whitespace() || c == '>').next().unwrap_or("").to_string(),
        });
    }
    None
}

/// Icon links in the page, best first: big touch icons, then sized icons, then plain ones.
pub fn icon_candidates(html: &str, base: &Url) -> Vec<Url> {
    let lower = html.to_ascii_lowercase();
    let mut found: Vec<(Url, i64)> = Vec::new();
    let mut at = 0;
    while let Some(i) = lower[at..].find("<link").map(|i| i + at) {
        let end = lower[i..].find('>').map_or(lower.len(), |e| i + e + 1);
        at = end;
        if lower.as_bytes().get(i + 5).is_some_and(|c| c.is_ascii_alphanumeric()) {
            continue;
        }
        let tag = &html[i..end];
        let rel = attr(tag, "rel").unwrap_or_default().to_lowercase();
        let Some(href) = attr(tag, "href") else { continue };
        let is_icon = rel.split_whitespace().any(|w| w == "icon") || rel.contains("apple-touch-icon");
        if !is_icon || rel.contains("mask-icon") {
            continue;
        }
        let Ok(url) = base.join(&href.replace("&amp;", "&")) else { continue };
        if url.scheme() != "https" && url.scheme() != "http" {
            continue;
        }
        let size = attr(tag, "sizes").unwrap_or_default().split_whitespace().filter_map(|s| s.split('x').next()?.parse::<i64>().ok()).max().unwrap_or(0).max(0);
        let rank = if rel.contains("apple-touch-icon") { 180 } else { 0 } + size.min(256) + if url.path().ends_with(".svg") { 120 } else { 0 };
        found.push((url, rank));
    }
    found.sort_by_key(|f| std::cmp::Reverse(f.1));
    found.into_iter().map(|(u, _)| u).collect()
}

const IMAGE_TYPES: [&str; 8] = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon", "image/ico"];

/// The site's icon as a data URL (the app resizes it before saving).
pub async fn fetch_site_icon(raw: &str) -> Result<String> {
    let site = site_url(raw)?;
    let client = client();
    let mut candidates = Vec::new();
    match get(&client, site.clone()).await {
        Ok((res, url)) => {
            let html = res.status().is_success() && res.headers().get("content-type").and_then(|v| v.to_str().ok()).is_some_and(|t| t.contains("html"));
            if html && let Ok(body) = read_limited(res, MAX_HTML).await {
                candidates.extend(icon_candidates(&String::from_utf8_lossy(&body), &url));
            }
        }
        Err(e) if e.status == 400 => return Err(e),
        Err(_) => {} // the page may be unreachable while /favicon.ico still works
    }
    candidates.extend(["/apple-touch-icon.png", "/favicon.ico"].iter().filter_map(|p| site.join(p).ok()));

    for url in candidates.into_iter().take(6) {
        match get(&client, url).await {
            Ok((res, _)) if res.status().is_success() => {
                let kind = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").split(';').next().unwrap_or("").trim().to_lowercase();
                if !IMAGE_TYPES.contains(&kind.as_str()) {
                    continue;
                }
                let Ok(body) = read_limited(res, MAX_ICON).await else { continue };
                if body.len() < 16 {
                    continue;
                }
                let kind = if kind == "image/vnd.microsoft.icon" || kind == "image/ico" { "image/x-icon".to_string() } else { kind };
                return Ok(format!("data:{kind};base64,{}", base64::engine::general_purpose::STANDARD.encode(body)));
            }
            Err(e) if e.status == 400 => return Err(e),
            _ => {}
        }
    }
    Err(HttpError::new(404, "This website doesn’t have an icon Keys can use"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_addresses() {
        for ip in ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.20.0.1", "169.254.1.1", "100.64.0.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "64:ff9b::a00:1"] {
            assert!(is_private(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["1.1.1.1", "140.82.112.3", "2606:4700::1111"] {
            assert!(!is_private(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn refuses_local_names_and_literals() {
        for u in ["http://localhost/", "http://printer.local/", "http://127.0.0.1/", "http://[::1]/", "http://0x7f000001/", "ftp://example.com/"] {
            assert!(assert_public(&Url::parse(u).unwrap()).is_err(), "{u}");
        }
        assert!(assert_public(&Url::parse("https://github.com/").unwrap()).is_ok());
    }

    #[test]
    fn site_urls_and_candidates() {
        assert_eq!(site_url("github.com/login").unwrap().as_str(), "https://github.com/");
        let base = Url::parse("https://example.com/a/").unwrap();
        let html = r#"<head><link rel="icon" href="/f.ico"><LINK REL='apple-touch-icon' sizes="180x180" href="t.png"><link rel="mask-icon" href="/m.svg"></head>"#;
        let c = icon_candidates(html, &base);
        assert_eq!(c[0].as_str(), "https://example.com/a/t.png");
        assert_eq!(c[1].as_str(), "https://example.com/f.ico");
        assert_eq!(c.len(), 2);
    }
}
