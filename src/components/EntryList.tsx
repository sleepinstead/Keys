import { forwardRef, Fragment, useCallback, useMemo, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { ArrowDownAZ, AtSign, ChevronDown, Clock3, ExternalLink, KeyRound, Pencil, Plus, Search, Star, StarOff, Trash2, Upload, X } from 'lucide-react';
import { api, errorMessage } from '../api.ts';
import { useConfirm, useCopy, useSettings, useToast } from '../context.tsx';
import type { Entry, EntrySummary, EntryType } from '../../shared/types.ts';
import { hostname, safeHref, TYPE_LABELS } from '../util.ts';
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
  { title, entries, query, onQuery, sort, onSort, selectedId, onSelect, onEdit, onChanged, onDeleted, onCreate, onImport, totalCount, defaultType },
  searchRef,
) {
  const hideIcons = useSettings().settings.hideIcons;
  const copy = useCopy();
  const confirm = useConfirm();
  const toast = useToast();
  const [menu, setMenu] = useState<{ x: number; y: number; entry: EntrySummary; row: HTMLElement } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

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
                      data-menu-open={menu?.entry.id === e.id || undefined}
                      onClick={() => onSelect(e.id)}
                      onContextMenu={(ev) => openMenu(ev, e)}
                    >
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
      <ContextMenu at={menu} items={menu ? menuItems(menu.entry) : []} label={menu ? `Actions for ${menu.entry.title}` : 'Actions'} onClose={closeMenu} returnTo={menu?.row} />
    </section>
  );
});
