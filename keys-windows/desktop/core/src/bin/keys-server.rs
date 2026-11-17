//! Headless Keys server (for testing): the same thing the Mac app runs inside its window.
//! KEYS_PORT picks the port (default 5174).

use keys_core::storage::{Storage, config_dir, default_db_file};

#[tokio::main]
async fn main() {
    let port = std::env::var("KEYS_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(5174);
    let storage = Storage::open(Some(config_dir().join("location.json")), default_db_file());
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("Keys couldn’t start on port {port}: {e}");
            std::process::exit(1);
        }
    };
    let app = keys_core::api::App::new(storage, port);
    // Testing the sidebar's update card without a real release (debug builds only): KEYS_FAKE_UPDATE=0.3.0.
    #[cfg(debug_assertions)]
    if let Ok(version) = std::env::var("KEYS_FAKE_UPDATE") {
        app.set_update(Some(serde_json::json!({ "version": version, "notes": "Test update", "state": "available" })));
        let me = app.clone();
        app.on_install(move || me.set_update(Some(serde_json::json!({ "version": "test", "notes": "", "state": "installing" }))));
    }
    let cleanup = app.clone();
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        cleanup.shutdown();
        std::process::exit(0);
    });
    println!("Keys (Rust) on http://localhost:{port}");
    if let Err(e) = keys_core::api::serve_app(app, listener).await {
        eprintln!("Keys stopped: {e}");
    }
}
