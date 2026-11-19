import type {
  EntryType,
  AuditReport,
  BrowserPairing,
  Category,
  CategoryColor,
  Credential,
  CredentialType,
  Entry,
  EntryInput,
  EntrySummary,
  ExportFormat,
  ExportResult,
  SyncStatus,
  ImportResult,
  PinStatus,
  Settings,
  StrengthResult,
  TrashedEntry,
  VaultStatus,
} from '../shared/types.ts';

export const LOCK_EVENT = 'keys:locked';
/** Ask the vault view to reload its lists (after an undo, say). */
export const REFRESH_EVENT = 'keys:refresh';

// Per tab and per port, unlike a cookie, and useless once the vault locks.
const TOKEN = 'keys-session';
function readToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN);
  } catch {
    return memoryToken;
  }
}
function writeToken(token: string | null) {
  memoryToken = token;
  try {
    if (token) sessionStorage.setItem(TOKEN, token);
    else sessionStorage.removeItem(TOKEN);
  } catch {
    /* storage blocked: the token lasts until this page reloads */
  }
}
let memoryToken: string | null = null;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  const token = readToken();
  try {
    res = await fetch(`/api${path}`, {
      method,
      cache: 'no-store',
      headers: {
        'x-keys-request': '1',
        ...(token ? { 'x-keys-session': token } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Can’t reach the Keys server. Is it running?', 'OFFLINE');
  }
  const text = await res.text();
  let data: { error?: string; code?: string; sessionToken?: string } | null = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    // Locked, or the database file went away (a synced folder offline): back to the lock screen,
    // which then explains what's wrong instead of every action failing one by one.
    if ((res.status === 401 && data?.code === 'LOCKED') || (res.status === 503 && data?.code === 'NO_DATABASE')) window.dispatchEvent(new Event(LOCK_EVENT));
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.code);
  }
  if (data?.sessionToken) writeToken(data.sessionToken);
  if (path === '/lock') writeToken(null);
  return data as T;
}

const id = (v: string) => encodeURIComponent(v);

export const api = {
  status: () => request<VaultStatus>('GET', '/status'),

  // Which database file Keys uses
  connectStorage: (path: string, current?: string) => request<VaultStatus>('POST', '/storage/connect', { path, current }),
  createStorage: (path: string, current?: string) => request<VaultStatus>('POST', '/storage/create', { path, current }),
  moveStorage: (path: string, current?: string) => request<VaultStatus>('POST', '/storage/move', { path, current }),
  defaultStorage: (current?: string) => request<VaultStatus>('POST', '/storage/default', { current }),
  browsers: () => request<BrowserPairing[]>('GET', '/browsers'),
  approveBrowser: (code: string) => request<BrowserPairing>('POST', '/browsers/approve', { code }),
  removeBrowser: (browserId: string) => request<{ ok: true }>('DELETE', `/browsers/${encodeURIComponent(browserId)}`),
  wipeStorage: (current?: string) => request<VaultStatus>('POST', '/storage/wipe', { current }),
  retryStorage: () => request<VaultStatus>('POST', '/storage/retry'),
  sync: () => request<SyncStatus>('GET', '/sync'),
  mergeConflict: (path: string) => request<{ merged: number; skipped: number }>('POST', '/sync/merge', { path }),
  appInfo: () => request<{ version?: string }>('GET', '/app'),
  browseStorage: (mode: 'open' | 'save') => request<{ path: string | null }>('POST', '/storage/browse', { mode }),
  storageTemplate: () => request<{ filename: string; data: string }>('GET', '/storage/template'),
  setup: (password: string, type: CredentialType = 'password') => request<VaultStatus>('POST', '/setup', { password, type }),
  unlock: (password: string) => request<VaultStatus>('POST', '/unlock', { password }),
  unlockPin: (pin: string) => request<VaultStatus>('POST', '/unlock/pin', { pin }),
  unlockAuto: () => request<VaultStatus>('POST', '/unlock/auto'),
  setAutoUnlock: (current: string) => request<VaultStatus>('POST', '/auto-unlock', { current }),
  removeAutoUnlock: () => request<VaultStatus>('DELETE', '/auto-unlock'),
  setPin: (pin: string, masterPassword: string) => request<{ pin: PinStatus }>('POST', '/pin', { pin, masterPassword }),
  removePin: () => request<{ pin: null }>('DELETE', '/pin'),
  lock: () => request<{ ok: true }>('POST', '/lock'),
  ping: () => request<{ expiresAt: number }>('POST', '/session/ping'),
  siteIcon: (url: string) => request<{ icon: string }>('POST', '/tools/site-icon', { url }),
  strength: (password: string, userInputs: string[] = []) =>
    request<StrengthResult>('POST', '/tools/strength', { password, userInputs }),

  entries: () => request<EntrySummary[]>('GET', '/entries'),
  entry: (entryId: string) => request<Entry>('GET', `/entries/${id(entryId)}`),
  createEntry: (input: EntryInput) => request<Entry>('POST', '/entries', input),
  /** `baseUpdatedAt`: the version the editor started from; a newer one on the server gives 409 CHANGED. */
  updateEntry: (entryId: string, input: EntryInput, baseUpdatedAt?: number) => request<Entry>('PUT', `/entries/${id(entryId)}`, { ...input, baseUpdatedAt }),
  updateEntries: (ids: string[], patch: { favorite?: boolean; categoryId?: string | null }) => request<{ updated: number }>('POST', '/entries/update', { ids, ...patch }),
  trash: () => request<TrashedEntry[]>('GET', '/trash'),
  restoreTrash: (ids: string[]) => request<{ restored: number }>('POST', '/trash/restore', { ids }),
  purgeTrash: (ids: string[] | 'all', current: string) =>
    request<{ purged: number }>('POST', '/trash/purge', ids === 'all' ? { all: true, current } : { ids, current }),
  deleteEntries: (ids: string[]) => request<{ deleted: number }>('POST', '/entries/delete', { ids }),
  deleteEntry: (entryId: string) => request<{ ok: true }>('DELETE', `/entries/${id(entryId)}`),
  /** `onlyIfEmpty`: for the background fetch, so it never replaces an icon the person chose. */
  setIcon: (entryId: string, icon: string, onlyIfEmpty = false) => request<Entry>('PUT', `/entries/${id(entryId)}/icon`, { icon, onlyIfEmpty }),
  clearHistory: (entryId: string) => request<Entry>('DELETE', `/entries/${id(entryId)}/history`),

  categories: () => request<Category[]>('GET', '/categories'),
  createCategory: (name: string) => request<Category>('POST', '/categories', { name }),
  renameCategory: (catId: string, name: string) => request<Category>('PUT', `/categories/${id(catId)}`, { name }),
  colorCategory: (catId: string, color: CategoryColor | null) => request<Category>('PUT', `/categories/${id(catId)}`, { color }),
  deleteCategory: (catId: string) => request<{ ok: true }>('DELETE', `/categories/${id(catId)}`),

  updateSettings: (patch: Partial<Settings>) =>
    request<{ settings: Settings; expiresAt: number }>('PUT', '/settings', patch),
  changePassword: (current: string, next: string, type: CredentialType = 'password') =>
    request<{ ok: true; credential: Credential }>('POST', '/account/change-password', { current, next, type }),

  audit: () => request<AuditReport>('GET', '/audit'),
  checkBreaches: () => request<AuditReport>('POST', '/audit/breaches', {}),

  exportVault: (format: ExportFormat, masterPassword: string, exportPassword?: string, types?: EntryType[]) =>
    request<ExportResult>('POST', '/export', { format, masterPassword, exportPassword, types }),
  importVault: (content: string, password?: string) =>
    request<ImportResult>('POST', '/import', { content, password }),
};

/** True when a request failed only because the vault locked (the lock screen already says so). */
export function isLockedError(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'LOCKED';
}

/** Message to show for a failure. Empty for "vault is locked", which is never worth a toast. */
export function errorMessage(err: unknown): string {
  if (isLockedError(err)) return '';
  return err instanceof Error ? err.message : 'Something went wrong';
}
