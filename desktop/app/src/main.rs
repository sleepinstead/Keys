//! Keys for Mac: one window around the Keys app, served by the Rust core on 127.0.0.1:5174
//! (the same address as before, so the browser extension keeps working). Nothing else listens,
//! and the window can't call any native commands.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use keys_core::storage::{Storage, config_dir, default_db_file};
use tauri::{WebviewUrl, WebviewWindowBuilder};

fn main() {
    let port: u16 = std::env::var("KEYS_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(5174);

    // Bind first, so the window never opens onto nothing (and a second Keys says so clearly).
    let listener = match std::net::TcpListener::bind(("127.0.0.1", port)) {
        Ok(l) => l,
        Err(_) => {
            eprintln!("Keys is already running, or another app uses port {port}. Quit it (or `npm start`) and open Keys again.");
            std::process::exit(1);
        }
    };
    listener.set_nonblocking(true).expect("non-blocking socket");

    let storage = Storage::open(Some(config_dir().join("location.json")), default_db_file());
    let keys = keys_core::api::App::new(storage, port);
    let on_exit = keys.clone();

    tauri::Builder::default()
        .setup(move |app| {
            tauri::async_runtime::spawn(async move {
                let listener = tokio::net::TcpListener::from_std(listener).expect("listener");
                if let Err(e) = keys_core::api::serve_app(keys, listener).await {
                    eprintln!("Keys stopped: {e}");
                }
            });
            let url = format!("http://localhost:{port}/").parse().expect("valid URL");
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Keys")
                .inner_size(1240.0, 820.0)
                .min_inner_size(880.0, 600.0)
                .center()
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Keys couldn’t start")
        .run(move |_, event| {
            // On quit: lock, and remove this computer's "open" marker beside a shared database.
            if let tauri::RunEvent::Exit = event {
                on_exit.shutdown();
            }
        });
}
