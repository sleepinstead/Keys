import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { DatabaseZap, FolderOpen } from 'lucide-react';
import { api, errorMessage } from '../api.ts';
import type { Credential, StorageInfo, VaultStatus } from '../../shared/types.ts';
import { CREDENTIAL_NAMES } from './credential.tsx';
import { Button, Dialog, OtpInput } from './ui.tsx';

export type StorageMode = 'connect' | 'create' | 'move' | 'default';

const COPY: Record<StorageMode, { title: string; description: string; action: string; placeholder: string }> = {
  connect: {
    title: 'Connect a database',
    description: 'Open an existing Keys database file. Keys will lock and use that file from now on.',
    action: 'Connect',
    placeholder: '~/Library/Mobile Documents/com~apple~CloudDocs/Keys.sqlite',
  },
  create: {
    title: 'New database',
    description: 'Create an empty database in a folder you choose, then set its password.',
    action: 'Create',
    placeholder: '~/Library/Mobile Documents/com~apple~CloudDocs/Keys.sqlite',
  },
  default: {
    title: 'Use the built-in database',
    description: 'Keys will lock and open the file inside its own folder. Your current file isn’t changed or deleted.',
    action: 'Switch',
    placeholder: '',
  },
  move: {
    title: 'Move your database',
    description: 'Copy everything to a new file and keep working from there. The old file stays where it is.',
    action: 'Move',
    placeholder: '~/Library/Mobile Documents/com~apple~CloudDocs/Keys.sqlite',
  },
};

/** Pick a database location by browsing (macOS) or pasting a path, then connect, create or move. */
export function StorageDialog({
  mode,
  storage,
  credential,
  onClose,
  onDone,
}: {
  mode: StorageMode | null;
  storage: StorageInfo;
  /** The current database's credential, which must be entered to change files. Null when there's none to check. */
  credential: Credential | null;
  onClose: () => void;
  onDone: (status: VaultStatus) => void;
}) {
  const [path, setPath] = useState('');
  const [current, setCurrent] = useState('');
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = mode ? COPY[mode] : COPY.connect;

  useEffect(() => {
    if (mode) {
      setPath('');
      setCurrent('');
      setError(null);
    }
  }, [mode]);

  async function browse() {
    setBrowsing(true);
    setError(null);
    try {
      const picked = (await api.browseStorage(mode === 'connect' ? 'open' : 'save')).path;
      if (picked) setPath(picked);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBrowsing(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const secret = credential ? current : undefined;
      onDone(
        mode === 'default'
          ? await api.defaultStorage(secret)
          : await (mode === 'create' ? api.createStorage : mode === 'move' ? api.moveStorage : api.connectStorage)(path, secret),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={mode !== null} onClose={onClose} size="sm" title={copy.title} description={copy.description} bare>
      <form className="dialog-form" onSubmit={submit}>
        <div className="dialog-body stack storage-dialog">
          {mode !== 'default' && (
          <div className="field">
            <label htmlFor="storage-path" className="field-label">
              {mode === 'connect' ? 'Database file' : 'Save as'}
            </label>
            <div className="storage-path-row">
              <input
                id="storage-path"
                className="input input-mono"
                placeholder={copy.placeholder}
                value={path}
                onChange={(e) => setPath(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                data-autofocus
              />
              {storage.canBrowse && (
                <Button variant="outline" icon={<FolderOpen size={15} />} onClick={() => void browse()} loading={browsing}>
                  Browse
                </Button>
              )}
            </div>
            <div className="field-hint">
              {storage.canBrowse ? 'Browse, or paste the full location.' : 'Paste the full location, like ~/Documents/Keys.sqlite.'} iCloud Drive and Google Drive work when the
              file is kept on this device.
            </div>
          </div>
          )}
          {credential && (
            <div className="field storage-current">
              <label htmlFor="storage-current" className="field-label">
                Current {CREDENTIAL_NAMES[credential.type]}
              </label>
              {credential.type === 'pin' ? (
                <OtpInput id="storage-current" label={`Current ${credential.length}-digit PIN`} length={credential.length} value={current} onChange={setCurrent} size="md" />
              ) : (
                <input
                  id="storage-current"
                  type="password"
                  className="input"
                  autoComplete="current-password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  {...(mode === 'default' ? { 'data-autofocus': true } : {})}
                />
              )}
            </div>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="dialog-foot">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            disabled={(mode !== 'default' && !path.trim()) || (credential !== null && (credential.type === 'pin' ? current.length !== credential.length : !current))}
          >
            {copy.action}
          </Button>
        </footer>
      </form>
    </Dialog>
  );
}

/**
 * Shown instead of the lock screen when the chosen database file can't be
 * opened: not synced to this device yet, moved, renamed or unreadable.
 */
export function StorageUnavailable({ storage, onChanged }: { storage: StorageInfo; onChanged: () => void }) {
  const [mode, setMode] = useState<StorageMode | null>(null);
  const [busy, setBusy] = useState<'retry' | 'default' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (which: 'retry' | 'default') => {
    setBusy(which);
    setError(null);
    try {
      await (which === 'retry' ? api.retryStorage() : api.defaultStorage());
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="screen lock">
      <div className="lock-center">
        <section className="lock-card storage-missing" role="alertdialog" aria-labelledby="storage-missing-title" aria-describedby="storage-missing-lede">
          <span className="storage-missing-icon" aria-hidden="true">
            <DatabaseZap size={22} />
          </span>
          <h1 id="storage-missing-title" className="lock-title">
            Can’t open your database
          </h1>
          <p id="storage-missing-lede" className="lock-lede">
            {error ?? storage.error}
          </p>
          <code className="storage-missing-path" title={storage.path}>
            {storage.path}
          </code>
          <div className="storage-missing-actions">
            <Button variant="primary" className="btn-block" loading={busy === 'retry'} onClick={() => void run('retry')}>
              Try again
            </Button>
            <Button variant="outline" className="btn-block" onClick={() => setMode('connect')}>
              Choose another file
            </Button>
            <button type="button" className="text-btn" disabled={busy !== null} onClick={() => void run('default')}>
              Use the built-in database instead
            </button>
          </div>
        </section>
      </div>
      <StorageDialog mode={mode} storage={storage} credential={null} onClose={() => setMode(null)} onDone={() => onChanged()} />
    </main>
  );
}
