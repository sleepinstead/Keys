import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../api.ts';
import { useSettings, useToast } from '../context.tsx';
import { encodePattern } from '../../shared/credential.ts';
import type { Credential, TrashedEntry } from '../../shared/types.ts';
import { plural, timeAgo, TYPE_LABELS } from '../util.ts';
import { CREDENTIAL_NAMES, PatternInput } from './credential.tsx';
import { Button, ContextMenu, Dialog, EmptyState, IconButton, Monogram, OtpInput, Spinner, useContextMenu } from './ui.tsx';
import type { MenuItem } from './ui.tsx';

/** Asks for the vault's password or PIN before deleting items for good. */
function PurgeDialog({
  target,
  credential,
  onClose,
  onDone,
}: {
  /** The items to delete, or 'all' to empty the bin. Null when closed. */
  target: TrashedEntry[] | 'all' | null;
  credential: Credential;
  onClose: () => void;
  onDone: (purged: number) => void;
}) {
  const [secret, setSecret] = useState('');
  const [pattern, setPattern] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (target) {
      setSecret('');
      setPattern([]);
      setError(null);
    }
  }, [target]);

  const name = CREDENTIAL_NAMES[credential.type];
  const count = target === 'all' ? null : target?.length ?? 0;
  const ready = credential.type === 'pin' ? secret.length === credential.length : credential.type === 'pattern' ? pattern.length >= 4 : secret.length > 0;

  async function purge(value: string, e?: FormEvent) {
    e?.preventDefault();
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { purged } = await api.purgeTrash(target === 'all' ? 'all' : target.map((t) => t.id), value);
      onDone(purged);
    } catch (err) {
      setError(errorMessage(err));
      setSecret('');
      setPattern([]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={target !== null}
      onClose={onClose}
      size="sm"
      bare
      title={target === 'all' ? 'Empty Recently deleted?' : count === 1 ? `Delete ${(target as TrashedEntry[])[0]!.title} permanently?` : `Delete ${plural(count ?? 0, 'item')} permanently?`}
      description={`This can’t be undone. Enter your ${name} to confirm.`}
    >
      <form className="dialog-form" onSubmit={(e) => void purge(credential.type === 'pattern' ? encodePattern(pattern) : secret, e)}>
        <div className="dialog-body stack purge-dialog">
          {credential.type === 'pin' ? (
            <OtpInput id="purge-secret" label={`Your ${credential.length}-digit PIN`} length={credential.length} value={secret} onChange={setSecret} size="md" autoFocus disabled={busy} />
          ) : credential.type === 'pattern' ? (
            <PatternInput value={pattern} onChange={setPattern} onComplete={(p) => void purge(encodePattern(p))} label="Your pattern" disabled={busy} compact />
          ) : (
            <div className="field">
              <label htmlFor="purge-secret" className="field-label">
                {name[0]!.toUpperCase() + name.slice(1)}
              </label>
              <input id="purge-secret" type="password" className="input" autoComplete="current-password" value={secret} onChange={(e) => setSecret(e.target.value)} data-autofocus disabled={busy} />
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
          <Button type="submit" variant="danger" loading={busy} disabled={!ready}>
            Delete permanently
          </Button>
        </footer>
      </form>
    </Dialog>
  );
}

/** What's in the bin at a glance: how much, of what kind, and how long it has been there. */
function TrashSummary({ items }: { items: TrashedEntry[] }) {
  const byType = (Object.keys(TYPE_LABELS) as TrashedEntry['type'][])
    .map((t) => ({ t, n: items.filter((i) => i.type === t).length }))
    .filter((x) => x.n > 0);
  const newest = items[0]!.deletedAt;
  const oldest = items[items.length - 1]!.deletedAt;
  const week = items.filter((i) => Date.now() - i.deletedAt < 7 * 86_400_000).length;
  return (
    <section className="card card-pad trash-summary">
      <div className="trash-total">
        <strong>{items.length}</strong>
        <span>{items.length === 1 ? 'item can be restored' : 'items can be restored'}</span>
      </div>
      <div className="trash-bar" aria-hidden="true">
        {byType.map(({ t, n }) => (
          <span key={t} data-type={t} style={{ flexGrow: n }} />
        ))}
      </div>
      <ul className="trash-kinds">
        {byType.map(({ t, n }) => (
          <li key={t} data-type={t}>
            <span className="trash-dot" aria-hidden="true" />
            {n === 1 ? TYPE_LABELS[t].one : TYPE_LABELS[t].many}
            <b>{n}</b>
          </li>
        ))}
      </ul>
      <dl className="trash-times">
        <div>
          <dt>Last deleted</dt>
          <dd>{timeAgo(newest)}</dd>
        </div>
        {items.length > 1 && (
          <div>
            <dt>Oldest here</dt>
            <dd>{timeAgo(oldest)}</dd>
          </div>
        )}
        <div>
          <dt>This week</dt>
          <dd>{plural(week, 'item')}</dd>
        </div>
      </dl>
      <p className="trash-note">Nothing here is erased on its own. Items stay until you restore them or delete them permanently.</p>
    </section>
  );
}

export function TrashView({ onChanged }: { onChanged: () => void }) {
  const { settings } = useSettings();
  const toast = useToast();
  const [items, setItems] = useState<TrashedEntry[] | null>(null);
  const [credential, setCredential] = useState<Credential>({ type: 'password' });
  const [purging, setPurging] = useState<TrashedEntry[] | 'all' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rowMenu = useContextMenu<TrashedEntry>();
  const trashMenu = (item: TrashedEntry): MenuItem[] => [
    { label: 'Restore', icon: <RotateCcw size={15} />, onSelect: () => void restore([item]) },
    { label: 'Delete permanently…', icon: <Trash2 size={15} />, danger: true, separatorBefore: true, onSelect: () => setPurging([item]) },
  ];

  const load = () =>
    api
      .trash()
      .then(setItems)
      .catch((e) => setError(errorMessage(e)));
  useEffect(() => {
    void load();
    void api.status().then((s) => setCredential(s.credential), () => {});
  }, []);

  async function restore(list: TrashedEntry[]) {
    setBusy(true);
    try {
      await api.restoreTrash(list.map((i) => i.id));
      toast(list.length === 1 ? `Restored ${list[0]!.title}` : `Restored ${plural(list.length, 'item')}`);
      await load();
      onChanged();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (!items) {
    return <div className="page page-center">{error ? <p className="form-error">{error}</p> : <Spinner size={20} />}</div>;
  }

  return (
    <div className="page page-wide">
      <header className="page-head page-head-row">
        <div>
          <h1>Recently deleted</h1>
          <p className="page-lede">Deleted items wait here until you remove them for good. That needs your {CREDENTIAL_NAMES[credential.type]}.</p>
        </div>
        {items.length > 0 && (
          <div className="row-buttons">
            <Button variant="outline" size="sm" icon={<RotateCcw size={14} />} disabled={busy} onClick={() => void restore(items)}>
              Restore all
            </Button>
            <Button variant="danger" size="sm" icon={<Trash2 size={14} />} disabled={busy} onClick={() => setPurging('all')}>
              Empty
            </Button>
          </div>
        )}
      </header>

      <div className="audit-grid">
        <div className="audit-col">
      {items.length === 0 ? (
        <EmptyState title="Nothing in Recently deleted">
          <p>When you delete an item it comes here first, so you can restore it if you change your mind.</p>
        </EmptyState>
      ) : (
        <ul className="group trash-list">
          {items.map((item) => (
            <li
              key={item.id}
              className="trash-row"
              data-menu-open={rowMenu.menu?.target.id === item.id || undefined}
              onContextMenu={(ev) => !busy && rowMenu.open(ev, item)}
            >
              {!settings.hideIcons[item.type] && <Monogram title={item.title} type={item.type} icon={item.icon} />}
              <span className="trash-main">
                <span className="entry-row-title">{item.title}</span>
                <span className="entry-row-sub">
                  {item.username ? `${item.username}, ` : ''}deleted {timeAgo(item.deletedAt)}
                </span>
              </span>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void restore([item])}>
                Restore
              </Button>
              <IconButton label={`Delete ${item.title} permanently`} className="icon-btn-danger" disabled={busy} onClick={() => setPurging([item])}>
                <Trash2 size={16} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <ContextMenu
        at={rowMenu.menu}
        items={rowMenu.menu ? trashMenu(rowMenu.menu.target) : []}
        label={rowMenu.menu ? `Actions for ${rowMenu.menu.target.title}` : 'Actions'}
        onClose={rowMenu.close}
        returnTo={rowMenu.menu?.row}
      />
        </div>
        <aside className="audit-side">
          {items.length > 0 && <TrashSummary items={items} />}
          <section className="card card-pad">
            <h2 className="side-title">How it works</h2>
            <dl className="gen-guide">
              <div>
                <dt>Delete</dt>
                <dd>Deleting an item moves it here. It disappears from your lists, the audit and exports.</dd>
              </div>
              <div>
                <dt>Restore</dt>
                <dd>Puts the item back exactly as it was, password history included.</dd>
              </div>
              <div>
                <dt>Delete permanently</dt>
                <dd>Erases it from your database file for good. Keys asks for your {CREDENTIAL_NAMES[credential.type]} first.</dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>

      <PurgeDialog
        target={purging}
        credential={credential}
        onClose={() => setPurging(null)}
        onDone={(n) => {
          setPurging(null);
          toast(`Deleted ${plural(n, 'item')} permanently`);
          void load();
          onChanged();
        }}
      />
    </div>
  );
}
