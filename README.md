# Keys

An offline-first password manager. Everything is encrypted on your machine and stored in one local SQLite file, `data/database.sqlite`; nothing goes to a cloud service. Only two features use the internet: website icons for logins (on by default; Settings → Icons → Hide icons in Logins stops them) and the opt-in breach check.

## Run it

Requires Node.js 24.7 or newer (it uses Node's built-in `node:sqlite` and `crypto.argon2`, so there are no native modules to compile).

```bash
npm install
npm run build
npm start            # http://localhost:5174
```

For development (Vite on :5173 with hot reload, API on :5174):

```bash
npm run dev
```

```bash
npm test             # crypto, generator, audit, CSV and full API tests
npm run typecheck
```

## Where data lives

Everything Keys stores is in **one SQLite file**, and you choose where it lives. Out of the box it's `data/database.sqlite` in the project folder; under **Settings → Database** you can put it anywhere this device can reach: any folder, iCloud Drive, Google Drive (with the file set to stay downloaded), a USB drive.

- **Connect a database:** open a Keys file you already have. Keys locks and switches to it.
- **Move this database:** copy everything to a new location and keep working from there. The old file is left untouched.
- **New empty database:** download an empty database (all tables, no data) to place anywhere and connect later, or on macOS create one directly in a folder you pick.
- **Erase this database:** permanently deletes everything in the open file (it needs your password or PIN) and returns to setup.
- **Built-in location:** switch back to `data/database.sqlite`.

On macOS each option has a **Browse** button that opens the normal Finder dialog; anywhere else, paste the file's full path (`~/…` and `file://` links work). Every change of file needs the current database's master password or PIN, with the usual lockout after repeated mistakes.

Keys remembers only the file's *location*, in a small pointer file outside the project: `~/Library/Application Support/Keys/location.json` on macOS (`%APPDATA%\Keys` on Windows, `~/.config/keys` on Linux). Delete it to go back to the built-in location. Keys never creates or overwrites a file it was pointed at: if the file is missing (say iCloud hasn't downloaded it yet), the app says so and offers Try again, Choose another file or the built-in database. A file is only accepted if it's an empty SQLite file or has Keys' tables, and every Keys database is stamped with its own SQLite `application_id`.

- Items, categories, password history, breach results, settings (including the generator's last-used options) and unlock-throttling state are all rows in that file, so they travel with it.
- SQLite runs in rollback-journal mode, so there are no `-wal`/`-shm` side files to sync; a `-journal` file appears only during a write.
- The browser keeps no vault data: no localStorage or IndexedDB and no cookies. Each tab holds only the session token in `sessionStorage`, which is meaningless after a lock or restart.
- Tests use an in-memory database or throwaway temp folders and never touch `data/` or your pointer file.

**Cloud folders:** open the database from one device at a time. Two devices writing the same file at once can leave sync conflicts, and SQLite can't lock a file across machines.

To back up, use an encrypted export (below) or copy the database file while Keys is stopped. `data/` is git-ignored. `KEYS_PORT` changes the port.

## What it does

- **First run:** a short landing page and one question per screen to create the vault, then a one-time tour and a getting-started checklist you can dismiss.
- **Item types:** logins, secure notes, API keys and recovery codes, each with categories, favorites and extra (optionally hidden) fields.
- **Password history:** changing a password keeps the previous 20 in that item.
- **Generator:** random passwords (8–128 characters, character sets, look-alike exclusion), passphrases from the EFF 7,776-word list (3–12 words, separator, capitals, a digit), and PINs (4–12 digits, never obvious ones like 1234 or 1212). All with unbiased Web Crypto randomness. The setup screen can suggest a passphrase for your master password.
- **Vault credential:** when creating the vault you choose how it unlocks: a password, a passphrase (4+ words), a 4 or 6-digit PIN (entered in one-digit-per-box OTP fields) or a pattern on a 3×3 dot grid. You can switch kinds later in Settings. PINs and patterns show a clear warning: see the security model.
- **PIN quick unlock (optional, password vaults):** a 4 or 6-digit PIN to reopen the vault after it auto-locks.
- **Security audit:** flags weak (zxcvbn score ≤ 2), reused, old (configurable), and breached passwords, with a health score.
- **Website icons (on by default):** each login with a website shows that site's icon. Keys asks the site itself (its page, `/apple-touch-icon.png` or `/favicon.ico`), never a third-party icon service, and refuses local or private network addresses. The icon is resized to a 128 px PNG and stored encrypted inside the item. Upload your own or remove it from the item editor; or hide icons for any kind of item under Settings → Icons (logins show icons by default, other kinds don't). Any item can get a custom icon: pick one of the built-in icons on a coloured tile, or upload an image.
- **Breach check (opt-in):** Have I Been Pwned k-anonymity range API with response padding. Only the first 5 hex characters of each password's SHA-1 leave the machine.
- **Import:** Keys exports (including ones made under the old name, VaultX), Bitwarden JSON, and CSV from Chrome, Firefox, Safari, 1Password, LastPass and Bitwarden. Duplicates are skipped.
- **Keyboard first:** `⌘K` searches items and runs commands, `/` filters the list, `N` adds an item, `E` edits, `⌘↵` saves, `⌘⇧L` locks.
- **Themes:** light, dark or follow the system (saved in the vault). Motion respects reduced-motion settings.
- **Export:** encrypted Keys file (Argon2id + AES-256-GCM, own password), or plaintext JSON/CSV after a warning. Every export re-asks for the master password.

