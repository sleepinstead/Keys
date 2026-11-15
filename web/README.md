# Keys in the browser

The same Keys app and vault as the desktop app, served by Node on your own computer. Use it where the desktop app can't run yet (for example Windows with Smart App Control on).

Needs **Node.js 24.7 or newer** (nodejs.org). Then, from this folder:

```
npm run setup     # once: installs what the server and the interface need
npm run build     # builds the interface (again after pulling changes)
npm start         # Keys at http://127.0.0.1:5174 — keep this window open
```

Open http://127.0.0.1:5174 in your browser. Stop with Ctrl+C. `KEYS_PORT=5180 npm start` (PowerShell: `$env:KEYS_PORT=5180; npm start`) uses another port.

- Same database location as the desktop app (`%APPDATA%\Keys` on Windows, `~/Library/Application Support/Keys` on a Mac), so switching to the desktop app later keeps everything. Don't run both at once: they use the same port.
- The browser extension connects to it like to the desktop app.
- Differences from the desktop app: no automatic updates (pull and `npm run build` again), and copied passwords are cleared only while the Keys tab is in front.
