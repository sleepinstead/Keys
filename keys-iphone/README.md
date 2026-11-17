# Keys for iPhone

A read-only web app: it opens your Keys file from Google Drive and decrypts it on the phone. Static files only, published to GitHub Pages.

```
npm install
npm run dev        # http://localhost:5180
npm run build      # into dist-phone/
npm test           # reads vaults written by keys-macos's Rust core (builds it first)
```

`.env.local` holds `VITE_GOOGLE_CLIENT_ID`. `phone/vault.ts` must stay byte-compatible with `keys-macos/desktop/core/src/vault.rs`.
