//! Headless Keys server (for testing): the same thing the Mac app runs inside its window.
//! KEYS_PORT picks the port (default 5174).

use keys_core::storage::{Storage, config_dir, default_db_file};

#[tokio::main]
async fn main() {
    let port = std::env::var("KEYS_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(5174);
    let storage = Storage::open(Some(config_dir().join("location.json")), default_db_file());
    println!("Keys (Rust) on http://localhost:{port}");
    if let Err(e) = keys_core::api::serve(storage, port).await {
        eprintln!("Keys couldn’t start: {e}");
        std::process::exit(1);
    }
}
