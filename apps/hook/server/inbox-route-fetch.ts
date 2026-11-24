/**
 * One request of a command that is a thin client over the window's routes (`inbox rows`, `projects`, `icon`,
 * `export-decisions`): `path` (with its query) and, for a change, a JSON body. On this computer it goes to the running
 * Inbox's listener; for a paired cloud agent, through the agent door (inbox-call-command.ts `inboxPairedRouteFetch`).
 */
export type InboxRouteFetch = (path: string, init?: { method?: string; body?: string }) => Promise<Response>;

/** The running Inbox on this computer, at `port`; each request waits at most `timeoutMs`. */
export function localRouteFetch(port: number, timeoutMs: number): InboxRouteFetch {
  return (path, init = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: init.method ?? "GET",
      ...(init.body !== undefined ? { headers: { "Content-Type": "application/json" }, body: init.body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
}
