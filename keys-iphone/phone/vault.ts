// Reads a Keys.sqlite file and decrypts it in the browser, exactly as keys-web's server does (server/vault.ts).
// Read-only: nothing here ever writes to the file.
import { argon2id } from 'hash-wasm';
import type { Database, SqlJsStatic } from 'sql.js';
import type { Credential, EntryData } from '../shared/types.ts';

// Must match keys-web/server/vault.ts and crypto.ts byte for byte.
const DEK_AAD = 'vaultx:dek:v1';
const entryAad = (id: string) => `vaultx:entry:${id}`;
const categoryAad = (id: string) => `vaultx:category:${id}`;
const APP_ID = 0x4b455953; // PRAGMA application_id of a Keys database ("KEYS")

export interface Kdf {
  algorithm: 'argon2id';
  memory: number;
  passes: number;
  parallelism: number;
  salt: string;
}

export interface PhoneEntry extends EntryData {
  id: string;
  updatedAt: number;
}

export interface PhoneCategory {
  id: string;
  name: string;
}

export interface LockedVault {
  credential: Credential;
  kdf: Kdf;
  wrapped: Uint8Array;
  entries: { id: string; blob: Uint8Array; updatedAt: number }[];
  categories: { id: string; blob: Uint8Array }[];
}

export class WrongCredential extends Error {
  constructor() {
    super('Wrong password');
  }
}

/** Same bounds as the server: a crafted file mustn't make the phone allocate gigabytes. */
function isValidKdf(raw: unknown): raw is Kdf {
  const k = (raw ?? {}) as Partial<Kdf>;
  return (
    k.algorithm === 'argon2id' &&
    Number.isInteger(k.memory) && k.memory! >= 8192 && k.memory! <= 1_048_576 &&
    Number.isInteger(k.passes) && k.passes! >= 1 && k.passes! <= 10 &&
    Number.isInteger(k.parallelism) && k.parallelism! >= 1 && k.parallelism! <= 16 &&
    typeof k.salt === 'string' && k.salt.length >= 16 && k.salt.length <= 128
  );
}

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Opens the file and pulls out what unlocking needs. Throws if it isn't a Keys database. */
export function readVault(SQL: SqlJsStatic, bytes: Uint8Array): LockedVault {
  let db: Database;
  try {
    db = new SQL.Database(bytes);
  } catch {
    throw new Error('That file isn’t a Keys database');
  }
  try {
    const one = (sql: string) => db.exec(sql)[0]?.values ?? [];
    const appId = one('PRAGMA application_id')[0]?.[0];
    const meta = new Map(one('SELECT key, value FROM meta') as [string, string][]);
    if (appId !== APP_ID || !meta.get('wrapped_key')) throw new Error('That file isn’t a Keys database, or it has no vault yet');
    const kdf: unknown = JSON.parse(meta.get('kdf') ?? 'null');
    if (!isValidKdf(kdf)) throw new Error('This database has invalid key settings');
    return {
      credential: JSON.parse(meta.get('credential') ?? '{"type":"password"}') as Credential,
      kdf,
      wrapped: b64(meta.get('wrapped_key')!),
      entries: (one('SELECT id, blob, updated_at FROM entries WHERE deleted_at IS NULL') as [string, Uint8Array, number][]).map(
        ([id, blob, updatedAt]) => ({ id, blob, updatedAt }),
      ),
      categories: (one('SELECT id, blob FROM categories') as [string, Uint8Array][]).map(([id, blob]) => ({ id, blob })),
    };
  } finally {
    db.close();
  }
}

/** AES-256-GCM, server layout: version(1) | nonce(12) | tag(16) | ciphertext. */
async function open(key: CryptoKey, blob: Uint8Array, aad: string): Promise<Uint8Array> {
  if (blob.length < 29 || blob[0] !== 1) throw new Error('Decryption failed');
  const nonce = blob.slice(1, 13);
  const tag = blob.subarray(13, 29);
  const ct = blob.subarray(29);
  const sealed = new Uint8Array(ct.length + 16); // WebCrypto wants ciphertext followed by the tag
  sealed.set(ct);
  sealed.set(tag, ct.length);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode(aad), tagLength: 128 },
    key,
    sealed,
  );
  return new Uint8Array(plain);
}

const aesKey = (raw: Uint8Array) => crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, 'AES-GCM', false, ['decrypt']);

/** Argon2id with the vault's settings. The app runs this in a worker (kdf.worker.ts) so the page never freezes. */
export type Derive = (password: string, kdf: Kdf) => Promise<Uint8Array>;

export const deriveKek: Derive = (password, kdf) =>
  argon2id({
    password: password.normalize('NFKC'),
    salt: b64(kdf.salt),
    memorySize: kdf.memory,
    iterations: kdf.passes,
    parallelism: kdf.parallelism,
    hashLength: 32,
    outputType: 'binary',
  });

/** Master credential → Argon2id → KEK → unwraps the vault key (DEK), kept non-extractable. */
export async function unlock(vault: LockedVault, credential: string, derive: Derive = deriveKek): Promise<CryptoKey> {
  const kek = await derive(credential, vault.kdf);
  let dek: Uint8Array;
  try {
    dek = await open(await aesKey(kek), vault.wrapped, DEK_AAD);
  } catch {
    throw new WrongCredential();
  } finally {
    kek.fill(0);
  }
  try {
    return await aesKey(dek);
  } finally {
    dek.fill(0);
  }
}

const json = <T>(bytes: Uint8Array): T => JSON.parse(new TextDecoder().decode(bytes)) as T;

/** Decrypts every live item. An item that fails (e.g. half-synced) is skipped, not fatal. */
export async function decryptAll(vault: LockedVault, key: CryptoKey): Promise<{ entries: PhoneEntry[]; categories: PhoneCategory[] }> {
  const entries: PhoneEntry[] = [];
  for (const row of vault.entries) {
    try {
      entries.push({ ...json<EntryData>(await open(key, row.blob, entryAad(row.id))), id: row.id, updatedAt: row.updatedAt });
    } catch {
      /* skip */
    }
  }
  const categories: PhoneCategory[] = [];
  for (const row of vault.categories) {
    try {
      categories.push({ id: row.id, name: json<{ name: string }>(await open(key, row.blob, categoryAad(row.id))).name });
    } catch {
      /* skip */
    }
  }
  entries.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  return { entries, categories };
}
