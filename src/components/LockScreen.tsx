import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { AnimatePresence, motion, useAnimate } from 'motion/react';
import { ArrowLeft, ArrowRight, Asterisk, Check, CloudOff, Database, Eye, EyeOff, Grid3x3, Hash, HardDrive, KeyRound, Lock, ShieldCheck, Sparkles, WholeWord } from 'lucide-react';
import type { ReactNode } from 'react';
import { api, errorMessage, LOCK_EVENT } from '../api.ts';
import { collapse, dialog, fade } from '../motion.ts';
import { encodePattern, passphraseProblem, passphraseWords } from '../../shared/credential.ts';
import { generatePassword, isWeakPin } from '../../shared/generator.ts';
import type { VaultStatus } from '../../shared/types.ts';
import { CREDENTIAL_NAMES, PatternInput, PatternSetup, PinWarning } from './credential.tsx';
import type { CredentialChoice } from './credential.tsx';
import { Dial } from './Dial.tsx';
import { StorageDialog } from './StorageDialog.tsx';
import type { StorageMode } from './StorageDialog.tsx';
import type { DialState } from './Dial.tsx';
import { AppMark, Button, IconButton, OtpInput, Segmented, StrengthMeter, useStrength } from './ui.tsx';

export { PinWarning } from './credential.tsx';

let snapshot: HTMLElement | null = null;

/**
 * Keeps a copy of the app as it looked when it locked, to show blurred behind the lock card.
 * Every letter, value and label is scrubbed first, so the copy holds no vault data.
 */
export function captureBackdrop() {
  const live = [...document.querySelectorAll('.screen > *')].findLast((el) => !el.classList.contains('lock'));
  if (!live) return;
  const copy = live.cloneNode(true) as HTMLElement;
  const walk = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
  for (let t = walk.nextNode(); t; t = walk.nextNode()) t.nodeValue = t.nodeValue!.replace(/\S/g, 'x');
  for (const el of copy.querySelectorAll('*')) {
    for (const a of ['id', 'value', 'title', 'aria-label', 'alt', 'href', 'placeholder', 'name']) el.removeAttribute(a);
    // The app's own images (its logo) stay; anything else, like a site's icon, goes.
    if (el instanceof HTMLImageElement && !el.src.startsWith('data:') && new URL(el.src, location.href).origin !== location.origin) el.removeAttribute('src');
  }
  copy.querySelectorAll('input, textarea').forEach((i) => ((i as HTMLInputElement).value = ''));
  copy.inert = true;
  snapshot = copy;
}

/** Whether the lock screen opens over a copy of the app (so it needn't fade in). */
export const hasBackdrop = () => snapshot !== null;

function Backdrop() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (snapshot && host.current) host.current.replaceChildren(snapshot);
  }, []);
  if (snapshot) return <div ref={host} className="lock-backdrop lock-backdrop-live" aria-hidden="true" />;
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
  /** Setup is three steps: welcome, choose how to unlock, create it. */
  const [step, setStep] = useState(0);
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

  function goTo(next: number) {
    setError(null);
    if (next < 2) choose(choice); // going back clears anything half-typed
    setStep(next);
  }

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
    ? 'Choose how you’ll unlock. It can’t be recovered if you forget it.'
    : kind === 'pin'
      ? `Enter your ${otpLength}-digit PIN to unlock.`
      : kind === 'pattern'
        ? 'Draw your pattern to unlock.'
        : quick && !quick.available
          ? `Enter your ${name}. PIN unlock comes back once you’ve used it.`
          : `Enter your ${name} to unlock.`;

  const formBlock = kind === 'pin' ? (
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
                    <li data-ok={(pinComplete && !pinWeak) || undefined} data-bad={pinWeak || undefined}>
                      {pinWeak ? 'Too easy to guess: avoid patterns, repeats and years' : 'Not an obvious one like 1234, 0000 or a year'}
                    </li>
                    <li data-ok={pinMatches || undefined}>Both entries match</li>
                  </ul>
                  <Button type="submit" variant="primary" size="lg" className="btn-block lock-submit" loading={busy} disabled={!canCreate || locked}>
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
                        {/* Too long for the field to show whole, so it's spelled out here in one compact line. */}
                        <p className="suggestion-note">
                          <span className="suggestion-inline">{suggested}</span> Write it down before you continue.
                        </p>
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

              <Button type="submit" variant="primary" size="lg" className="btn-block lock-submit" loading={busy} disabled={!canSubmit}>
                {creating ? 'Set up' : 'Unlock'}
              </Button>
            </form>
          );

  const statusBlock = (
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
  );

  const storageDialog = (
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
  );

  if (creating) {
    return (
      <Onboarding
        step={step}
        onStep={goTo}
        choice={choice}
        onChoose={choose}
        storage={status.storage}
        onChangeStorage={() => setStorageMode('connect')}
        locked={locked || busy || verified}
        turns={turns}
        dialState={dialState}
        form={formBlock}
        statusLine={statusBlock}
        storageDialog={storageDialog}
        cardRef={card}
      />
    );
  }

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

          {formBlock}

          {statusBlock}

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
          {storageDialog}
        </motion.section>
      </div>
    </main>
  );
}

