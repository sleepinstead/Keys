import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { FormEvent, MouseEvent, ReactNode } from 'react';
import { ArrowDownToLine, FileKey2, PanelLeftClose, PanelLeftOpen, FolderOpen, KeyRound, Layers, LifeBuoy, Lock, NotebookPen, Pencil, Plus, Search, SlidersHorizontal, ShieldCheck, Sparkles, Star, Trash2, TriangleAlert } from 'lucide-react';
import { api } from '../api.ts';
import { useSettings } from '../context.tsx';
import type { AppUpdate, Category, CategoryColor, EntrySummary, EntryType, SyncStatus } from '../../shared/types.ts';
import { modKey, TYPE_LABELS } from '../util.ts';
import { AppMark, ContextMenu, IconButton, Kbd, Tooltip, FolderIcon, useContextMenu } from './ui.tsx';
import type { MenuItem } from './ui.tsx';
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
  onContextMenu,
  menuOpen,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  count?: number;
  tone?: string;
  onContextMenu?: (e: MouseEvent<HTMLButtonElement>) => void;
  menuOpen?: boolean;
}) {
  const collapsed = useContext(Collapsed);
  const button = (
      <button
        type="button"
        className="nav-item"
        aria-current={active ? 'page' : undefined}
        aria-label={collapsed ? label : undefined}
        data-menu-open={menuOpen || undefined}
        onClick={onClick}
        onContextMenu={onContextMenu}
      >
        <span className="nav-icon">{icon}</span>
        <span className="nav-label">{label}</span>
        {count !== undefined && count > 0 && (
          <span className="nav-count" data-tone={tone}>
            {count}
          </span>
        )}
      </button>
  );
  // Folded to icons: the name (and count) shows beside the icon on hover.
  return (
    <li>
      {collapsed ? (
        <Tooltip content={count ? `${label} · ${count}` : label} side="right">
          {button}
        </Tooltip>
      ) : (
        button
      )}
    </li>
  );
}

/** Whether the sidebar is folded down to a rail of icons. */
const Collapsed = createContext(false);

