import { useEffect, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { animate, AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { AtSign, Check, ChevronRight, RotateCcw, Clock3, Copy as CopyIcon, ExternalLink, KeyRound, Layers, PanelRightOpen, Radar, RefreshCw, ShieldAlert, ShieldX, Trash2, Zap } from 'lucide-react';
import { api, errorMessage } from '../api.ts';
import { useCopy, useSettings, useToast } from '../context.tsx';
import { fade } from '../motion.ts';
import type { AuditIssue, AuditItem, AuditReport, DuplicateGroup } from '../../shared/types.ts';
import { plural, safeHref, timeAgo } from '../util.ts';
import { Button, ContextMenu, Dialog, EmptyState, Monogram, Spinner, STRENGTH_WORDS, useContextMenu } from './ui.tsx';
import type { MenuItem } from './ui.tsx';

const ISSUES: { key: AuditIssue; label: string; explain: string; icon: ReactNode; tone: string }[] = [
  { key: 'breached', label: 'Breached', explain: 'Seen in public data breaches. Change these first.', icon: <ShieldX size={18} />, tone: 'bad' },
  { key: 'weak', label: 'Weak', explain: 'Short or predictable enough to be guessed.', icon: <Zap size={18} />, tone: 'warn' },
  { key: 'reused', label: 'Reused', explain: 'Used on more than one account, so one leak exposes them all.', icon: <CopyIcon size={18} />, tone: 'muted' },
  { key: 'outdated', label: 'Old', explain: 'Not changed in a long time.', icon: <Clock3 size={18} />, tone: 'muted' },
];

const TICKS = 44;
const SWEEP = 260; // degrees of arc the gauge covers, open at the bottom

type HealthTone = 'good' | 'warn' | 'bad';
const healthTone = (v: number): HealthTone => (v >= 80 ? 'good' : v >= 50 ? 'warn' : 'bad');

/** Counts up to `value` once, then follows it. */
function useCountUp(value: number) {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(reduce ? value : 0);
  useEffect(() => {
    if (reduce) return setShown(value);
    const c = animate(shown, value, { duration: 0.9, ease: [0.2, 0, 0, 1], onUpdate: (v) => setShown(Math.round(v)) });
    return () => c.stop();
  }, [value]);
  return shown;
}

/** Tick-mark gauge for the vault's health score. */
function HealthGauge({ value }: { value: number }) {
  const shown = useCountUp(value);
  const lit = Math.round((value / 100) * TICKS);
  const start = -90 - SWEEP / 2;
  return (
    <div className="gauge" data-tone={healthTone(value)} role="img" aria-label={`Password health ${value} out of 100`}>
      <svg viewBox="0 0 160 160" aria-hidden="true">
        {Array.from({ length: TICKS }, (_, i) => {
          const a = ((start + (SWEEP * i) / (TICKS - 1)) * Math.PI) / 180;
          const [c, s] = [Math.cos(a), Math.sin(a)];
          return (
            <motion.line
              key={i}
              x1={80 + c * 62}
              y1={80 + s * 62}
              x2={80 + c * 74}
              y2={80 + s * 74}
              className={i < lit ? 'gauge-tick is-lit' : 'gauge-tick'}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2, delay: i < lit ? i * 0.014 : 0 }}
            />
          );
        })}
      </svg>
      <div className="gauge-label">
        <span className="gauge-value">{shown}</span>
        <span className="gauge-caption">Health</span>
      </div>
    </div>
  );
}

const WORST_FIRST: AuditIssue[] = ['breached', 'weak', 'reused', 'outdated'];

/** One bar split by each login's worst problem, so the whole vault reads at a glance. */
function HealthBar({ items }: { items: AuditItem[] }) {
  const counts = { healthy: 0, breached: 0, weak: 0, reused: 0, outdated: 0 };
  for (const item of items) counts[WORST_FIRST.find((k) => item.issues.includes(k)) ?? 'healthy']++;
  const parts = (['healthy', ...WORST_FIRST] as const).filter((k) => counts[k] > 0);
  return (
    <div className="health-bar" role="img" aria-label={parts.map((k) => `${counts[k]} ${k === 'healthy' ? 'healthy' : ISSUES.find((i) => i.key === k)!.label.toLowerCase()}`).join(', ')}>
      <div className="health-bar-track">
        {parts.map((k) => (
          <motion.span
            key={k}
            className="health-bar-seg"
            data-kind={k}
            initial={{ flexGrow: 0 }}
            animate={{ flexGrow: counts[k] }}
            transition={{ duration: 0.7, ease: [0.2, 0, 0, 1] }}
          />
        ))}
      </div>
    </div>
  );
}

