import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, Check, Eye, EyeOff, Grid3x3, KeyRound, Lock, Sparkles, WholeWord } from 'lucide-react';
import { api, errorMessage, LOCK_EVENT } from '../api.ts';
import { ease } from '../motion.ts';
import { passphraseProblem, passphraseWords } from '../../shared/credential.ts';
import { generatePassword, isWeakPin } from '../../shared/generator.ts';
import type { CredentialType, VaultStatus } from '../../shared/types.ts';
import { PatternSetup, PinWarning } from './credential.tsx';
import { Dial } from './Dial.tsx';
import type { DialState } from './Dial.tsx';
import { StorageDialog } from './StorageDialog.tsx';
import type { StorageMode } from './StorageDialog.tsx';
import { AppMark, Button, IconButton, OtpInput, Segmented, StrengthMeter, useStrength } from './ui.tsx';

type Step = 'welcome' | 'method' | 'secret' | 'confirm';

// Choosing a file reloads the app's status, which remounts this screen: come back to the same step.
let resumeAt: Step | null = null;

const METHODS: { type: CredentialType; title: string; note: string; icon: ReactNode }[] = [
  { type: 'password', title: 'Master password', note: 'The strongest choice. Recommended.', icon: <KeyRound size={18} /> },
  { type: 'passphrase', title: 'Passphrase', note: 'Several words that are easier to remember.', icon: <WholeWord size={18} /> },
  { type: 'pin', title: 'PIN', note: 'Quick to enter, far easier to crack.', icon: <Lock size={18} /> },
  { type: 'pattern', title: 'Pattern', note: 'Draw on a grid, far easier to crack.', icon: <Grid3x3 size={18} /> },
];

const SECRET_TITLE: Record<CredentialType, string> = {
  password: 'Choose a master password',
  passphrase: 'Choose a passphrase',
  pin: 'Choose a PIN',
  pattern: 'Draw a pattern',
};

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

const slide = {
  enter: (dir: number) => ({ opacity: 0, x: dir * 18 }),
  center: { opacity: 1, x: 0, transition: { duration: 0.26, ease } },
  exit: (dir: number) => ({ opacity: 0, x: dir * -12, transition: { duration: 0.12, ease } }),
};

