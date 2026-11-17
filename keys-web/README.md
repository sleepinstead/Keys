# Keys in the browser

The same Keys interface and vault as the desktop apps, served by Node on your own computer. Use it where the desktop app can't run yet (for example Windows with Smart App Control on).

Needs **Node.js 24.7 or newer** (nodejs.org). Then, from this `keys-web` folder:

```
npm run setup     # once, and after pulling changes: installs what Keys needs
npm run build     # builds the interface (again after pulling changes)
npm start         # Keys at http://127.0.0.1:5174 — keep this window open
```

`npm run dev` runs it with live reload for working on the code (open http://localhost:5173).

Open http://127.0.0.1:5174 in your browser. Stop with Ctrl+C. `KEYS_PORT=5180 npm start` (PowerShell: `$env:KEYS_PORT=5180; npm start`) uses another port.

- Same database location as the desktop app (`%APPDATA%\Keys` on Windows, `~/Library/Application Support/Keys` on a Mac), so switching to the desktop app later keeps everything. Don't run both at once: they use the same port.
- The browser extension connects to it like to the desktop app.
- Differences from the desktop app: no automatic updates (pull and `npm run build` again), and copied passwords are cleared only while the Keys tab is in front.