export function Sidebar({
  hidden,
  view,
  onView,
  entries,
  categories,
  onAddCategory,
  onCreate,
  onEditCategory,
  onDeleteCategory,
  onLock,
  onSearch,
  expiresAt,
  idleMs,
  auditCount,
  trashCount,
  sync,
  collapsed,
  onToggle,
}: {
  /** Off-canvas on a narrow screen: kept out of the tab order and away from screen readers. */
  hidden?: boolean;
  view: View;
  onView: (v: View) => void;
  entries: EntrySummary[];
  categories: Category[];
  onAddCategory: (name: string, color: CategoryColor | null) => Promise<boolean>;
  /** New item of a kind, optionally straight into a category. */
  onCreate: (type: EntryType, categoryId?: string) => void;
  onEditCategory: (id: string, patch: { name?: string; color?: CategoryColor | null }) => Promise<boolean>;
  onDeleteCategory: (category: Category) => void;
  onLock: () => void;
  onSearch: () => void;
  expiresAt: number | null;
  idleMs: number;
  auditCount: number | null;
  trashCount: number;
  /** Other computers using this file, and conflict copies to merge. */
  sync: SyncStatus | null;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState<CategoryColor | null>(null);
  const { settings } = useSettings();
  const key = viewKey(view);
  // Every count in one pass over the items, only when they change.
  const counts = useMemo(() => {
    const c = { favorites: 0, type: {} as Record<string, number>, category: {} as Record<string, number> };
    for (const e of entries) {
      if (e.favorite) c.favorites++;
      c.type[e.type] = (c.type[e.type] ?? 0) + 1;
      if (e.categoryId) c.category[e.categoryId] = (c.category[e.categoryId] ?? 0) + 1;
    }
    return c;
  }, [entries]);
  const items = (filter: Filter): View => ({ kind: 'items', filter });
  const go = (v: View) => () => onView(v);

  // Right-click menus: kinds offer a new item of that kind; categories can be opened, filled, edited or deleted.
  const rowMenu = useContextMenu<{ type: EntryType } | { category: Category }>();
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const menuItems = (t: { type: EntryType } | { category: Category }): MenuItem[] => {
    if ('type' in t) {
      return [
        { label: `Show ${TYPE_LABELS[t.type].many.toLowerCase()}`, icon: <FolderOpen size={15} />, onSelect: () => onView(items({ kind: 'type', type: t.type })) },
        { label: `New ${TYPE_LABELS[t.type].inline}`, icon: <Plus size={15} />, onSelect: () => onCreate(t.type) },
      ];
    }
    const c = t.category;
    return [
      { label: 'Show items', icon: <FolderOpen size={15} />, onSelect: () => onView(items({ kind: 'category', categoryId: c.id })) },
      { label: 'New login here', icon: <Plus size={15} />, onSelect: () => onCreate('login', c.id) },
      {
        label: 'Rename',
        icon: <Pencil size={15} />,
        separatorBefore: true,
        onSelect: () => {
          setEditName(c.name);
          setEditing(c.id);
        },
      },
      { label: 'Delete category…', icon: <Trash2 size={15} />, danger: true, separatorBefore: true, onSelect: () => onDeleteCategory(c) },
    ];
  };
  const isMenuFor = (match: (t: { type: EntryType } | { category: Category }) => boolean) => Boolean(rowMenu.menu && match(rowMenu.menu.target));

  async function saveEdit(e: FormEvent, c: Category) {
    e.preventDefault();
    const next = editName.trim();
    if (!next || next === c.name) return setEditing(null);
    if (await onEditCategory(c.id, { name: next })) setEditing(null);
  }

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
    <Tooltip content="Search" shortcut={`${modKey}K`} side="right" disabled={!collapsed}>
      <button type="button" className="search-trigger" onClick={onSearch} aria-label="Search">
        <Search size={15} aria-hidden="true" />
        <span className="search-label">Search</span>
        <Kbd>{`${modKey}K`}</Kbd>
      </button>
    </Tooltip>
  );

  return (
    <Collapsed.Provider value={collapsed}>
    <nav className="sidebar" id="main-nav" aria-label="Main" inert={hidden || undefined}>
      <div className="brand">
        <span className="brand-mark">
          <AppMark size="sm" />
          <span className="wordmark">Keys</span>
        </span>
        <IconButton className="sidebar-toggle" label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} shortcut={`${modKey}\\`} tooltipSide={collapsed ? 'right' : 'bottom'} onClick={onToggle} aria-expanded={!collapsed} aria-controls="main-nav">
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </IconButton>
      </div>

      {search}

      <div className="nav-scroll">
        <ul className="nav-list">
          <NavItem active={key === 'all'} onClick={go(items({ kind: 'all' }))} icon={<Layers size={16} />} label="All items" count={entries.length} />
          <NavItem active={key === 'favorites'} onClick={go(items({ kind: 'favorites' }))} icon={<Star size={16} />} label="Favorites" count={counts.favorites} tone="yellow" />
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
              count={counts.type[t] ?? 0}
              tone={TYPE_TONES[t]}
              onContextMenu={(e) => rowMenu.open(e, { type: t })}
              menuOpen={isMenuFor((m) => 'type' in m && m.type === t)}
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
              {categories.map((c, i) =>
                editing === c.id ? (
                  <li key={c.id}>
                    <form onSubmit={(e) => void saveEdit(e, c)} className="nav-add">
                      <ColorMenu
                        label={`Folder colour for ${c.name}`}
                        value={c.color}
                        onChange={(next) => void onEditCategory(c.id, { color: next })}
                        trigger={(props) => (
                          <IconButton label="Folder colour" className="icon-btn-xs" {...props}>
                            <FolderIcon color={c.color} />
                          </IconButton>
                        )}
                      />
                      <input
                        className="input input-sm"
                        autoFocus
                        aria-label={`New name for ${c.name}`}
                        maxLength={60}
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onFocus={(e) => e.currentTarget.select()}
                        // Leaving the field saves, like renaming in Finder; the colour menu doesn't count as leaving.
                        onBlur={(e) => !(e.relatedTarget as Element | null)?.closest('.nav-add, .color-menu') && void saveEdit(e as unknown as FormEvent, c)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            e.stopPropagation();
                            setEditing(null);
                          }
                        }}
                      />
                    </form>
                  </li>
                ) : (
                  <NavItem
                    key={c.id}
                    active={key === `cat:${c.id}`}
                    onClick={go(items({ kind: 'category', categoryId: c.id }))}
                    icon={<FolderIcon color={c.color} />}
                    label={c.name}
                    count={counts.category[c.id] ?? 0}
                    tone={c.color ?? CATEGORY_TONES[i % CATEGORY_TONES.length]}
                    onContextMenu={(e) => rowMenu.open(e, { category: c })}
                    menuOpen={isMenuFor((m) => 'category' in m && m.category.id === c.id)}
                  />
                ),
              )}
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

      <ContextMenu
        at={rowMenu.menu}
        items={rowMenu.menu ? menuItems(rowMenu.menu.target) : []}
        label={rowMenu.menu ? ('type' in rowMenu.menu.target ? TYPE_LABELS[rowMenu.menu.target.type].many : rowMenu.menu.target.category.name) : 'Actions'}
        onClose={rowMenu.close}
        returnTo={rowMenu.menu?.row}
      />

      <div className="sidebar-foot">
        {sync && sync.conflicts.length > 0 && (
          <button type="button" className="sync-note sync-note-warn" onClick={go({ kind: 'settings' })}>
            <TriangleAlert size={14} aria-hidden="true" />
            {sync.conflicts.length === 1 ? 'A conflicting copy to merge' : `${sync.conflicts.length} conflicting copies to merge`}
          </button>
        )}
        {sync && sync.devices.length > 0 && (
          <p className="sync-note" title={sync.devices.map((d) => d.name).join(', ')}>
            <span className="sync-dot" aria-hidden="true" />
            Also open on {sync.devices[0]!.name}
            {sync.devices.length > 1 ? ` +${sync.devices.length - 1}` : ''}
          </p>
        )}
        {sync?.update && <UpdateCard update={sync.update} collapsed={collapsed} />}
        <LockButton onLock={onLock} expiresAt={expiresAt} idleMs={idleMs} collapsed={collapsed} />
      </div>
    </nav>
    </Collapsed.Provider>
  );
}