## Security model

```
master password ──Argon2id (128 MiB, t=3, p=4, random salt)──▶ KEK
KEK ──AES-256-GCM unwrap──▶ DEK (random 256-bit vault key)
DEK ──AES-256-GCM──▶ each item and category (AAD = row id)
```

- Only ciphertext, row ids, timestamps and non-secret settings are written to SQLite. Titles, usernames, URLs, category names and history are all encrypted. `secure_delete` is on, so deleted rows are overwritten.
- Changing the master password re-wraps the DEK; items aren't re-encrypted.
- The DEK only exists in the server process's memory while the vault is unlocked. Locking, idle timeout, or stopping the server zeroes it.
- **Unlock throttling:** after 5 wrong passwords, attempts are refused with exponential backoff (5 s doubling, max 15 min). This persists across restarts.
- **Sessions:** one session at a time, held in a random 256-bit token sent as a request header. It isn't a cookie because browsers share cookies with every app on localhost, whatever the port. A new tab needs its own unlock, which ends the previous tab's session. Auto-lock after idle time (default 5 min), plus an optional lock when the tab is hidden.
- **Local-server hardening:** listens on `127.0.0.1` only; rejects non-loopback `Host` headers (DNS rebinding); every API call needs a custom header, an exact `Origin` match when one is sent, and `Sec-Fetch-Site: same-origin` (blocks other sites *and* other apps on other localhost ports); no CORS; strict CSP with no inline scripts and no third-party origins; `no-store` on API responses.
- **PIN and pattern vaults:** if you choose a PIN or a pattern as the vault credential, it derives the key with a much heavier Argon2id setting (512 MiB, 6 passes) and the app locks out after repeated mistakes. That still can't make 10,000 or 1,000,000 possibilities safe against someone who copies `data/database.sqlite`: expect a 4-digit PIN or any pattern to fall within hours, a 6-digit PIN in days. Encrypted backups of these vaults require a separate file password of 10+ characters.
- **PIN quick unlock:** a short PIN can't protect data at rest (every 4-digit PIN can be tried offline in minutes), so it never does. The master password still derives the only key that decrypts the file. When a PIN is set, a PIN-wrapped copy of the vault key is kept in server memory only; it survives auto-lock, is destroyed after 5 wrong PINs or when the server stops, and is re-armed by the next master-password unlock. The PIN itself is stored encrypted under the vault key, and obvious PINs (1234, 0000, 1212, years) are refused.
- **Clipboard:** copied secrets are overwritten after 30 s by default, and on lock.

### Known limits

- JavaScript strings can't be wiped from memory, so decrypted values can linger in the server and browser heap until garbage-collected. Key material is held in `Buffer`s and zeroed.
- Browsers only allow clipboard writes while the page has focus. If the timer fires while Keys is in the background, the wipe happens on next focus. The wipe also replaces whatever you copied after the secret.
- Anything running as your OS user can read the (encrypted) database file and could read the server's memory while the vault is unlocked. Keys protects data at rest and against other websites, not against malware on the same account.
- There is no master-password recovery. Keep an encrypted export somewhere safe.

## Layout

```
server/   Express API: crypto.ts, vault.ts (key hierarchy, records), session.ts,
          audit.ts (strength, reuse, HIBP), importExport.ts, security.ts
shared/   types and the password generator (used by both sides)
src/      React UI
test/     node:test suites
data/     database.sqlite (created on first run, git-ignored)
```
