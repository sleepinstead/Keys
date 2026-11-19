import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, KeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode, Ref } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, animate, motion, useMotionValue, useSpring, useTransform, useVelocity } from 'motion/react';
import { Check, Copy, Folder, Monitor, Moon, Sun, X } from 'lucide-react';
import { api } from '../api.ts';
import { dialog, fade, pop, quick } from '../motion.ts';
import { isMac } from '../util.ts';
import { play } from '../sound.ts';
import { CATEGORY_COLORS } from '../../shared/types.ts';
import type { Appearance, CategoryColor, EntryType, StrengthResult } from '../../shared/types.ts';

// ---------------------------------------------------------------- tooltip

let lastTooltipClose = 0;
const OPEN_DELAY = 450;
const WARM_WINDOW = 400;

/**
 * Small dark label shown on hover or keyboard focus. Opens after a short delay, but
 * instantly while you move between neighbouring controls, and hides on press.
 */
export function Tooltip({
  content,
  shortcut,
  side = 'top',
  children,
  disabled,
}: {
  content: ReactNode;
  shortcut?: string;
  side?: 'top' | 'bottom' | 'right';
  children: ReactNode;
  disabled?: boolean;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; side: typeof side } | null>(null);

  const show = () => {
    if (disabled) return;
    window.clearTimeout(timer.current);
    const warm = Date.now() - lastTooltipClose < WARM_WINDOW;
    timer.current = window.setTimeout(() => setOpen(true), warm ? 0 : OPEN_DELAY);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    if (open) lastTooltipClose = Date.now();
    setOpen(false);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    let s = side;
    if (s === 'top' && r.top < 44) s = 'bottom';
    const left = s === 'right' ? r.right + 8 : r.left + r.width / 2;
    const top = s === 'top' ? r.top - 8 : s === 'bottom' ? r.bottom + 8 : r.top + r.height / 2;
    setPos({ left, top, side: s });
  }, [open, side]);

  // Keep the label inside the window horizontally.
  useLayoutEffect(() => {
    if (!pos || !tip.current || pos.side === 'right') return;
    const w = tip.current.offsetWidth;
    const clamped = Math.min(window.innerWidth - 8 - w / 2, Math.max(8 + w / 2, pos.left));
    if (Math.abs(clamped - pos.left) > 0.5) setPos({ ...pos, left: clamped });
  }, [pos]);

  return (
    <span
      ref={anchor}
      className="tt-anchor"
      onPointerEnter={show}
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocus={(e) => e.target.matches(':focus-visible') && show()}
      onBlur={hide}
      onKeyDown={(e) => ['Escape', 'Enter', ' '].includes(e.key) && hide()}
    >
      {children}
      {createPortal(
        <AnimatePresence>
          {open && pos && (
            <motion.div
              ref={tip}
              role="tooltip"
              aria-hidden="true"
              className={`tooltip tooltip-${pos.side}`}
              style={{
                left: pos.left,
                top: pos.top,
                x: pos.side === 'right' ? 0 : '-50%',
                y: pos.side === 'top' ? '-100%' : pos.side === 'right' ? '-50%' : 0,
              }}
              {...pop}
            >
              <span>{content}</span>
              {shortcut && <Kbd tone="tooltip">{shortcut}</Kbd>}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </span>
  );
}

// ---------------------------------------------------------------- buttons

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'link';

export function Button({
  variant = 'outline',
  size,
  icon,
  iconRight,
  loading,
  children,
  className = '',
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'lg'; icon?: ReactNode; iconRight?: ReactNode; loading?: boolean }) {
  return (
    <button
      type="button"
      className={`btn btn-${variant}${size ? ` btn-${size}` : ''} ${className}`.trim()}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children !== undefined && <span>{children}</span>}
      {iconRight}
    </button>
  );
}

/** Icon-only button. Its label doubles as the tooltip and the accessible name. */
export function IconButton({
  label,
  shortcut,
  tooltipSide,
  children,
  className = '',
  variant = 'ghost',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement>; label: string; shortcut?: string; tooltipSide?: 'top' | 'bottom' | 'right'; variant?: 'ghost' | 'outline' }) {
  return (
    <Tooltip content={label} shortcut={shortcut} side={tooltipSide}>
      <button type="button" className={`icon-btn icon-btn-${variant} ${className}`.trim()} aria-label={label} {...rest}>
        {children}
      </button>
    </Tooltip>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg className="spinner" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** Splits "⌘⇧L" or "CtrlK" into ["⌘", "⇧", "L"] so each key gets a little room. */
function keyParts(combo: string): string[] {
  const parts: string[] = [];
  let rest = combo;
  for (let m = rest.match(/^(⌘|⇧|⌥|⌃|Ctrl\+?|Shift\+?|Alt\+?)/); m && rest.length > m[1]!.length; m = rest.match(/^(⌘|⇧|⌥|⌃|Ctrl\+?|Shift\+?|Alt\+?)/)) {
    const key = m[1]!.replace('+', '');
    // Windows names modifier keys in words.
    parts.push(isMac ? key : key === '⇧' ? 'Shift' : key === '⌥' ? 'Alt' : key);
    rest = rest.slice(m[1]!.length);
  }
  if (rest) parts.push(rest);
  return parts;
}

/** A keyboard shortcut: one soft, filled key cap holding the whole combination. */
export function Kbd({ children, tone }: { children: ReactNode; tone?: 'tooltip' }) {
  return (
    <kbd className="kbd" data-tone={tone}>
      {typeof children === 'string' ? keyParts(children).map((k, i) => <span key={i}>{k}</span>) : children}
    </kbd>
  );
}

/** Copy button that briefly shows a check once the copy lands. */
export function CopyButton({ label, onCopy }: { label: string; onCopy: () => Promise<boolean> }) {
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <IconButton
      label={done ? 'Copied' : label}
      className={done ? 'is-done' : undefined}
      onClick={async () => {
        if (await onCopy()) {
          setDone(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setDone(false), 1500);
        }
      }}
    >
      {done ? <Check size={16} strokeWidth={2.4} /> : <Copy size={16} />}
    </IconButton>
  );
}

// -------------------------------------------------------------- identity

/** A category's folder: plain grey, or filled with its colour. */
export function FolderIcon({ color, size = 16 }: { color?: CategoryColor | null; size?: number }) {
  if (!color) return <Folder size={size} />;
  const hex = CATEGORY_COLORS[color];
  return <Folder size={size} className="folder-tinted" color={hex} fill={hex} fillOpacity={0.2} />;
}

/** Neutral tile with the item's first letter, or its picture when it has one. Every kind starts with the letter. */
export function Monogram({ title, size = 'md', icon }: { seed?: string; title: string; type: EntryType; size?: 'sm' | 'md' | 'lg'; icon?: string }) {
  const letter = (title.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase();
  const tint = icon?.startsWith('tint:') ? (icon.slice(5) as CategoryColor) : null;
  const isImage = !!icon && icon !== 'none' && !tint;
  return (
    <span
      className={`mono mono-${size}${isImage ? ' mono-has-img' : ''}${tint ? ' mono-tint' : ''}`}
      style={tint ? ({ '--tone': CATEGORY_COLORS[tint] } as CSSProperties) : undefined}
      aria-hidden="true"
    >
      {isImage ? <img className="mono-img" src={icon} alt="" draggable={false} /> : <span className="mono-letter">{letter}</span>}
    </span>
  );
}

export function AppMark({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`app-mark app-mark-${size}`} aria-hidden="true">
      <img className="app-mark-tilted" src="/logos/mark-tilted.png" alt="" draggable={false} />
    </span>
  );
}

// ---------------------------------------------------------------- secrets

/** Monospace secret; digits and symbols are slightly muted so look-alikes are easier to tell apart. */
export function SecretText({ value, className = '' }: { value: string; className?: string }) {
  return (
    <span className={`secret ${className}`.trim()}>
      {/* Coloured characters for the eye; the plain value for screen readers (aria-label on a span isn't read). */}
      <span aria-hidden="true">
        {[...value].map((ch, i) => (
          <span key={i} className={/[0-9]/.test(ch) ? 'ch-digit' : /[\p{L}]/u.test(ch) ? undefined : 'ch-symbol'}>
            {ch}
          </span>
        ))}
      </span>
      <span className="visually-hidden">{value}</span>
    </span>
  );
}

// --------------------------------------------------------------- strength

export function useStrength(password: string, userInputs: string[] = [], delay = 140): StrengthResult | null {
  const [result, setResult] = useState<StrengthResult | null>(null);
  const inputsKey = userInputs.join('\u0000');
  useEffect(() => {
    if (!password) {
      setResult(null);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      api
        .strength(password, inputsKey ? inputsKey.split('\u0000') : [])
        .then((r) => !cancelled && setResult(r))
        .catch(() => {});
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [password, inputsKey, delay]);
  return result;
}

export const STRENGTH_WORDS = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'];
export const STRENGTH_TONE: readonly ('bad' | 'warn' | 'good')[] = ['bad', 'bad', 'warn', 'good', 'good'];

/** Four segments that fill with the zxcvbn score. */
export function StrengthMeter({ result }: { result: StrengthResult | null; showWarning?: boolean }) {
  const score = result?.score ?? -1;
  const tone = score < 0 ? 'none' : STRENGTH_TONE[score];
  const filled = score < 0 ? 0 : Math.max(1, score);
  return (
    <div className="strength" data-tone={tone}>
      <div
        className="strength-bar"
        role="meter"
        aria-label="Password strength"
        aria-valuemin={0}
        aria-valuemax={4}
        aria-valuenow={Math.max(0, score)}
        aria-valuetext={score >= 0 ? STRENGTH_WORDS[score] : 'Not rated'}
      >
        {[1, 2, 3, 4].map((i) => (
          <span key={i} data-on={i <= filled || undefined} />
        ))}
      </div>
      <div className="strength-text">
        {result ? (
          <>
            <strong>{STRENGTH_WORDS[result.score]}</strong>
            <span>Takes {result.crackTime} to crack</span>
          </>
        ) : (
          <span>&nbsp;</span>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- inputs

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

/* Liquid toggle: the thumb rides a spring, stretches with its own speed, swells a touch under
   the pointer and can be dragged across; crossing the middle flips the switch. */
const SW_MIN = 3;
const SW_MAX = 25;
const SW_MID = 14;
const SW_STRETCH = 36;
const SW_SPEED = 50;
const SW_SETTLE = { stiffness: 380, damping: 34, mass: 0.6 };
const SW_MOVE = { type: 'spring' as const, stiffness: 170 - (50 - SW_SPEED) * 1.1, damping: 21.5, mass: 0.9 };
const swClamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
/* scaled down from the 92px original, so the speed that stretches it is too */
const swScale = (SW_MAX - SW_MIN) / 46;

export function Switch({ checked, onChange, label, id, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; id?: string; disabled?: boolean }) {
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState(false);
  const el = useRef<HTMLButtonElement>(null);
  const grab = useRef<{ id: number; grab: number | null; moved: boolean; on: boolean } | null>(null);
  const x = useMotionValue(checked ? SW_MAX : SW_MIN);
  const vel = useVelocity(x);
  const v = useSpring(vel, SW_SETTLE);
  const stretch = (s: number) => 1 + Math.min(0.4, Math.abs(s / swScale) / 600) * (SW_STRETCH / 100);
  const swell = useSpring(hover && !disabled ? 1.035 : 1, SW_SETTLE);
  const sx = useTransform([v, swell], ([a, b]: number[]) => stretch(a!) * b!);
  const sy = useTransform([v, swell], ([a, b]: number[]) => b! / stretch(a!));
  const still = useRef(typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches).current;

  useEffect(() => {
    if (dragging) return;
    const c = animate(x, checked ? SW_MAX : SW_MIN, still ? { duration: 0.16 } : SW_MOVE);
    return () => c.stop();
  }, [checked, dragging, x, still]);

  const flip = (to: boolean) => {
    play(to ? 'click' : 'off');
    onChange(to);
  };
  const local = (clientX: number) => {
    const b = el.current;
    if (!b) return 0;
    const r = b.getBoundingClientRect();
    const s = r.width / (b.offsetWidth || r.width) || 1;
    return (clientX - r.left) / s;
  };

  return (
    <button
      ref={el}
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      data-on={checked}
      disabled={disabled}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) return;
        grab.current = { id: e.pointerId, grab: null, moved: false, on: checked };
        setDragging(true);
        try {
          el.current?.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }}
      onPointerMove={(e) => {
        const g = grab.current;
        if (!g || g.id !== e.pointerId) return;
        const p = local(e.clientX);
        if (g.grab === null) g.grab = p - x.get();
        const nx = swClamp(p - g.grab, SW_MIN, SW_MAX);
        if (Math.abs(nx - x.get()) > 0.4) g.moved = true;
        x.set(nx);
        play('drag', { at: (nx - SW_MIN) / (SW_MAX - SW_MIN), gap: 150 });
        const on = nx > SW_MID;
        if (on !== g.on) {
          g.on = on;
          flip(on);
        }
      }}
      onPointerUp={(e) => {
        const g = grab.current;
        if (!g) return;
        grab.current = null;
        try {
          el.current?.releasePointerCapture?.(e.pointerId);
        } catch {
          /* ignore */
        }
        if (!g.moved) flip(!checked);
        setDragging(false);
      }}
      onPointerCancel={() => {
        grab.current = null;
        setDragging(false);
      }}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onClick={(e) => {
        /* keyboard activation (Space/Enter) arrives as a click with no pointer */
        if (e.detail === 0) flip(!checked);
      }}
    >
      <span className="switch-blobs" aria-hidden="true">
        <motion.span className="switch-knob" style={{ x, scaleX: sx, scaleY: sy }} />
      </span>
    </button>
  );
}

// ------------------------------------------------------------ radio groups

/**
 * Keyboard for a `role="radiogroup"` of `role="radio"` buttons, as the ARIA pattern has it: the
 * group is one Tab stop (`radioTabIndex`), and arrow keys, Home and End move and choose at once.
 */
export function radioKeys<T>(values: readonly T[], value: T, onChange: (v: T) => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.altKey || e.metaKey || e.ctrlKey || !values.length) return;
    const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[e.key];
    const i = Math.max(0, values.indexOf(value));
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? values.length - 1 : step ? (i + step + values.length) % values.length : -1;
    if (next < 0) return;
    e.preventDefault();
    if (values[next] !== value) onChange(values[next]!);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };
}

/** Only the chosen radio (or the first, when none is) can be reached with Tab. */
export const radioTabIndex = <T,>(values: readonly T[], value: T, option: T) => (option === value || (!values.includes(value) && option === values[0]) ? 0 : -1);

/** Tabs-style segmented control; the white pill slides to the chosen option. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  size,
  block,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  size?: 'sm';
  block?: boolean;
}) {
  const id = useId();
  const values = options.map((o) => o.value);
  return (
    <div className={`segmented${size ? ` segmented-${size}` : ''}${block ? ' segmented-block' : ''}`} role="radiogroup" aria-label={label} onKeyDown={radioKeys(values, value, onChange)}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} tabIndex={radioTabIndex(values, value, o.value)} onClick={() => onChange(o.value)}>
          {value === o.value && <motion.span layoutId={`seg-${id}`} className="segmented-pill" transition={quick} />}
          <span className="segmented-label">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Three-way theme picker: system, light, dark. */
export function ThemeToggle({ value, onChange }: { value: Appearance; onChange: (v: Appearance) => void }) {
  const options: { value: Appearance; label: string; icon: ReactNode }[] = [
    { value: 'system', label: 'Match system', icon: <Monitor size={16} /> },
    { value: 'light', label: 'Light', icon: <Sun size={16} /> },
    { value: 'dark', label: 'Dark', icon: <Moon size={16} /> },
  ];
  const values = options.map((o) => o.value);
  return (
    <div className="theme-toggle" role="radiogroup" aria-label="Theme" onKeyDown={radioKeys(values, value, onChange)}>
      {options.map((o) => (
        <Tooltip key={o.value} content={o.label}>
          <button type="button" role="radio" aria-checked={value === o.value} aria-label={o.label} tabIndex={radioTabIndex(values, value, o.value)} onClick={() => onChange(o.value)}>
            {value === o.value && <span className="theme-toggle-pill" />}
            <span className="theme-toggle-icon">{o.icon}</span>
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <h3>{title}</h3>
      {children}
    </div>
  );
}

// ------------------------------------------------------------------- menu

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  checked?: boolean;
  shortcut?: string;
  separatorBefore?: boolean;
  /** Shown but not choosable, e.g. removing the last copy of an account. */
  disabled?: boolean;
}

/** Arrow keys move between a menu's items, wrapping at the ends. */
function moveFocus(e: KeyboardEvent, list: HTMLElement | null) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const buttons = [...(list?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
  const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
  buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
}

function MenuButtons({ items, close }: { items: MenuItem[]; close: () => void }) {
  return (
    <>
      {items.map((item, i) => (
        <div key={`${i}-${item.label}`}>
          {item.separatorBefore && <div className="menu-sep" role="separator" />}
          <button
            type="button"
            role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={item.checked}
            className={item.danger ? 'is-danger' : undefined}
            disabled={item.disabled}
            onClick={() => {
              close();
              item.onSelect();
            }}
          >
            {item.icon && <span className="menu-icon">{item.icon}</span>}
            <span className="menu-label">{item.label}</span>
            {item.shortcut && <Kbd>{item.shortcut}</Kbd>}
            {item.checked && <Check size={15} className="menu-check" />}
          </button>
        </div>
      ))}
    </>
  );
}

/**
 * Right-click menu at the pointer (or under the row, from the keyboard's menu key).
 * Kept inside the window, closed by any click, scroll or Escape, and focus goes back to `returnTo`.
 */
/**
 * Right-click (or the keyboard's menu key) on a row opens a menu for that row.
 * Returns the open menu, a handler for `onContextMenu`, and a closer.
 */
export function useContextMenu<T>() {
  const [menu, setMenu] = useState<{ x: number; y: number; target: T; row: HTMLElement } | null>(null);
  const open = useCallback((e: ReactMouseEvent<HTMLElement>, target: T) => {
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const keyboard = e.clientX === 0 && e.clientY === 0; // the menu key reports no pointer position
    setMenu({ x: keyboard ? r.left + 16 : e.clientX, y: keyboard ? r.bottom : e.clientY, target, row: e.currentTarget });
  }, []);
  const close = useCallback(() => setMenu(null), []);
  return { menu, open, close };
}

export function ContextMenu({ at, items, label, onClose, returnTo }: { at: { x: number; y: number } | null; items: MenuItem[]; label: string; onClose: () => void; returnTo?: HTMLElement | null }) {
  const list = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const close = useCallback(() => {
    onClose();
    returnTo?.focus({ preventScroll: true });
  }, [onClose, returnTo]);

  useLayoutEffect(() => {
    if (!at || !list.current) return setPos(at);
    const { width, height } = list.current.getBoundingClientRect();
    setPos({
      x: Math.max(8, Math.min(at.x, window.innerWidth - width - 8)),
      y: at.y + height + 8 > window.innerHeight ? Math.max(8, at.y - height) : at.y,
    });
  }, [at]);

  useEffect(() => {
    if (!at) return;
    const onDown = (e: PointerEvent) => !list.current?.contains(e.target as Node) && onClose();
    const dismiss = () => onClose();
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    requestAnimationFrame(() => list.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus());
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
    };
  }, [at, onClose]);

  return createPortal(
    <AnimatePresence>
      {at && (
        <motion.div
          ref={list}
          role="menu"
          aria-label={label}
          className="menu menu-context"
          style={{ left: (pos ?? at).x, top: (pos ?? at).y }}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close();
            } else if (e.key === 'Tab') {
              e.preventDefault();
              close();
            } else moveFocus(e, list.current);
          }}
          {...pop}
        >
          <MenuButtons items={items} close={close} />
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/** Popover menu anchored to its trigger. Arrow keys move, Enter picks, Escape closes. */
export function Menu({
  trigger,
  items,
  align = 'end',
  label,
  heading,
  footer,
}: {
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => ReactNode;
  items: MenuItem[];
  align?: 'start' | 'end';
  label: string;
  heading?: string;
  /** Extra content under the items (e.g. colour swatches); gets a function that closes the menu. */
  footer?: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);
  // After picking, focus goes back to the button that opened the menu (not lost to the page).
  const closeToTrigger = useCallback(() => {
    setOpen(false);
    root.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !root.current?.contains(e.target as Node) && close();
    window.addEventListener('pointerdown', onDown);
    requestAnimationFrame(() => list.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus());
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open, close]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      root.current?.querySelector<HTMLButtonElement>('button')?.focus();
    } else if (e.key === 'Tab') close();
    else moveFocus(e, list.current);
  };

  return (
    <div className="menu-root" ref={root} onKeyDown={onKeyDown}>
      {trigger({ onClick: () => setOpen((o) => !o), 'aria-expanded': open, 'aria-haspopup': 'menu' })}
      <AnimatePresence>
        {open && (
          <motion.div ref={list} role="menu" aria-label={label} className={`menu menu-${align}`} {...pop}>
            {heading && <div className="menu-heading">{heading}</div>}
            <MenuButtons items={items} close={closeToTrigger} />
            {footer?.(close)}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ----------------------------------------------------------------- dialog

/**
 * Modal dialog: dims the app, traps focus, closes on Escape or a click outside
 * (both go through `onClose`, so callers can confirm before discarding work).
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  hideClose,
  bare,
  className = '',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  hideClose?: boolean;
  /** Render children as-is (for content that brings its own body and footer, like a form). */
  bare?: boolean;
  className?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement as HTMLElement | null;
    const raf = requestAnimationFrame(() => {
      const el = panel.current;
      if (!el || el.contains(document.activeElement)) return;
      (el.querySelector<HTMLElement>('[data-autofocus], [autofocus]') ?? el.querySelector<HTMLElement>('input, textarea, select, button:not([data-dialog-close])') ?? el).focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(raf);
      requestAnimationFrame(() => returnFocus.current?.focus?.());
    };
  }, [open]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !panel.current) return;
    const els = [...panel.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea, select, a[href], [tabindex]:not([tabindex="-1"])')].filter(
      (el) => el.offsetParent !== null,
    );
    const first = els[0];
    const last = els[els.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="dialog-layer" {...fade} onKeyDown={onKeyDown}>
          <div className="dialog-overlay" onClick={onClose} />
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descId : undefined}
            tabIndex={-1}
            className={`dialog dialog-${size} ${className}`.trim()}
            {...dialog}
          >
            <header className="dialog-head">
              <div>
                <h2 id={titleId}>{title}</h2>
                {description && (
                  <p id={descId} className="dialog-desc">
                    {description}
                  </p>
                )}
              </div>
              {!hideClose && (
                <IconButton label="Close" shortcut="Esc" onClick={onClose} data-dialog-close>
                  <X size={17} />
                </IconButton>
              )}
            </header>
            {bare ? children : children !== undefined && <div className="dialog-body">{children}</div>}
            {footer && <footer className="dialog-foot">{footer}</footer>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

// -------------------------------------------------------------- OTP input

/* Six small cells and a caret. Digits rise into their cells; a right code (success) draws the
   cells together until a goo filter fuses them into one capsule that says so, and a wrong one
   (invalid) sends a shiver down the row and drains the digits out. One invisible input sits
   over the row, so paste, autofill, backspace and screen readers all just work. */

const OTP_W = 36;
const OTP_H = 44;
const OTP_G = 7;
const OTP_CAP = 128;
const OTP_POP_MS = 260;
const OTP_SHAKE_MS = 620;
/* the merge is a spring a little under critical, so the capsule overshoots and settles */
const OTP_MERGE = (() => {
  const k = 0.075;
  const zeta = 0.42;
  return { k, d: 1 - 2 * zeta * Math.sqrt(k) };
})();
const clampN = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const mixN = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothN = (a: number, b: number, v: number) => {
  const u = clampN((v - a) / (b - a), 0, 1);
  return u * u * (3 - 2 * u);
};

/** Blur-and-threshold SVG filter; its id is per mount so two instances never collide. */
function useGoo(blur: number, cut: number) {
  const id = `goo-${useId().replace(/:/g, '')}`;
  const goo = (
    <svg className="liq-defs" aria-hidden="true" focusable="false">
      <defs>
        <filter id={id} x="-50%" y="-50%" width="200%" height="200%" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceGraphic" stdDeviation={blur} result="smear" />
          <feColorMatrix in="smear" type="matrix" values={`1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ${cut} ${-(cut / 2)}`} />
        </filter>
      </defs>
    </svg>
  );
  return { url: `url(#${id})`, goo };
}

type OtpPhase = 'type' | 'check' | 'ok' | 'no';

export function OtpInput({
  id,
  length,
  value,
  onChange,
  onComplete,
  label,
  masked = true,
  invalid = false,
  success = false,
  disabled = false,
  autoFocus = false,
  size = 'lg',
  describedBy,
}: {
  success?: boolean;
  id: string;
  length: number;
  value: string;
  onChange: (v: string) => void;
  onComplete?: (v: string) => void;
  label: string;
  masked?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  size?: 'lg' | 'md';
  describedBy?: string;
}) {
  const n = length;
  const r = 12;
  const rowW = n * OTP_W + (n - 1) * OTP_G;
  const still = useRef(typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches).current;
  const input = useRef<HTMLInputElement>(null);
  const [focus, setFocus] = useState(false);

  /* the last full code, kept so a wrong one can drain out after the parent clears it */
  const lastFull = useRef('');
  if (value.length === n) lastFull.current = value;
  const phase: OtpPhase = success ? 'ok' : invalid ? 'no' : value.length === n && disabled ? 'check' : 'type';
  /* once a wrong code has drained out, the row is empty and ready for another try */
  const [drained, setDrained] = useState(false);
  const shown = phase === 'no' && value === '' && !drained ? lastFull.current : value;

  const caret = useRef({ x: OTP_W / 2, v: 0 });
  const popAt = useRef<number[]>([]);
  const merge = useRef({ m: 0, v: 0, to: 0 });
  const shook = useRef(-Infinity);
  const raf = useRef(0);
  const [, setTick] = useState(0);
  /* start the shiver's clock in the same render that turns the row red, so the first
     frame of a wrong code is not drawn with a stale clock (digits blinking out and back) */
  const lastPhase = useRef(phase);
  if (phase !== lastPhase.current) {
    if (phase === 'no') shook.current = performance.now();
    lastPhase.current = phase;
  }
  const live = useRef({ value, n, phase });
  live.current = { value, n, phase };

  const wake = useCallback(() => {
    if (raf.current) return;
    let prev = 0;
    const tick = (t: number) => {
      const dt = prev ? clampN((t - prev) / 16.67, 0, 2.5) : 1;
      prev = t;
      let busy = false;
      const { value: c, n: count, phase: ph } = live.current;

      const target = Math.min(c.length, count - 1) * (OTP_W + OTP_G) + OTP_W / 2;
      const k = caret.current;
      if (still) {
        k.x = target;
        k.v = 0;
      } else {
        k.v += (target - k.x) * 0.2 * dt;
        k.v *= Math.pow(0.62, dt);
        k.x += k.v * dt;
        if (Math.abs(target - k.x) < 0.05 && Math.abs(k.v) < 0.05) {
          k.x = target;
          k.v = 0;
        } else busy = true;
      }

      const mg = merge.current;
      if (mg.m !== mg.to || mg.v !== 0) {
        if (still) {
          mg.m = mg.to;
          mg.v = 0;
        } else {
          mg.v += (mg.to - mg.m) * OTP_MERGE.k * dt;
          mg.v *= Math.pow(OTP_MERGE.d, dt);
          mg.m += mg.v * dt;
          if (Math.abs(mg.to - mg.m) < 0.0008 && Math.abs(mg.v) < 0.0008) {
            mg.m = mg.to;
            mg.v = 0;
          } else busy = true;
        }
      }

      if (t - shook.current < OTP_SHAKE_MS + 200 + count * 45) busy = true;
      if (ph === 'check' && !still) busy = true;
      setTick((x) => x + 1);
      if (popAt.current.some((at) => t - at < OTP_POP_MS)) busy = true;
      raf.current = busy ? requestAnimationFrame(tick) : 0;
    };
    raf.current = requestAnimationFrame(tick);
  }, [still]);

  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    },
    [],
  );
  useEffect(() => {
    wake();
  }, [value, n, phase, focus, wake]);

  useEffect(() => {
    if (autoFocus && !disabled) input.current?.focus();
  }, [autoFocus, disabled]);

  /* answers: a right code fuses and blurs, a wrong one shivers, a fused row splits again */
  const prevPhase = useRef(phase);
  useEffect(() => {
    const was = prevPhase.current;
    prevPhase.current = phase;
    if (phase === was) return;
    if (phase === 'ok') {
      play('perk');
      merge.current = { ...merge.current, to: 1 };
      input.current?.blur();
    } else if (phase === 'no') {
      play('deny');
      setDrained(false);
      const t = window.setTimeout(() => {
        setDrained(true);
        const t0 = performance.now();
        for (let i = 0; i < n; i++) popAt.current[i] = t0 + i * 40;
        wake();
        input.current?.focus();
      }, still ? 0 : 200 + n * 40 + 260);
      wake();
      return () => window.clearTimeout(t);
    } else if (was === 'ok') {
      play('expand');
      merge.current = { ...merge.current, to: 0 };
    }
    wake();
  }, [phase, wake]);

  const handle = (raw: string) => {
    if (success) return;
    const next = raw.replace(/\D/g, '').slice(0, n);
    if (!still && next.length > value.length) {
      const t0 = performance.now();
      for (let i = value.length; i < next.length; i++) popAt.current[i] = t0 + (i - value.length) * 45;
    }
    onChange(next);
    if (next.length === n) onComplete?.(next);
  };

  const now = performance.now();
  const raw = merge.current.m;
  const m = clampN(raw, 0, 1);
  const home = (i: number) => i * (OTP_W + OTP_G);
  const mid = (rowW - OTP_W) / 2;
  const since = now - shook.current;
  const shaking = phase === 'no' && since < OTP_SHAKE_MS && !still;
  const shake = (i: number) =>
    shaking ? 8 * Math.exp(-since / 170) * Math.sin((since / 1000) * Math.PI * 2 * 7.5 - i * 0.45) : 0;
  /* each cell squashes with how hard it is moving, so the shiver reads as jelly, not a slide */
  const squash = (i: number): [number, number] => {
    if (!shaking) return [1, 1];
    const v = Math.abs(8 * Math.exp(-since / 170) * Math.cos((since / 1000) * Math.PI * 2 * 7.5 - i * 0.45)) / 8;
    return [1 + 0.1 * v, 1 - 0.08 * v];
  };
  const cellX = (i: number) => mixN(home(i), mid, m) + shake(i);
  const pop = (i: number) => {
    const at = popAt.current[i];
    if (at === undefined) return 1;
    const u = (now - at) / OTP_POP_MS;
    return u > 0 && u < 1 ? 1 + 0.04 * Math.sin(Math.PI * u) : 1;
  };
  const breath = (i: number) => {
    if (phase !== 'check' || still) return pop(i);
    const u = ((now % 900) / 900) * (n + 2) - i;
    return 1 - 0.07 * (u > 0 && u < 2 ? Math.sin((u / 2) * Math.PI) : 0);
  };
  const over = raw - 1;
  const capW = OTP_CAP * smoothN(0.3, 1, m) * (1 + Math.max(-0.12, over) * 0.9);
  const capSy = 1 - Math.max(-0.12, over) * 0.55;
  const cellR = mixN(r, OTP_H / 2, smoothN(0.15, 0.7, m));
  const typing = focus && (phase === 'type' || (phase === 'no' && drained));
  const { url, goo } = useGoo(3, 24);

  return (
    <div
      className={`otp otp-${size}`}
      data-phase={phase}
      data-drained={(phase === 'no' && drained) || undefined}
      data-disabled={(disabled && phase === 'type') || undefined}
      onClick={() => input.current?.focus()}
    >
      <label htmlFor={id} className="visually-hidden">
        {label}
      </label>
      <div className="otp-row" style={{ width: rowW, height: OTP_H }}>
        <div className="otp-goo" aria-hidden="true" style={{ filter: still ? undefined : url }}>
          {Array.from({ length: n }, (_, i) => (
            <span
              key={i}
              className="otp-cell"
              style={{
                width: OTP_W,
                borderRadius: cellR,
                transform: `translateX(${cellX(i).toFixed(2)}px) scale(${(breath(i) * squash(i)[0]).toFixed(3)}, ${(breath(i) * squash(i)[1]).toFixed(3)})`,
              }}
            />
          ))}
          {capW > 0.5 && (
            <span
              className="otp-cell"
              style={{
                width: capW,
                borderRadius: OTP_H / 2,
                transform: `translateX(${((rowW - capW) / 2).toFixed(2)}px) scaleY(${capSy.toFixed(3)})`,
              }}
            />
          )}
        </div>

        {Array.from({ length: n }, (_, i) => {
          const d = shown[i];
          /* a wrong code drains right to left */
          const out = phase === 'no' && value === '' && !still ? smoothN(0, 1, (since - 200 - (n - 1 - i) * 40) / 240) : 0;
          return (
            <span
              key={i}
              className="otp-slot"
              aria-hidden="true"
              style={{ width: OTP_W, transform: `translateX(${cellX(i).toFixed(2)}px)`, opacity: 1 - smoothN(0, 0.45, m) }}
            >
              {d && (
                <span
                  key={masked ? `${i}-dot` : `${i}-${d}`}
                  className={masked ? 'otp-digit otp-dot' : 'otp-digit'}
                  style={{ opacity: 1 - out }}
                >
                  {masked ? null : d}
                </span>
              )}
            </span>
          );
        })}

        <i
          className="otp-caret"
          aria-hidden="true"
          data-on={typing && value.length < n && m < 0.08}
          style={{
            transform: `translateX(${(caret.current.x - 1).toFixed(2)}px) scaleX(${(1 + Math.min(5, Math.abs(caret.current.v) * 0.9)).toFixed(3)})`,
          }}
        />

        <span className="otp-ok" aria-hidden="true" style={{ opacity: smoothN(0.72, 1, m), scale: `${mixN(0.92, 1, smoothN(0.72, 1, m))}` }}>
          <Check size={14} strokeWidth={2} aria-hidden="true" />
          Verified
        </span>

        <input
          ref={input}
          id={id}
          className="otp-field"
          type={masked ? 'password' : 'text'}
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          data-form-type="other"
          maxLength={n}
          value={value}
          disabled={disabled}
          spellCheck={false}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          onChange={(e) => handle(e.target.value)}
          onSelect={(e) => {
            const el = e.currentTarget;
            if (el.selectionStart !== el.value.length) el.setSelectionRange(el.value.length, el.value.length);
          }}
        />
      </div>
      {goo}
    </div>
  );
}

/**
 * Ref for a page's fixed title bar: keeps `--page-head-h` on its scrolling pane in step with the
 * bar's height, so side panels can stay put just below it while the list scrolls.
 */
export function stickyHead(el: HTMLElement | null) {
  const pane = el?.closest<HTMLElement>('.page-pane');
  if (!el || !pane) return;
  const sync = () => pane.style.setProperty('--page-head-h', `${el.offsetHeight}px`);
  sync();
  const watch = new ResizeObserver(sync);
  watch.observe(el);
  return () => watch.disconnect();
}
