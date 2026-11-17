// Rules for the different kinds of vault credential, shared by the client
// (live checklists) and the server (the final word).
import { isWeakPin } from './generator.ts';

export const PASSPHRASE_MIN_WORDS = 4;
export const PATTERN_MIN_POINTS = 4;
export const PATTERN_SIZE = 3;

/** Splits a passphrase into words on spaces, hyphens, dots, underscores or commas. */
export function passphraseWords(value: string): string[] {
  return value
    .trim()
    .split(/[\s\-._,]+/)
    .filter(Boolean);
}

/** Why a passphrase isn't acceptable, or null when it is. */
export function passphraseProblem(value: string): string | null {
  const words = passphraseWords(value);
  if (words.length < PASSPHRASE_MIN_WORDS) return `Use at least ${PASSPHRASE_MIN_WORDS} words`;
  if (words.some((w) => w.length < 3)) return 'Each word needs at least 3 letters';
  if (new Set(words.map((w) => w.toLowerCase())).size < words.length) return 'Don’t repeat words';
  return null;
}

export function pinProblem(pin: string, length: number): string | null {
  if (!/^\d*$/.test(pin)) return 'Digits only';
  if (pin.length !== length) return `Enter ${length} digits`;
  if (isWeakPin(pin)) return 'Too easy to guess: avoid patterns, repeats and years';
  return null;
}

// ------------------------------------------------------------------ pattern

/** Dots are numbered 0–8, left to right, top to bottom. Stored as "0-4-8-5". */
export const encodePattern = (points: number[]) => points.join('-');

export function decodePattern(value: string): number[] | null {
  if (!/^\d(-\d)*$/.test(value)) return null;
  const points = value.split('-').map(Number);
  if (points.some((p) => p >= PATTERN_SIZE * PATTERN_SIZE)) return null;
  if (new Set(points).size !== points.length) return null;
  return points;
}

/**
 * The dot a straight line from `a` to `b` passes through, if any. Like Android, a
 * line can't skip over an unused dot: it gets added on the way.
 */
export function dotBetween(a: number, b: number): number | null {
  const [ar, ac] = [Math.floor(a / PATTERN_SIZE), a % PATTERN_SIZE];
  const [br, bc] = [Math.floor(b / PATTERN_SIZE), b % PATTERN_SIZE];
  if ((ar + br) % 2 || (ac + bc) % 2) return null;
  const mid = ((ar + br) / 2) * PATTERN_SIZE + (ac + bc) / 2;
  return mid === a || mid === b ? null : mid;
}

/** Straight lines through a whole row, column or diagonal are the first things anyone tries. */
function isStraightLine(points: number[]): boolean {
  if (points.length > 3) return false;
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
  ];
  const key = points.join(',');
  return lines.some((l) => l.join(',') === key || [...l].reverse().join(',') === key);
}

export function patternProblem(value: string): string | null {
  const points = decodePattern(value);
  if (!points) return 'That isn’t a valid pattern';
  if (points.length < PATTERN_MIN_POINTS) return `Connect at least ${PATTERN_MIN_POINTS} dots`;
  if (isStraightLine(points)) return 'Too simple: use more than a straight line';
  return null;
}
