import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { FileKey2, KeyRound, Layers, LifeBuoy, Lock, NotebookPen, Plus, Search, SlidersHorizontal, ShieldCheck, Sparkles, Star, Trash2 } from 'lucide-react';
import { useSettings } from '../context.tsx';
import type { Category, CategoryColor, EntrySummary, EntryType } from '../../shared/types.ts';
import { modKey, TYPE_LABELS } from '../util.ts';
import { AppMark, IconButton, Kbd, Tooltip, FolderIcon } from './ui.tsx';
import { ColorMenu } from './ColorMenu.tsx';

export type Filter =
  | { kind: 'all' }
  | { kind: 'favorites' }
  | { kind: 'type'; type: EntryType }
  | { kind: 'category'; categoryId: string };

export type View = { kind: 'items'; filter: Filter } | { kind: 'generator' } | { kind: 'audit' } | { kind: 'trash' } | { kind: 'settings' };

export const TYPE_ICONS: Record<EntryType, ReactNode> = {
  login: <KeyRound size={16} />,
  note: <NotebookPen size={16} />,
  apiKey: <FileKey2 size={16} />,
  recovery: <LifeBuoy size={16} />,
};

export function viewKey(v: View): string {
  if (v.kind !== 'items') return v.kind;
  const f = v.filter;
  return f.kind === 'type' ? `type:${f.type}` : f.kind === 'category' ? `cat:${f.categoryId}` : f.kind;
}

/** Badge colour for each section of the sidebar. */
const TYPE_TONES: Record<EntryType, string> = { login: 'blue', note: 'orange', apiKey: 'violet', recovery: 'teal' };
const CATEGORY_TONES = ['pink', 'cyan', 'lime', 'indigo', 'amber', 'rose', 'emerald', 'sky'];

function NavItem({
  active,
  onClick,
  icon,
  label,
  count,
  tone = 'gray',
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  count?: number;
  tone?: string;
}) {
  const button = (
      <button type="button" className="nav-item" aria-current={active ? 'page' : undefined} onClick={onClick}>
        <span className="nav-icon">{icon}</span>
        <span className="nav-label">{label}</span>
        {count !== undefined && count > 0 && (
          <span className="nav-count" data-tone={tone}>
            {count}
          </span>
        )}
      </button>
  );
  return <li>{button}</li>;
}

