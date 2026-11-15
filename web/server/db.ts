import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Per-user config folder: never the project folder, never synced by default. */
export function configDir(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Keys');
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Keys');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'keys');
}

/** Where the database lives until the user connects one somewhere else (see storage.ts). */
export const DB_FILE = path.join(configDir(), 'Keys.sqlite');

export interface Row {
  id: string;
  blob: Uint8Array;
  created_at: number;
  updated_at: number;
  /** Entries only: when it was moved to Recently deleted, or null. */
  deleted_at?: number | null;
}

const MIGRATIONS: string[] = [
  `CREATE TABLE meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );
   CREATE TABLE entries (
     id         TEXT PRIMARY KEY,
     blob       BLOB NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE categories (
     id         TEXT PRIMARY KEY,
     blob       BLOB NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );`,
  // Recently deleted: an item stays (encrypted, as before) until it's deleted for good.
  `ALTER TABLE entries ADD COLUMN deleted_at INTEGER;`,
];

export type Table = 'entries' | 'categories';
const columns = (table: Table) => (table === 'entries' ? 'id, blob, created_at, updated_at, deleted_at' : 'id, blob, created_at, updated_at');

/** Stamped into every Keys database (PRAGMA application_id) so files can be recognised. 'KEYS'. */
export const APP_ID = 0x4b455953;
const TABLES = ['meta', 'entries', 'categories'];
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

/**
 * Checks that a file is safe to open as a Keys database without changing it:
 * an empty file, a fresh SQLite file with no tables, or one with Keys' tables.
 * Throws a readable message otherwise.
 */
export function inspectDatabase(file: string): { empty: boolean } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new Error('That file doesn’t exist, or this app can’t see it');
  }
  if (!stat.isFile()) throw new Error('That’s a folder, not a database file');
  try {
    fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    throw new Error('Keys can’t read and write that file. Check its permissions');
  }
  if (stat.size === 0) return { empty: true };
  const head = Buffer.alloc(16);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (!head.equals(SQLITE_HEADER)) {
    throw new Error('That isn’t a SQLite database. If it’s in iCloud or Google Drive, make sure it’s downloaded to this device');
  }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (tables.length === 0) return { empty: true };
    if (!TABLES.every((t) => tables.includes(t))) throw new Error('That SQLite file isn’t a Keys database');
    if (version > MIGRATIONS.length) throw new Error('That database was made by a newer version of Keys');
    const check = db.prepare('PRAGMA quick_check').get() as { quick_check: string };
    if (check.quick_check !== 'ok') throw new Error('That database file is damaged');
    return { empty: false };
  } catch (err) {
    if (err instanceof Error && !/^SQLITE|database disk image/i.test(err.message)) throw err;
    throw new Error('That database file is damaged or still syncing');
  } finally {
    db.close();
  }
}

/**
 * Thin wrapper over SQLite. Only ciphertext, ids, timestamps and
 * non-secret settings ever reach this layer.
 */
export class Store {
  private conn: DatabaseSync;

  readonly file: string;

  /** Bumped every time the file is re-read because another device changed it. */
  revision = 0;

  /** Called after the file was re-read (Storage passes this on, so the app can react). */
  onReload: (() => void) | null = null;

  /** The file as Keys last read or wrote it: anything else means another device changed it. */
  private seen: { ino: number; dev: number; size: number; mtimeMs: number } | null = null;

  get db(): DatabaseSync {
    return this.conn;
  }

  /**
   * `file` is the default DB_FILE or one the user connected; tests pass ':memory:'
   * so they never write to disk. Only the default location's folder is created.
   */
  constructor(file: string = DB_FILE) {
    this.file = file;
    if (file === DB_FILE) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.conn = Store.connect(file);
    this.migrate();
    if ((this.db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id !== APP_ID) {
      this.db.exec(`PRAGMA application_id = ${APP_ID}`);
    }
    if (file !== ':memory:') {
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        /* some synced folders don't support permissions; the contents are encrypted anyway */
      }
    }
    this.remember();
  }

