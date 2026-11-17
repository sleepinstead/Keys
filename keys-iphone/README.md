# Keys for iPhone

A read-only web app: it opens your Keys file from Google Drive and decrypts it on the phone. Static files only, published to GitHub Pages.

```
npm install
npm run dev        # http://localhost:5180
npm run build      # into dist-phone/
npm test           # reads vaults written by the keys-web server (run npm install in keys-web first)
```

`.env.local` holds `VITE_GOOGLE_CLIENT_ID`. `phone/vault.ts` must stay byte-compatible with the vault format in `keys-web/server/vault.ts` and `crypto.ts`.
