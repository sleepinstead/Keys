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

/// A GUI app has no terminal to print to, so problems at launch get a real alert.
fn alert(title: &str, message: &str) {
    let script = format!("display alert {title:?} message {message:?} as critical");
    let _ = std::process::Command::new("/usr/bin/osascript").args(["-e", &script]).status();
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

    // Bind first, so the window never opens onto nothing (and a second Keys says so clearly).
    let Some(listener) = bind(port) else {
        alert("Keys is already open", &format!("Another copy of Keys, or Keys in the browser (npm start), is using port {port}. Quit it, then open Keys again."));
        std::process::exit(1);
    };
    listener.set_nonblocking(true).expect("non-blocking socket");

    let storage = Storage::open(Some(config_dir().join("location.json")), default_db_file());
    let keys = keys_core::api::App::new(storage, port);
    let on_exit = keys.clone();

    tauri::Builder::default()
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
            app.manage(keys.clone());
            app.manage(updates::Pending::default());
            let handle = app.handle().clone();
            keys.on_install(move || {
                tauri::async_runtime::spawn(updates::install(handle.clone()));
            });
            tauri::async_runtime::spawn(async move {
                let listener = tokio::net::TcpListener::from_std(listener).expect("listener");
                if let Err(e) = keys_core::api::serve_app(keys, listener).await {
                    eprintln!("Keys stopped: {e}");
                }
            });
            let url: Url = format!("http://localhost:{port}/").parse().expect("valid URL");
            let home = url.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .on_navigation(move |to| {
                    let ours = to.scheme() == "http" && matches!(to.host_str(), Some("localhost" | "127.0.0.1")) && to.port() == home.port();
                    if !ours {
                        open_in_browser(to);
                    }
                    ours
                })
                .on_new_window(|to, _| {
                    open_in_browser(&to);
                    NewWindowResponse::Deny
                })
                .title("Keys")
                .inner_size(1240.0, 820.0)
                .min_inner_size(880.0, 600.0)
                .center()
                .build()?;
            updates::schedule(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Keys couldn’t start")
        .run(move |_, event| {
            // On quit (and before an update restarts Keys): lock, and remove this computer's
            // "open" marker beside a shared database.
            if let tauri::RunEvent::Exit = event {
                on_exit.shutdown();
            }
        });
}
