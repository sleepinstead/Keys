import crypto from 'node:crypto';
import { Store } from './db.ts';
import type { Row } from './db.ts';
import {
  decrypt,
  decryptJson,
  DecryptionError,
  deriveKey,
  encrypt,
  encryptJson,
  KEY_BYTES,
  isValidKdf,
  newKdfParams,
  randomId,
} from './crypto.ts';
import { HttpError, sanitizeSettings } from './validate.ts';
import { DEFAULT_SETTINGS, isShortCredential } from '../shared/types.ts';
import type { Category, CategoryColor, Credential, Entry, EntryData, EntryInput, EntrySummary, Settings, TrashedEntry } from '../shared/types.ts';

// These labels keep the app's original name on purpose: they are authenticated into every
// ciphertext already on disk, so renaming them would make existing vaults undecryptable.
const DEK_AAD = 'vaultx:dek:v1';
const PIN_AAD = 'vaultx:pin:v1';
const entryAad = (id: string) => `vaultx:entry:${id}`;
const categoryAad = (id: string) => `vaultx:category:${id}`;

const HISTORY_LIMIT = 20;

/** What the list shows: no password, notes or history. */
const summary = (e: Entry): EntrySummary => ({
  id: e.id,
  type: e.type,
  title: e.title,
  username: e.username,
  url: e.url,
  categoryId: e.categoryId,
  favorite: e.favorite,
  icon: e.icon,
  hasPassword: e.password.length > 0,
  createdAt: e.createdAt,
  updatedAt: e.updatedAt,
});
const FREE_ATTEMPTS = 5;
const MAX_LOCKOUT_MS = 15 * 60 * 1000;
export const MIN_MASTER_LENGTH = 10;

const DEFAULT_CATEGORIES = ['Personal', 'Work', 'Finance', 'Social', 'Development'];

export interface EntryExtras {
  createdAt?: number;
  passwordUpdatedAt?: number;
  history?: EntryData['history'];
}

/**
 * Owns the key hierarchy and encrypted records.
 *
 *   master password --Argon2id--> KEK --AES-GCM unwrap--> DEK (random 256-bit vault key)
 *   DEK --AES-GCM--> every entry and category, each bound to its row id via AAD.
 *
 * Changing the master password only re-wraps the DEK.
 */
export class Vault {
  private readonly source: Store | { readonly store: Store };
  private unlocking = false;

  /** Takes a fixed Store, or something whose `store` can change (the user's chosen file). */
  constructor(source: Store | { readonly store: Store }) {
    this.source = source;
  }

  get store(): Store {
    return this.source instanceof Store ? this.source : this.source.store;
  }

  // ---------------------------------------------------------------- keys

  isInitialized(): boolean {
    return this.store.getMeta('wrapped_key') !== null;
  }

  /** Password or PIN. Not secret; the lock screen needs it to show the right input. */
  credential(): Credential {
    const raw = this.store.getMeta('credential');
    return raw ? (JSON.parse(raw) as Credential) : { type: 'password' };
  }

  async setup(password: string, credential: Credential = { type: 'password' }): Promise<Buffer> {
    if (this.isInitialized()) throw new HttpError(409, 'Setup is already done');
    const store = this.store; // the file this setup is for, even if another is connected meanwhile
    const dek = crypto.randomBytes(KEY_BYTES);
    const kdf = newKdfParams(isShortCredential(credential) ? 'pin' : 'password');
    const kek = await deriveKey(password, kdf);
    try {
      const wrapped = encrypt(kek, dek, DEK_AAD);
      const now = Date.now();
      if (this.store !== store) throw new HttpError(409, 'The database changed during setup. Start again.');
      this.store.transaction(() => {
        // Checked again here: a second setup may have finished during key derivation.
        if (this.isInitialized()) throw new HttpError(409, 'Setup is already done');
        this.store.setMeta('kdf', JSON.stringify(kdf));
        this.store.setMeta('wrapped_key', wrapped.toString('base64'));
        this.store.setMeta('credential', JSON.stringify(credential));
        this.store.setMeta('settings', JSON.stringify(DEFAULT_SETTINGS));
        this.store.setMeta('created_at', String(now));
        DEFAULT_CATEGORIES.forEach((name, i) => this.insertCategory(dek, name, now + i));
      });
      return dek;
    } finally {
      kek.fill(0);
    }
  }

