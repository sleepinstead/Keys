import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, Check, ChevronDown, Copy, ExternalLink, Eye, EyeOff, KeyRound, Pencil, Star, Trash2, TriangleAlert } from 'lucide-react';
import { api, errorMessage } from '../api.ts';
import { useConfirm, useCopy, useSettings, useToast } from '../context.tsx';
import { collapse, popStar, quick } from '../motion.ts';
import type { Category, Entry, StrengthResult } from '../../shared/types.ts';
import { FIELD_LABELS, formatDate, hostname, safeHref, timeAgo, TYPE_LABELS } from '../util.ts';
import { Button, CopyButton, FolderIcon, IconButton, Monogram, SecretText, STRENGTH_TONE, STRENGTH_WORDS, Spinner, Tooltip } from './ui.tsx';

const MASK = '••••••••••••';

function Row({ label, extra, children, actions }: { label: string; extra?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="row">
      <div className="row-main">
        <div className="row-label">
          {label}
          {extra}
        </div>
        <div className="row-value">{children}</div>
      </div>
      {actions && <div className="row-actions">{actions}</div>}
    </div>
  );
}

function SecretRow({ label, value, what, extra }: { label: string; value: string; what: string; extra?: ReactNode }) {
  const [shown, setShown] = useState(false);
  const copy = useCopy();
  useEffect(() => setShown(false), [value]);
  return (
    <Row
      label={label}
      extra={extra}
      actions={
        <>
          <IconButton label={shown ? `Hide ${what}` : `Reveal ${what}`} onClick={() => setShown(!shown)} aria-pressed={shown}>
            {shown ? <EyeOff size={16} /> : <Eye size={16} />}
          </IconButton>
          <CopyButton label={`Copy ${what}`} onCopy={() => copy(value, what)} />
        </>
      }
    >
      {shown ? <SecretText value={value} /> : <span className="masked">{MASK}</span>}
    </Row>
  );
}

function PlainRow({ label, value, what }: { label: string; value: string; what: string }) {
  const copy = useCopy();
  return (
    <Row label={label} actions={<CopyButton label={`Copy ${what}`} onCopy={() => copy(value, what, false)} />}>
      {value}
    </Row>
  );
}

/** A quick-action button. Copy actions briefly turn into a "Copied" confirmation. */
function QuickAction({ icon, children, onRun }: { icon: ReactNode; children: ReactNode; onRun: () => boolean | void | Promise<boolean | void> }) {
  const [done, setDone] = useState(false);
  const timer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <Button
      variant="outline"
      size="sm"
      className={done ? 'btn-done' : undefined}
      icon={<span className="btn-icon-swap" key={done ? 'done' : 'idle'}>{done ? <Check size={14} /> : icon}</span>}
      onClick={async () => {
        const ok = await onRun();
        if (ok !== true) return;
        setDone(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setDone(false), 1400);
      }}
    >
      {done ? 'Copied' : children}
    </Button>
  );
}

