import express from 'express';
import type { Request, Response } from 'express';
import { buildAuditReport, checkBreaches } from './audit.ts';
import type { RangeFetcher } from './audit.ts';
import { fetchSiteIcon } from './favicon.ts';
import { browse, Storage } from './storage.ts';
import type { IconFetcher } from './favicon.ts';
import { exportVault, importVault } from './importExport.ts';
import { SESSION_HEADER } from './security.ts';
import type { SessionManager } from './session.ts';
import { validatePin } from './pin.ts';
import type { QuickUnlock } from './pin.ts';
import { checkStrength } from './strength.ts';
import { HttpError, requireString, sanitizeCategoryName, sanitizeEntryInput } from './validate.ts';
import { MIN_MASTER_LENGTH } from './vault.ts';
import type { Vault } from './vault.ts';
import { CATEGORY_COLORS, isShortCredential, MASTER_PIN_LENGTHS } from '../shared/types.ts';
import { passphraseProblem, patternProblem } from '../shared/credential.ts';
import type { Credential, ExportFormat, VaultStatus } from '../shared/types.ts';

const CREDENTIAL_LABELS = { password: 'master password', passphrase: 'passphrase', pin: 'PIN', pattern: 'pattern' } as const;

interface Deps {
  vault: Vault;
  sessions: SessionManager;
  quick: QuickUnlock;
  fetchRange?: RangeFetcher;
  fetchIcon?: IconFetcher;
  storage: Storage;
}

