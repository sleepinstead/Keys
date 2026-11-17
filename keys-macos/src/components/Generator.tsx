import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, Copy, RefreshCw } from 'lucide-react';
import {
  estimateEntropy,
  generatePassword,
  MAX_PIN,
  MAX_WORDS,
  MIN_LENGTH,
  MIN_PIN,
  MIN_WORDS,
  SEPARATORS,
} from '../../shared/generator.ts';
import type { GeneratorMode, GeneratorOptions } from '../../shared/generator.ts';
import { useCopy, useSettings } from '../context.tsx';
import { fade } from '../motion.ts';
import { Button, CopyButton, IconButton, Segmented, StrengthMeter, Switch, useStrength } from './ui.tsx';

const SETS: { key: 'lowercase' | 'uppercase' | 'digits' | 'symbols'; label: string; sample: string }[] = [
  { key: 'lowercase', label: 'Lowercase', sample: 'abc' },
  { key: 'uppercase', label: 'Uppercase', sample: 'ABC' },
  { key: 'digits', label: 'Digits', sample: '123' },
  { key: 'symbols', label: 'Symbols', sample: '#$&' },
];

const MODES: { value: GeneratorMode; label: string }[] = [
  { value: 'random', label: 'Password' },
  { value: 'passphrase', label: 'Passphrase' },
  { value: 'pin', label: 'PIN' },
];

const SEPARATOR_LABELS: Record<string, string> = { '-': 'Hyphen', '.': 'Period', _: 'Underscore', ' ': 'Space', ',': 'Comma', '': 'None' };

function charClass(ch: string): string | undefined {
  return /[0-9]/.test(ch) ? 'ch-digit' : /[A-Za-z]/.test(ch) ? undefined : 'ch-symbol';
}

/** Shows the value; passphrase words stay together so lines only break between words. */
function Value({ value, mode, separator }: { value: string; mode: GeneratorMode; separator: string }) {
  const groups = mode === 'passphrase' && separator ? value.split(separator).flatMap((w, i) => (i ? [separator, w] : [w])) : [value];
  let index = 0;
  return (
    <span className={`secret gen-value gen-value-${mode}`} aria-label={value}>
      {groups.map((group, g) => (
        <span key={g} className="gen-group">
          {[...group].map((ch) => {
            const i = index++;
            return (
              <span key={i} aria-hidden="true" className={charClass(ch)}>
                {ch === ' ' ? '\u00a0' : ch}
              </span>
            );
          })}
        </span>
      ))}
    </span>
  );
}

function SliderRow({ id, label, value, min, max, onChange, unit }: { id: string; label: string; value: number; min: number; max: number; onChange: (v: number) => void; unit?: string }) {
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <div className="gen-length">
      <div className="gen-length-head">
        <label htmlFor={id} className="setting-label">
          {label}
        </label>
        <span className="gen-length-value">
          {value}
          {unit && <span className="gen-length-unit">{unit}</span>}
        </span>
      </div>
      <input id={id} type="range" className="range" min={min} max={max} value={value} style={{ '--fill': `${fill}%` } as CSSProperties} onChange={(e) => onChange(Number(e.target.value))} />
      <div className="gen-length-scale" aria-hidden="true">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}

function SwitchRow({ label, desc, checked, onChange }: { label: string; desc?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="setting-row setting-row-flush">
      <div>
        <div className="setting-label">{label}</div>
        {desc && <div className="setting-desc">{desc}</div>}
      </div>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

function ModePanel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <motion.div key={id} className="gen-controls" {...fade}>
      {children}
    </motion.div>
  );
}

