// Runs the (deliberately slow) Argon2id unlock step off the page's main thread.
import { deriveKek } from './vault.ts';
import type { Kdf } from './vault.ts';

self.onmessage = async (e: MessageEvent<{ password: string; kdf: Kdf }>) => {
  try {
    const kek = await deriveKek(e.data.password, e.data.kdf);
    self.postMessage({ kek }, { transfer: [kek.buffer] });
  } catch (err) {
    self.postMessage({ error: err instanceof Error ? err.message : 'Unlock failed' });
  }
};
