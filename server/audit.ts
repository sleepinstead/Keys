import crypto from 'node:crypto';
import type { AuditIssue, AuditItem, AuditReport, Entry, Settings } from '../shared/types.ts';
import { checkStrength } from './strength.ts';

const DAY = 86_400_000;
const AUDITED_TYPES = new Set(['login']);

function hostOf(url: string): string {
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function buildAuditReport(entries: Entry[], settings: Settings, now = Date.now()): AuditReport {
  const logins = entries.filter((e) => AUDITED_TYPES.has(e.type) && e.password.length > 0);

  // Group identical passwords. Compared in memory only; nothing is persisted.
  const groups = new Map<string, string[]>();
  for (const e of logins) {
    const fp = crypto.createHash('sha256').update(e.password).digest('base64');
    const ids = groups.get(fp) ?? [];
    ids.push(e.id);
    groups.set(fp, ids);
  }
  const reuseOf = new Map<string, number>();
  const reusedGroups: string[][] = [];
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    reusedGroups.push(ids);
    for (const id of ids) reuseOf.set(id, ids.length);
  }

  const items: AuditItem[] = logins.map((e) => {
    const strength = checkStrength(e.password, [e.username, e.title, hostOf(e.url)]);
    const ageDays = Math.max(0, Math.floor((now - e.passwordUpdatedAt) / DAY));
    const issues: AuditIssue[] = [];
    if (e.breach && e.breach.count > 0) issues.push('breached');
    if (strength.score <= 2) issues.push('weak');
    if (reuseOf.has(e.id)) issues.push('reused');
    if (ageDays >= settings.outdatedDays) issues.push('outdated');
    return {
      id: e.id,
      title: e.title,
      icon: e.icon,
      username: e.username,
      url: e.url,
      score: strength.score,
      crackTime: strength.crackTime,
      ageDays,
      reuseCount: reuseOf.get(e.id) ?? 0,
      breachCount: e.breach?.count ?? null,
      breachCheckedAt: e.breach?.checkedAt ?? null,
      issues,
    };
  });

  const count = (issue: AuditIssue) => items.filter((i) => i.issues.includes(issue)).length;
  const weights: Record<AuditIssue, number> = { breached: 1, weak: 0.6, reused: 0.5, outdated: 0.2 };
  const penalty = items.reduce(
    (sum, i) => sum + Math.min(1, i.issues.reduce((s, issue) => s + weights[issue], 0)),
    0,
  );
  const health = items.length === 0 ? 100 : Math.round(100 * (1 - penalty / items.length));

  const severity = (i: AuditItem) => i.issues.reduce((s, issue) => s + weights[issue], 0);
  items.sort((a, b) => severity(b) - severity(a) || a.score - b.score || a.title.localeCompare(b.title));

  return {
    generatedAt: now,
    health,
    totals: {
      logins: items.length,
      weak: count('weak'),
      reused: count('reused'),
      outdated: count('outdated'),
      breached: count('breached'),
      unchecked: items.filter((i) => i.breachCheckedAt === null).length,
    },
    items,
    reusedGroups,
    breachCheckEnabled: settings.breachCheckEnabled,
  };
}

// --------------------------------------------------------------- breaches

const HIBP_RANGE = 'https://api.pwnedpasswords.com/range/';

export type RangeFetcher = (prefix: string) => Promise<string>;

/**
 * Have I Been Pwned "range" API (k-anonymity): only the first 5 hex chars of
 * the SHA-1 hash leave the machine. Responses are padded so their size
 * doesn't leak which prefix was asked for.
 */
export const fetchRange: RangeFetcher = async (prefix) => {
  const res = await fetch(HIBP_RANGE + prefix, {
    headers: { 'Add-Padding': 'true', 'User-Agent': 'Keys-Password-Manager' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Breach service responded with ${res.status}`);
  return res.text();
};

export function sha1Upper(password: string): string {
  return crypto.createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
}

export function parseRange(body: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of body.split(/\r?\n/)) {
    const [suffix, count] = line.trim().split(':');
    if (suffix && count) out.set(suffix.toUpperCase(), Number(count));
  }
  return out;
}

/** Returns breach counts keyed by entry id. Lookups for the same prefix are shared. */
export async function checkBreaches(
  entries: Pick<Entry, 'id' | 'password'>[],
  fetcher: RangeFetcher = fetchRange,
  concurrency = 4,
): Promise<Map<string, number>> {
  const byPrefix = new Map<string, { id: string; suffix: string }[]>();
  for (const e of entries) {
    if (!e.password) continue;
    const hash = sha1Upper(e.password);
    const list = byPrefix.get(hash.slice(0, 5)) ?? [];
    list.push({ id: e.id, suffix: hash.slice(5) });
    byPrefix.set(hash.slice(0, 5), list);
  }
  const results = new Map<string, number>();
  const queue = [...byPrefix.entries()];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [prefix, list] = next;
      const range = parseRange(await fetcher(prefix));
      for (const { id, suffix } of list) results.set(id, range.get(suffix) ?? 0);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return results;
}
