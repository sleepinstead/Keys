import crypto from 'node:crypto';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { randomId, randomToken, safeEqual } from './crypto.ts';
import type { QuickUnlock } from './pin.ts';
import { SESSION_HEADER } from './security.ts';
import type { SessionManager } from './session.ts';
import type { Storage } from './storage.ts';
import { HttpError, requireString } from './validate.ts';
import type { Vault } from './vault.ts';
import type { BrowserPairing } from '../shared/types.ts';

/**
 * The browser extension's door into Keys. The extension never keeps passwords: it asks this
 * server, which reads the same database the app uses, and only while the vault is unlocked.
 *
 * A browser has to be paired once: the extension shows a short code and the person types it
 * into the unlocked app. The extension then holds a random token; only its hash is stored, in
 * the database file, so pairings travel with the vault and disappear with it.
 */

export const EXTENSION_HEADER = 'x-keys-extension';
export const EXTENSION_TOKEN_HEADER = 'x-keys-extension-token';

const PAIRINGS_META = 'browser_pairings';
const PAIR_TTL_MS = 3 * 60_000;
const MAX_PENDING = 5;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

interface StoredPairing extends BrowserPairing {
  hash: string;
}

interface Pending {
  code: string;
  name: string;
  createdAt: number;
  status: 'pending' | 'approved';
  token?: string;
}

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('base64');

function newCode(): string {
  return Array.from({ length: 6 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
}

const normalizeCode = (raw: unknown) => (typeof raw === 'string' ? raw.toUpperCase().replace(/[^A-Z0-9]/g, '') : '');

function cleanName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) : '';
  return name || 'Browser';
}

