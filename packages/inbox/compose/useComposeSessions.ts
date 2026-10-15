import { useCallback, useEffect, useState } from 'react';
import { inboxApi, type ComposeSessionsModel } from '../api';

/** How often the live sessions are read again while compose (or the palette) is open. */
export const COMPOSE_SESSIONS_REFRESH_MS = 5_000;

/**
 * Every live session (GET /api/inbox/sessions), read while `active` and every
 * few seconds after, so a session that starts fills To by itself and one that
 * stops greys out. The last answer stays while the next is on its way.
 */
export function useComposeSessions(active: boolean) {
  const [model, setModel] = useState<ComposeSessionsModel | null>(null);
  const load = useCallback(async () => {
    try {
      const next = await inboxApi.composeSessions();
      setModel(next);
      return next;
    } catch {
      return null;
    }
  }, []);
  useEffect(() => {
    if (!active) return;
    void load();
    const timer = setInterval(() => void load(), COMPOSE_SESSIONS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [active, load]);
  return { model, load };
}
