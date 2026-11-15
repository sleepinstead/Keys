//! Keys for Mac: one window around the Keys app, served by the Rust core on 127.0.0.1:5174
//! (the same address as before, so the browser extension keeps working). Nothing else listens,
//! and the window can't call any native commands. Updates are handled natively (updates.rs).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod updates;

use std::time::Duration;

use keys_core::storage::{Storage, config_dir, default_db_file};
use tauri::webview::NewWindowResponse;
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};

/// Website links ("Open github.com") go to the default browser; the Keys window never leaves Keys.
fn open_in_browser(url: &Url) {
    if matches!(url.scheme(), "http" | "https") {
        let _ = std::process::Command::new("/usr/bin/open").arg(url.as_str()).spawn();
    }
}

/// A GUI app has no terminal to print to, so problems at launch get a real alert. The text goes in
/// as arguments, never into the script itself.
fn alert(title: &str, message: &str) {
    let _ = std::process::Command::new("/usr/bin/osascript")
        .args(["-e", "on run argv", "-e", "display alert (item 1 of argv) message (item 2 of argv) as critical", "-e", "end run", title, message])
        .status();
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Binds the port, waiting a moment if the previous Keys is still closing (after an update).
fn bind(port: u16) -> Option<std::net::TcpListener> {
    for _ in 0..50 {
        if let Ok(l) = std::net::TcpListener::bind(("127.0.0.1", port)) {
            return Some(l);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    None
}

fn main() {
    let port: u16 = std::env::var("KEYS_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(5174);

    let on_exit: std::sync::Arc<std::sync::OnceLock<keys_core::api::Shared>> = Default::default();
    let keys_slot = on_exit.clone();

    tauri::Builder::default()
        // First: opening Keys again just brings the open window forward.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show_main(app)))
        // ~/Library/Logs/app.keys.desktop/: warnings and errors only, never request contents.
        .plugin(tauri_plugin_log::Builder::new().level(log::LevelFilter::Info).max_file_size(1 << 20).build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .menu(updates::menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            updates::MENU_CHECK => {
                tauri::async_runtime::spawn(updates::check(app.clone(), true));
            }
            updates::MENU_AUTO => {
                let on = !updates::auto_enabled();
                updates::set_auto(on);
                if let Some(item) = app.menu().and_then(|m| m.get(updates::MENU_AUTO)).and_then(|i| i.as_check_menuitem().cloned()) {
                    let _ = item.set_checked(on);
                }
            }
            _ => {}
        })
        .setup(move |app| {
            // Bind before opening the window, so it never shows nothing. Another Keys was ruled out
            // above, so this is Keys in the browser (npm start) or another program.
            let Some(listener) = bind(port) else {
                alert("Keys can’t start", &format!("Another program is using port {port}, which Keys needs. If Keys is running in the browser (npm start), quit it, then open Keys again."));
                std::process::exit(1);
            };
            listener.set_nonblocking(true)?;
            let storage = Storage::open(Some(config_dir().join("location.json")), default_db_file());
            let keys = keys_core::api::App::new(storage, port);
            let _ = keys_slot.set(keys.clone());
            let front = app.handle().clone();
            keys.on_show(move || show_main(&front));
            app.manage(keys.clone());
            app.manage(updates::Pending::default());
            let handle = app.handle().clone();
            keys.on_install(move || {
                tauri::async_runtime::spawn(updates::install(handle.clone()));
            });
            let died = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let stopped = match tokio::net::TcpListener::from_std(listener) {
                    Ok(l) => keys_core::api::serve_app(keys, l).await,
                    Err(e) => Err(e),
                };
                if let Err(e) = stopped {
                    log::error!("Keys stopped: {e}");
                    alert("Keys stopped unexpectedly", "Open Keys again. Your vault is safe.");
                    died.exit(1);
                }
            });
            // 127.0.0.1, not "localhost": that name can resolve to ::1 first, where another program
            // could be listening and pose as Keys.
            let url: Url = format!("http://127.0.0.1:{port}/").parse().expect("valid URL");
            let home = url.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .on_navigation(move |to| {
                    let ours = to.scheme() == "http" && to.host_str() == Some("127.0.0.1") && to.port() == home.port();
                    if !ours {
                        open_in_browser(to);
                    }
                    ours
                })
                .on_new_window(|to, _| {
                    open_in_browser(&to);
                    NewWindowResponse::Deny
                })
                // The app's own drop zone (import) handles dropped files.
                .disable_drag_drop_handler()
                .title("Keys")
                .inner_size(1240.0, 820.0)
                .min_inner_size(880.0, 600.0)
                .center()
                .build()?;
            updates::schedule(app.handle().clone());
            Ok(())
        })
        // Closing the window keeps Keys running (like other Mac apps), so the browser extension keeps
        // working; ⌘Q quits. Auto-lock still applies.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("Keys couldn’t start")
        .run(move |app, event| match event {
            // Clicking the Dock icon brings the window back.
            tauri::RunEvent::Reopen { .. } => show_main(app),
            // On quit (and before an update restarts Keys): lock, and remove this computer's
            // "open" marker beside a shared database.
            tauri::RunEvent::Exit => {
                if let Some(keys) = on_exit.get() {
                    keys.shutdown();
                }
            }
            _ => {}
        });
}
