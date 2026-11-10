import { decryptJson, deriveKey, DecryptionError, encryptJson, isValidKdf, newKdfParams } from './crypto.ts';
import { HttpError, sanitizeEntryInput } from './validate.ts';
import type { Vault } from './vault.ts';
import { ENTRY_TYPES } from '../shared/types.ts';
import type { CustomField, EntryType, ExportFormat, ExportResult, ImportResult } from '../shared/types.ts';

// Kept from the app's original name: it is bound into every encrypted export, so changing it
// would make older backups unreadable.
const EXPORT_AAD = 'vaultx:export:v1';

/** Entry shape used in exports: categories by name so files are portable. */
interface PortableEntry {
  type: EntryType;
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  codes: string;
  category: string | null;
  favorite: boolean;
  icon?: string;
  customFields: CustomField[];
  createdAt?: number;
  passwordUpdatedAt?: number;
  history?: { password: string; changedAt: number }[];
}

interface PortableVault {
  categories: string[];
  entries: PortableEntry[];
}

function snapshot(vault: Vault, key: Buffer): PortableVault {
  const categories = vault.listCategories(key);
  const names = new Map(categories.map((c) => [c.id, c.name]));
  return {
    categories: categories.map((c) => c.name),
    entries: vault.listEntries(key).map((e) => ({
      type: e.type,
      title: e.title,
      username: e.username,
      password: e.password,
      url: e.url,
      notes: e.notes,
      codes: e.codes,
      category: e.categoryId ? (names.get(e.categoryId) ?? null) : null,
      favorite: e.favorite,
      icon: e.icon,
      customFields: e.customFields,
      createdAt: e.createdAt,
      passwordUpdatedAt: e.passwordUpdatedAt,
      history: e.history,
    })),
  };
}

// ------------------------------------------------------------------ CSV

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (quoted) throw new HttpError(400, 'Malformed CSV: unterminated quote');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const COLUMN_ALIASES: Record<keyof Omit<PortableEntry, 'icon' | 'customFields' | 'createdAt' | 'passwordUpdatedAt' | 'history'>, string[]> = {
  type: ['type'],
  title: ['title', 'name', 'account', 'site name', 'item name'],
  url: ['url', 'login_uri', 'website', 'uri', 'web site', 'login url', 'site'],
  username: ['username', 'login_username', 'user', 'user name', 'login', 'login name', 'email', 'e-mail'],
  password: ['password', 'login_password', 'pass'],
  notes: ['notes', 'note', 'extra', 'comments', 'comment'],
  codes: ['codes', 'recovery codes'],
  category: ['category', 'folder', 'grouping', 'group'],
  favorite: ['favorite', 'fav', 'favourite'],
};

