import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { Asterisk, Hash, RotateCcw, TriangleAlert } from 'lucide-react';
import { decodePattern, dotBetween, encodePattern, patternProblem, PATTERN_SIZE } from '../../shared/credential.ts';
import type { Credential, CredentialType } from '../../shared/types.ts';
import { Button, Segmented } from './ui.tsx';

// ------------------------------------------------------------------ picker

export interface CredentialChoice {
  type: CredentialType;
  pinLength: 4 | 6;
}

export const choiceFromCredential = (c: Credential): CredentialChoice => ({ type: c.type, pinLength: c.type === 'pin' && c.length === 4 ? 4 : 6 });

export const CREDENTIAL_NAMES: Record<CredentialType, string> = {
  password: 'master password',
  passphrase: 'passphrase',
  pin: 'PIN',
  pattern: 'pattern',
};

const KINDS: { value: CredentialType; label: string; icon: ReactNode }[] = [
  { value: 'password', label: 'Password', icon: <Asterisk size={14} /> },
  { value: 'pin', label: 'PIN', icon: <Hash size={14} /> },
];

function describe(choice: CredentialChoice): { text: string; strength: string; tone: 'good' | 'warn' | 'bad' } {
  switch (choice.type) {
    case 'password':
      return { text: '10 or more characters, any mix.', strength: 'Strongest', tone: 'good' };
    case 'passphrase':
      return { text: 'Four or more words. Easy to remember, hard to guess.', strength: 'Strong', tone: 'good' };
    case 'pin':
      return {
        text: 'Easy to crack if someone copies your file.',
        strength: choice.pinLength === 6 ? 'Weaker' : 'Weakest',
        tone: choice.pinLength === 4 ? 'bad' : 'warn',
      };
    case 'pattern':
      return { text: 'Connect at least 4 dots on a grid. Quick, but easy to watch over your shoulder.', strength: 'Weak', tone: 'warn' };
  }
}

/** Choose how the vault unlocks: password, passphrase, PIN (4 or 6 digits) or pattern. */
export function CredentialPicker({ value, onChange }: { value: CredentialChoice; onChange: (c: CredentialChoice) => void }) {
  const d = describe(value);
  return (
    <div className="cred-picker">
      <Segmented
        label="Unlock with"
        block
        value={value.type}
        onChange={(type) => onChange({ ...value, type })}
        options={KINDS.map((k) => ({ value: k.value, label: <>{k.icon}{k.label}</> }))}
      />
      {value.type === 'pin' && (
        <Segmented
          label="PIN length"
          size="sm"
          value={String(value.pinLength) as '4' | '6'}
          onChange={(v) => onChange({ ...value, pinLength: Number(v) as 4 | 6 })}
          options={[
            { value: '6', label: '6 digits' },
            { value: '4', label: '4 digits' },
          ]}
        />
      )}
      <p className="cred-desc">
        <span className="badge" data-tone={d.tone}>
          {d.strength}
        </span>
        {d.text}
      </p>
    </div>
  );
}

/** Shown before a PIN or pattern is set as the vault credential. */
export function PinWarning({ length, pattern }: { length?: number; pattern?: boolean }) {
  return (
    <div className="notice notice-warn" role="note">
      <TriangleAlert size={16} aria-hidden="true" />
      <p>
        <strong>Easier to crack.</strong> Anyone with a copy of your file could try every{' '}
        {pattern ? 'pattern within hours' : `${length}-digit PIN ${length === 4 ? 'in under an hour' : length === 6 ? 'within days' : 'within months'}`}.
      </p>
    </div>
  );
}

// ----------------------------------------------------------------- pattern

const CELL = 100;
const center = (i: number) => [(i % PATTERN_SIZE) * CELL + CELL / 2, Math.floor(i / PATTERN_SIZE) * CELL + CELL / 2] as const;

/**
 * A 3×3 dot grid. Drag through the dots, or tap or press Enter on them one at a time
 * and then choose Done. Like Android, a line through an unused dot picks it up.
 */
