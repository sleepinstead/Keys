import { decrypt, DecryptionError, deriveKey, encrypt, newKdfParams } from './crypto.ts';
import type { KdfParams } from './crypto.ts';
import { HttpError } from './validate.ts';
import { isWeakPin } from '../shared/generator.ts';

export const PIN_LENGTHS = [4, 6] as const;
export const MAX_PIN_ATTEMPTS = 5;
const WRAP_AAD = 'keys:pin-unlock:v1';

export function validatePin(pin: unknown, lengths: readonly number[] = PIN_LENGTHS): string {
  if (typeof pin !== 'string' || !/^\d+$/.test(pin)) throw new HttpError(400, 'A PIN can only contain digits');
  if (!lengths.includes(pin.length)) {
    throw new HttpError(400, `A PIN must be ${lengths.slice(0, -1).join(', ')}${lengths.length > 1 ? ' or ' : ''}${lengths[lengths.length - 1]} digits`);
  }
  if (isWeakPin(pin)) {
    throw new HttpError(400, 'That PIN is one of the first an attacker would try. Pick a less predictable one.', 'WEAK_PIN');
  }
  return pin;
}

/**
 * PIN quick unlock. A short PIN can't protect data at rest (10,000 four-digit PINs
 * fall to an offline search in minutes), so it never does: the PIN-wrapped vault key
 * exists only in this process's memory. It is armed by a master-password unlock,
 * survives auto-lock, and is destroyed after MAX_PIN_ATTEMPTS wrong PINs or when the
 * server stops, after which the master password is required again.
 */
export class QuickUnlock {
  private wrapped: Buffer | null = null;
  private kdf: KdfParams | null = null;
  private busy = false;
  length = 0;
  attemptsLeft = 0;

  get armed(): boolean {
    return this.wrapped !== null;
  }

  async arm(dek: Buffer, pin: string): Promise<void> {
    const kdf = newKdfParams();
    const key = await deriveKey(pin, kdf);
    try {
      this.disarm();
      this.wrapped = encrypt(key, dek, WRAP_AAD);
      this.kdf = kdf;
      this.length = pin.length;
      this.attemptsLeft = MAX_PIN_ATTEMPTS;
    } finally {
      key.fill(0);
    }
  }

  /** Returns a fresh copy of the vault key, or null for a wrong PIN. */
  async unlock(pin: string): Promise<Buffer | null> {
    if (!this.wrapped || !this.kdf) {
      throw new HttpError(409, 'PIN unlock isn’t available right now. Use your master password.', 'PIN_UNAVAILABLE');
    }
    if (this.busy) throw new HttpError(429, 'An unlock is already in progress');
    this.busy = true;
    const kdf = this.kdf;
    try {
      const key = await deriveKey(pin, kdf);
      try {
        if (!this.wrapped) return null;
        const dek = decrypt(key, this.wrapped, WRAP_AAD);
        this.attemptsLeft = MAX_PIN_ATTEMPTS;
        return dek;
      } catch (err) {
        if (!(err instanceof DecryptionError)) throw err;
        this.attemptsLeft -= 1;
        if (this.attemptsLeft <= 0) this.disarm();
        return null;
      } finally {
        key.fill(0);
      }
    } finally {
      this.busy = false;
    }
  }

  disarm(): void {
    this.wrapped?.fill(0);
    this.wrapped = null;
    this.kdf = null;
    this.length = 0;
    this.attemptsLeft = 0;
  }
}
