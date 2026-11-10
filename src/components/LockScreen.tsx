import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { AnimatePresence, motion, useAnimate } from 'motion/react';
import { Check, Database, Eye, EyeOff, Grid3x3, KeyRound, Lock, ShieldCheck, WholeWord } from 'lucide-react';
import { api, errorMessage, LOCK_EVENT } from '../api.ts';
import { dialog, fade } from '../motion.ts';
import { encodePattern } from '../../shared/credential.ts';
import type { VaultStatus } from '../../shared/types.ts';
import { CREDENTIAL_NAMES, PatternInput } from './credential.tsx';
import { Dial } from './Dial.tsx';
import { StorageDialog } from './StorageDialog.tsx';
import type { StorageMode } from './StorageDialog.tsx';
import type { DialState } from './Dial.tsx';
import { Button, IconButton, OtpInput } from './ui.tsx';

export { PinWarning } from './credential.tsx';

/** A quiet sketch of the app behind the unlock dialog. It holds no data. */
/** A faint outline of the app behind the lock card: sidebar, then the inset panel with the list and an item. */
function Backdrop() {
  return (
    <div className="lock-backdrop" aria-hidden="true">
      <div className="sk-sidebar">
        <span className="sk sk-brand" />
        <span className="sk sk-input" />
        {Array.from({ length: 4 }, (_, i) => (
          <span key={i} className="sk sk-nav" style={{ width: `${55 + ((i * 17) % 30)}%` }} />
        ))}
        <span className="sk sk-heading" />
        {Array.from({ length: 5 }, (_, i) => (
          <span key={`c${i}`} className="sk sk-nav" style={{ width: `${45 + ((i * 23) % 35)}%` }} />
        ))}
        <span className="sk-grow" />
        <span className="sk sk-foot" />
      </div>
      <div className="sk-panel">
        <div className="sk-list">
          <div className="sk-list-head">
            <span className="sk sk-title" />
            <span className="sk sk-btn" />
          </div>
          <span className="sk sk-input" />
          {Array.from({ length: 9 }, (_, i) => (
            <div key={i} className="sk-row">
              <span className="sk sk-tile" />
              <div>
                <span className="sk sk-line" style={{ width: `${45 + ((i * 23) % 40)}%` }} />
                <span className="sk sk-line sk-line-sm" style={{ width: `${30 + ((i * 13) % 30)}%` }} />
              </div>
            </div>
          ))}
        </div>
        <div className="sk-detail">
          <div className="sk-toolbar" />
          <div className="sk-detail-body">
            <div className="sk-hero">
              <span className="sk sk-tile sk-tile-lg" />
              <div>
                <span className="sk sk-line sk-line-lg" />
                <span className="sk sk-line sk-line-sm" />
              </div>
            </div>
            <div className="sk-detail-grid">
              <div className="sk-col">
                <span className="sk sk-card" />
                <span className="sk sk-card sk-card-sm" />
              </div>
              <div className="sk-col">
                <span className="sk sk-card sk-card-sm" />
                <span className="sk sk-card sk-card-md" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function LockScreen({ status, onUnlocked }: { status: VaultStatus; onUnlocked: (s: VaultStatus) => void }) {
  const vaultKind = status.credential.type;
  const pinVault = status.credential.type === 'pin' ? status.credential.length : null;
  const [storageMode, setStorageMode] = useState<StorageMode | null>(null);
  const [quick, setQuick] = useState(status.pin);
  const [method, setMethod] = useState<'pin' | 'primary'>((vaultKind === 'password' || vaultKind === 'passphrase') && status.pin?.available ? 'pin' : 'primary');
  const [password, setPassword] = useState('');
  const [digits, setDigits] = useState('');
  const [pattern, setPattern] = useState<number[]>([]);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capsLock, setCapsLock] = useState(false);
  const [lockoutUntil, setLockoutUntil] = useState(status.lockoutUntil);
  const [now, setNow] = useState(Date.now());
  const input = useRef<HTMLInputElement>(null);
  const [card, animateCard] = useAnimate();

  /** Which input this screen shows. */
  const kind = method === 'pin' && quick?.available ? 'pin' : vaultKind;
  const isText = kind === 'password' || kind === 'passphrase';
  const otpLength = kind !== 'pin' ? null : (pinVault ?? quick?.length ?? null);

  useEffect(() => {
    if (!lockoutUntil) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [lockoutUntil]);
  const waitSeconds = lockoutUntil ? Math.max(0, Math.ceil((lockoutUntil - now) / 1000)) : 0;

  const canSubmit = !busy && !verified && waitSeconds === 0 && password.length > 0;

  const fail = async (err: unknown) => {
    setBusy(false);
    setFailed(true);
    setDeclined(true);
    window.setTimeout(() => setDeclined(false), 1200);
    setError(errorMessage(err));
    void animateCard(card.current, { x: [0, -6, 6, -4, 4, 0] }, { duration: 0.32 });
    const s = await api.status().catch(() => null);
    if (s) {
      setLockoutUntil(s.lockoutUntil);
      setQuick(s.pin);
      if (method === 'pin' && !s.pin?.available) setMethod('primary');
    }
  };

  /** Show the green "verified" state and let the dial swing open before entering the vault. */
  const succeed = (next: VaultStatus) => {
    setBusy(false);
    setVerified(true);
    window.setTimeout(() => onUnlocked(next), 750);
  };

  async function attempt(run: () => Promise<VaultStatus>, after?: () => void) {
    if (busy || verified || waitSeconds > 0) return;
    setError(null);
    setBusy(true);
    try {
      succeed(await run());
    } catch (err) {
      after?.();
      await fail(err);
    }
  }

  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!canSubmit) return;
    void attempt(() => api.unlock(password), () => requestAnimationFrame(() => input.current?.select()));
  }

  const submitDigits = (value: string) =>
    void attempt(
      () => (pinVault ? api.unlock(value) : api.unlockPin(value)),
      () => setDigits(''),
    );

  const submitPattern = (points: number[]) =>
    void attempt(
      () => api.unlock(encodePattern(points)),
      () => window.setTimeout(() => setPattern([]), 700),
    );

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => setCapsLock(e.getModifierState?.('CapsLock') ?? false);

  const dialState: DialState = verified ? 'success' : busy ? 'busy' : declined ? 'error' : 'idle';
  const turns = kind === 'pin' ? digits.length * 5 : kind === 'pattern' ? pattern.length * 5 : password.length;
  const locked = busy || verified;
  const name = CREDENTIAL_NAMES[kind];

  const lede =
    kind === 'pin'
      ? `Enter your ${otpLength}-digit PIN to unlock.`
      : kind === 'pattern'
        ? 'Draw your pattern to unlock.'
        : quick && !quick.available
          ? `Enter your ${name}. PIN unlock comes back once you’ve used it.`
          : `Enter your ${name} to unlock.`;

  return (
    <main className="lock">
      <Backdrop />
      <div className="lock-overlay" />
      <div className="lock-center">
        <motion.section ref={card} className="lock-card" role="dialog" aria-modal="true" aria-labelledby="lock-title" aria-describedby="lock-lede" {...dialog}>
          <Dial turns={turns} state={dialState} size={176} />
          <h1 id="lock-title" className="lock-title">
            Welcome back
          </h1>
          <p id="lock-lede" className="lock-lede">
            {lede}
          </p>

          {kind === 'pin' ? (
            <form key={`pin-${otpLength}`} className="lock-form" onSubmit={submit}>
                <OtpInput
                  id="unlock-pin"
                  label={`${otpLength}-digit PIN`}
                  length={otpLength!}
                  value={digits}
                  autoFocus
                  disabled={locked || waitSeconds > 0}
                  invalid={failed && !digits}
                  success={verified}
                  onChange={(v) => {
                    setDigits(v);
                    setFailed(false);
                    if (error) setError(null);
                  }}
                  onComplete={submitDigits}
                  describedBy="lock-status"
                />
            </form>
          ) : kind === 'pattern' ? (
            <form key="pattern" className="lock-form lock-form-pattern" onSubmit={submit}>
                <PatternInput
                  value={pattern}
                  onChange={(p) => {
                    setPattern(p);
                    setFailed(false);
                    if (error) setError(null);
                  }}
                  onComplete={submitPattern}
                  label="Unlock pattern"
                  state={verified ? 'success' : declined ? 'error' : 'idle'}
                  disabled={locked || waitSeconds > 0}
                />
            </form>
          ) : (
            <form key={`text-${kind}`} className="lock-form" onSubmit={submit}>
              <div className="input-icon">
                {kind === 'passphrase' ? <WholeWord size={17} aria-hidden="true" className="input-icon-lead" /> : <Lock size={17} aria-hidden="true" className="input-icon-lead" />}
                <label htmlFor="master" className="visually-hidden">
                  {kind === 'passphrase' ? 'Passphrase' : 'Master password'}
                </label>
                <input
                  ref={input}
                  id="master"
                  type={show ? 'text' : 'password'}
                  className={`input input-lg${show ? ' input-mono' : ''}`}
                  data-state={verified ? 'success' : undefined}
                  placeholder={kind === 'passphrase' ? 'Passphrase' : 'Master password'}
                  autoComplete="current-password"
                  autoFocus
                  spellCheck={false}
                  value={password}
                  disabled={locked}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setFailed(false);
                    if (error) setError(null);
                  }}
                  onKeyDown={onKey}
                  onKeyUp={onKey}
                  aria-invalid={failed || undefined}
                  aria-describedby="lock-status"
                />
                <IconButton label={show ? 'Hide' : 'Show'} onClick={() => setShow(!show)} className="input-icon-trail">
                  {show ? <EyeOff size={17} /> : <Eye size={17} />}
                </IconButton>
              </div>

              <Button type="submit" variant="primary" size="lg" className="btn-block" loading={busy} disabled={!canSubmit}>
                Unlock
              </Button>
            </form>
          )}

          <div id="lock-status" className="lock-status" aria-live="assertive">
            <AnimatePresence mode="wait" initial={false}>
              {verified ? (
                <motion.p key="ok" className="form-success" {...fade}>
                  <Check size={14} strokeWidth={2.6} />
                  Unlocked
                </motion.p>
              ) : error ? (
                <motion.p key={`e-${error}`} className="form-error" {...fade}>
                  {error}
                </motion.p>
              ) : waitSeconds > 0 ? (
                <motion.p key="wait" className="form-error" {...fade}>
                  Too many attempts. Try again in {waitSeconds}s.
                </motion.p>
              ) : capsLock && isText ? (
                <motion.p key="caps" className="form-hint" {...fade}>
                  Caps Lock is on
                </motion.p>
              ) : null}
            </AnimatePresence>
          </div>

          {(vaultKind === 'password' || vaultKind === 'passphrase') && quick?.available && (
            <button
              type="button"
              className="text-btn lock-switch"
              disabled={locked}
              onClick={() => {
                setError(null);
                setDigits('');
                setMethod(method === 'pin' ? 'primary' : 'pin');
              }}
            >
              {method === 'pin' ? <KeyRound size={14} /> : <Grid3x3 size={14} />}
              {method === 'pin' ? `Use ${CREDENTIAL_NAMES[vaultKind]} instead` : 'Use PIN instead'}
            </button>
          )}

          <div className="lock-foot">
            <span className="lock-foot-item">
              <ShieldCheck size={13} aria-hidden="true" />
              AES-256 · Argon2id
            </span>
            <button type="button" className="lock-foot-item lock-db" onClick={() => setStorageMode('connect')} title={`${status.storage.path}\nChoose a different database file`}>
              <Database size={13} aria-hidden="true" />
              <span className="lock-db-name">{status.storage.path.split(/[\\/]/).pop()}</span>
              <span className="lock-db-change">Change</span>
            </button>
          </div>
          <StorageDialog
            mode={storageMode}
            storage={status.storage}
            credential={status.credential}
            onClose={() => setStorageMode(null)}
            onDone={() => {
              setStorageMode(null);
              window.dispatchEvent(new Event(LOCK_EVENT));
            }}
          />
        </motion.section>
      </div>
    </main>
  );
}
