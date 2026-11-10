import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronDown } from 'lucide-react';
import { pop } from '../motion.ts';

export interface SelectOption<T extends string | number> {
  value: T;
  label: string;
}

/**
 * The app's own dropdown, used instead of the browser's native one so it looks
 * like every other menu. The list floats at the page root (so tiles and dialogs
 * can't clip it) and flips above the trigger when there's no room below.
 * Keyboard: ↑/↓ or Enter/Space opens; ↑/↓ moves, Enter picks, Escape or Tab closes,
 * Home/End jump, and typing a letter jumps to the next option starting with it.
 */
export function Select<T extends string | number>({
  id,
  value,
  options,
  onChange,
  label,
  className = '',
}: {
  id?: string;
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  /** Accessible name when there's no visible <label for={id}>. */
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const current = options[selectedIndex];

  const place = () => {
    const r = trigger.current!.getBoundingClientRect();
    const height = Math.min(options.length * 34 + 12, 320);
    const below = window.innerHeight - r.bottom;
    const width = Math.max(r.width, 160);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    setPos(below < height + 12 && r.top > below ? { left, width, bottom: window.innerHeight - r.top + 6 } : { left, width, top: r.bottom + 6 });
  };

  const show = () => {
    setActive(selectedIndex);
    setOpen(true);
  };
  const hide = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const pick = (i: number) => {
    const o = options[i];
    if (o && o.value !== value) onChange(o.value);
    hide();
  };

  useLayoutEffect(() => {
    if (open) place();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!list.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) hide(false);
    };
    const close = () => hide(false);
    // Escape closes only this menu. Caught before React sees it, so a dialog
    // around the dropdown doesn't close too.
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      hide();
    };
    document.addEventListener('keydown', onEscape, true);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', close);
    // Scrolling the page closes the list (it's positioned against the trigger); scrolling the list itself doesn't.
    const onScroll = (e: Event) => !list.current?.contains(e.target as Node) && close();
    window.addEventListener('scroll', onScroll, true);
    requestAnimationFrame(() => list.current?.focus());
    return () => {
      document.removeEventListener('keydown', onEscape, true);
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const typeahead = (key: string, from: number) => {
    const k = key.toLowerCase();
    for (let step = 1; step <= options.length; step++) {
      const i = (from + step) % options.length;
      if (options[i]!.label.toLowerCase().startsWith(k)) return i;
    }
    return from;
  };

  const onTriggerKey = (e: ReactKeyboardEvent) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      show();
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      const i = typeahead(e.key, selectedIndex);
      if (i !== selectedIndex) onChange(options[i]!.value);
    }
  };

  const onListKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // don't also close a dialog this sits in
      hide();
    } else if (e.key === 'Tab') {
      hide();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(options.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setActive(e.key === 'Home' ? 0 : options.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(active);
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      setActive((a) => typeahead(e.key, a));
    }
  };

  return (
    <>
      <button
        ref={trigger}
        id={id}
        type="button"
        className={`select select-trigger ${className}`.trim()}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={label ? `${label}: ${current?.label ?? ''}` : undefined}
        data-open={open || undefined}
        onClick={() => (open ? hide() : show())}
        onKeyDown={onTriggerKey}
      >
        <span className="select-value">{current?.label}</span>
        <ChevronDown size={14} className="select-chevron" aria-hidden="true" />
      </button>
      {createPortal(
        <AnimatePresence>
          {open && pos && (
            <motion.ul
              ref={list}
              id={listId}
              role="listbox"
              tabIndex={-1}
              aria-activedescendant={`${listId}-${active}`}
              className="select-menu"
              style={{ left: pos.left, minWidth: pos.width, top: pos.top, bottom: pos.bottom, transformOrigin: pos.top !== undefined ? 'top' : 'bottom' }}
              onKeyDown={onListKey}
              {...pop}
            >
              {options.map((o, i) => (
                <li
                  key={String(o.value)}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={o.value === value}
                  data-index={i}
                  data-active={i === active || undefined}
                  className="select-option"
                  onPointerMove={() => setActive(i)}
                  onClick={() => pick(i)}
                >
                  <span className="select-check" aria-hidden="true">
                    {o.value === value && <Check size={14} strokeWidth={2.4} />}
                  </span>
                  {o.label}
                </li>
              ))}
            </motion.ul>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
