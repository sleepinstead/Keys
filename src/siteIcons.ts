import { useEffect, useRef } from 'react';
import { api } from './api.ts';
import { normalizeIcon } from './icon.ts';
import type { Entry, EntrySummary } from '../shared/types.ts';

const AT_ONCE = 2;

/**
 * Gives logins their website's icon by default. Any login with a website and no
 * icon yet ('' — not 'none', which means the user picked the letter) is fetched
 * once per session, a couple at a time. Failures are left alone until next
 * unlock, so an offline session doesn't keep retrying.
 */
export function useSiteIcons(entries: EntrySummary[] | null, enabled: boolean, onUpdated: (entry: Entry) => void) {
  const tried = useRef(new Set<string>());
  const running = useRef(0);
  const latest = useRef(onUpdated);
  latest.current = onUpdated;

  useEffect(() => {
    if (!enabled || !entries) return;
    const queue = entries.filter((e) => e.type === 'login' && e.icon === '' && e.url.trim() && !tried.current.has(e.id));
    const next = () => {
      while (running.current < AT_ONCE && queue.length) {
        const e = queue.shift()!;
        // An earlier run's queue may already have started this one.
        if (tried.current.has(e.id)) continue;
        tried.current.add(e.id);
        running.current++;
        void (async () => {
          try {
            const icon = await normalizeIcon((await api.siteIcon(e.url)).icon);
            latest.current(await api.setIcon(e.id, icon));
          } catch {
            /* no icon for this site, or offline: it keeps its letter */
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
