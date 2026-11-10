import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the database lives until the user connects one somewhere else (see storage.ts). */
export const DB_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'database.sqlite');

export interface Row {
  id: string;
  blob: Uint8Array;
  created_at: number;
  updated_at: number;
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
];

export type Table = 'entries' | 'categories';

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
  readonly db: DatabaseSync;

  readonly file: string;

  /**
   * `file` is the default DB_FILE or one the user connected; tests pass ':memory:'
   * so they never write to disk. Only the default location's folder is created.
   */
  constructor(file: string = DB_FILE) {
    this.file = file;
    if (file === DB_FILE) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    // Rollback journal rather than WAL: committed data lives only in database.sqlite,
    // with no persistent -wal/-shm side files. The -journal file exists only mid-transaction.
    this.db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA secure_delete = ON;
    `);
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
  }

  /** Removes every item, category, setting and key, then compacts the file so nothing lingers in free pages. */
  wipe(): void {
    this.transaction(() => {
      for (const table of ['entries', 'categories', 'meta']) this.db.exec(`DELETE FROM ${table}`);
    });
    this.db.exec('VACUUM');
  }

  /** Writes a compact, consistent copy of the whole database to `file` (which must not exist). */
  copyTo(file: string): void {
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
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  deleteMeta(key: string): void {
    this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
  }

  all(table: Table): Row[] {
    return this.db.prepare(`SELECT id, blob, created_at, updated_at FROM ${table} ORDER BY created_at`).all() as unknown as Row[];
  }

  get(table: Table, id: string): Row | null {
    const row = this.db.prepare(`SELECT id, blob, created_at, updated_at FROM ${table} WHERE id = ?`).get(id);
    return (row as unknown as Row | undefined) ?? null;
  }

  insert(table: Table, row: Row): void {
    this.db
      .prepare(`INSERT INTO ${table} (id, blob, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(row.id, row.blob, row.created_at, row.updated_at);
  }

  update(table: Table, id: string, blob: Uint8Array, updatedAt: number): boolean {
    const res = this.db.prepare(`UPDATE ${table} SET blob = ?, updated_at = ? WHERE id = ?`).run(blob, updatedAt, id);
    return Number(res.changes) > 0;
  }

  delete(table: Table, id: string): boolean {
    const res = this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    return Number(res.changes) > 0;
  }

  close(): void {
    this.db.close();
  }
}
