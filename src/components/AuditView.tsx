import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { animate, AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Clock3, Copy as CopyIcon, Radar, RefreshCw, ShieldAlert, ShieldCheck, ShieldX, Zap } from 'lucide-react';
import { api, errorMessage } from '../api.ts';
import { useSettings, useToast } from '../context.tsx';
import { fade } from '../motion.ts';
import type { AuditIssue, AuditItem, AuditReport } from '../../shared/types.ts';
import { plural, timeAgo } from '../util.ts';
import { Button, EmptyState, Monogram, Spinner, STRENGTH_WORDS } from './ui.tsx';

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
  const label = (k: (typeof parts)[number]) => (k === 'healthy' ? 'Healthy' : ISSUES.find((i) => i.key === k)!.label);
  return (
    <div className="health-bar">
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
      <ul className="health-legend">
        {parts.map((k) => (
          <li key={k} data-kind={k}>
            <span className="health-dot" />
            <span className="health-legend-count">{counts[k]}</span> {label(k)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function issueLabel(item: AuditItem, issue: AuditIssue): string {
  if (issue === 'breached') return `In breaches ${item.breachCount!.toLocaleString()}×`;
  if (issue === 'reused') return `Used ${item.reuseCount}×`;
  if (issue === 'outdated') return `${Math.max(1, Math.floor(item.ageDays / 30))} months old`;
  return STRENGTH_WORDS[item.score]!;
}

export function AuditView({ onOpen, onReport }: { onOpen: (id: string) => void; onReport: (r: AuditReport) => void }) {
  const { settings, updateSettings } = useSettings();
  const [report, setReport] = useState<AuditReport | null>(null);
  const [filter, setFilter] = useState<AuditIssue | 'all'>('all');
  const [checking, setChecking] = useState(false);
  const [loading, setLoading] = useState(false);
  /** Bumped on every completed check so the gauge replays. */
  const [run, setRun] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

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
        {error ? <p className="form-error">{error}</p> : <Spinner size={22} />}
      </div>
    );
  }

  const { totals } = report;
  const flagged = report.items.filter((i) => i.issues.length > 0);
  const shown = filter === 'all' ? flagged : report.items.filter((i) => i.issues.includes(filter));
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
        <section className="audit-top">
          <div className="card audit-health">
            <HealthGauge key={run} value={report.health} />
            <div className="audit-health-text">
              <span className="badge" data-tone={healthTone(report.health)}>
                {report.health >= 80 ? 'Good' : report.health >= 50 ? 'Fair' : 'At risk'}
              </span>
              <h2>{report.health >= 80 ? 'Your passwords are in good shape' : report.health >= 50 ? 'A few things to tidy up' : 'Some passwords need fixing'}</h2>
              <p>
                {flagged.length === 0
                  ? 'No breached, weak, reused or old passwords.'
                  : 'Breached and weak passwords cost the most points. Start at the top of the list below.'}
              </p>
              <HealthBar items={report.items} />
            </div>
          </div>
          <div className="issue-grid" role="tablist" aria-label="Filter by issue">
            {ISSUES.map((i) => (
              <button
                key={i.key}
                type="button"
                role="tab"
                aria-selected={filter === i.key}
                className="issue-tile"
                data-tone={i.tone}
                onClick={() => setFilter(filter === i.key ? 'all' : i.key)}
              >
                <span className="issue-icon">{i.icon}</span>
                <span className="issue-count">{totals[i.key]}</span>
                <span className="issue-label">{i.label}</span>
              </button>
            ))}
          </div>
        </section>
      )}
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
            <EmptyState icon={<ShieldCheck size={22} />} title={filter === 'all' ? 'Nothing to fix' : `No ${ISSUES.find((i) => i.key === filter)!.label.toLowerCase()} passwords`} />
          ) : (
            <ul className="group audit-list" key={filter}>
              {shown.map((item) => (
                <li key={item.id}>
                  <button type="button" className="audit-row" onClick={() => onOpen(item.id)}>
                    {!settings.hideIcons.login && <Monogram title={item.title} type="login" icon={item.icon} />}
                    <span className="audit-main">
                      <span className="entry-row-title">{item.title}</span>
                      <span className="entry-row-sub">{item.username || item.url}</span>
                    </span>
                    <span className="audit-issues">
                      {item.issues.map((issue) => (
                        <span key={issue} className="badge" data-tone={issue === 'weak' && item.score <= 1 ? 'bad' : ISSUES.find((i) => i.key === issue)!.tone}>
                          {issueLabel(item, issue)}
                        </span>
                      ))}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
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
