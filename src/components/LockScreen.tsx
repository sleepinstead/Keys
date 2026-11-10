import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { AnimatePresence, motion, useAnimate } from 'motion/react';
import { Check, Database, Eye, EyeOff, Grid3x3, KeyRound, Lock, ShieldCheck, Sparkles, WholeWord } from 'lucide-react';
import { api, errorMessage, LOCK_EVENT } from '../api.ts';
import { collapse, dialog, fade } from '../motion.ts';
import { encodePattern, passphraseProblem, passphraseWords } from '../../shared/credential.ts';
import { generatePassword, isWeakPin } from '../../shared/generator.ts';
import type { VaultStatus } from '../../shared/types.ts';
import { CREDENTIAL_NAMES, CredentialPicker, PatternInput, PatternSetup, PinWarning } from './credential.tsx';
import type { CredentialChoice } from './credential.tsx';
import { Dial } from './Dial.tsx';
import { StorageDialog } from './StorageDialog.tsx';
import type { StorageMode } from './StorageDialog.tsx';
import type { DialState } from './Dial.tsx';
import { Button, IconButton, OtpInput, StrengthMeter, useStrength } from './ui.tsx';

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
  const creating = !status.initialized;
  const vaultKind = status.credential.type;
  const pinVault = status.credential.type === 'pin' ? status.credential.length : null;
  const [choice, setChoice] = useState<CredentialChoice>({ type: 'password', pinLength: 6 });
  const [storageMode, setStorageMode] = useState<StorageMode | null>(null);
  const [quick, setQuick] = useState(status.pin);
  const [method, setMethod] = useState<'pin' | 'primary'>(!creating && (vaultKind === 'password' || vaultKind === 'passphrase') && status.pin?.available ? 'pin' : 'primary');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [digits, setDigits] = useState('');
  const [digitsAgain, setDigitsAgain] = useState('');
  const [pattern, setPattern] = useState<number[]>([]);
  const [newPattern, setNewPattern] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  const [suggested, setSuggested] = useState<string | null>(null);
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
  const kind = creating ? choice.type : method === 'pin' && quick?.available ? 'pin' : vaultKind;
  const isText = kind === 'password' || kind === 'passphrase';
  const otpLength = kind !== 'pin' ? null : creating ? choice.pinLength : pinVault ?? quick?.length ?? null;
  const strength = useStrength(creating && isText ? password : '');

  useEffect(() => {
    if (!lockoutUntil) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [lockoutUntil]);
  const waitSeconds = lockoutUntil ? Math.max(0, Math.ceil((lockoutUntil - now) / 1000)) : 0;

  // Setup checks.
  const matches = confirm.length > 0 && confirm === password;
  const strongEnough = (strength?.score ?? 0) >= 3 && password.length >= 10;
  const phraseIssue = kind === 'passphrase' ? passphraseProblem(password) : null;
  const pinComplete = otpLength !== null && digits.length === otpLength;
  const pinWeak = pinComplete && isWeakPin(digits);
  const pinMatches = pinComplete && digitsAgain === digits;
  const canCreate =
    kind === 'password'
      ? strongEnough && matches
      : kind === 'passphrase'
        ? !phraseIssue && (strength?.score ?? 0) >= 3 && matches
        : kind === 'pin'
          ? pinComplete && !pinWeak && pinMatches
          : newPattern !== null;
  const canSubmit = !busy && !verified && waitSeconds === 0 && (creating ? canCreate : password.length > 0);

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
    if (!canSubmit && !(creating && canCreate)) return;
    if (creating) {
      const value = kind === 'pin' ? digits : kind === 'pattern' ? newPattern! : password;
      void attempt(() => api.setup(value, kind), () => {
        setDigits('');
        setDigitsAgain('');
      });
    } else {
      void attempt(() => api.unlock(password), () => requestAnimationFrame(() => input.current?.select()));
    }
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

  function choose(c: CredentialChoice) {
    setChoice(c);
    setPassword('');
    setConfirm('');
    setDigits('');
    setDigitsAgain('');
    setNewPattern(null);
    setSuggested(null);
    setError(null);
  }

  function suggest() {
    const phrase =
      kind === 'passphrase'
        ? generatePassword({ mode: 'passphrase', words: 5, separator: ' ', capitalize: false, includeNumber: false })
        : generatePassword({ mode: 'passphrase', words: 5, separator: '-', capitalize: true, includeNumber: true });
    setPassword(phrase);
    setConfirm(phrase);
    setSuggested(phrase);
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => setCapsLock(e.getModifierState?.('CapsLock') ?? false);

  const dialState: DialState = verified ? 'success' : busy ? 'busy' : declined ? 'error' : creating && canCreate ? 'ready' : 'idle';
  const turns =
    kind === 'pin'
      ? (digits.length + digitsAgain.length) * 5
      : kind === 'pattern'
        ? (creating ? (newPattern ? 9 : 0) : pattern.length) * 5
        : password.length + confirm.length;
  const locked = busy || verified;
  const name = CREDENTIAL_NAMES[kind];

  const lede = creating
    ? `Choose how you’ll unlock. Whatever you pick encrypts everything here and can’t be recovered.`
    : kind === 'pin'
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
          <Dial turns={turns} state={dialState} size={creating ? 150 : 176} />
          <h1 id="lock-title" className="lock-title">
            {creating ? 'Get started' : 'Welcome back'}
          </h1>
          <p id="lock-lede" className="lock-lede">
            {lede}
          </p>

          {creating && (
            <div className="lock-tabs">
              <CredentialPicker value={choice} onChange={choose} />
            </div>
          )}

          {kind === 'pin' ? (
            <form key={`pin-${otpLength}`} className="lock-form" onSubmit={submit}>
              {creating ? (
                <>
                  <div className="field">
                    <div className="field-row">
                      <span className="field-label">PIN</span>
                      <button type="button" className="text-btn" onClick={() => setShow(!show)} aria-pressed={show}>
                        {show ? <EyeOff size={14} /> : <Eye size={14} />}
                        {show ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    <OtpInput
                      id="setup-pin"
                      label={`New ${otpLength}-digit PIN`}
                      length={otpLength!}
                      value={digits}
                      masked={!show}
                      autoFocus
                      disabled={locked}
                      invalid={pinWeak}
                      onChange={(v) => {
                        setDigits(v);
                        if (v.length < otpLength!) setDigitsAgain('');
                      }}
                      onComplete={(v) => !isWeakPin(v) && requestAnimationFrame(() => document.getElementById('setup-pin-again')?.focus())}
                      describedBy="lock-status"
                    />
                  </div>
                  <div className="field">
                    <span className="field-label">Confirm PIN</span>
                    <OtpInput
                      id="setup-pin-again"
                      label="Confirm PIN"
                      length={otpLength!}
                      value={digitsAgain}
                      masked={!show}
                      disabled={locked || !pinComplete || pinWeak}
                      invalid={digitsAgain.length === otpLength && !pinMatches}
                      success={pinMatches}
                      onChange={setDigitsAgain}
                    />
                  </div>
                  <ul className="checklist">
                    <li data-ok={pinComplete || undefined}>{otpLength} digits</li>
                    <li data-ok={(pinComplete && !pinWeak) || undefined} data-bad={pinWeak || undefined}>
                      {pinWeak ? 'Too easy to guess: avoid patterns, repeats and years' : 'Not an obvious one like 1234, 0000 or a year'}
                    </li>
                    <li data-ok={pinMatches || undefined}>Both entries match</li>
                  </ul>
                  <PinWarning length={otpLength!} />
                  <Button type="submit" variant="primary" size="lg" className="btn-block" loading={busy} disabled={!canCreate || locked}>
                    Set up
                  </Button>
                </>
              ) : (
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
              )}
            </form>
          ) : kind === 'pattern' ? (
            <form key="pattern" className="lock-form lock-form-pattern" onSubmit={submit}>
              {creating ? (
                <>
                  <PatternSetup onChange={setNewPattern} disabled={locked} />
                  <PinWarning pattern />
                  <Button type="submit" variant="primary" size="lg" className="btn-block" loading={busy} disabled={!canCreate || locked}>
                    Set up
                  </Button>
                </>
              ) : (
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
              )}
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
                  placeholder={kind === 'passphrase' ? (creating ? 'Four or more words' : 'Passphrase') : 'Master password'}
                  autoComplete={creating ? 'new-password' : 'current-password'}
                  autoFocus
                  spellCheck={false}
                  value={password}
                  disabled={locked}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setSuggested(null);
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

              {creating && (
                <>
                  <AnimatePresence initial={false}>
                    {suggested && (
                      <motion.div className="collapse" {...collapse}>
                        <div className="suggestion">
                          <span className="suggestion-label">Suggested {name}</span>
                          <p className="suggestion-value">{suggested}</p>
                          <p className="suggestion-note">Write it down or memorise it before you continue.</p>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                  <div className="lock-row">
                    <StrengthMeter result={password ? strength : null} />
                    <button type="button" className="text-btn" onClick={suggest} disabled={locked}>
                      <Sparkles size={14} />
                      {suggested ? 'Suggest another' : 'Suggest one'}
                    </button>
                  </div>
                  <div className="input-icon">
                    {kind === 'passphrase' ? <WholeWord size={17} aria-hidden="true" className="input-icon-lead" /> : <Lock size={17} aria-hidden="true" className="input-icon-lead" />}
                    <label htmlFor="confirm" className="visually-hidden">
                      Confirm
                    </label>
                    <input
                      id="confirm"
                      type={show ? 'text' : 'password'}
                      className={`input input-lg${show ? ' input-mono' : ''}`}
                      placeholder={kind === 'passphrase' ? 'Confirm passphrase' : 'Confirm master password'}
                      autoComplete="new-password"
                      spellCheck={false}
                      value={confirm}
                      disabled={locked}
                      onChange={(e) => setConfirm(e.target.value)}
                      onKeyDown={onKey}
                    />
                    {matches && (
                      <span className="input-icon-trail input-check" aria-label="Entries match">
                        <Check size={16} strokeWidth={2.6} />
                      </span>
                    )}
                  </div>
                  <ul className="checklist">
                    {kind === 'passphrase' ? (
                      <>
                        <li data-ok={passphraseWords(password).length >= 4 || undefined}>At least 4 words ({passphraseWords(password).length} so far)</li>
                        <li data-ok={(password.length > 0 && !phraseIssue) || undefined} data-bad={(passphraseWords(password).length >= 4 && phraseIssue) || undefined}>
                          {passphraseWords(password).length >= 4 && phraseIssue ? phraseIssue : 'Each word 3+ letters, no repeats'}
                        </li>
                      </>
                    ) : (
                      <li data-ok={password.length >= 10 || undefined}>At least 10 characters</li>
                    )}
                    <li data-ok={(strength?.score ?? 0) >= 3 || undefined}>Rated Strong or better</li>
                    <li data-ok={matches || undefined}>Both entries match</li>
                  </ul>
                </>
              )}

              <Button type="submit" variant="primary" size="lg" className="btn-block" loading={busy} disabled={!canSubmit}>
                {creating ? 'Set up' : 'Unlock'}
              </Button>
            </form>
          )}

          <div id="lock-status" className="lock-status" aria-live="assertive">
            <AnimatePresence mode="wait" initial={false}>
              {verified ? (
                <motion.p key="ok" className="form-success" {...fade}>
                  <Check size={14} strokeWidth={2.6} />
                  {creating ? 'All set' : 'Unlocked'}
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

          {!creating && (vaultKind === 'password' || vaultKind === 'passphrase') && quick?.available && (
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
            credential={status.initialized ? status.credential : null}
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