function hostTitle(url: string): string {
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function fromCsv(text: string): PortableEntry[] {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new HttpError(400, 'CSV has no data rows');
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const col = (field: keyof typeof COLUMN_ALIASES) => header.findIndex((h) => COLUMN_ALIASES[field].includes(h));
  const idx = Object.fromEntries(Object.keys(COLUMN_ALIASES).map((f) => [f, col(f as keyof typeof COLUMN_ALIASES)]));
  if (idx.password! < 0 && idx.notes! < 0) {
    throw new HttpError(400, 'Unrecognised CSV: expected at least a "password" or "notes" column');
  }
  return rows.slice(1).map((r) => {
    const get = (f: string) => (idx[f]! >= 0 ? (r[idx[f]!] ?? '') : '');
    const rawType = get('type').trim();
    const type: EntryType = ENTRY_TYPES.includes(rawType as EntryType)
      ? (rawType as EntryType)
      : rawType === 'note' || (!get('password') && !get('username') && get('notes'))
        ? 'note'
        : 'login';
    const url = get('url');
    return {
      type,
      title: get('title').trim() || hostTitle(url) || 'Imported item',
      username: get('username'),
      password: get('password'),
      url,
      notes: get('notes'),
      codes: get('codes'),
      category: get('category').trim() || null,
      favorite: ['1', 'true', 'yes', 'y'].includes(get('favorite').trim().toLowerCase()),
      customFields: [],
    };
  });
}

// ----------------------------------------------------------- Bitwarden

interface BitwardenExport {
  encrypted?: boolean;
  folders?: { id: string; name: string }[];
  items?: {
    type: number;
    name?: string;
    notes?: string | null;
    favorite?: boolean;
    folderId?: string | null;
    login?: { username?: string | null; password?: string | null; uris?: { uri?: string | null }[] | null };
    fields?: { name?: string | null; value?: string | null; type?: number }[] | null;
  }[];
}

function fromBitwarden(data: BitwardenExport): PortableEntry[] {
  if (data.encrypted) throw new HttpError(400, 'Encrypted Bitwarden exports are not supported; export as unencrypted JSON');
  const folders = new Map((data.folders ?? []).map((f) => [f.id, f.name]));
  return (data.items ?? [])
    .filter((i) => i.type === 1 || i.type === 2)
    .map((i) => ({
      type: i.type === 2 ? 'note' : 'login',
      title: i.name || 'Imported item',
      username: i.login?.username ?? '',
      password: i.login?.password ?? '',
      url: i.login?.uris?.[0]?.uri ?? '',
      notes: i.notes ?? '',
      codes: '',
      category: (i.folderId && folders.get(i.folderId)) || null,
      favorite: Boolean(i.favorite),
      customFields: (i.fields ?? []).map((f) => ({
        id: '',
        label: f.name ?? '',
        value: f.value ?? '',
        hidden: f.type === 1,
      })),
    }));
}

// --------------------------------------------------------------- export

export async function exportVault(
  vault: Vault,
  key: Buffer,
  format: ExportFormat,
  exportPassword?: string,
): Promise<ExportResult> {
  const data = snapshot(vault, key);
  const stamp = new Date().toISOString().slice(0, 10);
  const createdAt = new Date().toISOString();

  if (format === 'encrypted') {
    if (!exportPassword) throw new HttpError(400, 'An export password is required');
    const kdf = newKdfParams();
    const exportKey = await deriveKey(exportPassword, kdf);
    try {
      const blob = encryptJson(exportKey, data, EXPORT_AAD);
      const file = { format: 'keys-export', version: 1, createdAt, kdf, data: blob.toString('base64') };
      return { filename: `keys-${stamp}.keys.json`, mime: 'application/json', content: JSON.stringify(file, null, 2) };
    } finally {
      exportKey.fill(0);
    }
  }

  if (format === 'json') {
    const file = { format: 'keys-plain', version: 1, createdAt, ...data };
    return { filename: `keys-${stamp}-UNENCRYPTED.json`, mime: 'application/json', content: JSON.stringify(file, null, 2) };
  }

  if (format === 'csv') {
    const header = ['type', 'title', 'username', 'password', 'url', 'notes', 'codes', 'category', 'favorite'];
    const rows = data.entries.map((e) => [
      e.type,
      e.title,
      e.username,
      e.password,
      e.url,
      e.notes,
      e.codes,
      e.category ?? '',
      e.favorite ? '1' : '0',
    ]);
    return { filename: `keys-${stamp}-UNENCRYPTED.csv`, mime: 'text/csv', content: toCsv([header, ...rows]) };
  }

  throw new HttpError(400, 'Unknown export format');
}

// --------------------------------------------------------------- import

async function parseImport(content: string, password?: string): Promise<{ source: string; data: PortableVault }> {
  const trimmed = content.trim();
  if (!trimmed) throw new HttpError(400, 'File is empty');
  if (!trimmed.startsWith('{')) {
    return { source: 'CSV', data: { categories: [], entries: fromCsv(content) } };
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'File is not valid JSON or CSV');
  }
  // 'vaultx-*' formats are files exported before the app was renamed to Keys.
  if (json.format === 'keys-export' || json.format === 'vaultx-export') {
    if (!password) throw new HttpError(400, 'This export is encrypted; enter its password', 'NEEDS_PASSWORD');
    if (!isValidKdf(json.kdf)) throw new HttpError(400, 'Export file has invalid key-derivation parameters');
    const key = await deriveKey(password, json.kdf);
    try {
      const data = decryptJson<PortableVault>(key, Buffer.from(String(json.data), 'base64'), EXPORT_AAD);
      return { source: 'Keys encrypted export', data };
    } catch (err) {
      if (err instanceof DecryptionError) throw new HttpError(400, 'Wrong password for this export', 'BAD_PASSWORD');
      throw err;
    } finally {
      key.fill(0);
    }
  }
  if (json.format === 'keys-plain' || json.format === 'vaultx-plain') {
    return { source: 'Keys JSON', data: json as unknown as PortableVault };
  }
  if (Array.isArray(json.items)) {
    return { source: 'Bitwarden JSON', data: { categories: [], entries: fromBitwarden(json as BitwardenExport) } };
  }
  throw new HttpError(400, 'Unrecognised JSON format');
}

/** `getKey` is called after parsing (which may await key derivation) so a session that locked meanwhile is caught. */
export async function importVault(
  vault: Vault,
  getKey: () => Buffer,
  content: string,
  password?: string,
): Promise<ImportResult> {
  const { source, data } = await parseImport(content, password);
  const key = getKey();
  if (!Array.isArray(data.entries)) throw new HttpError(400, 'Import file has no entries');

  const fingerprint = (e: { type: string; title: string; username: string; password: string; url: string }) =>
    JSON.stringify([e.type, e.title.trim(), e.username.trim(), e.password, e.url.trim()]);
  const existing = new Set(vault.listEntries(key).map(fingerprint));

  let imported = 0;
  let skipped = 0;
  let categoriesCreated = 0;
  const categoryIds = new Map<string, string>();
  const categoryFor = (name: string | null | undefined): string | null => {
    if (!name || typeof name !== 'string' || !name.trim()) return null;
    const norm = name.trim().slice(0, 60);
    const cached = categoryIds.get(norm.toLowerCase());
    if (cached) return cached;
    const { category, created } = vault.findOrCreateCategory(key, norm);
    if (created) categoriesCreated++;
    categoryIds.set(norm.toLowerCase(), category.id);
    return category.id;
  };

  vault.store.transaction(() => {
    for (const name of Array.isArray(data.categories) ? data.categories : []) categoryFor(name);
    for (const raw of data.entries) {
      let input;
      try {
        input = sanitizeEntryInput({ ...raw, categoryId: null });
      } catch {
        skipped++;
        continue;
      }
      if (existing.has(fingerprint(input))) {
        skipped++;
        continue;
      }
      input.categoryId = categoryFor(raw.category);
      const history = Array.isArray(raw.history)
        ? raw.history
            .filter((h) => h && typeof h.password === 'string' && Number.isFinite(h.changedAt))
            .map((h) => ({ password: h.password.slice(0, 4096), changedAt: h.changedAt }))
        : [];
      vault.createEntry(key, input, {
        createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : undefined,
        passwordUpdatedAt: Number.isFinite(raw.passwordUpdatedAt) ? raw.passwordUpdatedAt : undefined,
        history,
      });
      existing.add(fingerprint(input));
      imported++;
    }
  });

  return { imported, skipped, categoriesCreated, source };
}
