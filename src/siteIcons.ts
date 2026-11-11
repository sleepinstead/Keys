import { useEffect, useRef } from 'react';
import { api, ApiError } from './api.ts';
import { normalizeIcon } from './icon.ts';
import type { Entry, EntrySummary } from '../shared/types.ts';

const AT_ONCE = 2;
const FLUSH_MS = 400;

/**
 * Gives logins their website's icon by default. Any login with a website and no
 * icon yet ('' — not 'none', which means the user picked the letter) is fetched
 * once per session, a couple at a time. Failures are left alone until next
 * unlock, so an offline session doesn't keep retrying.
 *
 * Results arrive in batches (one list update every few hundred ms, not one per icon), and the
 * queue stops for good when the vault locks or this unmounts.
 */
export function useSiteIcons(entries: EntrySummary[] | null, enabled: boolean, onUpdated: (entries: Entry[]) => void) {
  const tried = useRef(new Set<string>());
  const queue = useRef<EntrySummary[]>([]);
  const running = useRef(0);
  const stopped = useRef(false);
  const done = useRef<Entry[]>([]);
  const flushTimer = useRef<number | undefined>(undefined);
  const latest = useRef(onUpdated);
  latest.current = onUpdated;

  useEffect(() => {
    stopped.current = false;
    return () => {
      stopped.current = true;
      window.clearTimeout(flushTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!enabled || !entries) return;
    for (const e of entries) {
      if (e.type === 'login' && e.icon === '' && e.url.trim() && !tried.current.has(e.id)) {
        tried.current.add(e.id);
        queue.current.push(e);
      }
    }
    const flush = () => {
      flushTimer.current = undefined;
      if (stopped.current || !done.current.length) return;
      const batch = done.current;
      done.current = [];
      latest.current(batch);
    };
    const next = () => {
      while (!stopped.current && running.current < AT_ONCE && queue.current.length) {
        const e = queue.current.shift()!;
        running.current++;
        void (async () => {
          try {
            const icon = await normalizeIcon((await api.siteIcon(e.url)).icon);
            if (stopped.current) return;
            done.current.push(await api.setIcon(e.id, icon));
            flushTimer.current ??= window.setTimeout(flush, FLUSH_MS);
          } catch (err) {
            // Locked: stop asking (each request would only fail and announce the lock again).
            if (err instanceof ApiError && err.code === 'LOCKED') stopped.current = true;
            /* otherwise no icon for this site, or offline: it keeps its letter */
          } finally {
            running.current--;
            next();
          }
        })();
      }
    };
    next();
  }, [entries, enabled]);
}
