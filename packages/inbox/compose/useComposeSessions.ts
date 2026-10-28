import { useCallback, useEffect, useState } from 'react';
import { inboxApi, type ComposeSessionsModel } from '../api';

/** Where compose reads the live sessions from: the Inbox's route, unless a transport (the tour) says otherwise. */
export type ComposeSessionsLoader = () => Promise<ComposeSessionsModel>;

/** How often the live sessions are read again while compose (or the palette) is open. */
export const COMPOSE_SESSIONS_REFRESH_MS = 5_000;

/**
 * Every live session (GET /api/inbox/sessions), read while `active` and every
 * few seconds after (never while the tab is hidden), so a session that starts shows in the picker and one that
 * stops greys out. The last answer stays while the next is on its way.
 */
export function useComposeSessions(active: boolean, loader?: ComposeSessionsLoader) {
  const [model, setModel] = useState<ComposeSessionsModel | null>(null);
  const load = useCallback(async () => {
    try {
      const next = await (loader ? loader() : inboxApi.composeSessions());
      setModel(next);
      return next;
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!active) return;
    // Paused while the tab is hidden; read again the moment it is shown.
    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (!hidden()) void load();
    const timer = setInterval(() => {
      if (!hidden()) void load();
    }, COMPOSE_SESSIONS_REFRESH_MS);
    const shown = () => {
      if (!hidden()) void load();
    };
    document.addEventListener('visibilitychange', shown);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [active, load]);
  return { model, load };
}
