import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { CATEGORY_COLORS } from '../../shared/types.ts';
import type { CategoryColor } from '../../shared/types.ts';
import { pop } from '../motion.ts';

const COLORS = Object.keys(CATEGORY_COLORS) as CategoryColor[];
const name = (c: CategoryColor) => c[0]!.toUpperCase() + c.slice(1);

/**
 * A small floating menu of folder colours, anchored under its trigger. It's
 * rendered at the page root so tiles that clip their contents can't cut it off.
 * Closes on pick, outside click, Escape or scroll.
 */
export function ColorMenu({
  value,
  onChange,
  label,
  trigger,
}: {
  value: CategoryColor | null;
  onChange: (color: CategoryColor | null) => void;
  label: string;
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'dialog' }) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    const width = 236;
    setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (e: PointerEvent) => {
      if (!panel.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        anchor.current?.querySelector('button')?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    requestAnimationFrame(() => (panel.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? panel.current?.querySelector<HTMLElement>('button'))?.focus());
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const pick = (c: CategoryColor | null) => {
    setOpen(false);
    onChange(c);
  };

  return (
    <>
      <span ref={anchor} className="color-menu-anchor">
        {trigger({ onClick: () => setOpen((o) => !o), 'aria-expanded': open, 'aria-haspopup': 'dialog' })}
      </span>
      {createPortal(
        <AnimatePresence>
          {open && pos && (
            <motion.div
              ref={panel}
              className="color-menu"
              role="dialog"
              aria-label={label}
              style={{ top: pos.top, left: pos.left }}
              {...pop}
            >
              <div className="color-menu-head">
                <span>Folder colour</span>
                <button type="button" className="text-btn" onClick={() => pick(null)} aria-pressed={value === null}>
                  None
                </button>
              </div>
              <div className="color-menu-grid" role="radiogroup" aria-label={label}>
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={value === c}
                    aria-label={name(c)}
                    title={name(c)}
                    className="color-menu-swatch"
                    style={{ '--swatch': CATEGORY_COLORS[c] } as CSSProperties}
                    onClick={() => pick(c)}
                  />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