  lockoutUntil(): number | null {
    const until = Number(this.store.getMeta('lockout_until') ?? 0);
    return until > Date.now() ? until : null;
  }

  /** Verify the master password and return the vault key. Applies exponential backoff. */
  async unlock(password: string): Promise<Buffer> {
    if (!this.isInitialized()) throw new HttpError(409, 'Setup isn’t finished yet');
    return this.oneGuessAtATime(async () => {
      const dek = await this.unwrap(password);
      if (!dek) {
        this.recordFailure();
        const what = ({ password: 'master password', passphrase: 'passphrase', pin: 'PIN', pattern: 'pattern' } as const)[this.credential().type];
        throw new HttpError(401, `Incorrect ${what}`, 'BAD_PASSWORD');
      }
      this.store.setMeta('failed_attempts', '0');
      this.store.setMeta('lockout_until', '0');
      return dek;
    });
  }

  /** Every password check goes through here, or a burst of parallel guesses would all pass the lockout check. */
  private async oneGuessAtATime<T>(check: () => Promise<T>): Promise<T> {
    if (this.lockoutUntil()) throw new HttpError(429, 'Too many failed attempts. Try again later.', 'LOCKED_OUT');
    if (this.unlocking) throw new HttpError(429, 'An unlock is already in progress');
    this.unlocking = true;
    try {
      return await check();
    } finally {
      this.unlocking = false;
    }
  }

  private async unwrap(password: string): Promise<Buffer | null> {
    const kdf: unknown = JSON.parse(this.store.getMeta('kdf')!);
    if (!isValidKdf(kdf)) throw new HttpError(400, 'This database has invalid key settings');
    const wrapped = Buffer.from(this.store.getMeta('wrapped_key')!, 'base64');
    const kek = await deriveKey(password, kdf);
    try {
      return decrypt(kek, wrapped, DEK_AAD);
    } catch (err) {
      if (err instanceof DecryptionError) return null;
      throw err;
    } finally {
      kek.fill(0);
    }
  }

  private recordFailure(): void {
    const attempts = Number(this.store.getMeta('failed_attempts') ?? 0) + 1;
    this.store.setMeta('failed_attempts', String(attempts));
    if (attempts >= FREE_ATTEMPTS) {
      const delay = Math.min(MAX_LOCKOUT_MS, 5000 * 2 ** (attempts - FREE_ATTEMPTS));
      this.store.setMeta('lockout_until', String(Date.now() + delay));
    }
  }

  /** Confirms the master password without touching lockout state beyond a failure count. */
  async verifyPassword(password: string): Promise<boolean> {
    return this.oneGuessAtATime(async () => {
      const dek = await this.unwrap(password);
      if (!dek) {
        this.recordFailure();
        return false;
      }
      dek.fill(0);
      return true;
    });
  }

  async changePassword(current: string, next: string, credential: Credential = { type: 'password' }): Promise<void> {
    await this.oneGuessAtATime(async () => {
      const dek = await this.unwrap(current);
      if (!dek) {
        this.recordFailure();
        throw new HttpError(401, `Current ${({ password: 'master password', passphrase: 'passphrase', pin: 'PIN', pattern: 'pattern' } as const)[this.credential().type]} is incorrect`, 'BAD_PASSWORD');
      }
      const kdf = newKdfParams(isShortCredential(credential) ? 'pin' : 'password');
      const kek = await deriveKey(next, kdf);
      try {
        const wrapped = encrypt(kek, dek, DEK_AAD);
        this.store.transaction(() => {
          this.store.setMeta('kdf', JSON.stringify(kdf));
          this.store.setMeta('wrapped_key', wrapped.toString('base64'));
          this.store.setMeta('credential', JSON.stringify(credential));
          // A vault opened by a PIN has no use for a second, quick-unlock PIN.
          if (isShortCredential(credential)) this.store.deleteMeta('pin');
        });
      } finally {
        kek.fill(0);
        dek.fill(0);
      }
    });
  }

  // ----------------------------------------------------------------- PIN

  /** Length of the quick-unlock PIN, if one is set. */
  pinLength(): number | null {
    const raw = this.store.getMeta('pin');
    return raw ? (JSON.parse(raw) as { length: number }).length : null;
  }

  /** The PIN is stored only encrypted under the vault key, so the database alone never reveals it. */
  savePin(key: Buffer, pin: string): void {
    const blob = encryptJson(key, { pin }, PIN_AAD).toString('base64');
    this.store.setMeta('pin', JSON.stringify({ length: pin.length, blob }));
  }

