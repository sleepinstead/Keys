import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { APP_ID, configDir } from './db.ts';
import type { Row, Store, Table } from './db.ts';
import type { OtherDevice, SyncConflict } from '../../shared/types.ts';

/**
 * Using one database file from several computers through a synced folder (Google Drive,
 * iCloud Drive, Dropbox, OneDrive).
 *
 * Presence: each computer with Keys open keeps a tiny marker file next to the database
 * (".Keys.sqlite.open-<device>.json": a name and a timestamp, nothing secret), refreshed every
 * minute and removed on exit, so the others can say "Also open on Windows PC".
 *
 * Conflict copies: when two computers save before the sync app catches up, it keeps both, e.g.
 * "Keys (1).sqlite" or "Keys (Armaan's conflicted copy).sqlite". Rows are encrypted with the
 * same vault key on every device, so a copy of the same vault can be merged row by row without
 * decrypting anything: for each item, the most recent version wins.
 */

const BEAT_MS = 60_000;
const STALE_MS = 4 * 60_000;

interface Marker {
  device: string;
  name: string;
  platform: string;
  at: number;
}

/** This computer's id, kept in the (unsynced) config folder so it's stable across restarts. */
function deviceId(): string {
  const file = path.join(configDir(), 'device.json');
  try {
    const { id } = JSON.parse(fs.readFileSync(file, 'utf8')) as { id?: unknown };
    if (typeof id === 'string' && /^[a-f0-9]{16}$/.test(id)) return id;
  } catch {
    /* first run */
  }
  const id = crypto.randomBytes(8).toString('hex');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ id }), { mode: 0o600 });
  } catch {
    /* not writable: a fresh id each run is still fine */
  }
  return id;
}

const PLATFORMS: Record<string, string> = { darwin: 'Mac', win32: 'Windows', linux: 'Linux' };

/** A friendly name for this computer, e.g. "Armaans-MacBook-Air" → "Armaans MacBook Air". */
function deviceName(): string {
  const host = os.hostname().replace(/\.local$/i, '').replace(/[-_]+/g, ' ').trim();
  return (host || PLATFORMS[process.platform] || 'Computer').slice(0, 60);
}

const markerPrefix = (dbFile: string) => `.${path.basename(dbFile)}.open-`;

export class Presence {
  private readonly id = deviceId();
  private readonly name = deviceName();
  private timer: NodeJS.Timeout | null = null;
  private marked: string | null = null;

  private readonly file: () => string | null;

  /** `file()` is the database in use right now; nothing is written for the built-in location or in tests. */
  constructor(file: () => string | null) {
    this.file = file;
  }

  start(): void {
    this.beat();
    this.timer = setInterval(() => this.beat(), BEAT_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.clear();
  }

  private markerFor(dbFile: string): string {
    return path.join(path.dirname(dbFile), `${markerPrefix(dbFile)}${this.id}.json`);
  }

  private clear(): void {
    if (!this.marked) return;
    try {
      fs.rmSync(this.marked, { force: true });
    } catch {
      /* folder offline */
    }
    this.marked = null;
  }

  /** Writes (or moves, after a file switch) this computer's marker. */
  beat(): void {
    const dbFile = this.file();
    const target = dbFile ? this.markerFor(dbFile) : null;
    if (this.marked && this.marked !== target) this.clear();
    if (!target) return;
    const marker: Marker = { device: this.id, name: this.name, platform: PLATFORMS[process.platform] ?? process.platform, at: Date.now() };
    try {
      fs.writeFileSync(target, JSON.stringify(marker));
      this.marked = target;
    } catch {
      /* folder offline or read-only: just don't announce */
    }
  }

  /** Other computers that have this database open (seen in the last few minutes). */
  others(): OtherDevice[] {
    const dbFile = this.file();
    if (!dbFile) return [];
    const dir = path.dirname(dbFile);
    const prefix = markerPrefix(dbFile);
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => n.startsWith(prefix) && n.endsWith('.json'));
    } catch {
      return [];
    }
    const now = Date.now();
    const out: OtherDevice[] = [];
    for (const n of names) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as Partial<Marker>;
        if (m.device === this.id || typeof m.at !== 'number' || typeof m.name !== 'string') continue;
        if (now - m.at > STALE_MS) continue;
        out.push({ name: m.name.slice(0, 60), platform: String(m.platform ?? '').slice(0, 20), lastSeenAt: m.at });
      } catch {
        /* half-synced marker */
      }
    }
    return out.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }
}