export function createApi({ vault, storage, sessions, quick, fetchRange, fetchIcon }: Deps): express.Router {
  const api = express.Router();
  const json = express.json({ limit: '1mb' });
  const bigJson = express.json({ limit: '100mb' }); // backups carry each item's icon

  const tokenOf = (req: Request) => {
    const token = req.headers[SESSION_HEADER];
    return typeof token === 'string' ? token : undefined;
  };
  const opened = (req: Request, res: Response, key: Buffer) => {
    const sessionToken = sessions.open(key);
    res.json({ ...status(req), sessionToken, unlocked: true, expiresAt: sessions.expiresAt(), settings: vault.getSettings() });
  };

  /** Returns the live vault key or throws 401. Call again after any `await` that precedes key use. */
  const keyFor = (req: Request, touch = true): Buffer => {
    const key = sessions.authorize(tokenOf(req), touch);
    if (!key) throw new HttpError(401, 'Locked. Unlock to continue', 'LOCKED');
    return key;
  };

  const status = (req: Request): VaultStatus => {
    if (!storage.available) {
      // The chosen file can't be opened (not synced yet, moved, no permission): say so instead of offering setup.
      return {
        storage: storage.info(),
        initialized: false,
        unlocked: false,
        lockoutUntil: null,
        expiresAt: null,
        settings: null,
        appearance: 'system',
        pin: null,
        credential: { type: 'password' },
      };
    }
    const unlocked = sessions.authorize(tokenOf(req), false) !== null;
    return {
      storage: storage.info(),
      initialized: vault.isInitialized(),
      unlocked,
      lockoutUntil: vault.lockoutUntil(),
      expiresAt: unlocked ? sessions.expiresAt() : null,
      settings: unlocked ? vault.getSettings() : null,
      appearance: vault.isInitialized() ? vault.getSettings().appearance : 'system',
      pin: pinStatus(),
      credential: vault.isInitialized() ? vault.credential() : { type: 'password' },
    };
  };

  const pinStatus = () => {
    const length = vault.isInitialized() ? vault.pinLength() : null;
    return length ? { length, available: quick.armed, attemptsLeft: quick.attemptsLeft } : null;
  };

  /** A master-password unlock re-arms PIN unlock (fresh attempts) when a PIN is set. */
  const rearmPin = async (key: Buffer) => {
    const pin = vault.readPin(key);
    if (pin) await quick.arm(key, pin);
  };

  /** Validates a new vault credential of any type and returns its descriptor. */
  const checkCredential = (value: string, type: unknown): Credential => {
    if (type === 'pin') {
      const pin = validatePin(value, MASTER_PIN_LENGTHS);
      return { type: 'pin', length: pin.length as 4 | 6 };
    }
    if (type === 'pattern') {
      const problem = patternProblem(value);
      if (problem) throw new HttpError(400, problem, 'WEAK_PATTERN');
      return { type: 'pattern' };
    }
    if (type === 'passphrase') {
      const problem = passphraseProblem(value);
      if (problem) throw new HttpError(400, problem, 'WEAK_PASSPHRASE');
      if (checkStrength(value).score < 3) throw new HttpError(400, 'That passphrase is too easy to guess. Use less common words.');
      return { type: 'passphrase' };
    }
    assertStrongMaster(value);
    return { type: 'password' };
  };

  const assertStrongMaster = (password: string) => {
    if (password.length < MIN_MASTER_LENGTH) {
      throw new HttpError(400, `Master password must be at least ${MIN_MASTER_LENGTH} characters`);
    }
    if (checkStrength(password).score < 3) {
      throw new HttpError(400, 'Master password is too easy to guess. Use a longer passphrase.');
    }
  };

  // ------------------------------------------------------------ session

  api.get('/status', (req, res) => {
    res.json(status(req));
  });

  // ------------------------------------------------------------ storage
  // Which SQLite file Keys uses. Switching to a different file locks the app,
  // since that file has its own master password.

  /**
   * Changing which file Keys uses needs the current database's password or PIN
   * (failures count towards the usual lockout). Skipped only when there's nothing
   * to protect: the file can't be opened, or it has no vault yet.
   */
  const requireCurrent = async (req: Request) => {
    if (!storage.available || !vault.isInitialized()) return;
    const current = typeof req.body?.current === 'string' ? req.body.current.slice(0, 1024) : '';
    const name = CREDENTIAL_LABELS[vault.credential().type];
    if (!current) throw new HttpError(400, `Enter your ${name} to change the database`);
    if (!(await vault.verifyPassword(current))) throw new HttpError(401, `Incorrect ${name}`, 'BAD_PASSWORD');
  };

  const switched = (req: Request, res: Response) => {
    sessions.lock();
    quick.disarm();
    res.json(status(req));
  };

  api.post('/storage/connect', json, async (req, res) => {
    await requireCurrent(req);
    storage.connect(req.body?.path);
    switched(req, res);
  });

  api.post('/storage/create', json, async (req, res) => {
    await requireCurrent(req);
    storage.create(req.body?.path);
    switched(req, res);
  });

  api.post('/storage/default', json, async (req, res) => {
    await requireCurrent(req);
    storage.useDefault();
    switched(req, res);
  });

  api.post('/storage/retry', (req, res) => {
    storage.retry();
    res.json(status(req));
  });

  /** Copies everything to a new file and keeps working from there; same data, so the session stays open. */
  api.post('/storage/move', json, async (req, res) => {
    keyFor(req);
    await requireCurrent(req);
    storage.move(req.body?.path);
    res.json(status(req));
  });

  /** Erases this database in place. The file stays, empty, ready for a fresh setup. */
  api.post('/storage/wipe', json, async (req, res) => {
    keyFor(req);
    await requireCurrent(req);
    vault.store.wipe();
    switched(req, res);
  });

  /** An empty Keys database (all tables, no data) to save anywhere and connect later. */
  api.get('/storage/template', (_req, res) => {
    res.json({ filename: 'Keys.sqlite', data: Storage.template().toString('base64') });
  });

  api.post('/storage/browse', json, async (req, res) => {
    res.json({ path: await browse(req.body?.mode === 'save' ? 'save' : 'open') });
  });

  api.post('/setup', json, async (req, res) => {
    const password = requireString(req.body?.password, 'Master password', 1024);
    const credential = checkCredential(password, req.body?.type);
    const key = await vault.setup(password, credential);
    opened(req, res, key);
  });

  api.post('/unlock', json, async (req, res) => {
    const password = requireString(req.body?.password, 'Master password', 1024);
    const key = await vault.unlock(password);
    await rearmPin(key);
    opened(req, res, key);
  });

  api.post('/unlock/pin', json, async (req, res) => {
    if (!vault.isInitialized()) throw new HttpError(409, 'Setup isn’t finished yet');
    const pin = typeof req.body?.pin === 'string' ? req.body.pin.slice(0, 16) : '';
    const key = await quick.unlock(pin);
    if (!key) {
      if (!quick.armed) {
        throw new HttpError(401, 'Too many wrong PINs. Use your master password to unlock.', 'PIN_EXHAUSTED');
      }
      const left = quick.attemptsLeft;
      throw new HttpError(401, `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left before the master password is needed.`, 'BAD_PIN');
    }
    opened(req, res, key);
  });

  // ---------------------------------------------------------------- PIN

  api.post('/pin', json, async (req, res) => {
    keyFor(req);
    if (isShortCredential(vault.credential())) {
      throw new HttpError(409, 'You already unlock with a PIN.', 'PIN_VAULT');
    }
    const pin = validatePin(req.body?.pin);
    const master = requireString(req.body?.masterPassword, 'Master password', 1024);
    if (!(await vault.verifyPassword(master))) throw new HttpError(401, 'Incorrect master password', 'BAD_PASSWORD');
    const key = keyFor(req);
    vault.savePin(key, pin);
    await quick.arm(keyFor(req, false), pin);
    res.json({ pin: pinStatus() });
  });

  api.delete('/pin', (req, res) => {
    keyFor(req);
    vault.removePin();
    quick.disarm();
    res.json({ pin: null });
  });

  api.post('/lock', (_req, res) => {
    sessions.lock();
    res.json({ ok: true });
  });

  api.post('/session/ping', (req, res) => {
    keyFor(req);
    res.json({ expiresAt: sessions.expiresAt() });
  });

  // -------------------------------------------------------------- tools

  api.post('/tools/strength', json, (req, res) => {
    const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 1024) : '';
    const inputs = Array.isArray(req.body?.userInputs)
      ? req.body.userInputs.filter((s: unknown): s is string => typeof s === 'string').map((s: string) => s.slice(0, 200))
      : [];
    res.json(checkStrength(password, inputs));
  });

  // Runs for logins without an icon, and when the user picks "Use website icon". It contacts that website directly.
  api.post('/tools/site-icon', json, async (req, res) => {
    keyFor(req);
    const url = typeof req.body?.url === 'string' ? req.body.url.slice(0, 2048) : '';
    res.json({ icon: await fetchSiteIcon(url, fetchIcon) });
  });

  // ------------------------------------------------------------ entries

  api.get('/entries', (req, res) => {
    res.json(vault.listSummaries(keyFor(req)));
  });

  api.get('/entries/:id', (req, res) => {
    res.json(vault.getEntry(keyFor(req), req.params.id));
  });

  api.post('/entries', json, (req, res) => {
    const key = keyFor(req);
    res.status(201).json(vault.createEntry(key, sanitizeEntryInput(req.body)));
  });

  api.put('/entries/:id', json, (req, res) => {
    const key = keyFor(req);
    res.json(vault.updateEntry(key, req.params.id, sanitizeEntryInput(req.body)));
  });

  api.delete('/entries/:id', (req, res) => {
    keyFor(req);
    vault.deleteEntry(req.params.id);
    res.json({ ok: true });
  });

  const itemIds = (raw: unknown): string[] => {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 10_000 || !raw.every((x) => typeof x === 'string' && x.length <= 64)) {
      throw new HttpError(400, 'Choose some items first');
    }
    return raw;
  };

  /** Removes several items at once, all or none. */
  api.post('/entries/delete', json, (req, res) => {
    keyFor(req);
    const ids = itemIds(req.body?.ids);
    vault.store.transaction(() => ids.forEach((id) => vault.deleteEntry(id)));
    res.json({ deleted: ids.length });
  });

  /** Favourites or moves several items at once, all or none. */
  api.post('/entries/update', json, (req, res) => {
    const key = keyFor(req);
    const ids = itemIds(req.body?.ids);
    const body = req.body as Record<string, unknown>;
    const favorite = body.favorite;
    const moving = Object.hasOwn(body, 'categoryId');
    const categoryId = body.categoryId;
    if (favorite !== undefined && typeof favorite !== 'boolean') throw new HttpError(400, 'Invalid favourite value');
    if (moving && categoryId !== null && (typeof categoryId !== 'string' || categoryId.length > 64)) throw new HttpError(400, 'Invalid category');
    if (favorite === undefined && !moving) throw new HttpError(400, 'Nothing to change');
    vault.store.transaction(() => {
      for (const id of ids) {
        const input = sanitizeEntryInput(vault.getEntry(key, id));
        if (favorite !== undefined) input.favorite = favorite;
        if (moving) input.categoryId = categoryId as string | null;
        vault.updateEntry(key, id, input);
      }
    });
    res.json({ updated: ids.length });
  });

  // Sets only the picture. Not a user edit, so "recently edited" order stays the same.
  api.put('/entries/:id/icon', json, (req, res) => {
    const key = keyFor(req);
    const icon = sanitizeEntryInput({ type: 'login', title: 'x', icon: req.body?.icon }).icon;
    vault.getEntry(key, req.params.id);
    vault.patchEntryData(key, req.params.id, { icon });
    res.json(vault.getEntry(key, req.params.id));
  });

  api.delete('/entries/:id/history', (req, res) => {
    res.json(vault.clearHistory(keyFor(req), req.params.id));
  });

  // --------------------------------------------------------- categories

  api.get('/categories', (req, res) => {
    res.json(vault.listCategories(keyFor(req)));
  });

  api.post('/categories', json, (req, res) => {
    const key = keyFor(req);
    res.status(201).json(vault.createCategory(key, sanitizeCategoryName(req.body?.name)));
  });

  api.put('/categories/:id', json, (req, res) => {
    const key = keyFor(req);
    const color = req.body?.color;
    if (color !== undefined && color !== null && !Object.hasOwn(CATEGORY_COLORS, color)) throw new HttpError(400, 'Unknown folder colour');
    res.json(
      vault.updateCategory(key, req.params.id, {
        name: req.body?.name === undefined ? undefined : sanitizeCategoryName(req.body.name),
        color,
      }),
    );
  });

  api.delete('/categories/:id', (req, res) => {
    vault.deleteCategory(keyFor(req), req.params.id);
    res.json({ ok: true });
  });

  // ----------------------------------------------------------- settings

  api.get('/settings', (req, res) => {
    keyFor(req);
    res.json(vault.getSettings());
  });

  api.put('/settings', json, (req, res) => {
    keyFor(req);
    const settings = vault.updateSettings(req.body);
    res.json({ settings, expiresAt: sessions.expiresAt() });
  });

  api.post('/account/change-password', json, async (req, res) => {
    keyFor(req);
    const current = requireString(req.body?.current, 'Current password', 1024);
    const next = requireString(req.body?.next, 'New password', 1024);
    const credential = checkCredential(next, req.body?.type);
    if (current === next) throw new HttpError(400, 'The new one must be different');
    await vault.changePassword(current, next, credential);
    if (isShortCredential(credential)) quick.disarm();
    res.json({ ok: true, credential });
  });

  // -------------------------------------------------------------- audit

  api.get('/audit', (req, res) => {
    res.json(buildAuditReport(vault.listEntries(keyFor(req)), vault.getSettings()));
  });

  let breachRun: Promise<unknown> | null = null;
  api.post('/audit/breaches', json, async (req, res) => {
    const key = keyFor(req);
    if (!vault.getSettings().breachCheckEnabled) {
      throw new HttpError(400, 'Breach checking is turned off. Enable it in Settings first.', 'DISABLED');
    }
    if (breachRun) throw new HttpError(429, 'A breach check is already running');
    const only = Array.isArray(req.body?.ids) ? new Set(req.body.ids as string[]) : null;
    const targets = vault
      .listEntries(key)
      .filter((e) => e.type === 'login' && e.password && (!only || only.has(e.id)))
      .map((e) => ({ id: e.id, password: e.password }));
    let results: Map<string, number>;
    try {
      breachRun = checkBreaches(targets, fetchRange);
      results = (await breachRun) as Map<string, number>;
    } catch (err) {
      throw new HttpError(502, `Breach check failed: ${(err as Error).message}`, 'NETWORK');
    } finally {
      breachRun = null;
    }
    const liveKey = keyFor(req, false); // the session may have locked while we were waiting on the network
    const checkedAt = Date.now();
    vault.store.transaction(() => {
      for (const t of targets) {
        if (!vault.store.get('entries', t.id)) continue; // deleted while the lookup was in flight
        const current = vault.getEntry(liveKey, t.id);
        // Skip entries whose password changed while the lookup was in flight.
        if (current.password === t.password && results.has(t.id)) {
          vault.patchEntryData(liveKey, t.id, { breach: { count: results.get(t.id)!, checkedAt } });
        }
      }
    });
    res.json(buildAuditReport(vault.listEntries(liveKey), vault.getSettings()));
  });

  // ------------------------------------------------------ import/export

  api.post('/export', json, async (req, res) => {
    keyFor(req);
    const format = req.body?.format as ExportFormat;
    if (!['encrypted', 'json', 'csv'].includes(format)) throw new HttpError(400, 'Unknown export format');
    const master = requireString(req.body?.masterPassword, 'Master password', 1024);
    if (!(await vault.verifyPassword(master))) throw new HttpError(401, 'Incorrect master password', 'BAD_PASSWORD');
    if (format === 'encrypted' && !req.body?.exportPassword && isShortCredential(vault.credential())) {
      // A backup file protected only by a short PIN or pattern would be trivial to open once copied.
      throw new HttpError(400, 'Choose a file password for the backup (at least 10 characters).', 'NEEDS_EXPORT_PASSWORD');
    }
    const exportPassword = format === 'encrypted' ? (req.body?.exportPassword || master) : undefined;
    if (format === 'encrypted' && typeof exportPassword === 'string' && exportPassword !== master) {
      if (exportPassword.length < MIN_MASTER_LENGTH) {
        throw new HttpError(400, `Export password must be at least ${MIN_MASTER_LENGTH} characters`);
      }
    }
    res.json(await exportVault(vault, keyFor(req), format, exportPassword));
  });

  api.post('/import', bigJson, async (req, res) => {
    keyFor(req);
    const content = requireString(req.body?.content, 'File content', 90_000_000);
    const password = typeof req.body?.password === 'string' && req.body.password ? req.body.password : undefined;
    // importVault awaits key derivation for encrypted files before it touches the vault key,
    // so hand it a getter that re-validates the session at that point.
    res.json(await importVault(vault, () => keyFor(req, false), content, password));
  });

  // ------------------------------------------------------------- errors

  api.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  return api;
}