export function Generator({ compact, onUse, onCopied }: { compact?: boolean; onUse?: (password: string) => void; onCopied?: (value: string, kind: string) => void }) {
  const { settings, updateSettings } = useSettings();
  const [opts, setOpts] = useState<GeneratorOptions>(settings.generator);
  const [value, setValue] = useState('');
  const [copied, setCopied] = useState(false);
  const copy = useCopy();
  const strength = useStrength(value, [], 80);
  const idp = compact ? 'c' : 'f';

  const regenerate = useCallback((o: GeneratorOptions) => {
    try {
      setValue(generatePassword(o));
    } catch {
      setValue('');
    }
  }, []);

  useEffect(() => regenerate(opts), [opts, regenerate]);

  // Options (never generated values) are saved with the vault settings in the database.
  const saved = JSON.stringify(settings.generator);
  useEffect(() => {
    if (JSON.stringify(opts) === saved) return;
    const t = window.setTimeout(() => void updateSettings({ generator: opts }).catch(() => {}), 400);
    return () => window.clearTimeout(t);
  }, [opts, saved, updateSettings]);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);

  const set = <K extends keyof GeneratorOptions>(k: K, v: GeneratorOptions[K]) => {
    const next = { ...opts, [k]: v };
    if (next.lowercase || next.uppercase || next.digits || next.symbols) setOpts(next);
  };

  const bits = estimateEntropy(opts);
  const enabledSets = SETS.filter((s) => opts[s.key]).length;
  const what = opts.mode === 'pin' ? 'PIN' : opts.mode === 'passphrase' ? 'passphrase' : 'password';

  return (
    <div className={`generator${compact ? ' generator-compact' : ''}`}>
      <Segmented label="What to generate" block value={opts.mode} onChange={(m) => set('mode', m)} options={MODES} />

      <div className="gen-display">
        <output aria-live="polite" className="gen-output">
          <Value value={value} mode={opts.mode} separator={opts.separator} />
        </output>
        <div className="gen-actions">
          <span className="gen-bits">{bits} bits</span>
          <IconButton label={`New ${what}`} variant="outline" onClick={() => regenerate(opts)}>
            <RefreshCw size={16} />
          </IconButton>
          {onUse ? (
            <Button size="sm" variant="primary" onClick={() => onUse(value)} disabled={!value}>
              Use this {what}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              className="gen-copy"
              onClick={async () => {
                const ok = await copy(value, what);
                setCopied(ok);
                if (ok) onCopied?.(value, what);
              }}
              disabled={!value}
              icon={copied ? <Check size={15} strokeWidth={2.6} /> : <Copy size={15} />}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          )}
        </div>
      </div>

      {opts.mode === 'pin' ? (
        <p className="gen-note">
          PINs are short by design, so they rely on the service locking you out after a few wrong tries. Use one only where digits are
          required, like a phone, card or door code. Obvious ones like 1234, 0000 and 1212 are never generated.
        </p>
      ) : (
        <StrengthMeter result={strength} />
      )}

      <AnimatePresence mode="wait" initial={false}>
        {opts.mode === 'random' && (
          <ModePanel id="random">
            <SliderRow id={`gen-length-${idp}`} label="Length" value={Math.min(64, opts.length)} min={MIN_LENGTH} max={64} onChange={(v) => set('length', v)} />
            <div className="gen-sets" role="group" aria-label="Characters to include">
              {SETS.map((s) => {
                const on = opts[s.key];
                return (
                  <button
                    key={s.key}
                    type="button"
                    className="set-chip"
                    aria-pressed={on}
                    disabled={on && enabledSets === 1}
                    title={on && enabledSets === 1 ? 'At least one set is needed' : undefined}
                    onClick={() => set(s.key, !on)}
                  >
                    <span className="set-check" aria-hidden="true">
                      {on && <Check size={12} strokeWidth={3} />}
                    </span>
                    <span className="set-label">{s.label}</span>
                    <span className="set-sample">{s.sample}</span>
                  </button>
                );
              })}
            </div>
            <SwitchRow label="Avoid look-alikes" desc="Leaves out l, 1, I, O and 0" checked={opts.excludeAmbiguous} onChange={(v) => set('excludeAmbiguous', v)} />
          </ModePanel>
        )}

        {opts.mode === 'passphrase' && (
          <ModePanel id="passphrase">
            <SliderRow id={`gen-words-${idp}`} label="Words" value={opts.words} min={MIN_WORDS} max={MAX_WORDS} onChange={(v) => set('words', v)} />
            <div className="gen-field">
              <div className="setting-label">Between words</div>
              <div className="sep-chips" role="radiogroup" aria-label="Word separator">
                {SEPARATORS.map((s) => (
                  <button
                    key={s || 'none'}
                    type="button"
                    role="radio"
                    aria-checked={opts.separator === s}
                    aria-label={SEPARATOR_LABELS[s]}
                    title={SEPARATOR_LABELS[s]}
                    className="sep-chip"
                    onClick={() => set('separator', s)}
                  >
                    <span className="sep-glyph">{s === ' ' ? '␣' : s === '' ? 'None' : s}</span>
                  </button>
                ))}
              </div>
            </div>
            <SwitchRow label="Capitalise words" checked={opts.capitalize} onChange={(v) => set('capitalize', v)} />
            <SwitchRow label="Add a number" desc="Puts one digit after a random word" checked={opts.includeNumber} onChange={(v) => set('includeNumber', v)} />
          </ModePanel>
        )}

        {opts.mode === 'pin' && (
          <ModePanel id="pin">
            <div className="gen-field">
              <div className="setting-label">Digits</div>
              <Segmented
                label="PIN length"
                value={String(opts.pinLength)}
                onChange={(v) => set('pinLength', Number(v))}
                options={[4, 6, 8, 10, 12].filter((n) => n >= MIN_PIN && n <= MAX_PIN).map((n) => ({ value: String(n), label: `${n} digits` }))}
              />
            </div>
          </ModePanel>
        )}
      </AnimatePresence>

      {!compact && (
        <p className="gen-foot">
          {opts.mode === 'passphrase'
            ? 'Words come from the EFF’s 7,776-word list, picked with the Web Crypto random generator on this device. Nothing is sent anywhere.'
            : 'Made on this device with the Web Crypto random generator. Nothing is sent anywhere.'}
        </p>
      )}
    </div>
  );
}

