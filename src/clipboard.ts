// Copies secrets and wipes them from the clipboard after a delay.
// Browsers only allow clipboard writes while the page has focus, so if the
// timer fires while Keys is in the background, the wipe happens on next focus.

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
  await navigator.clipboard.writeText(text);
  window.clearTimeout(timer);
  pendingWipe = false;
  timer = undefined;
  if (clearAfterSeconds > 0) {
    timer = window.setTimeout(() => {
      timer = undefined; // done: locking later shouldn't wipe whatever the user copies next
      void wipe();
    }, clearAfterSeconds * 1000);
  }
}

/** Called on lock: wipe now if a secret might still be on the clipboard. */
export function clearClipboardNow(): void {
  if (timer !== undefined || pendingWipe) {
    window.clearTimeout(timer);
    timer = undefined;
    void wipe();
  }
}
