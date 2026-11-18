import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { flushSync } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Menu as MenuIcon, Search } from 'lucide-react';
import { api, errorMessage, LOCK_EVENT, REFRESH_EVENT } from '../api.ts';
import { applyAppearance } from '../App.tsx';
import { SettingsProvider, useConfirm, useToast } from '../context.tsx';
import { fade } from '../motion.ts';
import { useSiteIcons } from '../siteIcons.ts';
import type { Appearance, AuditReport, SyncStatus, Category, CategoryColor, Entry, EntrySummary, EntryType, Settings, VaultStatus } from '../../shared/types.ts';
import { hostname, isTypingTarget, modKey, TYPE_LABELS } from '../util.ts';
import { CommandPalette } from './CommandPalette.tsx';
import type { PaletteActions } from './CommandPalette.tsx';
import { EntryDetail } from './EntryDetail.tsx';
import { EntryEditorDialog } from './EntryEditor.tsx';
import type { EditorState } from './EntryEditor.tsx';
import { EntryList } from './EntryList.tsx';
import { GeneratorView } from './Generator.tsx'; // already in the main bundle (the editor uses it)
import type { Sort } from './EntryList.tsx';
import { Sidebar, viewKey } from './Sidebar.tsx';
import type { Filter, View } from './Sidebar.tsx';
import { AppMark, EmptyState, IconButton, Kbd } from './ui.tsx';

/**
 * A page that loads separately (keeping startup small) but is fetched in the background soon after
 * unlock. Once its code is here it renders straight away, so opening it never fades in on a blank.
 */
function preloadable<P extends object>(load: () => Promise<ComponentType<P>>) {
  let ready: ComponentType<P> | null = null;
  const fetch = () => load().then((c) => (ready = c));
  const Lazy = lazy(() => fetch().then((c) => ({ default: c })));
  const Page = (props: P) => {
    const Ready = ready;
    return Ready ? <Ready {...props} /> : <Lazy {...props} />;
  };
  Page.preload = () => void fetch().catch(() => {});
  return Page;
}
const AuditView = preloadable(() => import('./AuditView.tsx').then((m) => m.AuditView));
const SettingsView = preloadable(() => import('./SettingsView.tsx').then((m) => m.SettingsView));
const TrashView = preloadable(() => import('./TrashView.tsx').then((m) => m.TrashView));

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove'] as const;
const PING_EVERY_MS = 20_000;
/** Name order, built once: localeCompare with options builds a new collator on every comparison. */
const byName = new Intl.Collator(undefined, { sensitivity: 'base' }).compare;