function issueSummary(kind: AuditIssue, count: number, report: AuditReport, outdatedDays: number): string {
  if (count === 0) return kind === 'reused' ? 'Every login has its own password.' : 'None.';
  if (kind === 'breached') return 'Seen in known data breaches. Change these first.';
  if (kind === 'weak') return 'Quick to guess. Replace them with generated passwords.';
  if (kind === 'reused') return `${plural(report.reusedGroups.length, 'password')} shared across ${plural(count, 'login')}.`;
  return `Unchanged for over ${outdatedDays >= 365 ? plural(Math.round(outdatedDays / 365), 'year') : plural(Math.round(outdatedDays / 30), 'month')}.`;
}

/** Review exact copies of the same login and remove the extras. One copy of each always stays. */
function DuplicatesDialog({ open, groups, onClose, onRemoved, onOpen }: { open: boolean; groups: DuplicateGroup[]; onClose: () => void; onRemoved: (n: number) => void; onOpen: (id: string) => void }) {
  // By default, remove every older copy that holds nothing the newest one lacks.
  const suggested = () => new Set(groups.flatMap((g) => g.items.slice(1).filter((i) => !i.extra).map((i) => i.id)));
  const [remove, setRemove] = useState<Set<string>>(suggested);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setRemove(suggested());
      setError(null);
    }
  }, [open, groups]);

  const rowMenu = useContextMenu<{ group: DuplicateGroup; id: string }>();
  /** Keep just this copy of the account: every other copy in its group is marked for removal. */
  const keepOnly = (group: DuplicateGroup, id: string) =>
    setRemove((prev) => {
      const next = new Set(prev);
      for (const i of group.items) i.id === id ? next.delete(i.id) : next.add(i.id);
      return next;
    });
  const dupeMenu = ({ group, id }: { group: DuplicateGroup; id: string }): MenuItem[] => {
    const removing = remove.has(id);
    const kept = group.items.filter((i) => !remove.has(i.id)).length;
    return [
      { label: 'Keep only this copy', icon: <Check size={15} />, onSelect: () => keepOnly(group, id) },
      removing
        ? { label: 'Keep this copy', icon: <RotateCcw size={15} />, onSelect: () => toggle(id) }
        : { label: 'Remove this copy', icon: <Trash2 size={15} />, danger: true, disabled: kept === 1, onSelect: () => toggle(id) },
      {
        label: 'Open item',
        icon: <PanelRightOpen size={15} />,
        separatorBefore: true,
        onSelect: () => {
          onClose();
          onOpen(id);
        },
      },
    ];
  };

  const toggle = (id: string) =>
    setRemove((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const { deleted } = await api.deleteEntries([...remove]);
      onRemoved(deleted);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Duplicate logins"
      description="Each group is one account saved more than once. Keep one copy and remove the rest. Removed copies go to Recently deleted."
      className="dialog-dupes"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} disabled={remove.size === 0} onClick={() => void confirm()}>
            {remove.size === 0 ? 'Remove' : `Remove ${plural(remove.size, 'login')}`}
          </Button>
        </>
      }
    >
      <div className="dupe-groups">
        {groups.map((g) => {
          const kept = g.items.filter((i) => !remove.has(i.id)).length;
          return (
            <section key={g.items[0]!.id} className="dupe-group">
              <header>
                <Monogram title={g.site} type="login" icon="" />
                <div>
                  <strong>{g.site}</strong>
                  <span>{g.username || 'No username'}</span>
                </div>
              </header>
              <ul>
                {g.items.map((item) => {
                  const removing = remove.has(item.id);
                  // The last remaining copy can't be ticked: removing it would lose the account.
                  const last = !removing && kept === 1;
                  return (
                    <li key={item.id}>
                      <label
                        className="dupe-row"
                        data-removing={removing || undefined}
                        data-menu-open={rowMenu.menu?.target.id === item.id || undefined}
                        onContextMenu={(ev) => !busy && rowMenu.open(ev, { group: g, id: item.id })}
                      >
                        <input type="checkbox" checked={removing} disabled={last || busy} onChange={() => toggle(item.id)} aria-label={`Remove ${item.title}, edited ${timeAgo(item.updatedAt)}`} />
                        <span className="dupe-row-title">{item.title}</span>
                        <span className="dupe-row-meta">
                          {item.extra && <span className="badge" data-tone="warn">Has its own notes</span>}
                          {removing ? 'Remove' : 'Keep'} · edited {timeAgo(item.updatedAt)}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <ContextMenu
        at={rowMenu.menu}
        items={rowMenu.menu ? dupeMenu(rowMenu.menu.target) : []}
        label="Actions for this copy"
        onClose={rowMenu.close}
        returnTo={rowMenu.menu?.row}
      />
    </Dialog>
  );
}

function issueLabel(item: AuditItem, issue: AuditIssue): string {
  if (issue === 'breached') return `In breaches ${item.breachCount!.toLocaleString()}×`;
  if (issue === 'reused') return `Used ${item.reuseCount}×`;
  if (issue === 'outdated') return `${Math.max(1, Math.floor(item.ageDays / 30))} months old`;
  return STRENGTH_WORDS[item.score]!;
}

/**
 * What the audit is doing while it loads. It's one request, so the checks are listed rather than
 * ticked off one by one: per-step progress would be invented. Hidden for quick loads, so it never flashes.
 */
function AuditLoading({ outdatedDays, breaches }: { outdatedDays: number; breaches: boolean }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setShown(true), 250);
    return () => window.clearTimeout(t);
  }, []);
  if (!shown) return null;
  const age = outdatedDays >= 365 ? plural(Math.round(outdatedDays / 365), 'year') : plural(Math.round(outdatedDays / 30), 'month');
  const steps: [ReactNode, string][] = [
    [<KeyRound size={15} />, 'Decrypting your logins'],
    [<Zap size={15} />, 'Rating how hard each password is to guess'],
    [<CopyIcon size={15} />, 'Looking for passwords used more than once'],
    [<Clock3 size={15} />, `Finding passwords unchanged for ${age}`],
    ...(breaches ? [[<Radar size={15} />, 'Reading results from your last breach check'] as [ReactNode, string]] : []),
  ];
  return (
    <motion.section className="card audit-loading" role="status" {...fade}>
      <header>
        <Spinner size={16} />
        <h2>Checking your passwords</h2>
      </header>
      <ul>
        {steps.map(([icon, text]) => (
          <li key={text}>
            <span aria-hidden="true">{icon}</span>
            {text}
          </li>
        ))}
      </ul>
      <p>All of this happens on this computer. Nothing is sent anywhere.</p>
    </motion.section>
  );
}

export function AuditView({ onOpen, onReport, onEntriesChanged }: { onOpen: (id: string) => void; onReport: (r: AuditReport) => void; onEntriesChanged: () => void }) {
  const { settings, updateSettings } = useSettings();
  const [report, setReport] = useState<AuditReport | null>(null);
  const [filter, setFilter] = useState<AuditIssue | 'all'>('all');
  const [checking, setChecking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  /** Bumped on every completed check so the gauge replays. */
  const [run, setRun] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const copy = useCopy();
  const [menu, setMenu] = useState<{ x: number; y: number; item: AuditItem; row: HTMLElement } | null>(null);

  const openMenu = (e: MouseEvent<HTMLButtonElement>, item: AuditItem) => {
    e.preventDefault(); // the menu only; the item stays closed
    const r = e.currentTarget.getBoundingClientRect();
    const keyboard = e.clientX === 0 && e.clientY === 0; // the menu key has no pointer position
    setMenu({ x: keyboard ? r.left + 16 : e.clientX, y: keyboard ? r.bottom : e.clientY, item, row: e.currentTarget });
  };

  /** The same actions as the item list, plus going straight to the site to change the password. */
  const menuItems = (item: AuditItem): MenuItem[] => {
    const href = safeHref(item.url);
    const items: MenuItem[] = [{ label: 'Open item', icon: <PanelRightOpen size={15} />, onSelect: () => onOpen(item.id) }];

    if (item.username) items.push({ label: 'Copy username', icon: <AtSign size={15} />, separatorBefore: true, onSelect: () => void copy(item.username, 'username', false) });
    items.push({
      label: 'Copy password',
      icon: <KeyRound size={15} />,
      separatorBefore: !item.username,
      onSelect: async () => {
        try {
          await copy((await api.entry(item.id)).password, 'password');
        } catch (err) {
          toast(errorMessage(err), 'error');
        }
      },
    });
    if (href) items.push({ label: 'Open website to change it', icon: <ExternalLink size={15} />, onSelect: () => window.open(href, '_blank', 'noopener,noreferrer') });
    items.push({
      label: 'Delete',
      icon: <Trash2 size={15} />,
      danger: true,
      separatorBefore: true,
      onSelect: async () => {
        try {
          await api.deleteEntry(item.id);
          toast(`Moved ${item.title} to Recently deleted`);
          onEntriesChanged();
          await load();
        } catch (err) {
          toast(errorMessage(err), 'error');
        }
      },
    });
    return items;
  };

  const load = async (manual = false) => {
    setLoading(true);
    setError(null);
    try {
      // A manual re-check spins for at least a moment, so it's clear something happened.
      const [r] = await Promise.all([api.audit(), manual ? new Promise((ok) => setTimeout(ok, 450)) : null]);
      setReport(r);
      onReport(r);
      setRun((n) => n + 1);
      if (manual) {
        const n = r.items.filter((i) => i.issues.length > 0).length;
        toast(n === 0 ? 'Audit complete. Everything looks healthy' : `Audit complete. ${plural(n, 'login')} need${n === 1 ? 's' : ''} attention`);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  async function checkBreaches() {
    setChecking(true);
    setError(null);
    try {
      if (!settings.breachCheckEnabled) await updateSettings({ breachCheckEnabled: true });
      const next = await api.checkBreaches();
      setReport(next);
      onReport(next);
      toast(next.totals.breached ? `${plural(next.totals.breached, 'password')} found in known breaches` : 'None of your passwords are in known breaches');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setChecking(false);
    }
  }

  if (!report) {
    return (
      <div className="page page-center" aria-busy={!error}>
        {error ? <p className="form-error">{error}</p> : <AuditLoading outdatedDays={settings.outdatedDays} breaches={settings.breachCheckEnabled} />}
      </div>
    );
  }

  const { totals } = report;
  const flagged = report.items.filter((i) => i.issues.length > 0);
  const shown = filter === 'all' ? flagged : report.items.filter((i) => i.issues.includes(filter));
    /** One login in the audit, as a row that opens it (right-click for more). */
  const renderRow = (item: AuditItem, only?: AuditIssue[]) =>
                  <button
      type="button"
      className="audit-row"
      onClick={() => onOpen(item.id)}
      onContextMenu={(ev) => openMenu(ev, item)}
      data-menu-open={menu?.item.id === item.id || undefined}
    >
      {!settings.hideIcons.login && <Monogram title={item.title} type="login" icon={item.icon} />}
      <span className="audit-main">
        <span className="entry-row-title">{item.title}</span>
        <span className="entry-row-sub">{item.username || item.url}</span>
      </span>
      <span className="audit-issues">
        {item.issues.filter((issue) => !only || only.includes(issue)).map((issue) => (
          <span key={issue} className="badge" data-tone={issue === 'weak' && item.score <= 1 ? 'bad' : ISSUES.find((i) => i.key === issue)!.tone}>
            {issueLabel(item, issue)}
          </span>
        ))}
      </span>
    </button>;

  // Logins sharing a password, biggest group first, so "Reused" shows exactly where each one is used.
  const byId = new Map(report.items.map((i) => [i.id, i]));
  const reuseGroups = report.reusedGroups
    .map((ids) => ({ items: ids.map((id) => byId.get(id)).filter((i): i is AuditItem => Boolean(i)) }))
    .filter((g) => g.items.length > 1)
    .sort((a, b) => b.items.length - a.items.length);
  const lastCheck = report.items.reduce<number | null>((m, i) => (i.breachCheckedAt && (!m || i.breachCheckedAt > m) ? i.breachCheckedAt : m), null);

  return (
    <div className="page page-wide">
      <header className="page-head page-head-row">
        <div>
          <h1>Security audit</h1>
          <p className="page-lede">
            {totals.logins === 0
              ? 'Add a few logins and Keys will check them for weak, reused and old passwords.'
              : flagged.length === 0
                ? `All ${plural(totals.logins, 'login')} look healthy.`
                : `${flagged.length} of ${plural(totals.logins, 'login')} need attention.`}
          </p>
        </div>
        <Button variant="outline" size="sm" icon={<RefreshCw size={14} className={loading ? 'spin' : undefined} />} aria-busy={loading || undefined} onClick={() => !loading && void load(true)}>
          {loading ? 'Checking…' : 'Re-check'}
        </Button>
      </header>

      <div className="audit-grid">
        <div className="audit-col">
      {totals.logins > 0 && (
        <section className="card audit-summary" aria-label="Summary">
          <div className="audit-summary-head">
            <HealthGauge key={run} value={report.health} />
            <div className="audit-summary-text">
              <span className="badge" data-tone={healthTone(report.health)}>
                {report.health >= 80 ? 'Good' : report.health >= 50 ? 'Fair' : 'At risk'}
              </span>
              <h2>{report.health >= 80 ? 'Your passwords are in good shape' : report.health >= 50 ? 'A few things to tidy up' : 'Some passwords need fixing'}</h2>
              <p>
                {plural(totals.logins, 'login')} checked, {totals.logins - flagged.length} healthy.
                {flagged.length > 0 && ' Fixing breached and weak passwords raises the score most.'}
              </p>
              <HealthBar items={report.items} />
            </div>
          </div>

          <ul className="audit-issue-list" aria-label="Filter by issue">
            {ISSUES.map((i) => {
              const count = totals[i.key];
              const unchecked = i.key === 'breached' && totals.unchecked === totals.logins;
              return (
                <li key={i.key}>
                  <button
                    type="button"
                    className="audit-issue"
                    data-kind={i.key}
                    aria-pressed={filter === i.key}
                    disabled={count === 0 && filter !== i.key} // an active filter can always be turned off
                    onClick={() => setFilter(filter === i.key ? 'all' : i.key)}
                  >
                    <span className="health-dot" aria-hidden="true" />
                    <span className="audit-issue-text">
                      <strong>{i.label}</strong>
                      <span>{unchecked ? 'Not checked yet. Run a breach check to find out.' : issueSummary(i.key, count, report, settings.outdatedDays)}</span>
                    </span>
                    <span className="audit-issue-count">{unchecked ? '–' : count}</span>
                    <ChevronRight size={16} className="audit-issue-chevron" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>

          {totals.duplicates > 0 && (
            <div className="audit-dupes">
              <span className="audit-dupes-icon" aria-hidden="true">
                <Layers size={16} />
              </span>
              <p>
                <strong>{plural(totals.duplicates, 'duplicate login')}</strong>
                <span>Same site, username and password as another login, often from importing twice.</span>
              </p>
              <Button variant="outline" size="sm" onClick={() => setReviewing(true)}>
                Review
              </Button>
            </div>
          )}
        </section>
      )}
      <DuplicatesDialog
        open={reviewing}
        groups={report.duplicateGroups}
        onClose={() => setReviewing(false)}
        onOpen={onOpen}
        onRemoved={(n) => {
          setReviewing(false);
          toast(`Removed ${plural(n, 'duplicate login')}`);
          onEntriesChanged();
          void load();
        }}
      />
      <ContextMenu at={menu} items={menu ? menuItems(menu.item) : []} label={menu ? `Actions for ${menu.item.title}` : 'Actions'} onClose={() => setMenu(null)} returnTo={menu?.row} />
      <AnimatePresence>
        {error && (
          <motion.p className="form-error" role="alert" {...fade}>
            {error}
          </motion.p>
        )}
      </AnimatePresence>
      {totals.logins > 0 && (
        <section className="audit-results">
          <div className="audit-results-head">
            <h2>{filter === 'all' ? 'Needs attention' : ISSUES.find((i) => i.key === filter)!.label}</h2>
            <p className="audit-explain">{filter === 'all' ? 'Worst first. Select an item to fix it.' : ISSUES.find((i) => i.key === filter)!.explain}</p>
          </div>
          {shown.length === 0 ? (
            <EmptyState
              title={totals.logins === 0 ? 'No logins to check yet' : filter === 'all' ? 'Nothing to fix' : `No ${ISSUES.find((i) => i.key === filter)!.label.toLowerCase()} passwords`}
            >
              <p>
                {totals.logins === 0
                  ? 'Logins with a password show up here once you add them.'
                  : filter === 'all'
                    ? totals.logins === 1
                      ? 'Your login has a strong, unique, recently changed password.'
                      : `All ${totals.logins} logins have strong, unique, recently changed passwords.`
                    : totals.logins === 1
                      ? 'Your login isn’t flagged for this.'
                      : `None of your ${totals.logins} logins are flagged for this.`}
                {totals.logins > 0 &&
                  totals.unchecked > 0 &&
                  (filter === 'all' || filter === 'breached') &&
                  (totals.logins === 1 ? ' Run a breach check to see if it appears in a known leak.' : ' Run a breach check to see if any appear in known leaks.')}
              </p>
            </EmptyState>
          ) : (
            filter === 'reused' ? (
              <div className="reuse-groups" key="reused">
                {reuseGroups.map((g, n) => (
                  <section key={g.items[0]!.id} className="reuse-group" id={`reuse-${g.items[0]!.id}`}>
                    <header className="reuse-head">
                      <span className="reuse-index">{n + 1}</span>
                      <div>
                        <strong>Same password on {g.items.length} logins</strong>
                        <span>
                          {STRENGTH_WORDS[g.items[0]!.score]} password
                          {g.items[0]!.breachCount ? ` · in breaches ${g.items[0]!.breachCount.toLocaleString()}×` : ''} · change it on all but one of these sites
                        </span>
                      </div>
                    </header>
                    <ul className="group audit-list">
                      {g.items.map((item) => (
                        <li key={item.id}>
                          {renderRow(item, ['breached', 'weak'])}
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            ) : (
            <ul className="group audit-list" key={filter}>
              {shown.map((item) => (
                <li key={item.id}>{renderRow(item)}</li>
              ))}
            </ul>
            )
          )}
        </section>
      )}
        </div>
        <aside className="audit-side">
      <section className="card breach-card">
        <span className="tile-icon">{checking ? <Radar size={18} className="spin-slow" /> : <ShieldAlert size={18} />}</span>
        <div className="breach-text">
          <h2>Check against known breaches</h2>
          <p>
            Uses Have I Been Pwned with k-anonymity: only the first 5 characters of each password’s SHA-1 hash are sent, so your passwords never leave
            this computer. {lastCheck ? `Last checked ${timeAgo(lastCheck)}.` : ''}
          </p>
          {!settings.breachCheckEnabled && <p className="breach-note">This is the only feature that goes online. It stays off until you run it.</p>}
        </div>
        <Button variant="primary" size="sm" onClick={checkBreaches} loading={checking} disabled={totals.logins === 0}>
          {settings.breachCheckEnabled ? 'Check now' : 'Turn on and check'}
        </Button>
      </section>
        <section className="card card-pad">
          <h2 className="side-title">What the audit checks</h2>
          <dl className="gen-guide">
            <div>
              <dt>Breached</dt>
              <dd>Passwords found in public leak lists. Only checked when you run a breach check.</dd>
            </div>
            <div>
              <dt>Weak</dt>
              <dd>Short, common or predictable passwords that are quick to guess.</dd>
            </div>
            <div>
              <dt>Reused</dt>
              <dd>The same password on more than one login. One leak exposes them all.</dd>
            </div>
            <div>
              <dt>Old</dt>
              <dd>Not changed for longer than the limit you set in Settings.</dd>
            </div>
          </dl>
        </section>
        </aside>
      </div>
    </div>
  );
}