export function Sidebar({
  view,
  onView,
  entries,
  categories,
  onAddCategory,
  onLock,
  onSearch,
  expiresAt,
  idleMs,
  auditCount,
  trashCount,
}: {
  view: View;
  onView: (v: View) => void;
  entries: EntrySummary[];
  categories: Category[];
  onAddCategory: (name: string, color: CategoryColor | null) => Promise<boolean>;
  onLock: () => void;
  onSearch: () => void;
  expiresAt: number | null;
  idleMs: number;
  auditCount: number | null;
  trashCount: number;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState<CategoryColor | null>(null);
  const { settings } = useSettings();
  const key = viewKey(view);
  const items = (filter: Filter): View => ({ kind: 'items', filter });
  const go = (v: View) => () => onView(v);

  async function addCategory(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setAdding(false);
    if (await onAddCategory(name.trim(), color)) {
      setName('');
      setColor(null);
      setAdding(false);
    }
  }

  const search = (
    <button type="button" className="search-trigger" onClick={onSearch}>
      <Search size={15} aria-hidden="true" />
      <span>Search</span>
      <Kbd>{`${modKey}K`}</Kbd>
    </button>
  );

  return (
    <nav className="sidebar" aria-label="Main">
      <div className="brand">
        <AppMark size="sm" />
        <span className="wordmark">Keys</span>
      </div>

      {search}

      <div className="nav-scroll">
        <ul className="nav-list">
          <NavItem active={key === 'all'} onClick={go(items({ kind: 'all' }))} icon={<Layers size={16} />} label="All items" count={entries.length} />
          <NavItem active={key === 'favorites'} onClick={go(items({ kind: 'favorites' }))} icon={<Star size={16} />} label="Favorites" count={entries.filter((e) => e.favorite).length} tone="yellow" />
        </ul>

        <h2 className="nav-heading">Types</h2>
        <ul className="nav-list">
          {(Object.keys(TYPE_LABELS) as EntryType[]).map((t) => (
            <NavItem
              key={t}
              active={key === `type:${t}`}
              onClick={go(items({ kind: 'type', type: t }))}
              icon={TYPE_ICONS[t]}
              label={TYPE_LABELS[t].many}
              count={entries.filter((e) => e.type === t).length}
              tone={TYPE_TONES[t]}
            />
          ))}
        </ul>

        <div className="nav-tools">
        <h2 className="nav-heading">Tools</h2>
        <ul className="nav-list">
          <NavItem active={key === 'generator'} onClick={go({ kind: 'generator' })} icon={<Sparkles size={16} />} label="Generator" />
          <NavItem active={key === 'audit'} onClick={go({ kind: 'audit' })} icon={<ShieldCheck size={16} />} label="Security audit" count={auditCount ?? undefined} tone="red" />
          <NavItem active={key === 'trash'} onClick={go({ kind: 'trash' })} icon={<Trash2 size={16} />} label="Recently deleted" count={trashCount || undefined} />
          <NavItem active={key === 'settings'} onClick={go({ kind: 'settings' })} icon={<SlidersHorizontal size={16} />} label="Settings" />
        </ul>
        </div>

        {settings.categoriesEnabled && (
          <div className="nav-categories">
            <div className="nav-heading-row">
              <h2 className="nav-heading">Categories</h2>
              <IconButton label="New category" className="icon-btn-xs" onClick={() => setAdding(true)} tooltipSide="right">
                <Plus size={14} />
              </IconButton>
            </div>
            <ul className="nav-list">
              {categories.map((c, i) => (
                <NavItem
                  key={c.id}
                  active={key === `cat:${c.id}`}
                  onClick={go(items({ kind: 'category', categoryId: c.id }))}
                  icon={<FolderIcon color={c.color} />}
                  label={c.name}
                  count={entries.filter((e) => e.categoryId === c.id).length}
                  tone={c.color ?? CATEGORY_TONES[i % CATEGORY_TONES.length]}
                />
              ))}
              {/* No animation: the field swaps straight for the new category, so the list never jumps. */}
              {adding && (
                  <li>
                    <form onSubmit={addCategory} className="nav-add">
                      <ColorMenu
                        label="Folder colour for the new category"
                        value={color}
                        onChange={setColor}
                        trigger={(props) => (
                          <IconButton label="Folder colour" className="icon-btn-xs" {...props}>
                            <FolderIcon color={color} />
                          </IconButton>
                        )}
                      />
                      <input
                        className="input input-sm"
                        autoFocus
                        placeholder="Category name"
                        aria-label="New category name"
                        maxLength={60}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        // Moving to the colour button or its menu isn't leaving the form.
                        onBlur={(e) => !name.trim() && !(e.relatedTarget as Element | null)?.closest('.nav-add, .color-menu') && setAdding(false)}
                        onKeyDown={(e) => e.key === 'Escape' && setAdding(false)}
                      />
                    </form>
                  </li>
                )}
            </ul>
          </div>
        )}
      </div>

      <div className="sidebar-foot">
        <LockButton onLock={onLock} expiresAt={expiresAt} idleMs={idleMs} />
      </div>
    </nav>
  );
}

/** Icon-only lock button. The tooltip says when the vault will lock itself; the icon turns red in the last minute. */
function LockButton({ onLock, expiresAt, idleMs }: { onLock: () => void; expiresAt: number | null; idleMs: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const left = expiresAt ? Math.max(0, expiresAt - now) : idleMs;
  const secs = Math.round(left / 1000);
  const soon = secs <= 60;
  const note = soon ? `Locks in ${secs}s if idle` : `Locks after ${Math.ceil(secs / 60)} min idle`;

  return (
    <Tooltip
      content={
        <>
          Lock now
          <span className="tooltip-sub">{note}</span>
        </>
      }
      shortcut={`${modKey}⇧L`}
    >
      <button type="button" className={`btn btn-outline lock-btn${soon ? ' is-soon' : ''}`} onClick={onLock} aria-label={`Lock now. ${note}`}>
        <Lock size={16} />
        Lock
      </button>
    </Tooltip>
  );
}
