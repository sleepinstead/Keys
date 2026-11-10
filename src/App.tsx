import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { api, errorMessage, LOCK_EVENT } from './api.ts';
import { clearClipboardNow } from './clipboard.ts';
import { ConfirmProvider, ToastProvider } from './context.tsx';
import type { Appearance, VaultStatus } from '../shared/types.ts';
import { LockScreen } from './components/LockScreen.tsx';
import { Onboarding } from './components/Onboarding.tsx';
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
      clearClipboardNow();
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
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={fade.exit}
        transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
      >
        {status.initialized ? <LockScreen status={status} onUnlocked={setStatus} /> : <Onboarding status={status} onUnlocked={setStatus} />}
      </motion.div>
    );
  } else {
    screen = (
      <motion.div
        key={`vault-${generation}`}
        className="screen"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={fade.exit}
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
            <AnimatePresence mode="wait">{screen}</AnimatePresence>
          </ConfirmProvider>
        </ToastProvider>
      </ErrorBoundary>
    </MotionConfig>
  );
}
