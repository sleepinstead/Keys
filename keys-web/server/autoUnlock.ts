import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from './db.ts';

/**
 * "Open without a PIN or password on this computer": the vault key, kept in a private file in
 * this user's config folder (never in the database). The database file on its own, synced or
 * copied elsewhere, still needs the PIN or password. Each saved key is filed under the vault's
 * identity (where the file is, when it was made, and its wrapped key), so connecting another
 * file, or changing the password, never opens with a stale key.
 */
export class AutoUnlock {
  private readonly file: string | null;
  private memory: Record<string, string> = {};

  /** `null` keeps everything in memory (tests). */
  constructor(file: string | null = path.join(configDir(), 'autounlock.json')) {
    this.file = file;
  }

  static id(where: string, createdAt: string | null, wrappedKey: string | null): string | null {
    if (!createdAt || !wrappedKey) return null;
    return crypto.createHash('sha256').update(`${where}\n${createdAt}\n${wrappedKey}`).digest('hex');
  }

  private read(): Record<string, string> {
    if (!this.file) return { ...this.memory };
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return raw && typeof raw === 'object' ? (raw as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  private write(all: Record<string, string>): void {
    if (!this.file) {
      this.memory = all;
      return;
    }
    if (Object.keys(all).length === 0) {
      fs.rmSync(this.file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    fs.chmodSync(this.file, 0o600);
  }

  has(id: string | null): boolean {
    return id !== null && typeof this.read()[id] === 'string';
  }

  /** A copy of the saved key (the caller owns it), or null. */
  get(id: string | null): Buffer | null {
    const v = id ? this.read()[id] : undefined;
    if (typeof v !== 'string') return null;
    const key = Buffer.from(v, 'base64');
    return key.length === 32 ? key : null;
  }

  save(id: string, key: Buffer): void {
    this.write({ ...this.read(), [id]: key.toString('base64') });
  }

  remove(id: string | null): void {
    if (!id) return;
    const all = this.read();
    if (!(id in all)) return;
    delete all[id];
    this.write(all);
  }
}