interface Copied {
  value: string;
  kind: string;
  at: number;
}

/**
 * Generator page: the generator on the left; on the right, what you've copied this
 * session (kept in memory only, gone when you leave the page) and a short guide.
 */
export function GeneratorView() {
  const [recent, setRecent] = useState<Copied[]>([]);
  const copy = useCopy();
  const [shown, setShown] = useState<number | null>(null);

  return (
    <div className="page page-wide">
      <header className="page-head">
        <h1>Generator</h1>
        <p className="page-lede">Make a random password, a memorable passphrase, or a PIN, then copy it or save it to an item.</p>
      </header>
      <div className="gen-page">
        <div className="card card-pad gen-main">
          <Generator onCopied={(value, kind) => setRecent((r) => [{ value, kind, at: Date.now() }, ...r.filter((x) => x.value !== value)].slice(0, 8))} />
        </div>
        <aside className="gen-side">
          <section className="card card-pad">
            <h2 className="side-title">Copied this session</h2>
            {recent.length === 0 ? (
              <p className="gen-side-empty">Anything you copy shows up here until you leave this page. It’s never saved.</p>
            ) : (
              <ul className="gen-recent">
                {recent.map((r, i) => (
                  <li key={r.at}>
                    <button type="button" className="gen-recent-value" onClick={() => setShown(shown === i ? null : i)} aria-label={shown === i ? 'Hide value' : 'Show value'}>
                      {shown === i ? <span className="secret">{r.value}</span> : <span className="masked">••••••••••</span>}
                    </button>
                    <span className="gen-recent-kind">{r.kind}</span>
                    <CopyButton label={`Copy ${r.kind}`} onCopy={() => copy(r.value, r.kind)} />
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="card card-pad">
            <h2 className="side-title">Which kind to use</h2>
            <dl className="gen-guide">
              <div>
                <dt>Password</dt>
                <dd>Best for anything Keys fills in for you. 20 random characters is plenty.</dd>
              </div>
              <div>
                <dt>Passphrase</dt>
                <dd>For things you type by hand, like a laptop login. Five words is strong.</dd>
              </div>
              <div>
                <dt>PIN</dt>
                <dd>Only where digits are required: phones, cards, door codes.</dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>
    </div>
  );
}