/** First run: one question per screen, with the vault's dial turning as you go. */
export function Onboarding({
  status,
  onUnlocked,
  onClose,
}: {
  status: VaultStatus;
  onUnlocked?: (s: VaultStatus) => void;
  /** Set when replaying from Settings: nothing here changes the vault. */
  onClose?: () => void;
}) {
  const replay = !!onClose;
  const [step, setStep] = useState<Step>(() => (replay ? 'welcome' : (resumeAt ?? 'welcome')));
  const [dir, setDir] = useState(1);
  const [type, setType] = useState<CredentialType>('password');
  const [pinLength, setPinLength] = useState<4 | 6>(6);
  const [secret, setSecret] = useState('');
  const [again, setAgain] = useState('');
  const [pattern, setPattern] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storageMode, setStorageMode] = useState<StorageMode | null>(null);
  const shown = useRef(false);

  const isText = type === 'password' || type === 'passphrase';
  const strength = useStrength(isText ? secret : '');
  const score = strength?.score ?? 0;
  const words = passphraseWords(secret).length;
  const phraseIssue = type === 'passphrase' ? passphraseProblem(secret) : null;
  const pinWeak = type === 'pin' && secret.length === pinLength && isWeakPin(secret);

  const secretOk =
    replay ||
    (type === 'password'
      ? secret.length >= 10 && score >= 3
      : type === 'passphrase'
        ? !phraseIssue && score >= 3
        : type === 'pin'
          ? secret.length === pinLength && !pinWeak
          : pattern !== null);
  const matches = type !== 'pattern' && again.length > 0 && again === secret;
  const locked = busy || opening;

  const hint = !isText
    ? null
    : !secret
      ? type === 'password'
        ? 'At least 10 characters.'
        : 'Four or more words.'
      : type === 'password' && secret.length < 10
        ? `${10 - secret.length} more ${10 - secret.length === 1 ? 'character' : 'characters'} to go.`
        : type === 'passphrase' && words >= 4 && phraseIssue
          ? phraseIssue
          : type === 'passphrase' && words < 4
            ? `${4 - words} more ${4 - words === 1 ? 'word' : 'words'} to go.`
            : score < 3
              ? 'Too easy to guess. Make it less predictable.'
              : null;

  const go = (next: Step, direction = 1) => {
    setDir(direction);
    setError(null);
    setStep(next);
  };

  function pick(next: CredentialType) {
    if (next !== type) {
      setSecret('');
      setAgain('');
      setPattern(null);
    }
    setType(next);
    setShow(false);
    go('secret');
  }

  function suggest() {
    setSecret(
      type === 'passphrase'
        ? generatePassword({ mode: 'passphrase', words: 5, separator: ' ', capitalize: false, includeNumber: false })
        : generatePassword({ mode: 'passphrase', words: 5, separator: '-', capitalize: true, includeNumber: true }),
    );
    setAgain('');
    setShow(true); // it has to be seen to be remembered
  }

  async function create() {
    if (replay) return onClose();
    setError(null);
    setBusy(true);
    try {
      const next = await api.setup(type === 'pattern' ? pattern! : secret, type);
      setBusy(false);
      setOpening(true);
      // The dial swings open and the screen clears before the vault appears.
      window.setTimeout(() => onUnlocked!(next), 950);
    } catch (err) {
      setBusy(false);
      setDeclined(true);
      window.setTimeout(() => setDeclined(false), 1200);
      setAgain('');
      setError(errorMessage(err));
    }
  }

  function advance(e?: FormEvent) {
    e?.preventDefault();
    if (locked) return;
    if (step === 'secret' && secretOk) {
      if (type === 'pattern') void create();
      else {
        setShow(false);
        go('confirm');
      }
    } else if (step === 'confirm' && (matches || replay)) void create();
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => setCapsLock(e.getModifierState?.('CapsLock') ?? false);

  // On the element, not the step: the new heading only mounts once the old step has faded out.
  const focusHeading = useCallback(
    (el: HTMLHeadingElement | null) => {
      if (!el) return;
      if (shown.current || replay) el.focus({ preventScroll: true });
      shown.current = true;
    },
    [replay],
  );

  useEffect(() => {
    if (!onClose) return;
    const opener = document.activeElement as HTMLElement | null;
    const onEscape = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onEscape);
    return () => {
      window.removeEventListener('keydown', onEscape);
      opener?.focus();
    };
  }, [onClose]);

  const stepIndex = ['welcome', 'method', 'secret', 'confirm'].indexOf(step);
  const typed = type === 'pin' ? (secret.length + again.length) * 3 : type === 'pattern' ? (pattern ? 15 : 0) : secret.length + again.length;
  const ready = step === 'confirm' ? matches : false;
  const dialState: DialState = opening ? 'success' : busy ? 'busy' : declined ? 'error' : ready ? 'ready' : 'idle';

  const total = type === 'pattern' ? 2 : 3;
  const canChangeFile = !replay && (step === 'welcome' || step === 'method');
  const custom = !status.storage.isDefault;
  const usesInput = !replay && (step === 'secret' || step === 'confirm') && type !== 'pattern';
  const Root = replay ? 'div' : 'main';

  const passwordField = (id: string, label: string, value: string, set: (v: string) => void, trailing: ReactNode) => (
    <div className="ob-field">
      <label htmlFor={id} className="visually-hidden">
        {label}
      </label>
      <input
        id={id}
        className={`ob-input${show ? ' ob-input-plain' : ''}`}
        type={show ? 'text' : 'password'}
        placeholder={replay ? 'Yours goes here' : label}
        autoComplete="new-password"
        spellCheck={false}
        autoFocus={!replay}
        disabled={locked || replay}
        value={value}
        onChange={(e) => {
          set(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={onKey}
        onKeyUp={onKey}
        aria-describedby="ob-status"
      />
      {trailing}
    </div>
  );

  const eye = (
    <IconButton label={show ? 'Hide' : 'Show'} onClick={() => setShow(!show)}>
      {show ? <EyeOff size={18} /> : <Eye size={18} />}
    </IconButton>
  );

  return (
    <Root className={replay ? 'ob ob-replay' : 'ob'} data-opening={opening || undefined} {...(replay ? { role: 'dialog', 'aria-modal': true, 'aria-label': 'Onboarding' } : {})}>
      <div className="ob-dial">
        <Dial turns={stepIndex * 12 + typed} state={dialState} size={720} />
      </div>

      <header className="ob-top">
        <AppMark size="sm" />
        <span className="wordmark">Keys</span>
        {replay && (
          <Button variant="outline" size="sm" className="ob-close" onClick={onClose}>
            Close
          </Button>
        )}
      </header>

      <div className="ob-scroll">
        <AnimatePresence mode="wait" initial={false} custom={dir}>
          <motion.div key={step} className="ob-main" custom={dir} variants={slide} initial="enter" animate="center" exit="exit">
            {step !== 'welcome' && (
              <div className="ob-nav">
                <IconButton
                  label="Back"
                  disabled={locked}
                  onClick={() => (step === 'method' ? go('welcome', -1) : step === 'secret' ? go('method', -1) : go('secret', -1))}
                >
                  <ArrowLeft size={18} />
                </IconButton>
                <span>
                  Step {stepIndex} of {total}
                </span>
              </div>
            )}

            {step === 'welcome' && (
              <>
                <h1 ref={focusHeading} tabIndex={-1} className="ob-hero">
                  Every password.
                  <br />
                  One lock.
                </h1>
                <p className="ob-lede">Keys keeps your passwords encrypted on this computer. There’s no account to create and no cloud to trust.</p>
                <div className="ob-cta">
                  <Button variant="primary" size="lg" onClick={() => go('method')}>
                    Create your vault
                  </Button>
                  {!replay && (
                    <button type="button" className="ob-link" onClick={() => setStorageMode('connect')}>
                      Open an existing vault
                    </button>
                  )}
                </div>
              </>
            )}

            {step === 'method' && (
              <>
                <h1 ref={focusHeading} tabIndex={-1} className="ob-title">
                  How do you want to unlock it?
                </h1>
                <div className="ob-methods">
                  {METHODS.map((m) => (
                    <button key={m.type} type="button" className="ob-method" onClick={() => pick(m.type)}>
                      <span className="ob-method-icon" aria-hidden="true">
                        {m.icon}
                      </span>
                      <span>
                        <strong>{m.title}</strong>
                        <small>{m.note}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {step === 'secret' && (
              <form onSubmit={advance}>
                <h1 ref={usesInput ? undefined : focusHeading} tabIndex={-1} className="ob-title">
                  {SECRET_TITLE[type]}
                </h1>

                {isText && (
                  <>
                    {passwordField('ob-secret', type === 'passphrase' ? 'Passphrase' : 'Master password', secret, setSecret, eye)}
                    <div className="ob-under">
                      {secret && !hint ? <StrengthMeter result={strength} /> : <span className="ob-hint">{hint}</span>}
                      {!replay && (
                        <button type="button" className="text-btn" onClick={suggest}>
                          <Sparkles size={14} />
                          Suggest one
                        </button>
                      )}
                    </div>
                    {show && secret && !replay && <p className="ob-note">Write this down or memorise it before you continue.</p>}
                  </>
                )}

                {type === 'pin' && (
                  <>
                    <div className="ob-pin-length">
                      <Segmented
                        label="PIN length"
                        size="sm"
                        value={String(pinLength) as '4' | '6'}
                        onChange={(v) => {
                          setPinLength(Number(v) as 4 | 6);
                          setSecret('');
                          setAgain('');
                        }}
                        options={[
                          { value: '6', label: '6 digits' },
                          { value: '4', label: '4 digits' },
                        ]}
                      />
                    </div>
                    <OtpInput key={pinLength} id="ob-pin" label={`New ${pinLength}-digit PIN`} length={pinLength} value={secret} autoFocus={!replay} disabled={replay} invalid={pinWeak} onChange={setSecret} describedBy="ob-status" />
                    {pinWeak && <p className="ob-hint ob-hint-bad">Too easy to guess. Avoid patterns, repeats and years.</p>}
                    <PinWarning length={pinLength} />
                  </>
                )}

                {type === 'pattern' && (
                  <div className="ob-pattern">
                    <PatternSetup onChange={setPattern} disabled={locked || replay} />
                    <PinWarning pattern />
                  </div>
                )}

                <div className="ob-actions">
                  <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!secretOk || locked}>
                    {type === 'pattern' ? (replay ? 'Done' : 'Create my vault') : 'Continue'}
                  </Button>
                </div>
              </form>
            )}

            {step === 'confirm' && (
              <form onSubmit={advance}>
                <h1 ref={usesInput ? undefined : focusHeading} tabIndex={-1} className="ob-title">
                  {type === 'pin' ? 'Enter it once more' : 'Type it once more'}
                </h1>
                {type === 'pin' ? (
                  <OtpInput id="ob-again" label="Confirm PIN" length={pinLength} value={again} masked autoFocus={!replay} disabled={locked || replay} invalid={again.length === pinLength && !matches} success={matches} onChange={setAgain} describedBy="ob-status" />
                ) : (
                  passwordField('ob-again', 'Confirm', again, setAgain, matches ? (
                    <span className="ob-match" role="img" aria-label="Entries match">
                      <Check size={18} strokeWidth={2.6} />
                    </span>
                  ) : null)
                )}
                <p className="ob-warning">Keys can’t reset this. If you forget it, your vault stays locked for good.</p>
                <div className="ob-actions">
                  <Button type="submit" variant="primary" size="lg" loading={busy} disabled={(!matches && !replay) || locked}>
                    {replay ? 'Done' : 'Create my vault'}
                  </Button>
                </div>
              </form>
            )}

            <div id="ob-status" className="ob-status" aria-live="assertive">
              {opening ? 'Vault created' : error ? error : capsLock && isText && step !== 'method' && step !== 'welcome' ? 'Caps Lock is on' : ''}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      <footer className="ob-foot">
        <span>{custom ? `Saved in ${fileName(status.storage.path)}.` : 'Saved on this computer.'}</span>
        {canChangeFile && (
          <button type="button" className="ob-link" onClick={() => setStorageMode(custom ? 'default' : 'create')}>
            {custom ? 'Use the built-in location' : 'Choose a folder'}
          </button>
        )}
      </footer>

      {!replay && (
        <StorageDialog
          mode={storageMode}
          storage={status.storage}
          credential={null}
          onClose={() => setStorageMode(null)}
          onDone={() => {
            setStorageMode(null);
            resumeAt = step;
            window.dispatchEvent(new Event(LOCK_EVENT));
          }}
        />
      )}
    </Root>
  );
}
