import { forwardRef, Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { ArrowDownAZ, AtSign, Check, Folder, ListChecks, ChevronDown, Clock3, ExternalLink, KeyRound, Pencil, Plus, Search, Star, StarOff, Trash2, Upload, X } from 'lucide-react';
import { api, errorMessage } from '../api.ts';
import { useConfirm, useCopy, useSettings, useToast } from '../context.tsx';
import type { Category, Entry, EntrySummary, EntryType } from '../../shared/types.ts';
import { hostname, plural, safeHref, TYPE_LABELS } from '../util.ts';
import { TYPE_ICONS } from './Sidebar.tsx';
import { Button, ContextMenu, EmptyState, IconButton, Kbd, Menu, Monogram, Tooltip } from './ui.tsx';
import type { MenuItem } from './ui.tsx';

export type Sort = 'name' | 'recent';

interface Props {
  title: string;
  entries: EntrySummary[];
  query: string;
  onQuery: (q: string) => void;
  sort: Sort;
  onSort: (s: Sort) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onEdit: (entry: Entry) => void;
  onChanged: (entry: Entry) => void;
  onDeleted: (id: string) => void;
  categories: Category[];
  /** After a bulk change: reload the list. */
  onBulkDone: (deleted: string[]) => Promise<void> | void;
  onCreate: (type: EntryType) => void;
  onImport: () => void;
  totalCount: number;
  defaultType: EntryType;
}

function subtitle(e: EntrySummary): string {
  if (e.type === 'note') return TYPE_LABELS.note.one;
  return e.username || hostname(e.url) || TYPE_LABELS[e.type].one;
}

export const EntryList = forwardRef<HTMLInputElement, Props>(function EntryList(
  { title, entries, query, onQuery, sort, onSort, selectedId, onSelect, onEdit, onChanged, onDeleted, categories, onBulkDone, onCreate, onImport, totalCount, defaultType },
  searchRef,
) {
  const { hideIcons, categoriesEnabled } = useSettings().settings;
  const copy = useCopy();
  const confirm = useConfirm();
  const toast = useToast();
  const [menu, setMenu] = useState<{ x: number; y: number; entry: EntrySummary; row: HTMLElement } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  // Bulk selection: the Select button, ⌘/Ctrl-click to toggle, Shift-click for a range.
  const [selecting, setSelecting] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = entries.filter((e) => checked.has(e.id));
  const inSelection = selecting || checked.size > 0;
  const stopSelecting = useCallback(() => {
    setSelecting(false);
    setChecked(new Set());
    setAnchor(null);
  }, []);
  useEffect(stopSelecting, [title, stopSelecting]);
  useEffect(() => {
    if (!inSelection) return;
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.dialog-layer, .menu') && stopSelecting();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inSelection, stopSelecting]);

  const onRowClick = (ev: MouseEvent<HTMLButtonElement>, entry: EntrySummary) => {
    const from = anchor ?? (inSelection ? null : selectedId);
    if (ev.shiftKey && from) {
      const [a, b] = [entries.findIndex((x) => x.id === from), entries.findIndex((x) => x.id === entry.id)].sort((x, y) => x - y);
      if (a >= 0) {
        setChecked((prev) => new Set([...prev, ...entries.slice(a, b + 1).map((x) => x.id)]));
        setAnchor(entry.id);
        return;
      }
    }
    if (inSelection || ev.metaKey || ev.ctrlKey) {
      setChecked((prev) => {
        // Starting with ⌘-click keeps the item that was open, like Finder.
        const next = new Set(prev.size === 0 && !selecting && selectedId ? [selectedId] : prev);
        if (!next.delete(entry.id)) next.add(entry.id);
        return next;
      });
      setAnchor(entry.id);
      return;
    }
    onSelect(entry.id);
  };

  const bulk = async (run: () => Promise<string>, deleted: string[] = []) => {
    setBusy(true);
    try {
      const message = await run();
      await onBulkDone(deleted);
      toast(message);
      stopSelecting();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  const ids = chosen.map((e) => e.id);
  const allFavorite = chosen.length > 0 && chosen.every((e) => e.favorite);
  const favoriteAll = () =>
    void bulk(async () => {
      await api.updateEntries(ids, { favorite: !allFavorite });
      return allFavorite ? `Removed ${plural(ids.length, 'item')} from favorites` : `Added ${plural(ids.length, 'item')} to favorites`;
    });
  const moveAll = (categoryId: string | null) =>
    void bulk(async () => {
      await api.updateEntries(ids, { categoryId });
      return `Moved ${plural(ids.length, 'item')} to ${categories.find((c) => c.id === categoryId)?.name ?? 'no category'}`;
    });
  const deleteAll = async () => {
    const ok = await confirm({
      title: `Delete ${plural(ids.length, 'item')}?`,
      body: 'You won’t be able to recover these items or their password history once they’re deleted.',
      confirmLabel: `Delete ${plural(ids.length, 'item')}`,
      danger: true,
    });
    if (ok) void bulk(async () => (await api.deleteEntries(ids), `Deleted ${plural(ids.length, 'item')}`), ids);
  };

  const openMenu = (e: MouseEvent<HTMLButtonElement>, entry: EntrySummary) => {
    e.preventDefault(); // opens the menu only; the item itself stays closed
    // The keyboard's menu key reports no pointer position: open under the row instead.
    const r = e.currentTarget.getBoundingClientRect();
    const keyboard = e.clientX === 0 && e.clientY === 0;
    setMenu({ x: keyboard ? r.left + 16 : e.clientX, y: keyboard ? r.bottom : e.clientY, entry, row: e.currentTarget });
  };

  // Summaries carry no secrets, so actions that need the password load the full item first.
  const withEntry = (id: string, run: (entry: Entry) => Promise<void> | void) => async () => {
    try {
      await run(await api.entry(id));
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const menuItems = (e: EntrySummary): MenuItem[] => {
    const href = safeHref(e.url);
    const items: MenuItem[] = [
      { label: 'Edit', icon: <Pencil size={15} />, onSelect: withEntry(e.id, onEdit) },
    ];
    if (e.username) items.push({ label: 'Copy username', icon: <AtSign size={15} />, separatorBefore: true, onSelect: () => void copy(e.username, 'username', false) });
    if (e.hasPassword) items.push({ label: 'Copy password', icon: <KeyRound size={15} />, separatorBefore: !e.username, onSelect: withEntry(e.id, (full) => void copy(full.password, 'password')) });
    if (href) items.push({ label: 'Open website', icon: <ExternalLink size={15} />, onSelect: () => window.open(href, '_blank', 'noopener,noreferrer') });
    items.push(
      {
        label: e.favorite ? 'Remove from favorites' : 'Add to favorites',
        icon: e.favorite ? <StarOff size={15} /> : <Star size={15} />,
        separatorBefore: true,
        onSelect: withEntry(e.id, async (full) => onChanged(await api.updateEntry(full.id, { ...full, favorite: !full.favorite }))),
      },
      {
        label: 'Delete',
        icon: <Trash2 size={15} />,
        danger: true,
        separatorBefore: true,
        onSelect: async () => {
          const ok = await confirm({
            title: `Delete ${e.title}?`,
            body: 'You won’t be able to recover this item or its password history once it’s deleted.',
            confirmLabel: 'Delete item',
            danger: true,
          });
          if (!ok) return;
          try {
            await api.deleteEntry(e.id);
            toast(`Deleted ${e.title}`);
            onDeleted(e.id);
          } catch (err) {
            toast(errorMessage(err), 'error');
          }
        },
      },
    );
    return items;
  };
  const groups = useMemo(() => {
    if (sort !== 'name' || query) return [{ letter: '', items: entries }];
    const out: { letter: string; items: EntrySummary[] }[] = [];
    for (const e of entries) {
      const ch = e.title.trim()[0]?.toUpperCase() ?? '#';
      const letter = /[A-Z]/.test(ch) ? ch : '#';
      const last = out[out.length - 1];
      if (last && last.letter === letter) last.items.push(e);
      else out.push({ letter, items: [e] });
    }
    return out;
  }, [entries, sort, query]);

  // Arrow keys in the filter box move the selection.
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      if (query) onQuery('');
      else (e.target as HTMLInputElement).blur();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = entries.findIndex((x) => x.id === selectedId);
    const next = e.key === 'ArrowDown' ? Math.min(entries.length - 1, i + 1) : Math.max(0, i - 1);
    if (entries[next]) onSelect(entries[next].id);
  };

  return (
    <section className="list-pane" aria-label={title}>
      <header className="list-head">
        <div className="list-title-row">
          <h1 className="list-title">
            {title}
            <span className="list-count">{entries.length}</span>
          </h1>
          <div className="split">
            <Tooltip content={`New ${TYPE_LABELS[defaultType].inline}`} shortcut="N">
              <Button variant="primary" size="sm" icon={<Plus size={15} strokeWidth={2.2} />} onClick={() => onCreate(defaultType)}>
                New
              </Button>
            </Tooltip>
            <Menu
              label="New item type"
              heading="Create"
              trigger={(p) => (
                <button type="button" className="btn btn-primary btn-sm split-toggle" aria-label="Choose item type" {...p}>
                  <ChevronDown size={15} />
                </button>
              )}
              items={(Object.keys(TYPE_LABELS) as EntryType[]).map((t) => ({ label: TYPE_LABELS[t].one, icon: TYPE_ICONS[t], onSelect: () => onCreate(t) }))}
            />
          </div>
        </div>

        <div className="toolbar">
          <div className="search">
            <Search size={15} aria-hidden="true" className="search-icon" />
            <input
              ref={searchRef}
              type="text"
              className="search-input"
              placeholder="Filter items"
              aria-label="Filter items"
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              onKeyDown={onSearchKey}
              spellCheck={false}
              autoComplete="off"
            />
            {query ? (
              <button type="button" className="search-clear" aria-label="Clear filter" onClick={() => onQuery('')}>
                <X size={14} strokeWidth={2.2} />
              </button>
            ) : (
              <Kbd>/</Kbd>
            )}
          </div>
          <span className="toolbar-sep" aria-hidden="true" />
          <IconButton label={inSelection ? 'Done selecting' : 'Select items'} aria-pressed={inSelection} disabled={entries.length === 0} onClick={() => (inSelection ? stopSelecting() : setSelecting(true))}>
            <ListChecks size={16} />
          </IconButton>
          <Menu
            label="Sort items"
            heading="Sort by"
            trigger={(p) => (
              <IconButton label={sort === 'name' ? 'Sorted by name' : 'Sorted by recently edited'} {...p}>
                {sort === 'name' ? <ArrowDownAZ size={16} /> : <Clock3 size={16} />}
              </IconButton>
            )}
            items={[
              { label: 'Name', icon: <ArrowDownAZ size={16} />, checked: sort === 'name', onSelect: () => onSort('name') },
              { label: 'Recently edited', icon: <Clock3 size={16} />, checked: sort === 'recent', onSelect: () => onSort('recent') },
            ]}
          />
        </div>
      </header>

      <div className="list-scroll">
        {entries.length === 0 ? (
          totalCount === 0 ? (
            <EmptyState icon={<KeyRound size={20} />} title="Nothing saved yet">
              <p>Save your first login, or bring everything over from your browser or another password manager.</p>
              <div className="empty-actions">
                <Button variant="primary" icon={<Plus size={15} />} onClick={() => onCreate('login')}>
                  Add a login
                </Button>
                <Button variant="outline" icon={<Upload size={15} />} onClick={onImport}>
                  Import
                </Button>
              </div>
            </EmptyState>
          ) : query ? (
            <EmptyState icon={<Search size={20} />} title="No matches">
              <p>Nothing matches “{query}”. Try part of a website or username.</p>
            </EmptyState>
          ) : totalCount < 0 ? null : (
            <EmptyState title="Nothing here yet">
              <p>Items you add here will show up in this list.</p>
            </EmptyState>
          )
        ) : (
          <ul className="entry-list">
            {groups.map((g) => (
              <Fragment key={g.letter || 'all'}>
                {g.letter && (
                  <li className="list-letter" aria-hidden="true">
                    {g.letter}
                  </li>
                )}
                {g.items.map((e) => (
                  <li key={e.id}>
                    <button
                      type="button"
                      className="entry-row"
                      aria-current={selectedId === e.id ? 'true' : undefined}
                      aria-haspopup="menu"
                      aria-pressed={inSelection ? checked.has(e.id) : undefined}
                      data-menu-open={menu?.entry.id === e.id || undefined}
                      onClick={(ev) => onRowClick(ev, e)}
                      onContextMenu={(ev) => openMenu(ev, e)}
                    >
                      {inSelection && (
                        <span className="entry-check" aria-hidden="true">
                          {checked.has(e.id) && <Check size={12} strokeWidth={3} />}
                        </span>
                      )}
                      {/* Only logins get a picture; other kinds are plain text rows. */}
                      {!hideIcons[e.type] && <Monogram title={e.title} type={e.type} icon={e.icon} />}
                      <span className="entry-row-text">
                        <span className="entry-row-title">{e.title}</span>
                        <span className="entry-row-sub">{subtitle(e)}</span>
                      </span>
                      {e.favorite && <Star size={13} className="entry-row-fav" aria-label="Favorite" />}
                    </button>
                  </li>
                ))}
              </Fragment>
            ))}
          </ul>
        )}
      </div>
      {inSelection && (
        <div className="bulk-bar" role="toolbar" aria-label="Selected items">
          <div className="bulk-count">
            <strong aria-live="polite">{chosen.length === 0 ? 'Select items' : `${chosen.length} selected`}</strong>
            <button type="button" className="text-btn" onClick={() => setChecked(chosen.length === entries.length ? new Set() : new Set(entries.map((e) => e.id)))}>
              {chosen.length === entries.length ? 'Select none' : 'Select all'}
            </button>
          </div>
          <IconButton label={allFavorite ? 'Remove from favorites' : 'Add to favorites'} disabled={!chosen.length || busy} onClick={favoriteAll}>
            {allFavorite ? <StarOff size={16} /> : <Star size={16} />}
          </IconButton>
          {categoriesEnabled && (
            <Menu
              label="Move to category"
              heading="Move to"
              align="end"
              trigger={(p) => (
                <IconButton label="Move to category" disabled={!chosen.length || busy} {...p}>
                  <Folder size={16} />
                </IconButton>
              )}
              items={[
                ...categories.map((c) => ({ label: c.name, onSelect: () => moveAll(c.id) })),
                { label: 'No category', separatorBefore: categories.length > 0, onSelect: () => moveAll(null) },
              ]}
            />
          )}
          <IconButton label="Delete" className="bulk-delete" disabled={!chosen.length || busy} onClick={() => void deleteAll()}>
            <Trash2 size={16} />
          </IconButton>
          <IconButton label="Done selecting" onClick={stopSelecting}>
            <X size={16} />
          </IconButton>
        </div>
      )}
      <ContextMenu at={menu} items={menu ? menuItems(menu.entry) : []} label={menu ? `Actions for ${menu.entry.title}` : 'Actions'} onClose={closeMenu} returnTo={menu?.row} />
    </section>
  );
});
