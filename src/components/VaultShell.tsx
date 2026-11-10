import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Menu as MenuIcon, Search } from 'lucide-react';
import { api, errorMessage, LOCK_EVENT } from '../api.ts';
import { applyAppearance } from '../App.tsx';
import { SettingsProvider, useToast } from '../context.tsx';
import { fade } from '../motion.ts';
import { useSiteIcons } from '../siteIcons.ts';
import type { Appearance, AuditReport, Category, CategoryColor, ChecklistStep, Entry, EntrySummary, EntryType, Settings, VaultStatus } from '../../shared/types.ts';
import { hostname, isTypingTarget, modKey, TYPE_LABELS } from '../util.ts';
import { AuditView } from './AuditView.tsx';
import { CommandPalette } from './CommandPalette.tsx';
import type { PaletteActions } from './CommandPalette.tsx';
import { EntryDetail } from './EntryDetail.tsx';
import { EntryEditorDialog } from './EntryEditor.tsx';
import type { EditorState } from './EntryEditor.tsx';
import { EntryList } from './EntryList.tsx';
import type { Sort } from './EntryList.tsx';
import { GeneratorView } from './Generator.tsx';
import { Onboarding } from './Onboarding.tsx';
import { GettingStarted } from './GettingStarted.tsx';
import { SettingsView } from './SettingsView.tsx';
import { TrashView } from './TrashView.tsx';
import { Sidebar, viewKey } from './Sidebar.tsx';
import type { Filter, View } from './Sidebar.tsx';
import { AppMark, EmptyState, IconButton, Kbd } from './ui.tsx';

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove'] as const;
const PING_EVERY_MS = 20_000;

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

