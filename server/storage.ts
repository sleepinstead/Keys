import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir, DB_FILE, inspectDatabase, Store } from './db.ts';

export { configDir };
import { HttpError } from './validate.ts';
import type { StorageInfo } from '../shared/types.ts';

/**
 * Which SQLite file Keys uses. The user can connect a file anywhere they can
 * reach from this device (a local folder, iCloud Drive, Google Drive set to keep
 * files downloaded, a USB stick). Only the file's *path* is remembered, in a tiny
 * pointer file in the OS's per-user config folder, so the choice survives restarts
 * and doesn't depend on the project folder. Everything else lives in the database.
 */

export const POINTER_FILE = path.join(configDir(), 'location.json');

/** Accepts ~/…, quoted paths and file:// URLs pasted from Finder. Always returns an absolute path. */
export function normalizePath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new HttpError(400, 'Enter the database file’s location');
  let p = raw.trim().replace(/^(['"])(.*)\1$/, '$2');
  if (p.startsWith('file://')) {
    try {
      p = decodeURIComponent(new URL(p).pathname);
    } catch {
      throw new HttpError(400, 'That location isn’t valid');
    }
  }
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  if (!path.isAbsolute(p)) throw new HttpError(400, 'Use the full location, starting with / or ~/');
  if (p.length > 4096 || p.includes('\0')) throw new HttpError(400, 'That location isn’t valid');
  return path.normalize(p);
}

const NO_DB = 'NO_DATABASE';

export class Storage {
  private current: Store | null = null;
  private file: string;
  private error: string | null = null;
  private readonly pointer: string | null;
  private readonly defaultFile: string;

  /**
   * `memory` (tests) uses an in-memory database and never reads or writes the pointer.
   * Otherwise the pointer chooses the file, falling back to the default location.
   */
  constructor(opts: { memory?: boolean; pointerFile?: string | null; defaultFile?: string } = {}) {
    // In memory (tests), "the built-in location" is memory too, so nothing ever touches the disk.
    this.defaultFile = opts.memory ? ':memory:' : (opts.defaultFile ?? DB_FILE);
    if (opts.memory) {
      this.pointer = null;
      this.file = ':memory:';
      this.current = new Store(':memory:');
      return;
    }
    this.pointer = opts.pointerFile === undefined ? POINTER_FILE : opts.pointerFile;
    this.file = this.readPointer() ?? this.defaultFile;
    this.open();
  }

  /** The open database. Throws a clear 503 when the file can't be reached (e.g. a cloud folder that isn't synced). */
  get store(): Store {
    if (!this.current) throw new HttpError(503, this.error ?? 'The database isn’t available', NO_DB);
    return this.current;
  }

  get available(): boolean {
    return this.current !== null;
  }

  info(): StorageInfo {
    let size: number | null = null;
    try {
      if (this.file !== ':memory:') size = fs.statSync(this.file).size;
    } catch {
      /* missing */
    }
    return {
      path: this.file,
      isDefault: this.file === this.defaultFile || this.file === ':memory:',
      available: this.available,
      error: this.error,
      size,
      canBrowse: process.platform === 'darwin',
    };
  }

  /** Tries the current file again (after iCloud finishes downloading it, say). */
  retry(): StorageInfo {
    if (!this.current) this.open();
    if (!this.current) throw new HttpError(503, this.error!, NO_DB);
    return this.info();
  }

  /** Switches to an existing file. An empty or brand-new file gets Keys' tables. */
  connect(raw: unknown): StorageInfo {
    const file = normalizePath(raw);
    if (file === this.file && this.current) return this.info();
    try {
      inspectDatabase(file);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : 'That file can’t be used');
    }
    this.switchTo(file);
    return this.info();
  }

  /** Creates a new, empty database at `raw` (which must not exist yet) and connects it. */
  create(raw: unknown): StorageInfo {
    const file = this.newFilePath(raw);
    try {
      new Store(file).close();
    } catch {
      throw new HttpError(400, 'Keys couldn’t create a file there. Check the folder’s permissions');
    }
    this.switchTo(file);
    return this.info();
  }

  /** Copies the open database to `raw` (which must not exist yet) and continues from the copy. */
  move(raw: unknown): StorageInfo {
    const file = this.newFilePath(raw);
    try {
      this.store.copyTo(file);
      inspectDatabase(file);
    } catch (err) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* nothing written */
      }
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, 'Keys couldn’t write the copy there. Check the folder and free space');
    }
    this.switchTo(file);
    return this.info();
  }

  /** Back to the default file inside the app folder. */
  useDefault(): StorageInfo {
    this.switchTo(this.defaultFile);
    return this.info();
  }

  /** A brand-new, empty Keys database as bytes, for "Download a new database". */
  static template(): Buffer {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-'));
    const file = path.join(dir, 'keys.sqlite');
    try {
      new Store(file).close();
      return fs.readFileSync(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  close(): void {
    this.current?.close();
    this.current = null;
  }

  // ------------------------------------------------------------- internal

  private newFilePath(raw: unknown): string {
    let file = normalizePath(raw);
    if (!/\.(sqlite3?|db)$/i.test(file)) file += '.sqlite';
    if (fs.existsSync(file)) throw new HttpError(409, 'A file with that name already exists there. Pick another name, or connect it instead');
    let dir: fs.Stats;
    try {
      dir = fs.statSync(path.dirname(file));
    } catch {
      throw new HttpError(400, 'That folder doesn’t exist');
    }
    if (!dir.isDirectory()) throw new HttpError(400, 'That folder doesn’t exist');
    return file;
  }

  private open(): void {
    this.current = null;
    this.error = null;
    try {
      if (this.file !== this.defaultFile) inspectDatabase(this.file);
      this.current = new Store(this.file);
    } catch (err) {
      this.error =
        (err instanceof Error ? err.message : 'The database can’t be opened') +
        (this.file === this.defaultFile ? '' : '. If it’s in iCloud Drive or Google Drive, check it’s downloaded to this device.');
    }
  }

  private switchTo(file: string): void {
    const next = new Store(file); // throws before anything changes if it can't be opened
    this.current?.close();
    this.current = next;
    this.file = file;
    this.error = null;
    this.writePointer(file === this.defaultFile ? null : file);
  }

  private readPointer(): string | null {
    if (!this.pointer) return null;
    try {
      const { path: p } = JSON.parse(fs.readFileSync(this.pointer, 'utf8')) as { path?: unknown };
      return typeof p === 'string' && path.isAbsolute(p) ? p : null;
    } catch {
      return null;
    }
  }

  private writePointer(file: string | null): void {
    if (!this.pointer) return;
    if (file === null) {
      fs.rmSync(this.pointer, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(this.pointer), { recursive: true, mode: 0o700 });
    const tmp = `${this.pointer}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ path: file }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.pointer);
  }
}

/**
 * Native macOS file dialogs via AppleScript, so the user can pick a file in
 * Finder (iCloud Drive and Google Drive included) instead of typing a path.
 * Returns null if they cancel.
 */
export function browse(mode: 'open' | 'save'): Promise<string | null> {
  if (process.platform !== 'darwin') return Promise.reject(new HttpError(501, 'Browsing is only available on macOS. Paste the file’s location instead'));
  const script =
    mode === 'open'
      ? 'POSIX path of (choose file with prompt "Choose your Keys database")'
      : 'POSIX path of (choose file name with prompt "Save the Keys database as" default name "Keys.sqlite")';
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', 'tell application "System Events" to activate', '-e', script], { timeout: 10 * 60_000 }, (err, stdout, stderr) => {
      if (err) {
        if (/-128|User canceled/i.test(stderr)) return resolve(null);
        return reject(new HttpError(500, 'The file dialog couldn’t be opened'));
      }
      resolve(stdout.trim() || null);
    });
  });
}