  readPin(key: Buffer): string | null {
    const raw = this.store.getMeta('pin');
    if (!raw) return null;
    try {
      const { blob } = JSON.parse(raw) as { blob: string };
      return decryptJson<{ pin: string }>(key, Buffer.from(blob, 'base64'), PIN_AAD).pin;
    } catch (err) {
      if (err instanceof DecryptionError) return null;
      throw err;
    }
  }

  removePin(): void {
    this.store.deleteMeta('pin');
  }

  // ------------------------------------------------------------ settings

  getSettings(): Settings {
    const raw = this.store.getMeta('settings');
    return sanitizeSettings(raw ? JSON.parse(raw) : {}, DEFAULT_SETTINGS);
  }

  updateSettings(patch: unknown): Settings {
    const next = sanitizeSettings(patch, this.getSettings());
    this.store.setMeta('settings', JSON.stringify(next));
    return next;
  }

  // ------------------------------------------------------------- entries

  private readEntry(key: Buffer, row: Row): Entry {
    const data = decryptJson<EntryData>(key, row.blob, entryAad(row.id));
    // Items saved before icons existed have no icon field.
    return { ...data, icon: data.icon ?? '', id: row.id, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  /** Live items only: anything in Recently deleted is left out everywhere except the bin itself. */
  listEntries(key: Buffer): Entry[] {
    return this.store
      .all('entries')
      .filter((row) => !row.deleted_at)
      .map((row) => this.readEntry(key, row));
  }

  listSummaries(key: Buffer): EntrySummary[] {
    return this.listEntries(key).map((e) => summary(e));
  }

  listTrash(key: Buffer): TrashedEntry[] {
    return this.store
      .all('entries')
      .filter((row) => row.deleted_at)
      .map((row) => ({ ...summary(this.readEntry(key, row)), deletedAt: row.deleted_at! }))
      .sort((a, b) => b.deletedAt - a.deletedAt);
  }

  /** Puts items back. One whose category was deleted meanwhile comes back uncategorised. */
  restoreEntries(key: Buffer, ids: string[]): void {
    this.store.transaction(() => {
      for (const id of ids) {
        const row = this.store.get('entries', id);
        if (!row?.deleted_at) throw new HttpError(404, 'That item isn’t in Recently deleted');
        this.store.setDeleted(id, null);
        const { categoryId } = this.readEntry(key, row);
        if (categoryId && !this.store.get('categories', categoryId)) this.patchEntryData(key, id, { categoryId: null });
      }
    });
  }

  /** Deletes items for good. Only items already in Recently deleted can be purged. */
  purgeEntries(ids: string[]): void {
    this.store.transaction(() => {
      for (const id of ids) {
        if (!this.store.get('entries', id)?.deleted_at) throw new HttpError(404, 'That item isn’t in Recently deleted');
        this.store.delete('entries', id);
      }
    });
  }

  getEntry(key: Buffer, id: string): Entry {
    const row = this.store.get('entries', id);
    if (!row || row.deleted_at) throw new HttpError(404, 'Entry not found');
    return this.readEntry(key, row);
  }

  private checkCategory(categoryId: string | null): string | null {
    if (categoryId === null) return null;
    return this.store.get('categories', categoryId) ? categoryId : null;
  }

  createEntry(key: Buffer, input: EntryInput, extras: EntryExtras = {}): Entry {
    const id = randomId();
    const now = Date.now();
    const data: EntryData = {
      ...input,
      categoryId: this.checkCategory(input.categoryId),
      passwordUpdatedAt: extras.passwordUpdatedAt ?? now,
      history: (extras.history ?? []).slice(0, HISTORY_LIMIT),
      breach: null,
    };
    const createdAt = extras.createdAt ?? now;
    this.store.insert('entries', {
      id,
      blob: encryptJson(key, data, entryAad(id)),
      created_at: createdAt,
      updated_at: now,
    });
    return { ...data, id, createdAt, updatedAt: now };
  }

  updateEntry(key: Buffer, id: string, input: EntryInput): Entry {
    const existing = this.getEntry(key, id);
    const now = Date.now();
    const passwordChanged = existing.password !== input.password;
    const history =
      passwordChanged && existing.password
        ? [{ password: existing.password, changedAt: now }, ...existing.history].slice(0, HISTORY_LIMIT)
        : existing.history;
    const data: EntryData = {
      ...input,
      categoryId: this.checkCategory(input.categoryId),
      passwordUpdatedAt: passwordChanged ? now : existing.passwordUpdatedAt,
      history,
      breach: passwordChanged ? null : existing.breach,
      // Kept: its key says whether it still applies, so a stale one is simply re-rated.
      ...(existing.strength ? { strength: existing.strength } : {}),
    };
    // Starring or filing an item isn't editing it: "Last edited" and the Recent order stay put.
    const strip = ({ favorite: _f, categoryId: _c, ...rest }: EntryData) => JSON.stringify(rest);
    const { id: _id, createdAt: _cr, updatedAt: _up, ...before } = existing;
    const updatedAt = strip(before) === strip(data) ? existing.updatedAt : now;
    this.store.update('entries', id, encryptJson(key, data, entryAad(id)), updatedAt);
    return { ...data, id, createdAt: existing.createdAt, updatedAt };
  }

  /** Internal update that doesn't count as a user edit (e.g. caching breach results). */
  patchEntryData(key: Buffer, id: string, patch: Partial<EntryData>, onlyIf?: (current: EntryData) => boolean): void {
    const row = this.store.get('entries', id);
    if (!row) return;
    const { id: _id, createdAt: _c, updatedAt: _u, ...data } = this.readEntry(key, row);
    if (onlyIf && !onlyIf(data)) return;
    this.store.update('entries', id, encryptJson(key, { ...data, ...patch }, entryAad(id)), row.updated_at);
  }

  clearHistory(key: Buffer, id: string): Entry {
    this.getEntry(key, id);
    this.patchEntryData(key, id, { history: [] });
    return this.getEntry(key, id);
  }

  /** Moves an item to Recently deleted. */
  deleteEntry(id: string): void {
    const row = this.store.get('entries', id);
    if (!row || row.deleted_at) throw new HttpError(404, 'Entry not found');
    this.store.setDeleted(id, Date.now());
  }

  // ---------------------------------------------------------- categories

  private insertCategory(key: Buffer, name: string, createdAt = Date.now()): Category {
    const id = randomId();
    this.store.insert('categories', {
      id,
      blob: encryptJson(key, { name, color: null }, categoryAad(id)),
      created_at: createdAt,
      updated_at: createdAt,
    });
    return { id, name, color: null, createdAt };
  }

  listCategories(key: Buffer): Category[] {
    return this.store.all('categories').map((row) => {
      const data = decryptJson<{ name: string; color?: CategoryColor | null }>(key, row.blob, categoryAad(row.id));
      return { id: row.id, name: data.name, color: data.color ?? null, createdAt: row.created_at };
    });
  }

  createCategory(key: Buffer, name: string): Category {
    const existing = this.listCategories(key).find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (existing) throw new HttpError(409, 'A category with that name already exists');
    return this.insertCategory(key, name);
  }

  findOrCreateCategory(key: Buffer, name: string): { category: Category; created: boolean } {
    const existing = this.listCategories(key).find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (existing) return { category: existing, created: false };
    return { category: this.insertCategory(key, name), created: true };
  }

  /** Renames and/or recolours a category; fields left undefined keep their value. */
  updateCategory(key: Buffer, id: string, patch: { name?: string; color?: CategoryColor | null }): Category {
    const current = this.listCategories(key).find((c) => c.id === id);
    if (!current) throw new HttpError(404, 'Category not found');
    const name = patch.name ?? current.name;
    const color = patch.color === undefined ? current.color : patch.color;
    const clash = this.listCategories(key).find((c) => c.id !== id && c.name.toLowerCase() === name.toLowerCase());
    if (clash) throw new HttpError(409, 'A category with that name already exists');
    this.store.update('categories', id, encryptJson(key, { name, color }, categoryAad(id)), Date.now());
    return { id, name, color, createdAt: current.createdAt };
  }

  /** Deletes a category; its entries become uncategorised. */
  deleteCategory(key: Buffer, id: string): void {
    this.store.transaction(() => {
      if (!this.store.delete('categories', id)) throw new HttpError(404, 'Category not found');
      for (const entry of this.listEntries(key)) {
        if (entry.categoryId === id) this.patchEntryData(key, entry.id, { categoryId: null });
      }
    });
  }
}