function matches(e: EntrySummary, filter: Filter, q: string): boolean {
  if (filter.kind === 'favorites' && !e.favorite) return false;
  if (filter.kind === 'type' && e.type !== filter.type) return false;
  if (filter.kind === 'category' && e.categoryId !== filter.categoryId) return false;
  if (!q) return true;
  const hay = `${e.title}\n${e.username}\n${e.url}\n${hostname(e.url)}`.toLowerCase();
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
  const [replaying, setReplaying] = useState(false);
  const [detailVersion, setDetailVersion] = useState(0);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('name');
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [auditCount, setAuditCount] = useState<number | null>(null);
  const [trashCount, setTrashCount] = useState(0);
  const refreshTrash = useCallback(() => void api.trash().then((t) => setTrashCount(t.length), () => {}), []);
  useEffect(refreshTrash, [refreshTrash]);
  const searchRef = useRef<HTMLInputElement>(null);
  const sessionCounter = useRef(0);
  const toast = useToast();

  useSessionKeeper(settings, expiresAt, setExpiresAt, onLock);

  const loadEntries = useCallback(async () => {
    try {
      setEntries(await api.entries());
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
  const refreshAudit = useCallback(() => {
    api.audit().then(onAuditReport).catch(() => {});
  }, [onAuditReport]);

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

  const filter: Filter = view.kind === 'items' ? view.filter : { kind: 'all' };
  const visible = useMemo(() => {
    const list = (entries ?? []).filter((e) => matches(e, filter, query.trim()));
    return sort === 'name'
      ? list.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
      : list.sort((a, b) => b.updatedAt - a.updatedAt);
  }, [entries, viewKey(view), query, sort]);

  const listTitle =
    filter.kind === 'all'
      ? 'All items'
      : filter.kind === 'favorites'
        ? 'Favorites'
        : filter.kind === 'type'
          ? TYPE_LABELS[filter.type].many
          : (categories.find((c) => c.id === filter.categoryId)?.name ?? 'Category');

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const markDone = useCallback(
    (step: ChecklistStep) => {
      const state = settingsRef.current.checklist;
      if (state && !state.done.includes(step)) void updateSettings({ checklist: { ...state, done: [...state.done, step] } }).catch(() => {});
    },
    [updateSettings],
  );

  const selectView = useCallback((v: View) => {
    if (v.kind === 'generator' || v.kind === 'audit') markDone(v.kind);
    setView(v);
    setNavOpen(false);
    if (v.kind === 'items') setSelectedId(null);
  }, [markDone]);

  const openItem = useCallback((id: string) => {
    setView((v) => (v.kind === 'items' ? v : { kind: 'items', filter: { kind: 'all' } }));
    setQuery('');
    setSelectedId(id);
    setNavOpen(false);
  }, []);

  const openEditor = useCallback(
    (entry: Entry | null, type: EntryType = 'login') => {
      sessionCounter.current += 1;
      setEditor({
        entry,
        type: entry?.type ?? type,
        categoryId: entry ? entry.categoryId : settings.categoriesEnabled && filter.kind === 'category' ? filter.categoryId : null,
        session: sessionCounter.current,
      });
      setNavOpen(false);
    },
    [filter, settings.categoriesEnabled],
  );

  const create = useCallback((type: EntryType) => openEditor(null, type), [openEditor]);

  const onSaved = (saved: Entry) => {
    const wasNew = !editor?.entry;
    setEntries((list) => [...(list ?? []).filter((e) => e.id !== saved.id), summarise(saved)]);
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
  useSiteIcons(entries, !settings.hideIcons.login, (updated) => {
    setEntries((list) => (list ?? []).map((e) => (e.id === updated.id ? summarise(updated) : e)));
    if (updated.id === selectedRef.current) setDetailVersion((v) => v + 1);
  });

  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        onLock();
        return;
      }
      if (mod || e.altKey || isTypingTarget(e.target) || document.querySelector('.dialog-layer, .palette-layer, .menu, .ob-replay')) return;
      if (e.key === '/') {
        e.preventDefault();
        setView((v) => (v.kind === 'items' ? v : { kind: 'items', filter: { kind: 'all' } }));
        window.setTimeout(() => searchRef.current?.focus(), 0);
      } else if (e.key === 'n') {
        e.preventDefault();
        create('login');
      } else if (e.key === 'e' && selectedRef.current) {
        e.preventDefault();
        void api.entry(selectedRef.current).then((entry) => openRef.current(entry), () => {});
      } else if (e.key === 'Escape' && selectedRef.current) {
        setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [create, onLock]);

  const defaultType: EntryType = filter.kind === 'type' ? filter.type : 'login';
  const showingDetail = view.kind === 'items' && selectedId !== null;

  return (
    <SettingsProvider value={{ settings, updateSettings }}>
      <div className="shell" data-nav-open={navOpen || undefined} data-detail={showingDetail || undefined}>
        <header className="topbar">
          <IconButton label="Menu" onClick={() => setNavOpen(true)}>
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
          view={view}
          onView={selectView}
          entries={entries ?? []}
          categories={categories}
          onAddCategory={addCategory}
          onLock={onLock}
          onSearch={() => setPaletteOpen(true)}
          expiresAt={expiresAt}
          idleMs={settings.autoLockMinutes * 60_000}
          auditCount={auditCount}
          trashCount={trashCount}
        />

        <main className="workspace">
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
                    setEntries((list) => (list ?? []).map((e) => (e.id === updated.id ? summarise(updated) : e)));
                    if (updated.id === selectedRef.current) setDetailVersion((v) => v + 1);
                  }}
                  onDeleted={(id) => {
                    setEntries((list) => (list ?? []).filter((e) => e.id !== id));
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
                      onChanged={(updated) => setEntries((list) => [...(list ?? []).filter((e) => e.id !== updated.id), summarise(updated)])}
                      onDeleted={() => {
                        setEntries((list) => (list ?? []).filter((e) => e.id !== selectedId));
                        setSelectedId(null);
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
                    onViewOnboarding={() => setReplaying(true)}
                    onShowGettingStarted={() => {
                      selectView({ kind: 'items', filter: { kind: 'all' } });
                      void updateSettings({ checklist: { tourSeen: false, done: settings.checklist?.done ?? [] } }).catch(() => {});
                    }}
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
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        <GettingStarted
          hasItems={(entries?.length ?? 0) > 0}
          onAdd={() => create(defaultType)}
          onGo={(step) => selectView({ kind: step === 'backup' ? 'settings' : step })}
          watch={view.kind}
        />
        <AnimatePresence>
          {replaying && (
            <motion.div key="onboarding" className="ob-replay-layer" {...fade}>
              <Onboarding status={status} onClose={() => setReplaying(false)} />
            </motion.div>
          )}
        </AnimatePresence>
        <EntryEditorDialog state={editor} categories={categories} onSaved={onSaved} onClose={() => setEditor(null)} />
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} entries={entries ?? []} actions={paletteActions} />
      </div>
    </SettingsProvider>
  );
}
