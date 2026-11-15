// Copies secrets and wipes them from the clipboard after a delay.
// The Mac app clears it natively (even while Keys is in the background) and only if the clipboard
// still holds the secret, so whatever the user copied since is kept. Elsewhere the page clears it
// itself; browsers only allow that while the page has focus, so a missed wipe happens on next focus.
import { api } from './api.ts';

let timer: number | undefined;
let pendingWipe = false;
let lastHash: string | null = null; // the secret still possibly on the clipboard (native clearing)

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function wipe(): Promise<void> {
  try {
    await navigator.clipboard.writeText('');
    pendingWipe = false;
  } catch {
    pendingWipe = true;
    window.addEventListener('focus', () => void (pendingWipe && wipe()), { once: true });
  }
}

export async function copyText(text: string, clearAfterSeconds: number): Promise<void> {
  await navigator.clipboard.writeText(text);
  window.clearTimeout(timer);
  pendingWipe = false;
  timer = undefined;
  lastHash = null;
  if (clearAfterSeconds <= 0) return;
  const hash = await sha256(text);
  const native = await api.clearClipboard(hash, clearAfterSeconds).then((r) => r.native, () => false);
  if (native) {
    lastHash = hash;
    timer = window.setTimeout(() => {
      timer = undefined;
      lastHash = null;
    }, clearAfterSeconds * 1000);
    return;
  }
  timer = window.setTimeout(() => {
    timer = undefined; // done: locking later shouldn't wipe whatever the user copies next
    void wipe();
  }, clearAfterSeconds * 1000);
}

/** Called on lock: wipe now if a secret might still be on the clipboard. */
export function clearClipboardNow(): void {
  if (lastHash) {
    void api.clearClipboard(lastHash, 0).catch(() => undefined);
    lastHash = null;
    window.clearTimeout(timer);
    timer = undefined;
  } else if (timer !== undefined || pendingWipe) {
    window.clearTimeout(timer);
    timer = undefined;
    void wipe();
  }
}
