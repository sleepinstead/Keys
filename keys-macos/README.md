# Keys for Mac

The desktop app: a Tauri 2 window (`desktop/app`) around the React interface (`src/`), served by the Rust core (`desktop/core`) on 127.0.0.1:5174. Needs Node.js 24.7+ and Rust.

```
npm install
npm run dev        # Rust server + live-reloading interface at http://localhost:5173
npm test           # Rust tests (cargo test --workspace)
npm run app        # build Keys.app into desktop/target/release/bundle/macos
npm run release -- --notes-file notes.md   # build, sign and publish (tag mac-vX.Y.Z, feed: mac-updates)
```

Before a release: bump the version in `desktop/app/tauri.conf.json` and `desktop/app/Cargo.toml`, commit and push. The update key stays on this Mac (`~/.tauri/keys-updater.key`). The browser extension zip attached to the release comes from `../keys-extension`.
