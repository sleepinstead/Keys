# Keys for Windows

The desktop app for Windows: the same Tauri app and Rust core as keys-macos, with a tray icon instead of the Mac menu bar and an NSIS installer. It's built on GitHub (`.github/workflows/windows.yml` at the repository root), because it needs Windows to compile.

```
npm install
npm run dev        # work on the interface on this computer (Rust server + live reload)
npm test           # Rust tests (on this computer's OS)
npm run release -- --notes-file notes.md   # GitHub builds it, this Mac signs and publishes (tag windows-vX.Y.Z, feed: windows-updates)
```

Before a release: bump the version in `desktop/app/tauri.conf.json` and `desktop/app/Cargo.toml`, commit and push. The installer isn't code-signed yet, so Smart App Control blocks it; use keys-web on Windows until it is (see "Code signing policy" in the main README).
