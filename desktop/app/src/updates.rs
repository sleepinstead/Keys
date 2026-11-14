//! In-app updates. Keys asks GitHub for `latest.json` (the newest version, its notes and a signed
//! download), shows "Update available" in the sidebar above Lock, and installs only a download
//! signed with the Keys update key (its public half is built into the app). Nothing about you or
//! your vault is sent.
//!
//! Automatic checks can be turned off in the app menu ("Check for Updates Automatically");
//! the choice lives in updates.json in Keys' settings folder.

use std::sync::Mutex;
use std::time::Duration;

use keys_core::storage::config_dir;
use serde_json::{Value, json};
use keys_core::api::Shared;
use tauri::{AppHandle, Manager};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The update found last, ready to install from the sidebar or the menu.
#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

fn report(app: &AppHandle, update: &Update, state: &str) {
    let notes: String = update.body.clone().unwrap_or_default().chars().take(700).collect();
    app.state::<Shared>().set_update(Some(json!({ "version": update.version, "notes": notes.trim(), "state": state })));
}

/// Downloads, checks the signature, installs and restarts. On failure the sidebar says so.
pub async fn install(app: AppHandle) {
    let Some(update) = app.state::<Pending>().0.lock().unwrap_or_else(|p| p.into_inner()).clone() else { return };
    report(&app, &update, "installing");
    match update.download_and_install(|_, _| {}, || {}).await {
        // A clean restart: the quit handler locks the vault and removes this Mac's marker first.
        Ok(()) => app.request_restart(),
        Err(e) => {
            eprintln!("Update failed: {e}");
            report(&app, &update, "failed");
            notice(&app, "The update didn’t install", "Keys couldn’t download or verify the update. Nothing was changed. Try again later.", MessageDialogKind::Warning);
        }
    }
}

const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
pub const MENU_CHECK: &str = "check-updates";
pub const MENU_AUTO: &str = "auto-updates";

fn prefs_file() -> std::path::PathBuf {
    config_dir().join("updates.json")
}

pub fn auto_enabled() -> bool {
    std::fs::read_to_string(prefs_file()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v["auto"].as_bool()).unwrap_or(true)
}

pub fn set_auto(on: bool) {
    let _ = std::fs::create_dir_all(config_dir());
    let _ = std::fs::write(prefs_file(), json!({ "auto": on }).to_string());
}

/// The standard Mac menus, plus "Check for Updates…" and the automatic-checks switch under Keys.
pub fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    if let Some(app_menu) = menu.items()?.first().and_then(|i| i.as_submenu().cloned()) {
        let check = MenuItem::with_id(app, MENU_CHECK, "Check for Updates…", true, None::<&str>)?;
        let auto = CheckMenuItem::with_id(app, MENU_AUTO, "Check for Updates Automatically", true, auto_enabled(), None::<&str>)?;
        let sep = PredefinedMenuItem::separator(app)?;
        app_menu.insert_items(&[&check, &auto, &sep], 2)?;
    }
    Ok(menu)
}

fn notice(app: &AppHandle, title: &str, text: &str, kind: MessageDialogKind) {
    app.dialog().message(text).title(title).kind(kind).show(|_| {});
}

/// Looks for a newer version. `manual`: the person asked, so say "up to date" and show errors.
pub async fn check(app: AppHandle, manual: bool) {
    if !manual && !auto_enabled() {
        return;
    }
    let mut builder = app.updater_builder();
    // Development only: point at a local test feed.
    #[cfg(debug_assertions)]
    if let Some(url) = std::env::var("KEYS_UPDATE_URL").ok().and_then(|u| u.parse().ok()) {
        builder = match builder.endpoints(vec![url]) {
            Ok(b) => b,
            Err(e) => return eprintln!("update feed: {e}"),
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
            if manual {
                notice(&app, "You’re up to date", &format!("Keys {current} is the newest version."), MessageDialogKind::Info);
            }
            return;
        }
        Err(e) => {
            eprintln!("Update check failed: {e}");
            if manual {
                notice(&app, "Couldn’t check for updates", "Keys couldn’t reach GitHub. Check your connection and try again.", MessageDialogKind::Warning);
            }
            return;
        }
    };

    #[cfg(debug_assertions)]
    if std::env::var("KEYS_UPDATE_DRYRUN").is_ok() {
        match update.download(|_, _| {}, || {}).await {
            Ok(bytes) => println!("update {} downloaded and signature verified ({} bytes)", update.version, bytes.len()),
            Err(e) => println!("update {} rejected: {e}", update.version),
        }
        return;
    }

    *app.state::<Pending>().0.lock().unwrap_or_else(|p| p.into_inner()) = Some(update.clone());
    report(&app, &update, "available");
    if !manual {
        return; // the sidebar shows it, above Lock
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
}

/// Checks shortly after launch, then every few hours, while automatic checks are on.
pub fn schedule(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(10)).await;
        loop {
            check(app.clone(), false).await;
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}
