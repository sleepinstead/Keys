//! In-app updates. Keys asks GitHub for `latest.json` (the newest version, its notes and a signed
//! download), shows "Update available" in the sidebar above Lock, and installs only a download
//! signed with the Keys update key (its public half is built into the app). Nothing about you or
//! your vault is sent.
//!
//! Automatic checks can be turned off in the app menu ("Check for Updates Automatically");
//! the choice lives in updates.json in Keys' settings folder.

use std::sync::Mutex;
use std::time::Duration;

use keys_core::api::Shared;
use keys_core::storage::config_dir;
use serde_json::{Value, json};
#[cfg(target_os = "macos")]
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The update found last, ready to install from the sidebar or the menu.
#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

fn report(app: &AppHandle, update: &Update, state: &str) {
    report_progress(app, update, state, None);
}

/// What the sidebar card shows: version, notes, state, download progress (0–100) and where the
/// full release notes are.
fn report_progress(app: &AppHandle, update: &Update, state: &str, progress: Option<u8>) {
    let notes: String = update.body.clone().unwrap_or_default().chars().take(700).collect();
    let current = app.package_info().version.to_string();
    let url = format!("https://github.com/sleepinstead/Keys/releases/tag/v{}", update.version);
    app.state::<Shared>().set_update(Some(json!({
        "version": update.version, "current": current, "notes": notes.trim(), "state": state,
        "progress": progress, "releaseUrl": url,
    })));
}

/// Downloads, checks the signature, installs and restarts. On failure the sidebar says so.
/// Set while an update downloads and installs, so a second click (sidebar plus menu) can't start
/// another one, and a background check doesn't reset the sidebar card meanwhile.
static INSTALLING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Downloads the package, trying each mirror listed in latest.json and then its main address. Every
/// copy must carry the Keys update signature, so a mirror can at worst hold an update back.
async fn download(app: &AppHandle, update: &Update) -> Result<Vec<u8>, String> {
    let mut sources: Vec<tauri::Url> = update.raw_json["mirrors"].as_array().into_iter().flatten().filter_map(|m| m.as_str()?.parse().ok()).filter(|u: &tauri::Url| u.scheme() == "https").collect();
    sources.push(update.download_url.clone());
    let mut last = String::from("no download address");
    for url in sources {
        let mut copy = update.clone();
        copy.download_url = url;
        // Progress for the sidebar card, in steps of 2% so the page isn't flooded.
        let (mut got, mut shown) = (0usize, 0u8);
        let on_chunk = |len: usize, total: Option<u64>| {
            got += len;
            if let Some(total) = total.filter(|t| *t > 0) {
                let pct = ((got as f64 / total as f64) * 100.0).min(100.0) as u8;
                if pct >= shown.saturating_add(2) || pct == 100 {
                    shown = pct;
                    report_progress(app, update, "installing", Some(pct));
                }
            }
        };
        match copy.download(on_chunk, || {}).await {
            Ok(bytes) => return Ok(bytes),
            Err(e) => last = e.to_string(),
        }
    }
    Err(last)
}

pub async fn install(app: AppHandle) {
    use std::sync::atomic::Ordering;
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(update) = app.state::<Pending>().0.lock().unwrap_or_else(|p| p.into_inner()).clone() else {
        INSTALLING.store(false, Ordering::SeqCst);
        return;
    };
    report(&app, &update, "installing");
    let installed = match download(&app, &update).await {
        Ok(bytes) => update.install(bytes).map_err(|e| e.to_string()),
        Err(e) => Err(e),
    };
    match installed {
        // A clean restart: the quit handler locks the vault and removes this computer's marker first.
        // (On Windows the installer takes over and Keys exits; it reopens when the install is done.)
        Ok(()) => app.request_restart(),
        Err(e) => {
            INSTALLING.store(false, Ordering::SeqCst);
            log::error!("Update failed: {e}");
            report(&app, &update, "failed");
            notice(&app, "The update didn’t install", "Keys couldn’t download or verify the update. Nothing was changed. Try again later.", MessageDialogKind::Warning);
        }
    }
}

const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
pub const MENU_CHECK: &str = "check-updates";
pub const MENU_AUTO: &str = "auto-updates";
pub const MENU_SETTINGS: &str = "settings";

fn prefs_file() -> std::path::PathBuf {
    config_dir().join("updates.json")
}

pub fn auto_enabled() -> bool {
    std::fs::read_to_string(prefs_file()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v["auto"].as_bool()).unwrap_or(true)
}

/// Turns automatic checks on or off, from the menu or Settings, and keeps the menu's tick in step.
pub fn set_auto_everywhere(app: &AppHandle, on: bool) {
    set_auto(on);
    if let Some(item) = app.menu().and_then(|m| m.get(MENU_AUTO)).and_then(|i| i.as_check_menuitem().cloned()) {
        let _ = item.set_checked(on);
    }
}

