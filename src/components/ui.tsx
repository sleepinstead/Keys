import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, KeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Check, Copy, Folder, Monitor, Moon, Sun, X } from 'lucide-react';
import { api } from '../api.ts';
import { dialog, fade, pop, quick } from '../motion.ts';
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
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; shortcut?: string; tooltipSide?: 'top' | 'bottom' | 'right'; variant?: 'ghost' | 'outline' }) {
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
    parts.push(m[1]!.replace('+', ''));
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

export function Switch({ checked, onChange, label, id, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; id?: string; disabled?: boolean }) {
  return (
    <button id={id} type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="switch-knob" />
    </button>
  );
}

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
  return (
    <div className={`segmented${size ? ` segmented-${size}` : ''}${block ? ' segmented-block' : ''}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}>
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
  return (
    <div className="theme-toggle" role="radiogroup" aria-label="Theme">
      {options.map((o) => (
        <Tooltip key={o.value} content={o.label}>
          <button type="button" role="radio" aria-checked={value === o.value} aria-label={o.label} onClick={() => onChange(o.value)}>
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
      {items.map((item) => (
        <div key={item.label}>
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
      (el.querySelector<HTMLElement>('[data-autofocus], [autofocus]') ?? el.querySelector<HTMLElement>('input, textarea, select, button:not([data-dialog-close])') ?? el).focus();
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

/**
 * Numeric one-digit-per-box input, like a verification-code field. One real input sits on
 * top (transparent) so typing, paste, autofill, backspace and screen readers all just work;
 * the boxes are a picture of its value. Six-digit codes show as two groups of three.
 */
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
  const input = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (autoFocus && !disabled) input.current?.focus();
  }, [autoFocus, disabled]);
  const groupAt = length === 6 ? 3 : -1;
  // A new failure replays the shake even if the previous one is still marked invalid.
  const [shakes, setShakes] = useState(0);
  useEffect(() => {
    if (invalid) setShakes((n) => n + 1);
  }, [invalid]);

  return (
    <div className={`otp otp-${size}`} data-length={length} data-shake={shakes % 2} data-invalid={invalid || undefined} data-success={success || undefined} data-disabled={(disabled && !success) || undefined} onClick={() => input.current?.focus()}>
      <label htmlFor={id} className="visually-hidden">
        {label}
      </label>
      <input
        ref={input}
        id={id}
        className="otp-input"
        type={masked ? 'password' : 'text'}
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="off"
        maxLength={length}
        value={value}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          const next = e.target.value.replace(/\D/g, '').slice(0, length);
          onChange(next);
          if (next.length === length) onComplete?.(next);
        }}
        onSelect={(e) => {
          const el = e.currentTarget;
          if (el.selectionStart !== el.value.length) el.setSelectionRange(el.value.length, el.value.length);
        }}
      />
      {Array.from({ length }, (_, i) => {
        const ch = value[i];
        const current = focused && i === Math.min(value.length, length - 1) && (ch === undefined || value.length === length);
        return (
          <span key={i} className="otp-slot">
            {i === groupAt && <span className="otp-sep" aria-hidden="true" />}
            <span
              className="otp-cell"
              data-filled={ch !== undefined || undefined}
              data-current={current || undefined}
              style={{ '--i': i } as CSSProperties}
              aria-hidden="true"
            >
              <AnimatePresence initial={false}>
                {ch !== undefined && (
                  <motion.span
                    key={masked ? 'dot' : `d${ch}`}
                    className={masked ? 'otp-dot' : 'otp-digit'}
                    initial={{ scale: 0.2, opacity: 0, y: masked ? 0 : 6 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    exit={{ scale: 0.4, opacity: 0, transition: { duration: 0.1 } }}
                    transition={{ type: 'spring', stiffness: 700, damping: 28, mass: 0.6 }}
                  >
                    {masked ? null : ch}
                  </motion.span>
                )}
              </AnimatePresence>
              {current && ch === undefined && <span className="otp-caret" />}
            </span>
          </span>
        );
      })}
    </div>
  );
}