function siteOf(raw: string, assumeScheme: boolean): URL | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const url = new URL(assumeScheme && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? `https://${text}` : text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

const bareHost = (url: URL) => url.hostname.toLowerCase().replace(/^www\./, '');

/**
 * Whether a saved login belongs on a page. Same host (ignoring "www."), or a subdomain of the
 * saved host, so example.com also fills on accounts.example.com. A plain-http page only matches
 * a login saved with an explicit http:// address, and a saved port has to match.
 * shortcut: no public-suffix list, so a login saved for a shared host like github.io would also
 * match its subdomains; add the list if that ever matters.
 */
export function matchesSite(entryUrl: string, pageUrl: string): boolean {
  const page = siteOf(pageUrl, false);
  const saved = siteOf(entryUrl, true);
  if (!page || !saved) return false;
  if (page.protocol === 'http:' && !/^http:\/\//i.test(entryUrl.trim())) return false;
  if (saved.port && saved.port !== page.port) return false;
  const want = bareHost(saved);
  const host = bareHost(page);
  return host === want || (want.includes('.') && host.endsWith(`.${want}`));
}

interface Deps {
  vault: Vault;
  storage: Storage;
  sessions: SessionManager;
  quick: QuickUnlock;
  appUrl: string;
}

export function createExtensionApi({ vault, storage, sessions, quick, appUrl }: Deps) {
  const json = express.json({ limit: '64kb' });
  const pending = new Map<string, Pending>();

  const sweep = () => {
    const now = Date.now();
    for (const [id, p] of pending) if (now - p.createdAt > PAIR_TTL_MS) pending.delete(id);
  };

  const readPairings = (): StoredPairing[] => {
    try {
      const list = JSON.parse(vault.store.getMeta(PAIRINGS_META) ?? '[]');
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };
  const writePairings = (list: StoredPairing[]) => vault.store.setMeta(PAIRINGS_META, JSON.stringify(list));
  const publicPairing = ({ hash: _hash, ...p }: StoredPairing): BrowserPairing => p;

  // ---------------------------------------------------------------- extension side

  /**
   * Web pages can't call these: a custom header forces a CORS preflight, which is never granted.
   * An Origin, when sent, has to be an extension's.
   */
  const guard = (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    if (req.method === 'OPTIONS' || req.headers[EXTENSION_HEADER] !== '1' || (origin && !EXTENSION_ORIGIN.test(origin))) {
      res.status(403).json({ error: 'Request blocked', code: 'FORBIDDEN' });
      return;
    }
    next();
  };

  /** The paired browser making this request, or a 401 that tells the extension to pair again. */
  const pairingOf = (req: Request): StoredPairing => {
    const token = req.headers[EXTENSION_TOKEN_HEADER];
    if (typeof token === 'string' && token) {
      const hash = hashToken(token);
      const list = readPairings();
      const found = list.find((p) => safeEqual(p.hash, hash));
      if (found) {
        // Remembered roughly, so a busy page doesn't write to the database on every request.
        if (!found.lastUsedAt || Date.now() - found.lastUsedAt > 60_000) {
          found.lastUsedAt = Date.now();
          writePairings(list);
        }
        return found;
      }
    }
    throw new HttpError(401, 'This browser isn’t connected to Keys', 'NOT_PAIRED');
  };

  /** The vault key, if Keys is unlocked. Filling counts as activity, so Keys stays unlocked while you use it. */
  const keyFor = (touch: boolean): Buffer => {
    const key = sessions.peek(touch);
    if (!key) throw new HttpError(401, 'Keys is locked', 'LOCKED');
    return key;
  };

  const ext = express.Router();
  ext.use(guard);

  ext.post('/pair', json, (req, res) => {
    sweep();
    if (!storage.available || !vault.isInitialized()) throw new HttpError(409, 'Set up Keys first, then connect this browser', 'NO_VAULT');
    if (pending.size >= MAX_PENDING) throw new HttpError(429, 'Too many connection requests. Try again in a few minutes');
    const requestId = randomId();
    const code = newCode();
    pending.set(requestId, { code, name: cleanName(req.body?.name), createdAt: Date.now(), status: 'pending' });
    res.json({ requestId, code, expiresAt: Date.now() + PAIR_TTL_MS, appUrl });
  });

  ext.get('/pair/:id', (req, res) => {
    sweep();
    const p = pending.get(req.params.id);
    if (!p) return void res.json({ status: 'expired' });
    if (p.status === 'approved') {
      pending.delete(req.params.id); // the token is handed over exactly once
      return void res.json({ status: 'approved', token: p.token });
    }
    res.json({ status: 'pending' });
  });

  ext.get('/status', (req, res) => {
    const pairing = pairingOf(req);
    const key = sessions.peek(false);
    res.json({
      unlocked: key !== null,
      credential: vault.credential(),
      appUrl,
      browser: pairing.name,
      clipboardClearSeconds: vault.getSettings().clipboardClearSeconds,
    });
  });

  /** Logins for the page (or all of them, for the popup's search). Never includes passwords. */
  ext.get('/logins', (req, res) => {
    pairingOf(req);
    const key = keyFor(false);
    const url = typeof req.query.url === 'string' ? req.query.url : '';
    const all = req.query.all === '1';
    const logins = vault
      .listEntries(key)
      .filter((e) => e.type === 'login' && (e.username || e.password))
      .map((e) => ({ id: e.id, title: e.title, username: e.username, url: e.url, icon: e.icon, matches: Boolean(url) && matchesSite(e.url, url) }))
      .filter((e) => all || e.matches)
      .sort((a, b) => Number(b.matches) - Number(a.matches) || a.title.localeCompare(b.title));
    res.json({ logins });
  });

  /** A login's username and password, but only for a page it belongs to. */
  ext.post('/fill', json, (req, res) => {
    pairingOf(req);
    const key = keyFor(true);
    const id = requireString(req.body?.id, 'Item', 64);
    const url = requireString(req.body?.url, 'Page address', 4096);
    const entry = vault.getEntry(key, id);
    if (entry.type !== 'login' || !matchesSite(entry.url, url)) throw new HttpError(403, 'That login isn’t for this site', 'WRONG_SITE');
    res.json({ username: entry.username, password: entry.password });
  });

  /** For the popup's copy buttons, which the person presses themselves. */
  ext.post('/secret', json, (req, res) => {
    pairingOf(req);
    const key = keyFor(true);
    const entry = vault.getEntry(key, requireString(req.body?.id, 'Item', 64));
    if (entry.type !== 'login') throw new HttpError(400, 'Only logins can be copied here');
    res.json({ username: entry.username, password: entry.password });
  });

  /** Unlocks Keys from the extension, with the same password checks and lockout as the app. */
  ext.post('/unlock', json, async (req, res) => {
    pairingOf(req);
    if (sessions.unlocked) return void res.json({ unlocked: true });
    const secret = requireString(req.body?.secret, 'Password', 1024);
    const key = await vault.unlock(secret);
    const pin = vault.readPin(key);
    if (pin) await quick.arm(key, pin);
    sessions.open(key);
    res.json({ unlocked: true });
  });

  ext.post('/lock', (req, res) => {
    pairingOf(req);
    sessions.lock();
    res.json({ unlocked: false });
  });

  /** The extension forgetting itself ("Disconnect" in its settings). */
  ext.post('/disconnect', (req, res) => {
    const pairing = pairingOf(req);
    writePairings(readPairings().filter((p) => p.id !== pairing.id));
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- app side

  /** Managing browsers from the app's Settings: needs the app's own unlocked session. */
  const manage = express.Router();
  const appKey = (req: Request) => {
    const token = req.headers[SESSION_HEADER];
    if (!sessions.authorize(typeof token === 'string' ? token : undefined)) throw new HttpError(401, 'Locked. Unlock to continue', 'LOCKED');
  };

  manage.get('/browsers', (req, res) => {
    appKey(req);
    res.json(readPairings().map(publicPairing));
  });

  manage.post('/browsers/approve', json, (req, res) => {
    appKey(req);
    sweep();
    const code = normalizeCode(req.body?.code);
    const match = [...pending.entries()].find(([, p]) => p.status === 'pending' && code.length === 6 && safeEqual(p.code, code));
    if (!match) throw new HttpError(404, 'That code doesn’t match. Check the code in the extension, or start again there', 'BAD_CODE');
    const [, p] = match;
    const token = randomToken();
    const pairing: StoredPairing = { id: randomId(), name: p.name, createdAt: Date.now(), lastUsedAt: null, hash: hashToken(token) };
    writePairings([...readPairings(), pairing]);
    p.status = 'approved';
    p.token = token;
    res.json(publicPairing(pairing));
  });

  manage.delete('/browsers/:id', (req, res) => {
    appKey(req);
    const list = readPairings();
    if (!list.some((p) => p.id === req.params.id)) throw new HttpError(404, 'That browser isn’t connected');
    writePairings(list.filter((p) => p.id !== req.params.id));
    res.json({ ok: true });
  });

  return { extension: ext, manage };
}