/** Keeps the server session alive while the person is active, and notices when it has locked. */
function useSessionKeeper(settings: Settings, expiresAt: number | null, setExpiresAt: (t: number | null) => void, lock: () => void) {
  const expiresRef = useRef(expiresAt);
  expiresRef.current = expiresAt;

  useEffect(() => {
    let lastPing = Date.now();
    const onActivity = () => {
      if (Date.now() - lastPing < PING_EVERY_MS) return;
      lastPing = Date.now();
      api.ping().then((r) => setExpiresAt(r.expiresAt)).catch(() => {});
    };
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    const timer = window.setInterval(() => {
      const t = expiresRef.current;
      if (t && Date.now() >= t) {
        api
          .status()
          .then((s) => (s.unlocked ? setExpiresAt(s.expiresAt) : window.dispatchEvent(new Event(LOCK_EVENT))))
          .catch(() => {});
      }
    }, 1000);
    return () => {
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, onActivity));
      window.clearInterval(timer);
    };
  }, [setExpiresAt]);

  useEffect(() => {
    if (!settings.lockOnHiddenSeconds) return;
    let t: number | undefined;
    const onVisibility = () => {
      window.clearTimeout(t);
      if (document.hidden) t = window.setTimeout(lock, settings.lockOnHiddenSeconds * 1000);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [settings.lockOnHiddenSeconds, lock]);
}

const ALL: Filter = { kind: 'all' };

function matches(e: EntrySummary, filter: Filter, q: string, hay: string): boolean {
  if (filter.kind === 'favorites' && !e.favorite) return false;
  if (filter.kind === 'type' && e.type !== filter.type) return false;
  if (filter.kind === 'category' && e.categoryId !== filter.categoryId) return false;
  if (!q) return true;
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

function summarise(e: Entry): EntrySummary {
  return {
    id: e.id,
    type: e.type,
    title: e.title,
    username: e.username,
    url: e.url,
    categoryId: e.categoryId,
    favorite: e.favorite,
    icon: e.icon,
    hasPassword: e.password.length > 0,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

export function VaultShell({ status, onLock }: { status: VaultStatus; onLock: () => void }) {
  const [settings, setSettings] = useState<Settings>(status.settings!);
  const [expiresAt, setExpiresAt] = useState(status.expiresAt);
  const [entries, setEntries] = useState<EntrySummary[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [view, setView] = useState<View>({ kind: 'items', filter: { kind: 'all' } });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailVersion, setDetailVersion] = useState(0);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('name');
  const [navOpen, setNavOpen] = useState(false);
  // On narrow screens the sidebar slides off-canvas: closed, it's taken out of the tab order too.
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 860px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 860px)');
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  // The open drawer is modal: focus moves into it (the page behind is inert) and back to Menu when it closes.
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setNavOpen(false);
    window.addEventListener('keydown', onKey);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('#main-nav .nav-item')?.focus());
    return () => {
      window.removeEventListener('keydown', onKey);
      menuButton.current?.focus();
    };
  }, [navOpen]);
  // After unlocking, typing goes straight to search (as in other password managers).
  useEffect(() => {
    searchRef.current?.focus({ preventScroll: true });
  }, []);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [auditCount, setAuditCount] = useState<number | null>(null);
  const [trashCount, setTrashCount] = useState(0);
  const refreshTrash = useCallback(() => void api.trash().then((t) => setTrashCount(t.length), () => {}), []);
  useEffect(refreshTrash, [refreshTrash]);
  const searchRef = useRef<HTMLInputElement>(null);
  const sessionCounter = useRef(0);
  const toast = useToast();
  const confirm = useConfirm();

  useSessionKeeper(settings, expiresAt, setExpiresAt, onLock);

  // Every list load and local change gets a number; an older load that finishes late is dropped, so it
  // can't undo a save or a delete made while it was on its way.
  const entriesSeq = useRef(0);
  const editEntries = useCallback((change: (list: EntrySummary[] | null) => EntrySummary[]) => {
    entriesSeq.current++;
    setEntries(change);
  }, []);
  const loadEntries = useCallback(async () => {
    const n = ++entriesSeq.current;
    try {
      const list = await api.entries();
      if (n !== entriesSeq.current) return;
      setEntries(list);
      // The open item was deleted elsewhere: close it instead of showing a dead error.
      setSelectedId((id) => (id && !list.some((e) => e.id === id) ? null : id));
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }, [toast]);
  const loadCategories = useCallback(async () => {
    try {
      setCategories(await api.categories());
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }, [toast]);
  const onAuditReport = useCallback((r: AuditReport) => setAuditCount(r.items.filter((i) => i.issues.length > 0).length), []);
  // Coalesced: a burst of edits (or a bulk action) asks for one audit, and never two at once.
  const auditTimer = useRef<number | undefined>(undefined);
  const auditBusy = useRef(false);
  const auditAgain = useRef(false);
  const refreshAudit = useCallback(() => {
    window.clearTimeout(auditTimer.current);
    auditTimer.current = window.setTimeout(function run() {
      if (auditBusy.current) {
        auditAgain.current = true;
        return;
      }
      auditBusy.current = true;
      api
        .audit()
        .then(onAuditReport, () => {})
        .finally(() => {
          auditBusy.current = false;
          if (auditAgain.current) {
            auditAgain.current = false;
            run();
          }
        });
    }, 400);
  }, [onAuditReport]);
  useEffect(() => () => window.clearTimeout(auditTimer.current), []);

  // The same database file on other computers (through Google Drive and the like): look every
  // few seconds, and the moment Keys comes back to the front, for changes made elsewhere.
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const revision = useRef<string | null>(null);
  const lastSync = useRef('');
  useEffect(() => {
    let stopped = false;
    let busy = false;
    const look = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const next = await api.sync();
        if (stopped) return;
        // Only when something actually changed: a new object every few seconds would redraw the whole app.
        // (Device "last seen" times are rounded to the minute so a heartbeat alone doesn't count.)
        const key = JSON.stringify({ ...next, devices: next.devices.map((d) => [d.name, Math.round(d.lastSeenAt / 60_000)]) });
        if (key !== lastSync.current) {
          lastSync.current = key;
          setSync(next);
        }
        if (revision.current !== null && next.revision !== revision.current) {
          await Promise.all([loadEntries(), loadCategories()]);
          setDetailVersion((v) => v + 1);
          refreshAudit();
          refreshTrash();
          toast('Updated with changes from your other device');
        }
        revision.current = next.revision;
      } catch {
        /* locked or offline: the lock screen or the next look handles it */
      } finally {
        busy = false;
      }
    };
    void look();
    const timer = window.setInterval(() => void look(), 8000);
    const onFront = () => void look();
    const onRefresh = () => {
      void Promise.all([loadEntries(), loadCategories()]);
      refreshAudit();
      refreshTrash();
    };
    window.addEventListener(REFRESH_EVENT, onRefresh);
    window.addEventListener('focus', onFront);
    document.addEventListener('visibilitychange', onFront);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener(REFRESH_EVENT, onRefresh);
      window.removeEventListener('focus', onFront);
      document.removeEventListener('visibilitychange', onFront);
    };
  }, [loadEntries, loadCategories, refreshAudit, refreshTrash, toast]);

  useEffect(() => {
    // Once the vault is showing, fetch the other pages' code quietly so they open instantly.
    const t = window.setTimeout(() => [AuditView, SettingsView, TrashView].forEach((p) => p.preload()), 1500);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    void loadEntries();
    void loadCategories();
    const t = window.setTimeout(refreshAudit, 1200);
    return () => window.clearTimeout(t);
  }, [loadEntries, loadCategories, refreshAudit]);

  useEffect(() => {
    if (!settings.categoriesEnabled && view.kind === 'items' && view.filter.kind === 'category') {
      setView({ kind: 'items', filter: { kind: 'all' } });
    }
  }, [settings.categoriesEnabled, view]);


  const updateSettings = useCallback(
    async (patch: Partial<Settings>) => {
      // Flipped inside the transition, before saving, so the toggle's pill can glide between snapshots.
      const showTheme = (a: Appearance) => applyAppearance(a, () => flushSync(() => setSettings((s) => ({ ...s, appearance: a }))));
      const previous = (document.documentElement.dataset.theme ?? 'system') as Appearance;
      if (patch.appearance) showTheme(patch.appearance);
      try {
        const res = await api.updateSettings(patch);
        setSettings(res.settings);
        setExpiresAt(res.expiresAt);
      } catch (err) {
        if (patch.appearance) showTheme(previous);
        toast(errorMessage(err), 'error');
        throw err;
      }
    },
    [toast],
  );

  const filter: Filter = view.kind === 'items' ? view.filter : ALL; // stable, so callbacks built on it stay stable
  // Searchable text per item, built once per list change instead of on every keystroke.
  const haystacks = useMemo(() => new Map((entries ?? []).map((e) => [e.id, `${e.title}\n${e.username}\n${e.url}\n${hostname(e.url)}`.toLowerCase()])), [entries]);
  const visible = useMemo(() => {
    const list = (entries ?? []).filter((e) => matches(e, filter, query.trim(), haystacks.get(e.id) ?? ''));
    return sort === 'name'
      ? list.sort((a, b) => byName(a.title, b.title))
      : list.sort((a, b) => b.updatedAt - a.updatedAt);
  }, [entries, haystacks, viewKey(view), query, sort]);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const listTitle =
    filter.kind === 'all'
      ? 'All items'
      : filter.kind === 'favorites'
        ? 'Favorites'
        : filter.kind === 'type'
          ? TYPE_LABELS[filter.type].many
          : (categories.find((c) => c.id === filter.categoryId)?.name ?? 'Category');

  // The browser extension links here to connect: open Settings with the code dialog.
  const [connectBrowser, setConnectBrowser] = useState(false);
  useEffect(() => {
    const check = () => {
      if (window.location.hash !== '#connect-browser') return;
      window.history.replaceState(null, '', window.location.pathname);
      setView({ kind: 'settings' });
      setConnectBrowser(true);
    };
    check();
    window.addEventListener('hashchange', check);
    return () => window.removeEventListener('hashchange', check);
  }, []);

  const selectView = useCallback((v: View) => {
    setView(v);
    setNavOpen(false);
    if (v.kind === 'items') setSelectedId(null);
  }, []);

  const openItem = useCallback((id: string) => {
    setView((v) => (v.kind === 'items' ? v : { kind: 'items', filter: { kind: 'all' } }));
    setQuery('');
    setSelectedId(id);
    setNavOpen(false);
  }, []);

  const openEditor = useCallback(
    (entry: Entry | null, type: EntryType = 'login', inCategory?: string) => {
      sessionCounter.current += 1;
      setEditor({
        entry,
        type: entry?.type ?? type,
        categoryId: entry ? entry.categoryId : (inCategory ?? (settings.categoriesEnabled && filter.kind === 'category' ? filter.categoryId : null)),
        session: sessionCounter.current,
      });
      setNavOpen(false);
    },
    [filter, settings.categoriesEnabled],
  );

  const create = useCallback((type: EntryType) => openEditor(null, type), [openEditor]);

  const onSaved = (saved: Entry) => {
    const wasNew = !editor?.entry;
    editEntries((list) => [...(list ?? []).filter((e) => e.id !== saved.id), summarise(saved)]);
    setEditor(null);
    setView((v) => (v.kind === 'items' ? v : { kind: 'items', filter: { kind: 'all' } }));
    setSelectedId(saved.id);
    setDetailVersion((n) => n + 1);
    toast(wasNew ? `Saved ${saved.title}` : 'Changes saved');
    refreshAudit();
  };

  const addCategory = async (name: string, color: CategoryColor | null) => {
    try {
      const created = await api.createCategory(name);
      if (color) await api.colorCategory(created.id, color);
      await loadCategories();
      return true;
    } catch (err) {
      toast(errorMessage(err), 'error');
      return false;
    }
  };

  const editCategory = async (id: string, patch: { name?: string; color?: CategoryColor | null }) => {
    try {
      if (patch.name !== undefined) await api.renameCategory(id, patch.name);
      if (patch.color !== undefined) await api.colorCategory(id, patch.color);
      await loadCategories();
      return true;
    } catch (err) {
      toast(errorMessage(err), 'error');
      return false;
    }
  };

  const deleteCategory = async (c: Category) => {
    const count = (entries ?? []).filter((e) => e.categoryId === c.id).length;
    const ok = await confirm({
      title: `Delete the ${c.name} category?`,
      body: count ? `Its ${count === 1 ? 'item is' : `${count} items are`} kept and become uncategorised.` : 'It’s empty, so nothing else changes.',
      confirmLabel: 'Delete category',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteCategory(c.id);
      setView((v) => (v.kind === 'items' && v.filter.kind === 'category' && v.filter.categoryId === c.id ? { kind: 'items', filter: { kind: 'all' } } : v));
      await loadCategories();
      await loadEntries();
      toast(`Deleted ${c.name}`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const paletteActions = useMemo<PaletteActions>(
    () => ({
      openItem,
      create,
      generator: () => selectView({ kind: 'generator' }),
      audit: () => selectView({ kind: 'audit' }),
      settings: () => selectView({ kind: 'settings' }),
      lock: onLock,
    }),
    [openItem, create, selectView, onLock],
  );

  // Global shortcuts. Ignored while typing or while a dialog is open.
  const openRef = useRef(openEditor);
  openRef.current = openEditor;
  // Logins show their website's icon by default.
  useSiteIcons(entries, !settings.hideIcons.login, (batch) => {
    const byId = new Map(batch.map((e) => [e.id, summarise(e)]));
    editEntries((list) => (list ?? []).map((e) => byId.get(e.id) ?? e));
    if (selectedRef.current && byId.has(selectedRef.current)) setDetailVersion((v) => v + 1);
  });

  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const viewRef = useRef(view);
  viewRef.current = view;
  // Registered once; the handler is read through a ref so it always sees the current state.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  {
    keyRef.current = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        // Not over an open dialog: the palette would open behind it and take the typing.
        if (document.querySelector('.dialog-layer')) return;
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      // ⌘, : Settings, as in every Mac app.
      if (mod && e.key === ',') {
        if (document.querySelector('.dialog-layer')) return;
        e.preventDefault();
        selectView({ kind: 'settings' });
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        onLock();
        return;
      }
      if (mod || e.altKey || isTypingTarget(e.target) || document.querySelector('.dialog-layer, .palette-layer, .menu')) return;
      if (e.key === '/') {
        e.preventDefault();
        setView((v) => (v.kind === 'items' ? v : { kind: 'items', filter: { kind: 'all' } }));
        window.setTimeout(() => searchRef.current?.focus(), 0);
      } else if (e.key === 'n') {
        e.preventDefault();
        create('login');
      } else if (
        (e.key === 'ArrowDown' || e.key === 'ArrowUp') &&
        viewRef.current.kind === 'items' &&
        visibleRef.current.length > 0 &&
        // The list handles its own arrows; the sidebar and the item's own pane keep theirs.
        !document.activeElement?.closest('.entry-list, .sidebar, .detail')
      ) {
        // Wherever focus is (after a click it can land outside the list), ↑ and ↓ move through the items.
        e.preventDefault();
        const list = visibleRef.current;
        const i = list.findIndex((x) => x.id === selectedRef.current);
        const next = list[i < 0 ? (e.key === 'ArrowDown' ? 0 : list.length - 1) : e.key === 'ArrowDown' ? Math.min(list.length - 1, i + 1) : Math.max(0, i - 1)]!;
        setSelectedId(next.id);
        // Focus follows, so the next arrow is handled by the list itself (and the row scrolls into view).
        requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLElement>(`.entry-list [data-entry-id="${CSS.escape(next.id)}"]`)?.focus({ preventScroll: false })));
      } else if (e.key === 'e' && selectedRef.current) {
        e.preventDefault();
        void api.entry(selectedRef.current).then((entry) => openRef.current(entry), () => {});
      } else if (e.key === 'Escape' && (selectedRef.current || document.activeElement?.closest('.entry-row, .nav-item'))) {
        // Closing the item also lets go of the row or sidebar entry that had focus, so no ring lingers on it.
        setSelectedId(null);
        (document.activeElement as HTMLElement | null)?.blur();
      }
    };
  }

  const defaultType: EntryType = filter.kind === 'type' ? filter.type : 'login';
  const showingDetail = view.kind === 'items' && selectedId !== null;

  return (
    <SettingsProvider value={{ settings, updateSettings }}>
      <div className="shell" data-nav-open={navOpen || undefined} data-detail={showingDetail || undefined}>
        <header className="topbar" inert={narrow && navOpen}>
          <IconButton ref={menuButton} label="Menu" onClick={() => setNavOpen(true)} aria-expanded={navOpen} aria-controls="main-nav">
            <MenuIcon size={19} />
          </IconButton>
          <span className="brand">
            <AppMark size="sm" />
            <span className="wordmark">Keys</span>
          </span>
          <IconButton label="Search" shortcut={`${modKey}K`} onClick={() => setPaletteOpen(true)}>
            <Search size={18} />
          </IconButton>
        </header>
        <div className="scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />

        <Sidebar
          hidden={narrow && !navOpen}
          view={view}
          onView={selectView}
          entries={entries ?? []}
          categories={categories}
          onAddCategory={addCategory}
          onCreate={(type, categoryId) => openEditor(null, type, categoryId)}
          onEditCategory={editCategory}
          onDeleteCategory={(c) => void deleteCategory(c)}
          onLock={onLock}
          onSearch={() => setPaletteOpen(true)}
          expiresAt={expiresAt}
          idleMs={settings.autoLockMinutes * 60_000}
          auditCount={auditCount}
          trashCount={trashCount}
          sync={sync}
        />

        <main className="workspace" inert={narrow && navOpen}>
          <AnimatePresence mode="wait" initial={false}>
            {view.kind === 'items' ? (
              <motion.div key="items" className="items-view" {...fade}>
                <EntryList
                  ref={searchRef}
                  title={listTitle}
                  entries={visible}
                  query={query}
                  onQuery={setQuery}
                  sort={sort}
                  onSort={setSort}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onEdit={(entry) => openEditor(entry)}
                  onChanged={(updated) => {
                    editEntries((list) => (list ?? []).map((e) => (e.id === updated.id ? summarise(updated) : e)));
                    if (updated.id === selectedRef.current) setDetailVersion((v) => v + 1);
                  }}
                  onDeleted={(id) => {
                    editEntries((list) => (list ?? []).filter((e) => e.id !== id));
                    if (selectedRef.current === id) setSelectedId(null);
                    refreshAudit();
                    refreshTrash();
                  }}
                  categories={categories}
                  onBulkDone={async (deleted) => {
                    await loadEntries();
                    if (selectedRef.current && deleted.includes(selectedRef.current)) setSelectedId(null);
                    else setDetailVersion((v) => v + 1);
                    refreshAudit();
                    refreshTrash();
                  }}
                  onCreate={create}
                  onImport={() => selectView({ kind: 'settings' })}
                  totalCount={entries?.length ?? -1}
                  defaultType={defaultType}
                />
                <div className="detail-host">
                  {selectedId ? (
                    <EntryDetail
                      entryId={selectedId}
                      version={detailVersion}
                      categories={categories}
                      onEdit={(entry) => openEditor(entry)}
                      onChanged={(updated) => editEntries((list) => [...(list ?? []).filter((e) => e.id !== updated.id), summarise(updated)])}
                      onDeleted={(id) => {
                        // The id of what was actually deleted: the selection may already be the next item.
                        editEntries((list) => (list ?? []).filter((e) => e.id !== id));
                        setSelectedId((cur) => (cur === id ? null : cur));
                        refreshAudit();
                        refreshTrash();
                      }}
                      onBack={() => setSelectedId(null)}
                    />
                  ) : (
                    <div className="detail-empty">
                      <EmptyState title={entries && entries.length ? 'Select an item' : 'Nothing to show yet'}>
                        <p className="shortcut-hints">
                          <span>
                            <Kbd>{`${modKey}K`}</Kbd> Search everything
                          </span>
                          <span>
                            <Kbd>N</Kbd> New item
                          </span>
                          <span>
                            <Kbd>/</Kbd> Filter this list
                          </span>
                        </p>
                      </EmptyState>
                    </div>
                  )}
                </div>
              </motion.div>
            ) : (
              <motion.div key={view.kind} className="page-pane" {...fade}>
                <Suspense fallback={null}>
                {view.kind === 'generator' && <GeneratorView />}
                {view.kind === 'audit' && (
                  <AuditView
                    onOpen={openItem}
                    onReport={onAuditReport}
                    onEntriesChanged={() => {
                      setSelectedId(null);
                      void loadEntries();
                      refreshTrash();
                    }}
                  />
                )}
                {view.kind === 'trash' && (
                  <TrashView
                    credential={status.credential}
                    onChanged={() => {
                      refreshTrash();
                      void loadEntries();
                      refreshAudit();
                    }}
                  />
                )}
                {view.kind === 'settings' && (
                  <SettingsView
                    categories={categories}
                    sync={sync}
                    onMerged={async () => {
                      setSync(await api.sync().catch(() => sync));
                      await Promise.all([loadEntries(), loadCategories()]);
                      setDetailVersion((v) => v + 1);
                      refreshAudit();
                      refreshTrash();
                    }}
                    connectBrowser={connectBrowser}
                    onConnectBrowserDone={() => setConnectBrowser(false)}
                    onCategoriesChanged={async () => {
                      await loadCategories();
                      await loadEntries();
                    }}
                    onImported={async () => {
                      await loadCategories();
                      await loadEntries();
                      refreshAudit();
                    }}
                  />
                )}
                </Suspense>
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        <EntryEditorDialog state={editor} categories={categories} onSaved={onSaved} onClose={() => setEditor(null)} />
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} entries={entries ?? []} actions={paletteActions} />
      </div>
    </SettingsProvider>
  );
}
