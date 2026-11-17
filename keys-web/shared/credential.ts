// Rules for vault credentials (a master password or a PIN), shared by the client (live
// checklists) and the server (the final word).
import { isWeakPin } from './generator.ts';

export function pinProblem(pin: string, length: number): string | null {
  if (!/^\d*$/.test(pin)) return 'Digits only';
  if (pin.length !== length) return `Enter ${length} digits`;
  if (isWeakPin(pin)) return 'Too easy to guess: avoid patterns, repeats and years';
  return null;
}
