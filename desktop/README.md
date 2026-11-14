# Keys for Mac (Rust)

A native Mac app (Tauri) around the same Keys interface. The server is rewritten in Rust (`core/`): the same `Keys.sqlite` format, encryption (Argon2id, AES-256-GCM, the same `vaultx:*` labels), API and security checks as the Node server, so a vault moves freely between them, the iPhone app and the browser extension.

It serves on `127.0.0.1:5174`, like `npm start`, so run one or the other, not both.

## Build

Needs Rust (rustup.rs) and the web app built first:

```bash
npm run mac:build
```

The app is `desktop/target/release/bundle/macos/Keys.app`. Drag it to Applications.

`npm run mac:test` runs the Rust tests. `cargo run -p keys-core --bin keys-server` runs the server without a window (`KEYS_PORT` changes the port).

## Not in the Mac app yet

Security audit and breach checks, import and export, website icons, the browser extension's API (pairing, filling, saving), and the "also open on" and conflict-copy features of shared files. Those screens say so; use `npm start` for them until they're ported.
