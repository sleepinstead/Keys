import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronDown, Lock, Plus, Search } from 'lucide-react';
import { useSettings } from '../context.tsx';
import { collapse, pop, quick } from '../motion.ts';
import type { ChecklistStep } from '../../shared/types.ts';
import { modKey } from '../util.ts';
import { IconButton, Kbd } from './ui.tsx';

const GAP = 12;
const TIP_WIDTH = 264;

const TIPS: { target: string; title: string; body: string; art: ReactNode }[] = [
  {
    target: '.split',
    title: 'Add anything',
    body: 'Logins, notes, API keys and recovery codes. Press N from anywhere.',
    art: (
      <>
        <span className="tip-chip">
          <Plus size={13} /> New
        </span>
        <i className="tip-line" />
      </>
    ),
  },
  {
    target: '.search-trigger',
    title: 'Find it fast',
    body: 'Search your items and run any command from the keyboard.',
    art: (
      <>
        <Search size={14} />
        <i className="tip-line" />
        <Kbd tone="tooltip">{`${modKey}K`}</Kbd>
      </>
    ),
  },
  {
    target: '.lock-btn',
    title: 'Locks by itself',
    body: 'Keys locks after a few idle minutes. Lock it yourself here anytime.',
    art: (
      <>
        <Lock size={14} />
        <i className="tip-line" />
      </>
    ),
  },
];

const isVisible = (selector: string) => {
  const r = document.querySelector(selector)?.getBoundingClientRect();
  return !!r && r.width > 0 && r.left >= 0;
};

/** Small one-time notes anchored to the controls they explain. */
function Tour({ onFinish, watch }: { onFinish: () => void; watch: unknown }) {
  // Measured once the app has settled; a narrow window hides the sidebar's targets.
  const [tips, setTips] = useState<typeof TIPS | null>(null);
  const [index, setIndex] = useState(0);
  const [place, setPlace] = useState<{ left: number; top: number; arrow: number; side: 'right' | 'bottom' } | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const tip = tips?.[index];

  useEffect(() => {
    const t = window.setTimeout(() => {
      const shown = TIPS.filter((x) => isVisible(x.target));
      if (shown.length) setTips(shown);
      else onFinish();
    }, 700);
    return () => window.clearTimeout(t);
  }, []);

  useLayoutEffect(() => {
    if (!tip) return;
    const measure = () => {
      const r = document.querySelector(tip.target)?.getBoundingClientRect();
      if (!r || !card.current) return setPlace(null);
      const height = card.current.offsetHeight;
      if (r.right + GAP + TIP_WIDTH < window.innerWidth && r.right < 300) {
        const top = Math.max(8, Math.min(window.innerHeight - height - 8, r.top + r.height / 2 - height / 2));
        setPlace({ side: 'right', left: r.right + GAP, top, arrow: r.top + r.height / 2 - top });
      } else {
        const left = Math.max(8, Math.min(window.innerWidth - TIP_WIDTH - 8, r.left + r.width / 2 - TIP_WIDTH / 2));
        setPlace({ side: 'bottom', left, top: r.bottom + GAP, arrow: r.left + r.width / 2 - left });
      }
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [tip, watch]);

  useEffect(() => {
    if (place) next.current?.focus({ preventScroll: true });
  }, [index, !place]);

  if (!tips || !tip) return null;
  const last = index === tips.length - 1;

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={index}
        ref={card}
        className="tip"
        role="dialog"
        aria-label={tip.title}
        data-side={place?.side}
        style={{ left: place?.left ?? 0, top: place?.top ?? 0, visibility: place ? 'visible' : 'hidden', width: TIP_WIDTH, '--arrow': `${place?.arrow ?? 0}px` } as CSSProperties}
        onKeyDown={(e) => e.key === 'Escape' && onFinish()}
        {...pop}
      >
        <div className="tip-art" aria-hidden="true">
          {tip.art}
        </div>
        <h2>{tip.title}</h2>
        <p>{tip.body}</p>
        <div className="tip-foot">
          <span>
            {index + 1} of {tips.length}
          </span>
          {!last && (
            <button type="button" className="tip-skip" onClick={onFinish}>
              Skip
            </button>
          )}
          <button ref={next} type="button" className="tip-next" onClick={() => (last ? onFinish() : setIndex(index + 1))}>
            {last ? 'Done' : 'Next'}
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

function Checklist({
  hasItems,
  onAdd,
  onGo,
}: {
  hasItems: boolean;
  onAdd: () => void;
  onGo: (step: ChecklistStep) => void;
}) {
  const { settings, updateSettings } = useSettings();
  const [open, setOpen] = useState(() => window.innerWidth > 860);
  const done = settings.checklist?.done ?? [];
  const items: { label: string; done: boolean; go?: () => void }[] = [
    { label: 'Create your vault', done: true },
    { label: 'Add your first item', done: hasItems, go: onAdd },
    { label: 'Try the generator', done: done.includes('generator'), go: () => onGo('generator') },
    { label: 'Run a security audit', done: done.includes('audit'), go: () => onGo('audit') },
    { label: 'Make a backup', done: done.includes('backup'), go: () => onGo('backup') },
  ];
  const complete = items.filter((i) => i.done).length;
  const finish = () => void updateSettings({ checklist: null }).catch(() => {});

  return (
    <motion.aside className="gs" aria-label="Getting started" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={quick}>
      <header className="gs-head">
        <div>
          <h2>Getting started</h2>
          <p>A few things worth doing first</p>
        </div>
        <IconButton label={open ? 'Collapse' : 'Expand'} className="gs-toggle" data-open={open || undefined} onClick={() => setOpen(!open)}>
          <ChevronDown size={16} />
        </IconButton>
      </header>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="collapse" {...collapse}>
            <ul className="gs-list">
              {items.map((item) => (
                <li key={item.label}>
                  <button type="button" className="gs-item" data-done={item.done || undefined} disabled={item.done} onClick={item.go}>
                    <span className="gs-check" aria-hidden="true">
                      {item.done && <Check size={11} strokeWidth={3} />}
                    </span>
                    {item.label}
                    {item.done && <span className="visually-hidden"> (done)</span>}
                  </button>
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
      <footer className="gs-foot">
        <span>
          {complete} of {items.length} complete
        </span>
        <span className="gs-bar" aria-hidden="true">
          <i style={{ width: `${(complete / items.length) * 100}%` }} />
        </span>
        <button type="button" className="text-btn" onClick={finish}>
          {complete === items.length ? 'Finish' : 'Dismiss'}
        </button>
      </footer>
    </motion.aside>
  );
}

/** The welcome inside the app: a short tour once, then a checklist until it's finished or dismissed. */
export function GettingStarted({ hasItems, onAdd, onGo, watch }: { hasItems: boolean; onAdd: () => void; onGo: (step: ChecklistStep) => void; watch: unknown }) {
  const { settings, updateSettings } = useSettings();
  const state = settings.checklist;
  if (!state) return null;
  if (!state.tourSeen) return <Tour watch={watch} onFinish={() => void updateSettings({ checklist: { ...state, tourSeen: true } }).catch(() => {})} />;
  return <Checklist hasItems={hasItems} onAdd={onAdd} onGo={onGo} />;
}
