//! End-to-end tests of the Keys API: the real router over an in-memory database, no ports or files.

use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use keys_core::api::{App, Shared, router};
use keys_core::storage::Storage;
use serde_json::{Value, json};
use tower::ServiceExt;

const PW: &str = "violet-anchor-tundra-58-quill";
const EXT: &str = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

struct H {
    app: Shared,
    token: String,
}

impl H {
    fn new() -> H {
        H { app: App::new(Storage::memory().unwrap(), 5999), token: String::new() }
    }

    async fn raw(&self, req: Request<Body>) -> (StatusCode, axum::http::HeaderMap, Value) {
        let res = router(self.app.clone()).oneshot(req).await.unwrap();
        let (status, headers) = (res.status(), res.headers().clone());
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (status, headers, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    fn req(&self, method: &str, path: &str, body: Option<Value>) -> axum::http::request::Builder {
        let _ = body;
        Request::builder().method(method).uri(format!("/api{path}")).header("host", "localhost:5999").header("content-type", "application/json")
    }

    async fn call(&mut self, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let req = self.req(method, path, None).header("x-keys-request", "1").header("x-keys-session", self.token.clone()).body(body.map_or(Body::empty(), |b| Body::from(b.to_string()))).unwrap();
        let (status, _, v) = self.raw(req).await;
        if let Some(t) = v.get("sessionToken").and_then(Value::as_str) {
            self.token = t.to_string();
        }
        (status, v)
    }

    async fn ext(&self, method: &str, path: &str, token: Option<&str>, origin: Option<&str>, body: Option<Value>) -> (StatusCode, Value) {
        let mut b = self.req(method, &format!("/extension{path}"), None).header("x-keys-extension", "1");
        if let Some(o) = origin {
            b = b.header("origin", o);
        }
        if let Some(t) = token {
            b = b.header("x-keys-extension-token", t);
        }
        let (status, _, v) = self.raw(b.body(body.map_or(Body::empty(), |b| Body::from(b.to_string()))).unwrap()).await;
        (status, v)
    }

    async fn setup(&mut self) {
        let (s, v) = self.call("POST", "/setup", Some(json!({ "password": PW }))).await;
        assert_eq!(s, StatusCode::OK, "{v}");
    }

    async fn login(&mut self, title: &str, url: &str, password: &str) -> String {
        let (s, v) = self.call("POST", "/entries", Some(json!({ "type": "login", "title": title, "username": "me@x.com", "password": password, "url": url }))).await;
        assert_eq!(s, StatusCode::CREATED, "{v}");
        v["id"].as_str().unwrap().to_string()
    }
}

// ------------------------------------------------------------------ guards

#[tokio::test(flavor = "multi_thread")]
async fn guards_and_headers() {
    let h = H::new();
    let ok = |b: axum::http::request::Builder| b.body(Body::empty()).unwrap();
    // DNS rebinding: only loopback Host names.
    let (s, _, _) = h.raw(ok(Request::builder().uri("/api/status").header("host", "evil.com").header("x-keys-request", "1"))).await;
    assert_eq!(s, StatusCode::MISDIRECTED_REQUEST);
    // CSRF: the custom header, our exact origin, same-origin fetches only.
    let (s, _, v) = h.raw(ok(h.req("GET", "/status", None))).await;
    assert_eq!((s, v["code"].as_str()), (StatusCode::FORBIDDEN, Some("FORBIDDEN")));
    let (s, _, _) = h.raw(ok(h.req("GET", "/status", None).header("x-keys-request", "1").header("origin", "http://localhost:3000"))).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (s, _, _) = h.raw(ok(h.req("GET", "/status", None).header("x-keys-request", "1").header("sec-fetch-site", "cross-site"))).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (s, _, _) = h.raw(ok(h.req("OPTIONS", "/status", None).header("x-keys-request", "1"))).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (s, headers, _) = h.raw(ok(h.req("GET", "/status", None).header("x-keys-request", "1").header("origin", "http://127.0.0.1:5999"))).await;
    assert_eq!(s, StatusCode::OK);
    for name in ["content-security-policy", "x-content-type-options", "x-frame-options", "referrer-policy", "cross-origin-opener-policy"] {
        assert!(headers.contains_key(name), "missing {name}");
    }
    assert_eq!(headers["cache-control"], "no-store");
    // Malformed and oversized bodies.
    let (s, _, v) = h.raw(h.req("POST", "/unlock", None).header("x-keys-request", "1").body(Body::from("{nope")).unwrap()).await;
    assert_eq!((s, v["error"].as_str()), (StatusCode::BAD_REQUEST, Some("Malformed JSON")));
    let big = format!("{{\"password\":\"{}\"}}", "x".repeat(1_100_000));
    let (s, _, _) = h.raw(h.req("POST", "/unlock", None).header("x-keys-request", "1").body(Body::from(big)).unwrap()).await;
    assert_eq!(s, StatusCode::PAYLOAD_TOO_LARGE);
    // The extension door: its own header, extension origins only.
    let (s, _) = h.ext("GET", "/status", None, Some("https://evil.com"), None).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
}

// ------------------------------------------------------------------ setup, unlock, lockout

#[tokio::test(flavor = "multi_thread")]
async fn setup_unlock_and_lockout() {
    let mut h = H::new();
    let (s, v) = h.call("GET", "/status", None).await;
    assert_eq!((s, v["initialized"].as_bool()), (StatusCode::OK, Some(false)));
    let (s, _) = h.call("POST", "/setup", Some(json!({ "password": "short" }))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, v) = h.call("POST", "/setup", Some(json!({ "password": "1234", "type": "pin" }))).await;
    assert_eq!((s, v["code"].as_str()), (StatusCode::BAD_REQUEST, Some("WEAK_PIN")));
    h.setup().await;
    let (s, _) = h.call("POST", "/setup", Some(json!({ "password": PW }))).await;
    assert_eq!(s, StatusCode::CONFLICT, "setup only once");
    let (_, cats) = h.call("GET", "/categories", None).await;
    assert_eq!(cats.as_array().unwrap().len(), 5);

    h.call("POST", "/lock", None).await;
    let (s, v) = h.call("GET", "/entries", None).await;
    assert_eq!((s, v["code"].as_str()), (StatusCode::UNAUTHORIZED, Some("LOCKED")));
    for _ in 0..5 {
        let (s, v) = h.call("POST", "/unlock", Some(json!({ "password": "wrong-password-x" }))).await;
        assert_eq!((s, v["code"].as_str()), (StatusCode::UNAUTHORIZED, Some("BAD_PASSWORD")));
    }
    let (s, v) = h.call("POST", "/unlock", Some(json!({ "password": PW }))).await;
    assert_eq!((s, v["code"].as_str()), (StatusCode::TOO_MANY_REQUESTS, Some("LOCKED_OUT")), "locked out even with the right password");
}

/// Regression: an unlock cancelled half-way (the client went away) must not block later unlocks.
#[tokio::test(flavor = "multi_thread")]
async fn cancelled_unlock_releases_its_flag() {
    let mut h = H::new();
    h.setup().await;
    h.call("POST", "/lock", None).await;
    let app = h.app.clone();
    let slow = tokio::spawn(async move {
        let req = Request::builder().method("POST").uri("/api/unlock").header("host", "localhost:5999").header("x-keys-request", "1").body(Body::from(json!({ "password": PW }).to_string())).unwrap();
        router(app).oneshot(req).await
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    slow.abort();
    let _ = slow.await;
    let (s, v) = h.call("POST", "/unlock", Some(json!({ "password": PW }))).await;
    assert_eq!(s, StatusCode::OK, "{v}");
}

// ------------------------------------------------------------------ items

#[tokio::test(flavor = "multi_thread")]
async fn entries_history_trash_and_categories() {
    let mut h = H::new();
    h.setup().await;
    let id = h.login("GitHub", "github.com", "first-pass").await;
    let (_, list) = h.call("GET", "/entries", None).await;
    assert!(list[0].get("password").is_none(), "the list never carries passwords");
    assert_eq!(list[0]["hasPassword"], true);

    let (_, before) = h.call("GET", &format!("/entries/{id}"), None).await;
    let edit = json!({ "type": "login", "title": "GitHub", "username": "me@x.com", "password": "second-pass", "url": "github.com" });
    let (s, after) = h.call("PUT", &format!("/entries/{id}"), Some(edit)).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(after["history"][0]["password"], "first-pass");
    // Starring isn't editing: "last edited" stays.
    let (_, starred) = h.call("POST", "/entries/update", Some(json!({ "ids": [id], "favorite": true }))).await;
    assert_eq!(starred["updated"], 1);
    let (_, now) = h.call("GET", &format!("/entries/{id}"), None).await;
    assert_eq!((now["favorite"].as_bool(), now["updatedAt"] == after["updatedAt"]), (Some(true), true));
    assert!(before["updatedAt"].as_i64() <= now["updatedAt"].as_i64());

    let (s, v) = h.call("POST", "/entries", Some(json!({ "type": "login", "title": " " }))).await;
    assert_eq!((s, v["error"].as_str()), (StatusCode::BAD_REQUEST, Some("Title is required")));
    let (s, _) = h.call("POST", "/entries/delete", Some(json!({ "ids": [id, "missing"] }))).await;
    assert_eq!(s, StatusCode::NOT_FOUND, "all or nothing");
    let (_, list) = h.call("GET", "/entries", None).await;
    assert_eq!(list.as_array().unwrap().len(), 1);

    h.call("DELETE", &format!("/entries/{id}"), None).await;
    let (_, trash) = h.call("GET", "/trash", None).await;
    assert_eq!(trash[0]["id"], id.as_str());
    let (s, _) = h.call("POST", "/trash/purge", Some(json!({ "all": true, "current": "wrong-password-x" }))).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (_, v) = h.call("POST", "/trash/restore", Some(json!({ "ids": [id] }))).await;
    assert_eq!(v["restored"], 1);

    let (s, _) = h.call("POST", "/categories", Some(json!({ "name": "work" }))).await;
    assert_eq!(s, StatusCode::CONFLICT, "names are case-insensitive");
    let (s, c) = h.call("POST", "/categories", Some(json!({ "name": "Clients" }))).await;
    assert_eq!(s, StatusCode::CREATED);
    let (s, _) = h.call("PUT", &format!("/categories/{}", c["id"].as_str().unwrap()), Some(json!({ "color": "neon" }))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_and_backup_round_trip() {
    let mut h = H::new();
    h.setup().await;
    let (_, v) = h.call("PUT", "/settings", Some(json!({ "autoLockMinutes": 999, "appearance": "neon" }))).await;
    assert_eq!((v["settings"]["autoLockMinutes"].as_i64(), v["settings"]["appearance"].as_str()), (Some(240), Some("system")));
    h.login("GitHub", "github.com", "pw-1").await;

    let (s, v) = h.call("POST", "/export", Some(json!({ "format": "encrypted", "masterPassword": "wrong-password-x" }))).await;
    assert_eq!((s, v["code"].as_str()), (StatusCode::UNAUTHORIZED, Some("BAD_PASSWORD")));
    let (s, file) = h.call("POST", "/export", Some(json!({ "format": "encrypted", "masterPassword": PW, "exportPassword": "backup-password-1" }))).await;
    assert_eq!(s, StatusCode::OK);

    let mut other = H::new();
    other.setup().await;
    let (s, v) = other.call("POST", "/import", Some(json!({ "content": file["content"], "password": "nope-nope-nope" }))).await;
    assert_eq!((s, v["code"].as_str()), (StatusCode::BAD_REQUEST, Some("BAD_PASSWORD")));
    let (_, v) = other.call("POST", "/import", Some(json!({ "content": file["content"], "password": "backup-password-1" }))).await;
    assert_eq!((v["imported"].as_i64(), v["source"].as_str()), (Some(1), Some("Keys encrypted export")));
    let (_, v) = other.call("POST", "/import", Some(json!({ "content": file["content"], "password": "backup-password-1" }))).await;
    assert_eq!(v["skipped"], 1, "re-importing doesn't duplicate");

    let (_, csv) = h.call("POST", "/export", Some(json!({ "format": "csv", "masterPassword": PW }))).await;
    assert!(csv["content"].as_str().unwrap().starts_with("type,title,username,password,url"));
}

// ------------------------------------------------------------------ browser extension

#[tokio::test(flavor = "multi_thread")]
async fn extension_pairing_fill_and_save() {
    let mut h = H::new();
    let (s, v) = h.ext("POST", "/pair", None, Some(EXT), Some(json!({ "name": "Chrome" }))).await;
    assert_eq!((s, v["code"].as_str()), (StatusCode::CONFLICT, Some("NO_VAULT")));
    h.setup().await;
    let id = h.login("GitHub", "github.com", "pw-1").await;

    let (_, pair) = h.ext("POST", "/pair", None, Some(EXT), Some(json!({ "name": "Chrome" }))).await;
    let code = pair["code"].as_str().unwrap().to_lowercase();
    let (s, v) = h.call("POST", "/browsers/approve", Some(json!({ "code": "zzzzzz" }))).await;
    assert_eq!((s, v["code"].as_str()), (StatusCode::NOT_FOUND, Some("BAD_CODE")));
    let (s, _) = h.call("POST", "/browsers/approve", Some(json!({ "code": code }))).await;
    assert_eq!(s, StatusCode::OK);
    let poll = format!("/pair/{}", pair["requestId"].as_str().unwrap());
    let (_, v) = h.ext("GET", &poll, None, Some(EXT), None).await;
    let token = v["token"].as_str().unwrap().to_string();
    let (_, again) = h.ext("GET", &poll, None, Some(EXT), None).await;
    assert_eq!(again["status"], "expired", "the token is handed over once");

    let t = Some(token.as_str());
    let (s, _) = h.ext("GET", "/status", t, Some("chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba"), None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED, "a token only works from its own extension");
    let (_, v) = h.ext("GET", "/logins?url=https%3A%2F%2Fgist.github.com%2F", t, Some(EXT), None).await;
    assert_eq!(v["logins"][0]["matches"], true);
    assert!(v["logins"][0].get("password").is_none());
    let (_, v) = h.ext("POST", "/fill", t, Some(EXT), Some(json!({ "id": id, "url": "https://github.com/login" }))).await;
    assert_eq!(v["password"], "pw-1");
    let (s, v) = h.ext("POST", "/fill", t, Some(EXT), Some(json!({ "id": id, "url": "https://github.com.evil.io/" }))).await;
    assert_eq!((s, v["code"].as_str()), (StatusCode::FORBIDDEN, Some("WRONG_SITE")));
    let (_, v) = h.ext("POST", "/save/check", t, Some(EXT), Some(json!({ "url": "https://gist.github.com/", "username": "me@x.com", "password": "x" }))).await;
    assert_eq!(v["status"], "new", "a subdomain never overwrites its parent's login");
    let (_, v) = h.ext("POST", "/save", t, Some(EXT), Some(json!({ "url": "https://github.com/", "username": "ME@x.com", "password": "pw-2" }))).await;
    assert_eq!(v["status"], "updated");

    h.call("POST", "/lock", None).await;
    let (s, v) = h.ext("POST", "/fill", t, Some(EXT), Some(json!({ "id": id, "url": "https://github.com/" }))).await;
    assert_eq!((s, v["code"].as_str()), (StatusCode::UNAUTHORIZED, Some("LOCKED")));
    let (_, v) = h.ext("POST", "/disconnect", t, Some(EXT), None).await;
    assert_eq!(v["ok"], true);
    let (_, v) = h.ext("GET", "/status", t, Some(EXT), None).await;
    assert_eq!(v["code"], "NOT_PAIRED");
}

// ------------------------------------------------------------------ app updates

#[tokio::test(flavor = "multi_thread")]
async fn update_route_needs_the_mac_app_and_an_update() {
    let mut h = H::new();
    h.setup().await;
    let (s, _) = h.call("POST", "/update/install", None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let ran = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seen = ran.clone();
    h.app.on_install(move || {
        seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    });
    let (s, _) = h.call("POST", "/update/install", None).await;
    assert_eq!(s, StatusCode::CONFLICT, "nothing to install yet");
    h.app.set_update(Some(json!({ "version": "9.9.9", "notes": "", "state": "available" })));
    let (_, sync) = h.call("GET", "/sync", None).await;
    assert_eq!(sync["update"]["version"], "9.9.9");
    let (s, _) = h.call("POST", "/update/install", None).await;
    assert_eq!((s, ran.load(std::sync::atomic::Ordering::SeqCst)), (StatusCode::OK, 1));
}

// ------------------------------------------------------------------ audit fixes

#[tokio::test(flavor = "multi_thread")]
async fn stale_edit_and_background_icon_are_refused() {
    let mut h = H::new();
    h.setup().await;
    let id = h.login("GitHub", "github.com", "pw-1").await;
    let (_, opened) = h.call("GET", &format!("/entries/{id}"), None).await;
    let base = opened["updatedAt"].as_i64().unwrap();
    // Someone else changes it after the editor opened…
    tokio::time::sleep(Duration::from_millis(5)).await;
    let other = json!({ "type": "login", "title": "GitHub", "username": "me@x.com", "password": "pw-2", "url": "github.com" });
    h.call("PUT", &format!("/entries/{id}"), Some(other)).await;
    // …so the editor's save is refused instead of undoing that change.
    let mine = json!({ "type": "login", "title": "GitHub (mine)", "username": "me@x.com", "password": "pw-1", "url": "github.com", "baseUpdatedAt": base });
    let (s, v) = h.call("PUT", &format!("/entries/{id}"), Some(mine)).await;
    assert_eq!((s, v["code"].as_str()), (StatusCode::CONFLICT, Some("CHANGED")));
    let (_, now) = h.call("GET", &format!("/entries/{id}"), None).await;
    assert_eq!(now["password"], "pw-2");

    // The person picks a letter tile; a late background fetch must not replace it.
    h.call("PUT", &format!("/entries/{id}/icon"), Some(json!({ "icon": "tint:blue" }))).await;
    let png = "data:image/png;base64,iVBORw0KGgo=";
    let (_, v) = h.call("PUT", &format!("/entries/{id}/icon"), Some(json!({ "icon": png, "onlyIfEmpty": true }))).await;
    assert_eq!(v["icon"], "tint:blue");
}

/// A sync app replacing the file with a *different* vault while unlocked: the old session must not
/// write into it (rows under the wrong key made the new vault's list fail to load).
/// macOS only: Windows refuses to replace a file another program has open (sync apps make a
/// conflict copy instead, which `sharing` merges).
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn swapped_vault_refuses_writes_and_locks() {
    let dir = tempfile::tempdir().unwrap();
    let main_file = dir.path().join("Keys.sqlite");
    let mut a = H { app: App::new(Storage::open(None, main_file.clone()), 5999), token: String::new() };
    a.setup().await;
    a.login("Mine", "a.test", "pw").await;

    let other_file = dir.path().join("other.sqlite");
    let mut b = H { app: App::new(Storage::open(None, other_file.clone()), 5999), token: String::new() };
    b.setup().await;
    b.login("Theirs", "b.test", "pw").await;
    drop(b);
    std::fs::rename(&other_file, &main_file).unwrap(); // what a sync app does

    let (s, v) = a.call("POST", "/entries", Some(json!({ "type": "login", "title": "Late", "password": "x" }))).await;
    assert_eq!((s, v["code"].as_str()), (StatusCode::UNAUTHORIZED, Some("LOCKED")));
    let (s, _) = a.call("GET", "/entries", None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED, "the old session is locked");
    let (s, v) = a.call("POST", "/unlock", Some(json!({ "password": PW }))).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let (_, list) = a.call("GET", "/entries", None).await;
    let titles: Vec<&str> = list.as_array().unwrap().iter().filter_map(|e| e["title"].as_str()).collect();
    assert_eq!(titles, vec!["Theirs"], "nothing was written under the old key");
}

#[tokio::test(flavor = "multi_thread")]
async fn pairings_are_not_read_from_the_vault_file() {
    let mut h = H::new();
    h.setup().await;
    // A pairing planted in the (shared) vault file grants nothing.
    let token = "planted-token";
    let hash = keys_core::extension::hash_token(token);
    {
        let mut g = h.app.lock();
        g.storage.store().unwrap().set_meta("browser_pairings", &json!([{ "id": "x", "name": "Evil", "createdAt": 1, "lastUsedAt": null, "hash": hash }]).to_string()).unwrap();
    }
    let (s, v) = h.ext("GET", "/status", Some(token), None, None).await;
    assert_eq!((s, v["code"].as_str()), (StatusCode::UNAUTHORIZED, Some("NOT_PAIRED")));
}
