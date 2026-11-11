import type { EntryType } from '../shared/types.ts';

export const TYPE_LABELS: Record<EntryType, { one: string; many: string; inline: string }> = {
  login: { one: 'Login', many: 'Logins', inline: 'login' },
  note: { one: 'Secure note', many: 'Secure notes', inline: 'secure note' },
  apiKey: { one: 'API key', many: 'API keys', inline: 'API key' },
  recovery: { one: 'Recovery codes', many: 'Recovery codes', inline: 'recovery codes' },
};

/** Field labels change with the entry type; the stored shape stays the same. */
export const FIELD_LABELS: Record<EntryType, { username: string; password: string; url: string; notes: string }> = {
  login: { username: 'Username', password: 'Password', url: 'Website', notes: 'Notes' },
  apiKey: { username: 'Key ID', password: 'Secret', url: 'Endpoint', notes: 'Notes' },
  recovery: { username: 'Account', password: 'Password', url: 'Website', notes: 'Notes' },
  note: { username: 'Username', password: 'Password', url: 'Website', notes: 'Note' },
};

export function hostname(url: string): string {
  if (!url) return '';
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Only http(s) links are clickable, so a stored `javascript:` URL can't run. */
export function safeHref(url: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.includes('://') ? url : `https://${url}`);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.round((ts - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(s / 86400), 'day');
  if (abs < 86400 * 365) return rtf.format(Math.round(s / (86400 * 30)), 'month');
  return rtf.format(Math.round(s / (86400 * 365)), 'year');
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function downloadFile(filename: string, mime: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Saves base64-encoded binary content (e.g. a SQLite file) as a download. */
export function downloadBytes(filename: string, mime: string, base64: string): void {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? '⌘' : 'Ctrl';

export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
}
