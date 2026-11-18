# Setting up Keys

Keys runs as a small server on your own computer (http://127.0.0.1:5174), and you use it in your browser. This guide gets it running in the background all the time, opening like an app, with the browser extension connected.

You need [Node.js](https://nodejs.org) **24.7 or newer**.

`npm run dev` is only for working on Keys' code. You don't need it for everyday use: the steps below replace it. Don't run both at once, since they use the same port.

## Mac

### 1. Install and build (once)

```bash
cd path/to/keys/keys-web
npm run setup
npm run build
```

### 2. Run Keys in the background

From the same `keys-web` folder, paste this into Terminal. It starts Keys now, at every login, and again if it ever stops:

```bash
cat > ~/Library/LaunchAgents/com.keys.web.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.keys.web</string>
  <key>ProgramArguments</key><array><string>$(command -v node)</string><string>server/index.ts</string><string>--production</string></array>
  <key>WorkingDirectory</key><string>$PWD</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.keys.web.plist
```

Check it's running by opening http://127.0.0.1:5174.

### 3. Make it an app

- **Safari:** open http://127.0.0.1:5174, then **File › Add to Dock**.
- **Chrome:** open http://127.0.0.1:5174, then **⋮ › Cast, save and share › Install page as app**.

Keys now opens in its own window from the Dock, Launchpad or Spotlight.

Make sure the app opens `127.0.0.1:5174`. One made from `localhost:5173` (the `npm run dev` address) stops working when dev isn't running: remove it and add it again from `127.0.0.1:5174`.

### After updating the code

```bash
cd path/to/keys/keys-web
npm run build
launchctl kickstart -k gui/$(id -u)/com.keys.web
```

### Removing it

- **The background service:**

  ```bash
  launchctl bootout gui/$(id -u)/com.keys.web && rm ~/Library/LaunchAgents/com.keys.web.plist
  ```

- **The Safari app:** quit it, then drag **Keys** from the **Applications** folder in your home folder (Finder › **Go › Home › Applications**) to the Trash, and off the Dock.
- **The Chrome app:** open it, then **⋮ › Uninstall Keys**.

Your vault isn't touched by any of this: it stays in `~/Library/Application Support/Keys` (or wherever you moved it).

## Windows

### 1. Install and build (once)

In PowerShell:

```powershell
cd path\to\keys\keys-web
npm run setup
npm run build
```

### 2. Run Keys in the background

1. Press **Win + R**, type `shell:startup` and press Enter. Your Startup folder opens.
2. Create a file there named `Keys.vbs` containing this one line, with your own path to `keys-web`:

   ```vb
   CreateObject("WScript.Shell").Run "cmd /c cd /d C:\path\to\keys\keys-web && node server/index.ts --production", 0
   ```

   The `0` means no window opens.
3. Double-click `Keys.vbs` once to start Keys now. From then on it starts every time you sign in.

Check it's running by opening http://127.0.0.1:5174.

### 3. Make it an app

- **Edge:** open http://127.0.0.1:5174, then **⋯ › Apps › Install this site as an app**. To open it at sign-in too, find it in `edge://apps`, right-click it and choose **Start app when you sign in**.
- **Chrome:** open http://127.0.0.1:5174, then **⋮ › Cast, save and share › Install page as app**.

Keys now opens in its own window from the Start menu and taskbar.

### After updating the code

Run `npm run build` in `keys-web`, then sign out and back in (or end the `node` process in Task Manager and double-click `Keys.vbs`).

### Removing it

- **The background start:** delete `Keys.vbs` from the Startup folder (`shell:startup`), and end the `node` process in Task Manager.
- **The Edge or Chrome app:** open it, then **⋯ › Uninstall** (Edge) or **⋮ › Uninstall Keys** (Chrome).

Your vault stays in `%APPDATA%\Keys` (or wherever you moved it).

## Browser extension

Fills your logins on websites and offers to save new ones, in Chrome, Edge, Brave and other Chromium browsers (version 120 or newer). It keeps no passwords itself: it asks Keys, which must be running.

### Install

1. Download `Keys-extension-1.0.0.zip` from the [latest release](https://github.com/sleepinstead/Keys/releases/latest) and unzip it somewhere it can stay. Or use the `keys-extension` folder of this repository.
2. Open `chrome://extensions` (`edge://extensions` in Edge) and turn on **Developer mode**.
3. Choose **Load unpacked** and pick the unzipped folder.
4. Pin Keys to the toolbar from the puzzle-piece menu.

### Connect it to Keys

1. Make sure Keys is running and unlocked.
2. Click the Keys icon in the toolbar and press **Connect to Keys**. It shows a six-character code, valid for 3 minutes.
3. In Keys, open **Settings › Browser extension**, press **Connect** next to *Connect a browser*, and type the code.

The extension is connected for good. To disconnect it, use **Disconnect** in the same Settings card.

### Updating it

Replace the folder's files with the new version, then press the reload icon on the Keys card in `chrome://extensions`. Update Keys at the same time: the extension and Keys must be the same generation to talk to each other.

### Removing it

Press **Remove** on the Keys card in `chrome://extensions`, then disconnect the browser in **Settings › Browser extension** in Keys.
