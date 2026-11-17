import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { api, errorMessage, LOCK_EVENT } from './api.ts';
import { clearClipboardNow } from './clipboard.ts';
import { ConfirmProvider, ToastProvider } from './context.tsx';
import type { Appearance, VaultStatus } from '../shared/types.ts';
import { captureBackdrop, hasBackdrop, LockScreen } from './components/LockScreen.tsx';
import { StorageUnavailable } from './components/StorageDialog.tsx';
import { VaultShell } from './components/VaultShell.tsx';
import { ConnectionError, ErrorBoundary } from './components/ErrorScreen.tsx';
import { fade, viewTransition } from './motion.ts';

let firstAppearance = true;

/**
 * Applies the theme as one crossfade of the whole page. Fading each element instead
 * makes inherited text colours lag behind their parents, which reads as flicker.
 */
export function applyAppearance(a: Appearance, commit?: () => void) {
  const root = document.documentElement;
  const first = firstAppearance;
  firstAppearance = false;
  if ((root.dataset.theme ?? 'system') === a) return commit?.();
  const apply = () => {
    commit?.();
    if (a === 'system') delete root.dataset.theme;
    else root.dataset.theme = a;
  };
  // Nothing is on screen for the saved theme's first paint, so there's nothing to fade from.
  if (first) apply();
  else viewTransition(apply);
}

export function App() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every lock so the vault UI fully unmounts and drops decrypted data.
  const [generation, setGeneration] = useState(0);
  const unlocked = useRef(false);
  unlocked.current = status?.unlocked ?? false;

  const refresh = useCallback(async () => {
    try {
      const s = await api.status();
      applyAppearance(s.appearance);
      setStatus(s);
      setError(null); // only now, so retrying doesn't blank the error screen
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onLocked = () => {
      // Every request still in flight comes back "locked" too; only the first one locks the screen,
      // or the lock screen would remount (and fade in again) once per request.
      if (!unlocked.current) return void refresh();
      unlocked.current = false;
      clearClipboardNow();
      captureBackdrop();
      // The vault stays mounted for a moment under the lock screen; its dialogs (an open editor,
      // say) are portaled above everything, so hide them at once.
      document.body.dataset.locking = '';
      window.setTimeout(() => delete document.body.dataset.locking, 600);
      // Show the lock screen right away. Remounting the vault while the status
      // still says "unlocked" would fire its startup requests against a locked
      // session, and each failure used to surface as a toast.
      setStatus((s) => (s ? { ...s, unlocked: false, settings: null, expiresAt: null } : s));
      setGeneration((g) => g + 1);
      void refresh();
    };
    window.addEventListener(LOCK_EVENT, onLocked);
    return () => window.removeEventListener(LOCK_EVENT, onLocked);
  }, [refresh]);

  const lock = useCallback(() => {
    void api
      .lock()
      .catch(() => {})
      .finally(() => window.dispatchEvent(new Event(LOCK_EVENT)));
  }, []);

  let screen;
  if (!status) {
    screen = error ? (
      <motion.div key="error" className="screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={fade.exit}>
        <ConnectionError detail={error} onRetry={refresh} />
      </motion.div>
    ) : null;
  } else if (!status.storage.available) {
    screen = (
      <motion.div key={`storage-${generation}`} className="screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={fade.exit}>
        <StorageUnavailable storage={status.storage} onChanged={() => window.dispatchEvent(new Event(LOCK_EVENT))} />
      </motion.div>
    );
  } else if (!status.unlocked) {
    screen = (
      <motion.div
        // A different database file (or a fresh one) gets a fresh lock screen.
        key={`lock-${generation}-${status.storage.path}-${status.initialized}`}
        className="screen"
        // Fades in over the still-sharp app while its blurred copy deepens (styles.css).
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: { duration: hasBackdrop() ? 0.35 : 0.2, ease: [0.2, 0, 0, 1] } }}
        exit={{ opacity: 0, transition: { duration: 0.28, ease: [0.2, 0, 0, 1] } }}
        transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
      >
        <LockScreen status={status} onUnlocked={setStatus} />
      </motion.div>
    );
  } else {
    screen = (
      <motion.div
        key={`vault-${generation}`}
        className="screen"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        // Stays put under the lock screen as that blurs in, instead of flashing to blank.
        exit={{ opacity: 1, transition: { duration: 0.45 } }}
        transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
      >
        <VaultShell status={status} onLock={lock} />
      </motion.div>
    );
  }

  return (
    <MotionConfig reducedMotion="user">
      <ErrorBoundary>
        <ToastProvider>
          <ConfirmProvider>
            {/* Screens are fixed layers: the new one crossfades over the old. */}
            <AnimatePresence>{screen}</AnimatePresence>
          </ConfirmProvider>
        </ToastProvider>
      </ErrorBoundary>
    </MotionConfig>
  );
}