/** Ask the page to refresh its sync status now (the update card does, so progress shows at once). */
export const SYNC_NOW = 'keys:sync-now';

/** The first real line of the release notes ("## What's new", bullets and **bold** stripped). */
function summary(notes: string): string {
  for (const raw of notes.split('\n')) {
    const line = raw.replace(/^\s*(#+|[-*•]|\d+\.)\s*/, '').replace(/\*\*|__|`/g, '').trim();
    if (line && !/^(what'?s new|what’s new|changes|fixes|improvements)\b:?$/i.test(line)) return line;
  }
  return '';
}

/** Keys for Mac found a newer version: one click downloads it, checks its signature, and restarts. */
function UpdateCard({ update, collapsed }: { update: AppUpdate; collapsed: boolean }) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState(false);
  // The app reports progress: a failed install ends "Updating…" and offers Try again.
  useEffect(() => {
    if (update.state !== 'installing') setStarting(false);
    setError(update.state === 'failed');
  }, [update.state]);
  const busy = starting || update.state === 'installing';
  const pct = busy && typeof update.progress === 'number' ? update.progress : null;
  const phase = pct === null ? 'Getting ready…' : pct < 100 ? `Downloading… ${pct}%` : 'Installing…';
  const install = async () => {
    setStarting(true);
    setError(false);
    try {
      await api.installUpdate();
      window.dispatchEvent(new Event(SYNC_NOW));
    } catch {
      setStarting(false);
      setError(true);
    }
  };
  if (collapsed) {
    // Folded: just the download button, its state in the tooltip.
    return (
      <Tooltip content={busy ? phase : error ? 'Update didn’t install · Try again' : `Update to Keys ${update.version}`} side="right">
        <button type="button" className="update-rail" onClick={() => void install()} disabled={busy} aria-label={busy ? `Updating Keys. ${phase}` : `Update to Keys ${update.version}`}>
          {busy ? <span className="update-spinner" aria-hidden="true" /> : <ArrowDownToLine size={16} />}
        </button>
      </Tooltip>
    );
  }
  const note = summary(update.notes);
  return (
    <div className={`update-card${busy ? ' is-busy' : ''}${error ? ' is-failed' : ''}`}>
      <div className="update-head">
        <span className="update-icon" aria-hidden="true">
          {busy ? <span className="update-spinner" /> : <ArrowDownToLine size={15} />}
        </span>
        <span className="update-text">
          <strong>{busy ? 'Updating Keys' : error ? 'Update didn’t install' : 'Update available'}</strong>
          <small>
            {update.current ? `${update.current} → ` : ''}
            <b>{update.version}</b>
          </small>
        </span>
      </div>
      {busy ? (
        <div className="update-progress" role="progressbar" aria-label="Update download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined} aria-valuetext={phase}>
          <div className={`update-bar${pct === null ? ' is-indeterminate' : ''}`}>
            <span style={{ width: `${pct ?? 30}%` }} />
          </div>
          <small>{phase} · Restarts when done</small>
        </div>
      ) : (
        <>
          {error ? <p className="update-note">Check your connection and try again. Your vault wasn’t touched.</p> : note && <p className="update-note">{note}</p>}
          <div className="update-actions">
            <button type="button" className="update-btn" onClick={() => void install()}>
              {error ? 'Try again' : 'Update & restart'}
            </button>
            {update.releaseUrl && (
              <a className="update-link" href={update.releaseUrl} target="_blank" rel="noreferrer">
                What’s new
              </a>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Icon-only lock button. The tooltip says when the vault will lock itself; the icon turns red in the last minute. */
function LockButton({ onLock, expiresAt, idleMs, collapsed }: { onLock: () => void; expiresAt: number | null; idleMs: number; collapsed: boolean }) {
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
      side={collapsed ? 'right' : 'top'}
    >
      <button type="button" className={`btn btn-outline lock-btn${soon ? ' is-soon' : ''}`} onClick={onLock} aria-label={`Lock now. ${note}`}>
        <Lock size={16} />
        <span className="lock-label">Lock</span>
      </button>
    </Tooltip>
  );
}
