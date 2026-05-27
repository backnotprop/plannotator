import { createContext, useContext, useCallback, useEffect, type ReactNode } from 'react';

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface SessionContextValue {
  fetch: FetchFn;
}

const UNSET = Symbol('no-session');

const SessionContext = createContext<SessionContextValue | typeof UNSET>(UNSET);

export function SessionProvider({
  sessionId,
  children,
}: {
  sessionId: string;
  children: ReactNode;
}) {
  const sessionFetch = useCallback<FetchFn>(
    (input, init) => {
      if (typeof input === 'string') {
        if (input === '/api' || input.startsWith('/api/')) {
          return globalThis.fetch(`/s/${sessionId}/api${input.slice(4)}`, init);
        }
      }
      return globalThis.fetch(input, init);
    },
    [sessionId],
  );

  // Also set the window global so non-hook consumers (apiPath, <img src>) work
  useEffect(() => {
    const prev = window.__PLANNOTATOR_API_BASE__;
    window.__PLANNOTATOR_API_BASE__ = `/s/${sessionId}/api`;
    return () => {
      window.__PLANNOTATOR_API_BASE__ = prev;
    };
  }, [sessionId]);

  return (
    <SessionContext.Provider value={{ fetch: sessionFetch }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSessionFetch(): FetchFn {
  const ctx = useContext(SessionContext);
  if (ctx === UNSET) return globalThis.fetch;
  return ctx.fetch;
}