export function EntryDetail({
  entryId,
  categories,
  onEdit,
  onDeleted,
  onChanged,
  onBack,
  version,
}: {
  entryId: string;
  categories: Category[];
  onEdit: (entry: Entry) => void;
  onDeleted: () => void;
  onChanged: (entry: Entry) => void;
  onBack: () => void;
  /** Bumped after an edit so the detail reloads. */
  version: number;
}) {
  const [entry, setEntry] = useState<Entry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const confirm = useConfirm();
  const toast = useToast();
  const copy = useCopy();
  const { settings } = useSettings();
  const hideIcons = settings.hideIcons;
  const [strength, setStrength] = useState<StrengthResult | null>(null);
  const shownId = useRef<string | null>(null);

  // The item on screen stays until the next one (and its strength rating) has fully loaded,
  // then they swap in one go: no spinner flash, and no badges popping in afterwards.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await api.entry(entryId);
        const rating =
          next.type === 'login' && next.password
            ? await api.strength(next.password, [next.username, next.title, hostname(next.url)]).catch(() => null)
            : null;
        if (cancelled) return;
        if (shownId.current !== next.id) setHistoryOpen(false);
        shownId.current = next.id;
        setError(null);
        setEntry(next);
        setStrength(rating);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entryId, version]);

  if (error) {
    return (
      <section className="detail detail-center">
        <p className="form-error">{error}</p>
      </section>
    );
  }
  if (!entry) {
    return (
      <section className="detail detail-center detail-waiting" aria-busy="true">
        <Spinner size={18} />
      </section>
    );
  }

  const labels = FIELD_LABELS[entry.type];
  const category = categories.find((c) => c.id === entry.categoryId);
  const href = safeHref(entry.url);
  const codes = entry.codes.split(/\r?\n/).map((c) => c.trim()).filter(Boolean);
  const breached = entry.breach && entry.breach.count > 0;

  async function toggleFavorite() {
    if (!entry) return;
    try {
      const updated = await api.updateEntry(entry.id, { ...entry, favorite: !entry.favorite });
      setEntry(updated);
      onChanged(updated);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  async function remove() {
    if (!entry) return;
    try {
      await api.deleteEntry(entry.id);
      toast(`Moved ${entry.title} to Recently deleted`);
      onDeleted();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  async function clearHistory() {
    if (!entry) return;
    const ok = await confirm({
      title: 'Clear password history?',
      body: 'Previous passwords for this item will be deleted. The current one stays.',
      confirmLabel: 'Clear history',
      danger: true,
    });
    if (!ok) return;
    setEntry(await api.clearHistory(entry.id));
    setHistoryOpen(false);
  }

  const strengthChip = strength && (
    <Tooltip content={`Takes ${strength.crackTime} to crack`}>
      <span className="badge" data-tone={STRENGTH_TONE[strength.score]}>
        {STRENGTH_WORDS[strength.score]}
      </span>
    </Tooltip>
  );

  return (
    <section className="detail" aria-labelledby="detail-title">
      <div className="detail-toolbar">
        <IconButton label="Back to list" className="only-narrow" onClick={onBack}>
          <ArrowLeft size={18} />
        </IconButton>
        <div className="toolbar-end">
          <IconButton label={entry.favorite ? 'Remove from favorites' : 'Add to favorites'} onClick={(e) => { if (!entry.favorite) popStar(e.currentTarget); void toggleFavorite(); }} aria-pressed={entry.favorite}>
            <Star size={16} className={entry.favorite ? 'is-fav' : undefined} />
          </IconButton>
          {href && (
            <IconButton label={`Open ${hostname(entry.url)}`} onClick={() => window.open(href, '_blank', 'noopener,noreferrer')}>
              <ExternalLink size={16} />
            </IconButton>
          )}
          <IconButton label="Edit" shortcut="E" onClick={() => onEdit(entry)}>
            <Pencil size={16} />
          </IconButton>
          <span className="toolbar-sep" aria-hidden="true" />
          <IconButton label="Delete item" className="icon-btn-danger" onClick={() => void remove()}>
            <Trash2 size={16} />
          </IconButton>
        </div>
      </div>

      {/* Keyed by item: a new item starts at the top with fresh state, and fades in once. */}
      <div className="detail-scroll" key={entry.id}>
        <div className="detail-layout">
          <header className="hero">
          {!hideIcons[entry.type] && <Monogram title={entry.title} type={entry.type} size="lg" icon={entry.icon} />}
          <div className="hero-text">
            <h1 id="detail-title" className="hero-title">
              {entry.title}
            </h1>
            <p className="hero-meta">
              <span className="badge badge-outline">{TYPE_LABELS[entry.type].one}</span>
              {settings.categoriesEnabled && category && (
                <span className="badge badge-outline">
                  <FolderIcon color={category.color} size={12} />
                  {category.name}
                </span>
              )}
            </p>
          </div>
        </header>

          <div className="detail-main">
        {breached && (
          <div className="notice notice-bad">
            <TriangleAlert size={16} />
            <p>
              <strong>This password appears in data breaches.</strong> It’s been seen {entry.breach!.count.toLocaleString()} times in leaked password
              lists. Change it on the site, then update it here.
            </p>
          </div>
        )}

        {(entry.type !== 'note' || entry.customFields.length > 0) && (
          <div className="group">
            {entry.type !== 'note' && entry.username && <PlainRow label={labels.username} value={entry.username} what={labels.username.toLowerCase()} />}
            {(entry.type === 'login' || entry.type === 'apiKey') && entry.password && (
              <SecretRow label={labels.password} value={entry.password} what={labels.password.toLowerCase()} extra={entry.type === 'login' ? strengthChip : undefined} />
            )}
            {entry.type === 'recovery' && codes.length > 0 && <CodesRow codes={codes} />}
            {entry.type !== 'note' && entry.url && (
              <Row
                label={labels.url}
                actions={
                  <>
                    <CopyButton label={`Copy ${labels.url.toLowerCase()}`} onCopy={() => copy(entry.url, labels.url.toLowerCase(), false)} />
                    {href && (
                      <Tooltip content={`Open ${hostname(entry.url)}`}>
                        <a className="icon-btn icon-btn-ghost" href={href} target="_blank" rel="noopener noreferrer" aria-label={`Open ${hostname(entry.url)}`}>
                          <ExternalLink size={16} />
                        </a>
                      </Tooltip>
                    )}
                  </>
                }
              >
                {href ? (
                  <a className="row-link" href={href} target="_blank" rel="noopener noreferrer">
                    {hostname(entry.url)}
                  </a>
                ) : (
                  entry.url
                )}
              </Row>
            )}
            {entry.customFields.map((f) =>
              f.hidden ? (
                <SecretRow key={f.id} label={f.label || 'Field'} value={f.value} what={(f.label || 'field').toLowerCase()} />
              ) : (
                <PlainRow key={f.id} label={f.label || 'Field'} value={f.value} what={(f.label || 'field').toLowerCase()} />
              ),
            )}
          </div>
        )}

        {entry.type === 'note' && entry.notes && (
          <div className="group group-pad">
            <div className="row-label">{labels.notes}</div>
            <p className="notes-text">{entry.notes}</p>
          </div>
        )}

        {entry.history.length > 0 && (
          <div className="group">
            <button type="button" className="disclosure" aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>
              <span>Password history</span>
              <span className="badge">{entry.history.length}</span>
              <motion.span className="disclosure-chev" animate={{ rotate: historyOpen ? 180 : 0 }} transition={quick}>
                <ChevronDown size={16} />
              </motion.span>
            </button>
            <AnimatePresence initial={false}>
              {historyOpen && (
                <motion.div className="collapse" {...collapse}>
                  {entry.history.map((h, i) => (
                    <SecretRow key={i} label={`Used until ${formatDate(h.changedAt)}`} value={h.password} what="old password" />
                  ))}
                  <div className="collapse-foot">
                    <Button variant="ghost" size="sm" className="text-danger" icon={<Trash2 size={14} />} onClick={clearHistory}>
                      Clear history
                    </Button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

          </div>

          <aside className="detail-side" aria-label="Item details">
            {(entry.type === 'login' || entry.type === 'apiKey' || href) && (
              <div className="side-card">
                <h2 className="side-title">Quick actions</h2>
                <div className="side-actions">
                  {entry.username && entry.type !== 'note' && (
                    <QuickAction icon={<Copy size={14} />} onRun={() => copy(entry.username, labels.username.toLowerCase(), false)}>
                      Copy {labels.username.toLowerCase()}
                    </QuickAction>
                  )}
                  {(entry.type === 'login' || entry.type === 'apiKey') && entry.password && (
                    <QuickAction icon={<KeyRound size={14} />} onRun={() => copy(entry.password, labels.password.toLowerCase())}>
                      Copy {labels.password.toLowerCase()}
                    </QuickAction>
                  )}
                  {href && (
                    <QuickAction icon={<ExternalLink size={14} />} onRun={() => void window.open(href, '_blank', 'noopener,noreferrer')}>
                      Open {hostname(entry.url)}
                    </QuickAction>
                  )}
                </div>
              </div>
            )}

            {(entry.type === 'login' || entry.type === 'apiKey') && entry.password && (
              <div className="side-card">
                <h2 className="side-title">Security</h2>
                <dl className="side-list">
                  {entry.type === 'login' && (
                    <div>
                      <dt>Strength</dt>
                      <dd>
                        {strength ? (
                          <span className="badge" data-tone={STRENGTH_TONE[strength.score]}>
                            {STRENGTH_WORDS[strength.score]}
                          </span>
                        ) : (
                          '…'
                        )}
                      </dd>
                    </div>
                  )}
                  {entry.type === 'login' && strength && (
                    <div>
                      <dt>Time to crack</dt>
                      <dd>{strength.crackTime}</dd>
                    </div>
                  )}
                  {entry.type === 'login' && (
                    <div>
                      <dt>Breaches</dt>
                      <dd>
                        {entry.breach ? (
                          entry.breach.count > 0 ? (
                            <span className="badge" data-tone="bad">Seen {entry.breach.count.toLocaleString()}×</span>
                          ) : (
                            <span className="badge" data-tone="good">Not found</span>
                          )
                        ) : (
                          <span className="muted">Not checked</span>
                        )}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>{entry.type === 'apiKey' ? 'Secret changed' : 'Password changed'}</dt>
                    <dd>{timeAgo(entry.passwordUpdatedAt)}</dd>
                  </div>
                  <div>
                    <dt>Previous {entry.type === 'apiKey' ? 'secrets' : 'passwords'}</dt>
                    <dd>{entry.history.length}</dd>
                  </div>
                </dl>
              </div>
            )}

            <div className="side-card">
              <h2 className="side-title">Details</h2>
              <dl className="side-list">
                <div>
                  <dt>Type</dt>
                  <dd>{TYPE_LABELS[entry.type].one}</dd>
                </div>
                {settings.categoriesEnabled && (
                  <div>
                    <dt>Category</dt>
                    <dd>{category ? category.name : <span className="muted">None</span>}</dd>
                  </div>
                )}
                <div>
                  <dt>Favorite</dt>
                  <dd>{entry.favorite ? 'Yes' : 'No'}</dd>
                </div>
                {entry.customFields.length > 0 && (
                  <div>
                    <dt>Extra fields</dt>
                    <dd>{entry.customFields.length}</dd>
                  </div>
                )}
                <div>
                  <dt>Last edited</dt>
                  <dd>{timeAgo(entry.updatedAt)}</dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>{formatDate(entry.createdAt)}</dd>
                </div>
              </dl>
            </div>
          </aside>
        </div>
      </div>
    </section>
  );
}

function CodesRow({ codes }: { codes: string[] }) {
  const [shown, setShown] = useState(false);
  const copy = useCopy();
  return (
    <Row
      label="Recovery codes"
      extra={<span className="badge">{codes.length}</span>}
      actions={
        <>
          <IconButton label={shown ? 'Hide codes' : 'Reveal codes'} onClick={() => setShown(!shown)} aria-pressed={shown}>
            {shown ? <EyeOff size={16} /> : <Eye size={16} />}
          </IconButton>
          <CopyButton label="Copy all codes" onCopy={() => copy(codes.join('\n'), 'recovery codes')} />
        </>
      }
    >
      {shown ? (
        <ol className="codes">
          {codes.map((c, i) => (
            <li key={i}>
              <Tooltip content="Copy code">
                <button type="button" className="code-chip" onClick={() => void copy(c, `code ${i + 1}`)}>
                  <span className="code-num">{i + 1}</span>
                  <SecretText value={c} />
                </button>
              </Tooltip>
            </li>
          ))}
        </ol>
      ) : (
        <span className="masked">{MASK}</span>
      )}
    </Row>
  );
}