export function PatternInput({
  value,
  onChange,
  onComplete,
  label,
  state = 'idle',
  disabled,
  compact,
}: {
  value: number[];
  onChange: (points: number[]) => void;
  onComplete: (points: number[]) => void;
  label: string;
  state?: 'idle' | 'error' | 'success';
  disabled?: boolean;
  compact?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const points = useRef(value);
  points.current = value;
  const gestureAdded = useRef(0);
  const [pointer, setPointer] = useState<[number, number] | null>(null);
  const [tapping, setTapping] = useState(false);

  const add = (dot: number) => {
    const cur = points.current;
    if (cur.includes(dot)) return;
    const next = [...cur];
    const last = cur[cur.length - 1];
    if (last !== undefined) {
      const mid = dotBetween(last, dot);
      if (mid !== null && !next.includes(mid)) next.push(mid);
    }
    next.push(dot);
    points.current = next;
    gestureAdded.current += next.length - cur.length;
    onChange(next);
  };

  const local = (e: ReactPointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    const scale = (CELL * PATTERN_SIZE) / r.width;
    return [(e.clientX - r.left) * scale, (e.clientY - r.top) * scale] as [number, number];
  };

  const hit = ([x, y]: [number, number]) => {
    for (let i = 0; i < PATTERN_SIZE * PATTERN_SIZE; i++) {
      const [cx, cy] = center(i);
      if (Math.hypot(x - cx, y - cy) < CELL * 0.32) return i;
    }
    return null;
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (disabled || e.button !== 0) return;
    const p = local(e);
    const dot = hit(p);
    if (dot === null) return;
    e.preventDefault();
    try {
      box.current!.setPointerCapture(e.pointerId);
    } catch {
      /* some pointers (e.g. synthetic ones) can't be captured; tracking still works while over the grid */
    }
    gestureAdded.current = 0;
    if (!tapping) {
      points.current = [];
      onChange([]);
    }
    add(dot);
    setPointer(p);
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (!pointer) return;
    const p = local(e);
    setPointer(p);
    const dot = hit(p);
    if (dot !== null) add(dot);
  };

  const onPointerUp = () => {
    if (!pointer) return;
    setPointer(null);
    if (gestureAdded.current >= 2) {
      setTapping(false);
      onComplete(points.current);
    } else {
      // A single tap: carry on one dot at a time, finish with Done.
      setTapping(true);
    }
  };

  useEffect(() => {
    if (value.length === 0) setTapping(false);
  }, [value.length]);

  const path = value.map((i) => center(i).join(',')).join(' ');
  const last = value.length ? center(value[value.length - 1]!) : null;
  const size = CELL * PATTERN_SIZE;

  return (
    <div className={`pattern${compact ? ' pattern-compact' : ''}`} data-state={state} data-disabled={disabled || undefined}>
      <div
        ref={box}
        className="pattern-grid"
        role="group"
        aria-label={label}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <svg viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
          {value.length > 1 && <polyline points={path} className="pattern-line" />}
          {last && pointer && <line x1={last[0]} y1={last[1]} x2={pointer[0]} y2={pointer[1]} className="pattern-line pattern-line-live" />}
        </svg>
        {Array.from({ length: PATTERN_SIZE * PATTERN_SIZE }, (_, i) => {
          const on = value.includes(i);
          return (
            <button
              key={i}
              type="button"
              className="pattern-dot"
              aria-label={`Dot ${i + 1}, row ${Math.floor(i / PATTERN_SIZE) + 1}, column ${(i % PATTERN_SIZE) + 1}`}
              aria-pressed={on}
              disabled={disabled}
              onClick={(e) => {
                // Keyboard activation only; pointer input is handled by the grid.
                if (e.detail !== 0) return;
                setTapping(true);
                add(i);
              }}
            >
              <span />
            </button>
          );
        })}
      </div>
      <div className="pattern-controls">
        {value.length > 0 && !pointer && !disabled && (
          <button type="button" className="text-btn" onClick={() => onChange([])} disabled={disabled}>
            <RotateCcw size={13} />
            Clear
          </button>
        )}
        {tapping && value.length > 0 && !pointer && !disabled && (
          <Button size="sm" variant="outline" onClick={() => onComplete(points.current)} disabled={disabled}>
            Done
          </Button>
        )}
      </div>
    </div>
  );
}

/** Draw a new pattern, then draw it again to confirm. Reports the encoded pattern once both match. */
export function PatternSetup({ onChange, disabled }: { onChange: (encoded: string | null) => void; disabled?: boolean }) {
  const [first, setFirst] = useState<string | null>(null);
  const [points, setPoints] = useState<number[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [flash, setFlash] = useState<'error' | 'success' | 'idle'>('idle');

  const reset = () => {
    setFirst(null);
    setPoints([]);
    setConfirmed(false);
    setProblem(null);
    setFlash('idle');
    onChange(null);
  };

  const complete = (p: number[]) => {
    const encoded = encodePattern(p);
    if (!first) {
      const issue = patternProblem(encoded);
      if (issue) {
        setProblem(issue);
        setFlash('error');
        window.setTimeout(() => {
          setPoints([]);
          setFlash('idle');
        }, 700);
        return;
      }
      setProblem(null);
      setFirst(encoded);
      window.setTimeout(() => setPoints([]), 250);
      return;
    }
    if (encoded === first) {
      setConfirmed(true);
      setFlash('success');
      setProblem(null);
      onChange(encoded);
    } else {
      setProblem('The patterns don’t match. Draw it again.');
      setFlash('error');
      window.setTimeout(() => {
        setPoints([]);
        setFlash('idle');
      }, 700);
    }
  };

  const firstLen = first ? decodePattern(first)?.length ?? 0 : points.length;

  return (
    <div className="pattern-setup">
      <div className="field-row">
        <span className="field-label">{confirmed ? 'Pattern set' : first ? 'Draw it again to confirm' : 'Draw a pattern'}</span>
        {(first || confirmed) && (
          <button type="button" className="text-btn" onClick={reset} disabled={disabled}>
            <RotateCcw size={13} />
            Start over
          </button>
        )}
      </div>
      <PatternInput
        value={confirmed ? decodePattern(first!)! : points}
        onChange={(p) => {
          if (confirmed) return;
          setPoints(p);
          if (flash !== 'idle') setFlash('idle');
        }}
        onComplete={complete}
        label={first ? 'Confirm pattern' : 'New pattern'}
        state={flash}
        disabled={disabled || confirmed}
      />
      <ul className="checklist">
        <li data-ok={firstLen >= 4 || undefined}>Connect at least 4 dots</li>
        <li data-ok={!!first || undefined} data-bad={problem && !first ? true : undefined}>
          {problem && !first ? problem : 'More than a straight line'}
        </li>
        <li data-ok={confirmed || undefined} data-bad={problem && first ? true : undefined}>
          {problem && first ? problem : 'Drawn twice the same way'}
        </li>
      </ul>
    </div>
  );
}
