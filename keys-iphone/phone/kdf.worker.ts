// Runs the (deliberately slow) Argon2id unlock step off the page's main thread.
import { deriveKek } from './vault.ts';
import type { Kdf } from './vault.ts';

self.onmessage = async (e: MessageEvent<{ password: string; kdf: Kdf }>) => {
  try {
    const kek = await deriveKek(e.data.password, e.data.kdf);
    self.postMessage({ kek }, { transfer: [kek.buffer] });
  } catch (err) {
    // Argon2 needs a lot of memory (much more for PIN vaults); say so plainly when the phone runs out.
    const memory = err instanceof RangeError || (err instanceof Error && /memory/i.test(err.message));
    self.postMessage({ error: memory ? 'This iPhone ran out of memory while unlocking. Close other apps and try again.' : err instanceof Error ? err.message : 'Unlock failed' });
  }
};
