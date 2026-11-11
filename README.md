# Keys

Keys is a password manager that runs on your own computer. Your passwords are encrypted and saved in a single file that you control. Nothing is sent to a cloud service, and there's no account to sign up for.

I built it for people who want a simple, private place for their passwords without trusting a third party.

![Keys main screen](docs/screenshots/main.png)

## What it does

- **Stores four kinds of items:** logins, secure notes, API keys and recovery codes. You can sort them into categories and mark favorites.
- **Generates strong passwords**, passphrases and PINs.
- **Runs a security audit** that flags weak, reused, old and breached passwords.
- **Checks for breaches (optional)** with Have I Been Pwned. Your passwords never leave your computer.
- **Unlocks your way:** with a password, a passphrase, a PIN or a pattern. You can also add a quick-unlock PIN for after Keys auto-locks.
- **Keeps a recycle bin:** deleted items go to Recently deleted, so you can bring them back.
- **Remembers old passwords:** each item keeps its last 20.
- **Imports and exports:** import from Chrome, Firefox, Safari, 1Password, LastPass and Bitwarden. Export to an encrypted backup, JSON or CSV.
- **Works from the keyboard:** press `⌘K` to search, `N` for a new item, `⌘⇧L` to lock.
- **Has light and dark themes**, or follows your system.

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

Then open http://localhost:5174 and create your vault.

To work on the code with live reload, run `npm run dev`. The app opens at http://localhost:5173. Run the tests with `npm test`.

## Where your data lives

Everything is stored in one SQLite file. By default that's `Keys.sqlite` in your app data folder (`~/Library/Application Support/Keys` on macOS).

You can move it anywhere from **Settings → Database**: another folder, iCloud Drive, Google Drive or a USB drive. If you keep it in a cloud folder, only open it on one device at a time.

To back up, make an encrypted export, or copy the file while Keys is stopped.

## Browser extension

Keys comes with an extension for Chrome, Edge, Brave and other Chromium browsers. It fills your logins on websites. It doesn't keep a copy of your passwords. It asks Keys for them, and only while Keys is unlocked.

![Autofill menu on a login page](docs/screenshots/extension.png)

1. Download `Keys-extension-1.0.1.zip` from the [latest release](https://github.com/sleepinstead/Keys/releases) and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Drag the unzipped folder onto the page.
4. Click the Keys icon, choose **Connect to Keys**, and enter the code in **Settings → Browser extension**.

A login only fills on its own website, and only after you click it.

## Security in short

- Your master password unlocks a random vault key. That key encrypts every item, including titles and usernames.
- The key exists only in memory while Keys is unlocked. Keys locks itself after 5 minutes of inactivity by default.
- Too many wrong guesses lock you out for longer and longer.
- The server only answers requests from your own computer.

A few things to know:

- **There's no way to recover a forgotten master password.** Keep an encrypted export somewhere safe.
- **A PIN or pattern is much weaker than a password.** Someone with a copy of your file could crack it.
- **Keys can't protect you from malware** running on your own computer.

## Project layout

```
server/      local API, encryption and storage
src/         React app
shared/      code used by both sides
extension/   browser extension
test/        tests
```