// ---------------------------------------------------------------- conflict copies

/** The vault a database belongs to: set once at setup, the same in every copy of it. */
function vaultIdOf(db: DatabaseSync): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'created_at'").get() as { value: string } | undefined;
  return row?.value ?? null;
}

/**
 * Copies of this database the sync app left beside it: same folder, name starting with this
 * file's name, a Keys database of the same vault. Anything else is ignored.
 */
export function findConflicts(store: Store): SyncConflict[] {
  if (store.file === ':memory:') return [];
  const dir = path.dirname(store.file);
  const base = path.basename(store.file);
  const stem = base.replace(/\.sqlite$/i, '');
  const ours = vaultIdOf(store.db);
  if (!ours) return [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: SyncConflict[] = [];
  for (const name of names) {
    if (name === base || !name.startsWith(stem) || !/\.sqlite$/i.test(name) || name.startsWith('.')) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size === 0) continue;
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const appId = (db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id;
        if (appId !== APP_ID || vaultIdOf(db) !== ours) continue;
        const { changes } = diff(store, db);
        if (changes === 0) continue; // nothing new in it: not worth asking about
        out.push({ path: file, name, modifiedAt: st.mtimeMs, changes });
      } finally {
        db.close();
      }
    } catch {
      /* not a database, or still syncing */
    }
  }
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

const lastTouched = (r: Row) => Math.max(r.updated_at, r.deleted_at ?? 0);
const COLUMNS: Record<Table, string> = { entries: 'id, blob, created_at, updated_at, deleted_at', categories: 'id, blob, created_at, updated_at' };

/** Rows in `other` that are missing here or newer than ours. */
function diff(store: Store, other: DatabaseSync): { rows: { table: Table; row: Row }[]; changes: number } {
  const rows: { table: Table; row: Row }[] = [];
  let purged = new Set<string>();
  try {
    const list: unknown = JSON.parse(store.getMeta('purged') ?? '[]');
    if (Array.isArray(list)) purged = new Set(list.filter((x): x is string => typeof x === 'string'));
  } catch {
    /* none recorded */
  }
  for (const table of ['categories', 'entries'] as Table[]) {
    for (const row of other.prepare(`SELECT ${COLUMNS[table]} FROM ${table}`).all() as unknown as Row[]) {
      const mine = store.get(table, row.id);
      if (!mine && purged.has(row.id)) continue; // deleted for good here: the copy's older version stays gone
      if (!mine || lastTouched(row) > lastTouched(mine)) rows.push({ table, row });
    }
  }
  return { rows, changes: rows.length };
}

/**
 * Merges a conflict copy into the open database (newest version of each item wins; items only in
 * the copy are added), then renames the copy to *.merged. Only paths that `findConflicts` reported are accepted.
 */
export function mergeConflict(store: Store, file: string): { merged: number } {
  const known = findConflicts(store).find((c) => c.path === file);
  if (!known) throw new Error('That copy is no longer there, or has nothing new');
  const db = new DatabaseSync(file, { readOnly: true });
  let merged = 0;
  try {
    const { rows } = diff(store, db);
    store.transaction(() => {
      for (const { table, row } of rows) store.putRaw(table, row);
    });
    merged = rows.length;
  } finally {
    db.close();
  }
  // Kept, renamed so it isn't offered again: it might be someone's own backup.
  try {
    fs.renameSync(file, `${file}.merged`);
  } catch {
    /* left in place; it has nothing new now, so it isn't offered again */
  }
  return { merged };
}