pub fn set_auto(on: bool) {
    let _ = std::fs::create_dir_all(config_dir());
    let _ = std::fs::write(prefs_file(), json!({ "auto": on }).to_string());
}

/// macOS: the standard Mac menus, plus "Check for Updates…" and the automatic-checks switch under Keys.
#[cfg(target_os = "macos")]
pub fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    if let Some(app_menu) = menu.items()?.first().and_then(|i| i.as_submenu().cloned()) {
        let settings = MenuItem::with_id(app, MENU_SETTINGS, "Settings…", true, Some("CmdOrCtrl+,"))?;
        let check = MenuItem::with_id(app, MENU_CHECK, "Check for Updates…", true, None::<&str>)?;
        let auto = CheckMenuItem::with_id(app, MENU_AUTO, "Check for Updates Automatically", true, auto_enabled(), None::<&str>)?;
        let sep = PredefinedMenuItem::separator(app)?;
        app_menu.insert_items(&[&settings, &check, &auto, &sep], 2)?;
    }
    Ok(menu)
}

fn notice(app: &AppHandle, title: &str, text: &str, kind: MessageDialogKind) {
    app.dialog().message(text).title(title).kind(kind).show(|_| {});
}

/// Looks for a newer version. `manual`: the person asked, so say "up to date" and show errors.
/// Who asked: the scheduled check (quiet), the menu (answers in a dialog), or Settings (answers
/// in the page, no dialog).
#[derive(Clone, Copy, PartialEq)]
pub enum Asked {
    Auto,
    Menu,
    Settings,
}

/// Looks for a newer version. Returns what Settings shows: {state, version}.
pub async fn check(app: AppHandle, asked: Asked) -> Value {
    let manual = asked != Asked::Auto;
    let dialogs = asked == Asked::Menu;
    if !manual && !auto_enabled() {
        return json!({ "state": "off" });
    }
    if INSTALLING.load(std::sync::atomic::Ordering::SeqCst) {
        return json!({ "state": "installing" });
    }
    // Never hang: a stalled network (some block GitHub's download server) fails after a while instead.
    let mut builder = app.updater_builder().timeout(Duration::from_secs(120)).configure_client(|c| c.connect_timeout(Duration::from_secs(10)).read_timeout(Duration::from_secs(30)));
    // Development only: point at a local test feed.
    #[cfg(debug_assertions)]
    if let Some(url) = std::env::var("KEYS_UPDATE_URL").ok().and_then(|u| u.parse().ok()) {
        builder = match builder.endpoints(vec![url]) {
            Ok(b) => b,
            Err(e) => {
                log::warn!("update feed: {e}");
                return json!({ "state": "failed" });
            }
        };
    }
    let found = match builder.build() {
        Ok(updater) => updater.check().await,
        Err(e) => Err(e),
    };
    let current = app.package_info().version.to_string();
    let update = match found {
        Ok(Some(u)) => u,
        Ok(None) => {
            if dialogs {
                notice(&app, "You’re up to date", &format!("Keys {current} is the newest version."), MessageDialogKind::Info);
            }
            return json!({ "state": "current", "version": current });
        }
        Err(e) => {
            log::warn!("Update check failed: {e}");
            if dialogs {
                notice(&app, "Couldn’t check for updates", "Keys couldn’t reach GitHub. Check your connection and try again.", MessageDialogKind::Warning);
            }
            return json!({ "state": "failed" });
        }
    };

    #[cfg(debug_assertions)]
    if std::env::var("KEYS_UPDATE_DRYRUN").is_ok() {
        match update.download(|_, _| {}, || {}).await {
            Ok(bytes) => println!("update {} downloaded and signature verified ({} bytes)", update.version, bytes.len()),
            Err(e) => println!("update {} rejected: {e}", update.version),
        }
        return json!({ "state": "available", "version": update.version });
    }

    // An install may have started while this check was on the network: leave its progress alone.
    if INSTALLING.load(std::sync::atomic::Ordering::SeqCst) {
        return json!({ "state": "installing" });
    }
    *app.state::<Pending>().0.lock().unwrap_or_else(|p| p.into_inner()) = Some(update.clone());
    report(&app, &update, "available");
    let found = json!({ "state": "available", "version": update.version });
    if !dialogs {
        return found; // the sidebar (and Settings) show it
    }
    let text = format!("You have {current}. Keys locks while it updates, then reopens. Your vault isn’t changed.");
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(text)
        .title(format!("Keys {} is available", update.version))
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("Update Now".into(), "Later".into()))
        .show(move |yes| {
            let _ = tx.send(yes);
        });
    if rx.await.unwrap_or(false) {
        install(app).await;
    }
    found
}

/// Checks shortly after launch, then every few hours, while automatic checks are on.
pub fn schedule(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(10)).await;
        loop {
            check(app.clone(), Asked::Auto).await;
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}