  private static connect(file: string): DatabaseSync {
    // Wait (up to 5 s) for another program holding the file briefly, instead of failing at once.
    const db = new DatabaseSync(file, { timeout: 5000 });
    // Rollback journal rather than WAL: committed data lives only in the .sqlite file,
    // with no persistent -wal/-shm side files (which sync services handle badly).
    db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA secure_delete = ON;
    `);
    return db;
  }

  // ------------------------------------------------------------- shared files
  //
  // The same file can be used from several computers through a synced folder (Google Drive,
  // iCloud Drive, Dropbox). When another computer saves, the sync app replaces the file here.
  // Keys must then read the new file, never keep showing (or writing to) the old one.

  private stat(): fs.Stats | null {
    if (this.file === ':memory:') return null;
    try {
      return fs.statSync(this.file);
    } catch {
      return null; // mid-replace, or the folder went offline: keep the open copy for now
    }
  }

  private remember(): void {
    const s = this.stat();
    this.seen = s ? { ino: s.ino, dev: s.dev, size: s.size, mtimeMs: s.mtimeMs } : null;
  }

  /** Whether the file changed since Keys last read or wrote it. */
  changedOnDisk(): boolean {
    const s = this.stat();
    if (!s || !this.seen) return false;
    return s.ino !== this.seen.ino || s.dev !== this.seen.dev || s.size !== this.seen.size || s.mtimeMs !== this.seen.mtimeMs;
  }

  /**
   * Re-reads the file if another device changed it. Every read and save checks first (a file
   * check costs microseconds), so Keys never shows or edits an old copy.
   */
  refresh(): boolean {
    if (this.file === ':memory:' || this.conn.isTransaction) return false;
    if (!this.changedOnDisk()) return false;
    let next: DatabaseSync;
    try {
      next = Store.connect(this.file);
      next.prepare('SELECT count(*) FROM meta').get(); // a half-synced file fails here: keep the old one
    } catch {
      return false;
    }
    this.conn.close();
    this.conn = next;
    this.remember(); // first: migrating saves, and a save checks for changes again
    this.migrate(); // the other computer may run an older Keys
    this.remember();
    this.revision++;
    this.onReload?.();
    return true;
  }

  /** Before a save: pick up other devices' changes first. After: note the file as ours. */
  private write<T>(run: () => T): T {
    if (!this.conn.isTransaction) this.refresh();
    const result = run();
    if (!this.conn.isTransaction) this.remember();
    return result;
  }

  /** Removes every item, category, setting and key, then compacts the file so nothing lingers in free pages. */
  wipe(): void {
    this.transaction(() => {
      for (const table of ['entries', 'categories', 'meta']) this.db.exec(`DELETE FROM ${table}`);
    });
    // The data is already gone; a failed compaction (disk full, busy) mustn't turn that into an error.
    try {
      this.db.exec('VACUUM');
    } catch (err) {
      console.warn('Compacting after erase failed:', err instanceof Error ? err.message : 'unknown');
    }
    this.remember();
  }

  /** The file was there and now isn't (deleted, or moved away by a sync app): SQLite would keep
   *  serving the unlinked copy and refuse every save, so Storage drops this store instead. */
  vanished(): boolean {
    return this.file !== ':memory:' && this.seen !== null && !fs.existsSync(this.file);
  }

  /** Writes a compact, consistent copy of the whole database to `file` (which must not exist). */
  copyTo(file: string): void {
    this.refresh(); // the newest version: a sync app may have replaced the file since it was last read
    this.db.prepare('VACUUM INTO ?').run(file);
  }

  private migrate(): void {
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  transaction<T>(fn: () => T): T {
    this.refresh();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      this.remember();
      return result;
    } catch (err) {
      // SQLite may already have rolled back (disk full, I/O error); don't hide the real error.
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getMeta(key: string): string | null {
    this.refresh();
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.write(() =>
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value),
    );
  }

  deleteMeta(key: string): void {
    this.write(() => this.db.prepare('DELETE FROM meta WHERE key = ?').run(key));
  }

  all(table: Table): Row[] {
    this.refresh();
    return this.db.prepare(`SELECT ${columns(table)} FROM ${table} ORDER BY created_at`).all() as unknown as Row[];
  }

  get(table: Table, id: string): Row | null {
    this.refresh();
    const row = this.db.prepare(`SELECT ${columns(table)} FROM ${table} WHERE id = ?`).get(id);
    return (row as unknown as Row | undefined) ?? null;
  }

  /** Moves an entry into or out of Recently deleted. */
  setDeleted(id: string, at: number | null): boolean {
    const res = this.write(() => this.db.prepare('UPDATE entries SET deleted_at = ? WHERE id = ?').run(at, id));
    return Number(res.changes) > 0;
  }

  insert(table: Table, row: Row): void {
    this.write(() =>
      this.db.prepare(`INSERT INTO ${table} (id, blob, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(row.id, row.blob, row.created_at, row.updated_at),
    );
  }

  /** Writes a row exactly as given (merging a conflict copy): inserted, or replacing the one with its id. */
  putRaw(table: Table, row: Row): void {
    this.write(() => {
      if (table === 'entries') {
        this.db
          .prepare('INSERT OR REPLACE INTO entries (id, blob, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?)')
          .run(row.id, row.blob, row.created_at, row.updated_at, row.deleted_at ?? null);
      } else {
        this.db.prepare('INSERT OR REPLACE INTO categories (id, blob, created_at, updated_at) VALUES (?, ?, ?, ?)').run(row.id, row.blob, row.created_at, row.updated_at);
      }
    });
  }

  update(table: Table, id: string, blob: Uint8Array, updatedAt: number): boolean {
    const res = this.write(() => this.db.prepare(`UPDATE ${table} SET blob = ?, updated_at = ? WHERE id = ?`).run(blob, updatedAt, id));
    return Number(res.changes) > 0;
  }

  delete(table: Table, id: string): boolean {
    const res = this.write(() => this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id));
    return Number(res.changes) > 0;
  }

  close(): void {
    this.db.close();
  }
}
