import crypto from 'node:crypto';

export interface KdfParams {
  algorithm: 'argon2id';
  /** Memory cost in KiB. */
  memory: number;
  passes: number;
  parallelism: number;
  /** Base64 salt. */
  salt: string;
}

/** 128 MiB, 3 passes, 4 lanes: well above OWASP's Argon2id minimums. */
export const DEFAULT_KDF = { memory: 131072, passes: 3, parallelism: 4 } as const;

export const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT_VERSION = 1;

/**
 * Vaults unlocked by a numeric PIN get a much heavier KDF (512 MiB, 6 passes, ~0.5 s here)
 * so each offline guess costs as much as possible. It can't make 10^4 or 10^6 guesses
 * safe; it only slows them down.
 */
export const PIN_KDF = { memory: 524288, passes: 6, parallelism: 4 } as const;

export function newKdfParams(kind: 'password' | 'pin' = 'password'): KdfParams {
  const cost = kind === 'pin' ? PIN_KDF : DEFAULT_KDF;
  return { algorithm: 'argon2id', ...cost, salt: crypto.randomBytes(16).toString('base64') };
}

/** KDF settings come from files the user opens, so bound them: a crafted file can't be allowed to exhaust memory. */
export function isValidKdf(raw: unknown): raw is KdfParams {
  const k = (raw ?? {}) as Partial<KdfParams>;
  return (
    k.algorithm === 'argon2id' &&
    Number.isInteger(k.memory) && k.memory! >= 8192 && k.memory! <= 1_048_576 &&
    Number.isInteger(k.passes) && k.passes! >= 1 && k.passes! <= 10 &&
    Number.isInteger(k.parallelism) && k.parallelism! >= 1 && k.parallelism! <= 16 &&
    typeof k.salt === 'string' && k.salt.length >= 16 && k.salt.length <= 128
  );
}

/** Derive a 256-bit key from a password with Argon2id (runs on libuv's thread pool). */
export function deriveKey(password: string, params: KdfParams): Promise<Buffer> {
  if (params.algorithm !== 'argon2id') throw new Error('Unsupported KDF');
  const message = Buffer.from(password.normalize('NFKC'), 'utf8');
  return new Promise((resolve, reject) => {
    crypto.argon2(
      'argon2id',
      {
        message,
        nonce: Buffer.from(params.salt, 'base64'),
        memory: params.memory,
        passes: params.passes,
        parallelism: params.parallelism,
        tagLength: KEY_BYTES,
      },
      (err, key) => {
        message.fill(0);
        if (err) reject(err);
        else resolve(key);
      },
    );
  });
}

/**
 * AES-256-GCM. Output layout: version(1) | nonce(12) | tag(16) | ciphertext.
 * `aad` binds the ciphertext to its context (e.g. the row id) so blobs can't be swapped.
 */
export function encrypt(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  assertLiveKey(key);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT_VERSION]), nonce, cipher.getAuthTag(), ct]);
}

/**
 * Session keys are zeroed in place on lock. If an async operation outlives the
 * session, refuse to encrypt with the wiped (all-zero) key instead of silently
 * writing data under a known key.
 */
function assertLiveKey(key: Buffer): void {
  if (key.length !== KEY_BYTES || key.every((b) => b === 0)) throw new KeyWipedError();
}

export class KeyWipedError extends Error {
  constructor() {
    super('Locked. Unlock to continue');
  }
}

export class DecryptionError extends Error {
  constructor() {
    super('Decryption failed');
  }
}

export function decrypt(key: Buffer, blob: Uint8Array, aad: string): Buffer {
  assertLiveKey(key);
  const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  if (buf.length < 1 + NONCE_BYTES + TAG_BYTES || buf[0] !== FORMAT_VERSION) throw new DecryptionError();
  const nonce = buf.subarray(1, 1 + NONCE_BYTES);
  const tag = buf.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES);
  const ct = buf.subarray(1 + NONCE_BYTES + TAG_BYTES);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new DecryptionError();
  }
}

export function encryptJson(key: Buffer, value: unknown, aad: string): Buffer {
  const plain = Buffer.from(JSON.stringify(value), 'utf8');
  try {
    return encrypt(key, plain, aad);
  } finally {
    plain.fill(0);
  }
}

export function decryptJson<T>(key: Buffer, blob: Uint8Array, aad: string): T {
  const plain = decrypt(key, blob, aad);
  try {
    return JSON.parse(plain.toString('utf8')) as T;
  } finally {
    plain.fill(0);
  }
}

export function randomId(): string {
  return crypto.randomUUID();
}

export function randomToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
