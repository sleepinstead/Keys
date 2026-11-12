# Keys

Keys is a password manager that runs on your own computer. Your passwords are encrypted and kept in one file that you control. There's no account to create and no cloud service in the middle.

I built it for people who want a private, simple place for their passwords without handing them to a third party.

![Keys main screen](docs/screenshots/main.png)

## What it does

- **Keeps four kinds of items:** logins, secure notes, API keys and recovery codes. Sort them into categories and star your favorites.
- **Generates passwords**, passphrases and PINs.
- **Checks your passwords.** The security audit finds weak, old and breached passwords, and shows exactly which logins share the same one.
- **Breach checks are optional** and use Have I Been Pwned. Your passwords never leave your computer.
- **Unlocks your way:** a password, passphrase, PIN or pattern, plus an optional quick-unlock PIN.
- **Has a safety net.** Deleted items go to Recently deleted first, and each item remembers its last 20 passwords.
- **Imports and exports.** Bring logins over from Chrome, Firefox, Safari, 1Password, LastPass or Bitwarden. Export an encrypted backup, JSON or CSV.
- **Feels quick.** Right-click any item for shortcuts, press `⌘K` to search, `N` for a new item and `⌘⇧L` to lock.
- **Light and dark themes**, or follow your system.

## Built with

- React, TypeScript and Vite for the app
- Node.js and Express for the local server
- SQLite (built into Node) for storage
- Argon2id and AES-256-GCM for encryption

## Getting started

You need **Node.js 24.7 or newer**.

```bash
npm install
npm run build
npm start
```

Open http://localhost:5174. The first time, Keys walks you through a short setup where you choose how to unlock it.

To work on the code with live reload, run `npm run dev` and open http://localhost:5173. Set `KEYS_PORT` to use a different port.

## Where your data lives

Everything is in one SQLite file. By default it's `Keys.sqlite` in your app data folder (`~/Library/Application Support/Keys` on macOS).

You can move it from **Settings → Database** to any folder, iCloud Drive, Google Drive or a USB drive. In a cloud folder, open it on one device at a time.

To back up, make an encrypted export, or copy the file while Keys is stopped.

## Browser extension

Keys has an extension for Chrome, Edge, Brave and other Chromium browsers. It fills your logins on websites and asks before saving a new or changed password. It keeps no copy of your passwords: it asks Keys, and only while Keys is unlocked.

![Autofill menu on a login page](docs/screenshots/extension.png)

1. Download the latest `Keys-extension` zip from [Releases](https://github.com/sleepinstead/Keys/releases) and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Drag the unzipped folder onto the page.
4. Click the Keys icon, choose **Connect to Keys**, and paste the code into **Settings → Browser extension**.

A login only fills on its own website, and only after you click it. The extension needs Chrome 120 or newer.

## Security in short

- Your master password unlocks a random vault key, and that key encrypts every item, titles and usernames included.
- The key lives only in memory while Keys is unlocked. Keys locks itself after 5 minutes idle by default.
- Wrong guesses lock you out for longer each time.
- The server only answers your own computer.

A few things to know:

- **A forgotten master password can't be recovered.** Keep an encrypted export somewhere safe.
- **A PIN or pattern is much weaker than a password.** Someone with a copy of your file could crack it.
- **Keys can't protect you from malware** on your own computer.

## Project layout

```
server/      local API, encryption and storage
src/         React app
shared/      code used by both sides
extension/   browser extension
```

Third-party fonts, word lists and libraries are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
