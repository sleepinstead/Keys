import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CornerDownLeft, Lock, Search, SlidersHorizontal, ShieldCheck, Sparkles } from 'lucide-react';
import { dialog, fade } from '../motion.ts';
import type { EntrySummary, EntryType } from '../../shared/types.ts';
import { hostname, TYPE_LABELS } from '../util.ts';
import { TYPE_ICONS } from './Sidebar.tsx';
import { Kbd, Monogram } from './ui.tsx';

export interface PaletteActions {
  openItem: (id: string) => void;
  create: (type: EntryType) => void;
  generator: () => void;
  audit: () => void;
  settings: () => void;
  lock: () => void;
}

interface Result {
  id: string;
  group: 'Items' | 'Actions';
  label: string;
  sub?: string;
  icon: ReactNode;
  run: () => void;
}

function score(hay: string, q: string): number {
  const h = hay.toLowerCase();
  if (h.startsWith(q)) return 3;
  if (h.split(/[\s.@_-]/).some((w) => w.startsWith(q))) return 2;
  return h.includes(q) ? 1 : 0;
}

export function CommandPalette({
  open,
  onClose,
  entries,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  entries: EntrySummary[];
  actions: PaletteActions;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      returnFocus.current = document.activeElement as HTMLElement | null;
      setQuery('');
      setActive(0);
      requestAnimationFrame(() => input.current?.focus());
    } else {
      returnFocus.current?.focus?.();
    }
  }, [open]);

  const results = useMemo<Result[]>(() => {
    const q = query.trim().toLowerCase();
    const commands: Result[] = [
      ...(Object.keys(TYPE_LABELS) as EntryType[]).map((t) => ({
        id: `new-${t}`,
        group: 'Actions' as const,
        label: `New ${TYPE_LABELS[t].inline}`,
        icon: TYPE_ICONS[t],
        run: () => actions.create(t),
      })),
      { id: 'gen', group: 'Actions', label: 'Generate a password', icon: <Sparkles size={16} />, run: actions.generator },
      { id: 'audit', group: 'Actions', label: 'Run security audit', icon: <ShieldCheck size={16} />, run: actions.audit },
      { id: 'settings', group: 'Actions', label: 'Open settings', icon: <SlidersHorizontal size={16} />, run: actions.settings },
      { id: 'lock', group: 'Actions', label: 'Lock now', icon: <Lock size={16} />, run: actions.lock },
    ];
    const items: Result[] = entries
      .map((e) => ({ e, s: q ? Math.max(score(e.title, q) * 2, score(e.username, q), score(hostname(e.url), q)) : 1 }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || (q ? a.e.title.length - b.e.title.length : 0) || b.e.updatedAt - a.e.updatedAt)
      .slice(0, q ? 8 : 5)
      .map(({ e }) => ({
        id: e.id,
        group: 'Items' as const,
        label: e.title,
        sub: e.username || hostname(e.url) || TYPE_LABELS[e.type].one,
        icon: <Monogram title={e.title} type={e.type} size="sm" icon={e.icon} />,
        run: () => actions.openItem(e.id),
      }));
    const cmds = q ? commands.filter((c) => score(c.label, q) > 0) : commands;
    return [...items, ...cmds];
  }, [query, entries, actions]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (r: Result | undefined) => {
    if (!r) return;
    onClose();
    r.run();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(results.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      run(results[active]);
    } else if (e.key === 'Tab') {
      e.preventDefault();
    }
  };

  let lastGroup = '';

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="palette-layer" {...fade}>
          <div className="dialog-overlay" onClick={onClose} />
          <motion.div
            className="palette"
            role="dialog"
            aria-modal="true"
            aria-label="Search and commands"
            onKeyDown={onKeyDown}
            {...dialog}
          >
            <div className="palette-search">
              <Search size={17} aria-hidden="true" />
              <input
                ref={input}
                className="palette-input"
                aria-label="Search items and commands"
                placeholder="Search items or type a command"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                role="combobox"
                aria-expanded="true"
                aria-controls="palette-list"
                aria-activedescendant={results[active] ? `pal-${results[active].id}` : undefined}
                spellCheck={false}
                autoComplete="off"
              />
              <Kbd>Esc</Kbd>
            </div>
            <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
              {results.length === 0 && <p className="palette-empty">No items or commands match “{query}”.</p>}
              {results.map((r, i) => {
                const header = r.group !== lastGroup ? r.group : null;
                lastGroup = r.group;
                return (
                  <div key={r.id}>
                    {header && <div className="palette-group">{header === 'Items' && !query ? 'Recent' : header}</div>}
                    <button
                      type="button"
                      id={`pal-${r.id}`}
                      role="option"
                      aria-selected={i === active}
                      data-index={i}
                      className="palette-row"
                      onMouseMove={() => i !== active && setActive(i)}
                      onClick={() => run(r)}
                    >
                      <span className="palette-icon">{r.icon}</span>
                      <span className="palette-text">
                        <span className="palette-label">{r.label}</span>
                        {r.sub && <span className="palette-sub">{r.sub}</span>}
                      </span>
                      {i === active && <CornerDownLeft size={15} className="palette-enter" aria-hidden="true" />}
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="palette-foot">
              <span>
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> to move
              </span>
              <span>
                <Kbd>↵</Kbd> to open
              </span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
