import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CircleAlert, CircleCheck, Trash2 } from 'lucide-react';
import { copyText } from './clipboard.ts';
import { smooth } from './motion.ts';
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import type { Settings } from '../shared/types.ts';
import { Button, Dialog } from './components/ui.tsx';

// ------------------------------------------------------------------ toasts

interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const push = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    if (!text) return;
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 6000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout="position"
              className={`toast toast-${t.tone}`}
              initial={{ opacity: 0, x: 24, scale: 0.98 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 24, transition: { duration: 0.14 } }}
              transition={smooth}
            >
              {t.tone === 'error' ? <CircleAlert size={16} /> : <CircleCheck size={16} />}
              <span>{t.text}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// ----------------------------------------------------------------- confirm

interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
}

const ConfirmCtx = createContext<(opts: ConfirmOptions) => Promise<boolean>>(async () => false);

/** Confirmation dialog for destructive or irreversible actions. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const [open, setOpen] = useState(false);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback((o: ConfirmOptions) => {
    setOpts(o);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = (value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setOpen(false);
  };

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Dialog
        open={open}
        onClose={() => close(false)}
        size="sm"
        hideClose
        title={opts?.title}
        description={opts?.body}
        footer={
          <>
            <Button variant="outline" onClick={() => close(false)} data-autofocus>
              Cancel
            </Button>
            <Button variant={opts?.danger ? 'danger' : 'primary'} icon={opts?.danger ? <Trash2 size={15} /> : undefined} onClick={() => close(true)}>
              {opts?.confirmLabel}
            </Button>
          </>
        }
      />
    </ConfirmCtx.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmCtx);

// ---------------------------------------------------------------- settings

interface SettingsValue {
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
}

const SettingsCtx = createContext<SettingsValue>({ settings: DEFAULT_SETTINGS, updateSettings: async () => {} });
export const SettingsProvider = SettingsCtx.Provider;
export const useSettings = () => useContext(SettingsCtx);

// --------------------------------------------------------------- clipboard

/** Copy with auto-clear, announcing what happened. Resolves true when the copy landed. */
export function useCopy() {
  const seconds = useContext(SettingsCtx).settings.clipboardClearSeconds;
  const toast = useToast();
  return useCallback(
    async (text: string, what: string, secret = true): Promise<boolean> => {
      try {
        await copyText(text, secret ? seconds : 0);
        toast(secret && seconds > 0 ? `Copied ${what}. Clears in ${seconds}s` : `Copied ${what}`);
        return true;
      } catch {
        toast('Couldn’t copy. Click inside Keys and try again.', 'error');
        return false;
      }
    },
    [seconds, toast],
  );
}