const STEPS = ['Welcome', 'Choose how to unlock', 'Create it'];

/** Three segments: done ones full, the current one filling in. */
function StepProgress({ step }: { step: number }) {
  return (
    <span className="step-progress" role="progressbar" aria-label="Setup progress" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={step + 1} aria-valuetext={`Step ${step + 1} of ${STEPS.length}`}>
      {STEPS.map((label, i) => (
        <span key={label} className="step-progress-seg" data-state={i < step ? 'done' : i === step ? 'current' : undefined} />
      ))}
    </span>
  );
}

/** Points on the orbit above the stage dial (0° = top, clockwise), in the dial's 200-unit space. */
function orbitPoint(deg: number, r: number) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [100 + r * Math.cos(a), 100 + r * Math.sin(a)] as const;
}
function orbitArc(from: number, to: number, r = 96) {
  const [x1, y1] = orbitPoint(from, r);
  const [x2, y2] = orbitPoint(to, r);
  return `M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`;
}

/** First run, full screen: a short welcome, the choice of password or PIN, then creating it. */
function Onboarding({
  step,
  onStep,
  choice,
  onChoose,
  storage,
  onChangeStorage,
  locked,
  turns,
  dialState,
  form,
  statusLine,
  storageDialog,
  cardRef,
}: {
  step: number;
  onStep: (n: number) => void;
  choice: CredentialChoice;
  onChoose: (c: CredentialChoice) => void;
  storage: VaultStatus['storage'];
  onChangeStorage: () => void;
  locked: boolean;
  turns: number;
  dialState: DialState;
  form: ReactNode;
  statusLine: ReactNode;
  storageDialog: ReactNode;
  cardRef: React.RefObject<HTMLDivElement | null> | ((el: HTMLDivElement | null) => void) | React.Ref<HTMLDivElement>;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  // Each step announces itself and takes focus, except the very first paint.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (step < 2) heading.current?.focus();
  }, [step]);
  const fileName = storage.path.split(/[\\/]/).pop();
  const isPin = choice.type === 'pin';

  return (
    <main className="onboard">
      {/* The stage: Keys' own dial, large. It turns a quarter for each step and a tick per key typed,
          and the orbit above it tracks progress through setup. */}
      <div className="onboard-stage" aria-hidden="true">
        <div className="onboard-brand">
          <AppMark size="sm" />
          <span className="wordmark">Keys</span>
        </div>
        <div className="onboard-dial">
          <svg className="onboard-orbit" viewBox="0 0 200 200">
            <path className="onboard-orbit-track" d={orbitArc(-48, 48)} />
            <motion.path
              className="onboard-orbit-fill"
              d={orbitArc(-48, 48)}
              initial={false}
              animate={{ pathLength: step / (STEPS.length - 1) }}
              transition={{ duration: 0.6, ease: [0.2, 0, 0, 1] }}
            />
            {STEPS.map((label, i) => {
              const [x, y] = orbitPoint(-48 + i * 48, 96);
              const [lx, ly] = orbitPoint(-48 + i * 48, 106);
              return (
                <g key={label} className="onboard-node" data-state={i < step ? 'done' : i === step ? 'current' : undefined}>
                  <circle cx={x} cy={y} r={i === step ? 3.2 : 2.2} />
                  <text x={lx} y={ly} textAnchor="middle">{String(i + 1).padStart(2, '0')}</text>
                </g>
              );
            })}
          </svg>
          <Dial turns={turns + step * 15} state={dialState} size={200} />
        </div>
        <p className="onboard-stage-caption">
          <ShieldCheck size={13} aria-hidden="true" />
          AES-256 · Argon2id · stays on this computer
        </p>
      </div>

      <section className="onboard-main">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={step}
            ref={cardRef as React.Ref<HTMLDivElement>}
            className="onboard-panel"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6, transition: { duration: 0.12 } }}
            transition={{ duration: 0.28, ease: [0.2, 0, 0, 1] }}
          >
            {step === 0 && (
              <>
                <p className="onboard-eyebrow"><StepProgress step={0} />Welcome to Keys</p>
                <h1 ref={heading} tabIndex={-1} className="onboard-title">
                  Your passwords, kept on this computer.
                </h1>
                <p className="onboard-lede">Keys keeps your logins, notes and codes safe in one encrypted file. Setup takes a minute.</p>
                <ul className="onboard-points">
                  <li>
                    <span className="tile-icon"><Lock size={17} /></span>
                    <span>
                      <strong>Encrypted before it’s saved</strong>
                      <span>Only your password or PIN can open it.</span>
                    </span>
                  </li>
                  <li>
                    <span className="tile-icon"><HardDrive size={17} /></span>
                    <span>
                      <strong>One file you control</strong>
                      <span>
                        Saved as <code>{fileName}</code>.{' '}
                        <button type="button" className="onboard-inline-btn" onClick={onChangeStorage}>
                          Use a different file
                        </button>
                      </span>
                    </span>
                  </li>
                  <li>
                    <span className="tile-icon"><CloudOff size={17} /></span>
                    <span>
                      <strong>No account, no cloud</strong>
                      <span>Nothing leaves this computer.</span>
                    </span>
                  </li>
                </ul>
                <div className="onboard-actions">
                  <Button variant="primary" size="lg" onClick={() => onStep(1)} iconRight={<ArrowRight size={16} />} autoFocus>
                    Get started
                  </Button>
                </div>
              </>
            )}

            {step === 1 && (
              <>
                <p className="onboard-eyebrow"><StepProgress step={1} />Choose how to unlock</p>
                <h1 ref={heading} tabIndex={-1} className="onboard-title">
                  How will you unlock Keys?
                </h1>
                <p className="onboard-lede">You’ll use it every time Keys locks. It can’t be recovered if you forget it.</p>
                <div className="onboard-options" role="radiogroup" aria-label="Unlock with">
                  {(
                    [
                      { type: 'password', icon: <Asterisk size={18} />, title: 'Password', badge: 'Strongest', tone: 'good', text: '10 or more characters. Best if you keep anything important here.' },
                      { type: 'pin', icon: <Hash size={18} />, title: 'PIN', badge: choice.pinLength === 4 && isPin ? 'Weakest' : 'Weaker', tone: choice.pinLength === 4 && isPin ? 'bad' : 'warn', text: 'Quick to type, but easy to crack if someone copies your file.' },
                    ] as const
                  ).map((o) => (
                    <button
                      key={o.type}
                      type="button"
                      role="radio"
                      aria-checked={choice.type === o.type}
                      className="onboard-option"
                      onClick={() => onChoose({ ...choice, type: o.type })}
                    >
                      <span className="tile-icon">{o.icon}</span>
                      <span className="onboard-option-text">
                        <span className="onboard-option-title">
                          {o.title}
                          <span className="badge" data-tone={o.tone}>{o.badge}</span>
                        </span>
                        <span className="onboard-option-desc">{o.text}</span>
                      </span>
                      <span className="onboard-radio" aria-hidden="true" />
                    </button>
                  ))}
                </div>
                <AnimatePresence initial={false}>
                  {isPin && (
                    <motion.div className="collapse" {...collapse}>
                      <div className="onboard-pin-length">
                        <span className="field-label">PIN length</span>
                        <Segmented
                          label="PIN length"
                          size="sm"
                          value={String(choice.pinLength) as '4' | '6'}
                          onChange={(v) => onChoose({ ...choice, pinLength: Number(v) as 4 | 6 })}
                          options={[
                            { value: '6', label: '6 digits' },
                            { value: '4', label: '4 digits' },
                          ]}
                        />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
                <div className="onboard-actions">
                  <Button variant="ghost" size="lg" onClick={() => onStep(0)} icon={<ArrowLeft size={16} />}>
                    Back
                  </Button>
                  <Button variant="primary" size="lg" onClick={() => onStep(2)} iconRight={<ArrowRight size={16} />}>
                    Continue
                  </Button>
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <p className="onboard-eyebrow"><StepProgress step={2} />Create it</p>
                <h1 className="onboard-title">{isPin ? `Create a ${choice.pinLength}-digit PIN` : 'Create your master password'}</h1>
                <p className="onboard-lede">{isPin ? 'Avoid anything obvious like 1234, repeats or a year.' : 'Make it long and memorable, or let Keys suggest one. Write it down somewhere safe.'}</p>
                {form}
                {statusLine}
                <div className="onboard-actions onboard-actions-back">
                  <Button variant="ghost" onClick={() => onStep(1)} disabled={locked} icon={<ArrowLeft size={16} />}>
                    Back
                  </Button>
                </div>
              </>
            )}
          </motion.div>
        </AnimatePresence>
      </section>
      {storageDialog}
    </main>
  );
}
