# Keys in the browser

The Keys interface and vault, served by Node on your own computer.

Needs **Node.js 24.7 or newer** (nodejs.org). Then, from this `keys-web` folder:

```
npm run setup     # once, and after pulling changes: installs what Keys needs
npm run build     # builds the interface (again after pulling changes)
npm start         # Keys at http://127.0.0.1:5174 — keep this window open
```

`npm run dev` runs it with live reload for working on the code (open http://localhost:5173).

Open http://127.0.0.1:5174 in your browser. Stop with Ctrl+C. `KEYS_PORT=5180 npm start` (PowerShell: `$env:KEYS_PORT=5180; npm start`) uses another port.

- The database lives in `%APPDATA%\Keys` on Windows and `~/Library/Application Support/Keys` on a Mac (the same place earlier desktop versions of Keys used, so their vaults open here).
- The browser extension connects to it.
- Updates: pull and `npm run build` again. Copied passwords are cleared only while the Keys tab is in front.
