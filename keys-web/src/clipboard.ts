// Copies secrets and wipes them from the clipboard after a delay. Browsers only allow clearing
// while the page has focus, so a missed wipe happens the next time it's focused.
// Nothing is sent anywhere: the copy happens right away, inside the click that asked for it.

let timer: number | undefined;
let pendingWipe = false;

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
  window.clearTimeout(timer);
  pendingWipe = false;
  timer = undefined;
  await navigator.clipboard.writeText(text);
  if (clearAfterSeconds <= 0) return;
  timer = window.setTimeout(() => {
    timer = undefined; // done: locking later shouldn't wipe whatever the user copies next
    void wipe();
  }, clearAfterSeconds * 1000);
}

/** Called on lock: wipe now if a secret might still be on the clipboard. */
export function clearClipboardNow(): void {
  if (timer === undefined && !pendingWipe) return;
  window.clearTimeout(timer);
  timer = undefined;
  void wipe();
}
