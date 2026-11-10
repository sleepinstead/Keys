// Cryptographically secure password generator. Runs in the browser and in Node
// via the Web Crypto API (globalThis.crypto.getRandomValues).
import { WORDS } from './wordlist.ts';

export type GeneratorMode = 'random' | 'passphrase' | 'pin';

export interface GeneratorOptions {
  mode: GeneratorMode;
  // random
  length: number;
  lowercase: boolean;
  uppercase: boolean;
  digits: boolean;
  symbols: boolean;
  /** Drop look-alike characters such as l, 1, I, O and 0. */
  excludeAmbiguous: boolean;
  // passphrase
  words: number;
  separator: string;
  capitalize: boolean;
  /** Append one random digit to one random word. */
  includeNumber: boolean;
  // pin
  pinLength: number;
}

export const DEFAULT_GENERATOR_OPTIONS: GeneratorOptions = {
  mode: 'random',
  length: 20,
  lowercase: true,
  uppercase: true,
  digits: true,
  symbols: true,
  excludeAmbiguous: false,
  words: 5,
  separator: '-',
  capitalize: true,
  includeNumber: true,
  pinLength: 6,
};

export const MIN_LENGTH = 8;
export const MAX_LENGTH = 128;
export const MIN_WORDS = 3;
export const MAX_WORDS = 12;
export const MIN_PIN = 4;
export const MAX_PIN = 12;
export const SEPARATORS = ['-', '.', '_', ' ', ',', ''] as const;

const SETS = {
  lowercase: 'abcdefghijklmnopqrstuvwxyz',
  uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.<>?/~',
} as const;

const AMBIGUOUS = new Set('lI1O0o|`\'"');

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(n)));

/** Uniform random integer in [0, max) using rejection sampling (no modulo bias). */
export function randomInt(max: number): number {
  if (!Number.isInteger(max) || max <= 0 || max > 2 ** 32) {
    throw new RangeError('max must be an integer in (0, 2^32]');
  }
  const limit = Math.floor(2 ** 32 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    const value = buf[0]!;
    if (value < limit) return value % max;
  }
}

function pools(opts: GeneratorOptions): string[] {
  const keys = (['lowercase', 'uppercase', 'digits', 'symbols'] as const).filter((k) => opts[k]);
  return keys.map((k) => {
    const chars = [...SETS[k]];
    return (opts.excludeAmbiguous ? chars.filter((c) => !AMBIGUOUS.has(c)) : chars).join('');
  });
}

function randomPassword(opts: GeneratorOptions): string {
  const length = clamp(opts.length, MIN_LENGTH, MAX_LENGTH);
  const sets = pools(opts);
  if (sets.length === 0) throw new Error('Select at least one character set');
  const all = sets.join('');
  // Guarantee one character from every selected set, then fill the rest
  // from the combined pool, then shuffle so the guaranteed ones aren't predictable.
  const out = sets.map((set) => set[randomInt(set.length)]!);
  while (out.length < length) out.push(all[randomInt(all.length)]!);
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out.join('');
}

function passphrase(opts: GeneratorOptions): string {
  const count = clamp(opts.words, MIN_WORDS, MAX_WORDS);
  const words = Array.from({ length: count }, () => WORDS[randomInt(WORDS.length)]!);
  const shaped = opts.capitalize ? words.map((w) => w[0]!.toUpperCase() + w.slice(1)) : words;
  if (opts.includeNumber) {
    const i = randomInt(count);
    shaped[i] = shaped[i]! + String(randomInt(10));
  }
  const sep = (SEPARATORS as readonly string[]).includes(opts.separator) ? opts.separator : '-';
  return shaped.join(sep);
}

/** PINs that people (and attackers) try first: one digit repeated, runs like 1234/9876, or a repeated pair like 1212. */
export function isObviousPin(pin: string): boolean {
  if (/^(\d)\1+$/.test(pin)) return true;
  const d = [...pin].map(Number);
  const step = d[1]! - d[0]!;
  if ((step === 1 || step === -1) && d.every((v, i) => i === 0 || v - d[i - 1]! === step)) return true;
  if (pin.length % 2 === 0 && pin === pin.slice(0, 2).repeat(pin.length / 2)) return true;
  return false;
}

// Popular choices beyond the patterns isObviousPin catches.
const COMMON_PINS = new Set(['1004', '2000', '2001', '6969', '1122', '1313', '2580', '0852', '1357', '2468', '5683', '0007', '112233', '123321', '696969', '159753']);

/** True for PINs an attacker would try first: patterns, popular picks, years, and repeated halves (123123). */
export function isWeakPin(pin: string): boolean {
  const half = pin.slice(0, pin.length / 2);
  return isObviousPin(pin) || COMMON_PINS.has(pin) || (pin.length === 4 && /^(19|20)\d\d$/.test(pin)) || (pin.length % 2 === 0 && half + half === pin);
}

function pin(opts: GeneratorOptions): string {
  const length = clamp(opts.pinLength, MIN_PIN, MAX_PIN);
  for (;;) {
    const out = Array.from({ length }, () => String(randomInt(10))).join('');
    if (!isWeakPin(out)) return out;
  }
}

export function generatePassword(options: Partial<GeneratorOptions> = {}): string {
  const opts = { ...DEFAULT_GENERATOR_OPTIONS, ...options };
  if (opts.mode === 'passphrase') return passphrase(opts);
  if (opts.mode === 'pin') return pin(opts);
  return randomPassword(opts);
}

/** Bits of entropy for the given options, assuming uniform selection. */
export function estimateEntropy(options: Partial<GeneratorOptions> = {}): number {
  const opts = { ...DEFAULT_GENERATOR_OPTIONS, ...options };
  if (opts.mode === 'passphrase') {
    const count = clamp(opts.words, MIN_WORDS, MAX_WORDS);
    const extra = opts.includeNumber ? Math.log2(10 * count) : 0;
    return Math.round(count * Math.log2(WORDS.length) + extra);
  }
  if (opts.mode === 'pin') return Math.round(clamp(opts.pinLength, MIN_PIN, MAX_PIN) * Math.log2(10));
  const size = pools(opts).join('').length;
  if (size === 0) return 0;
  return Math.round(clamp(opts.length, MIN_LENGTH, MAX_LENGTH) * Math.log2(size));
}
