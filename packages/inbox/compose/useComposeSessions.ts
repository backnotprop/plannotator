import { useCallback, useEffect, useRef, useState } from 'react';
import { inboxApi, type ComposeSessionsModel, type ComposeTrustPick } from '../api';

/** Where compose reads the live sessions from: the Inbox's route, unless a transport (the tour) says otherwise. */
export type ComposeSessionsLoader = (trust: ComposeTrustPick | null) => Promise<ComposeSessionsModel>;

/** How often the live sessions are read again while compose (or the palette) is open. */
export const COMPOSE_SESSIONS_REFRESH_MS = 5_000;

/**
 * Every live session (GET /api/inbox/sessions), read while `active` and every
 * few seconds after (never while the tab is hidden), so a session that starts shows in the picker and one that
 * stops greys out. The last answer stays while the next is on its way. `trust`: the folder To names, whose files
 * each read looks at (Trust and start's facts); a new one is read at once. An answer is dropped only when it was asked
 * for another folder: a read slower than the refresh always has a newer one behind it, and must still land.
 */
export function useComposeSessions(active: boolean, loader?: ComposeSessionsLoader, trust: ComposeTrustPick | null = null) {
  const [model, setModel] = useState<ComposeSessionsModel | null>(null);
  const trustNow = useRef(trust);
  trustNow.current = trust;
  const load = useCallback(async () => {
    const pick = trustNow.current;
    try {
      const next = await (loader ? loader(pick) : inboxApi.composeSessions(null, pick));
      if (pick?.agent === trustNow.current?.agent && pick?.project === trustNow.current?.project) setModel(next);
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
  useEffect(() => {
    if (active && trust) void load();
  }, [active, load, trust?.agent, trust?.project]);
  return { model, load };
}
