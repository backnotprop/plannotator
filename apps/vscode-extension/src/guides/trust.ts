/**
 * Two small decisions about commands that reach the extension from a
 * webview, kept apart from `vscode` so they are tested directly.
 *
 * A webview message names what to do, but the page may show agent-written
 * text, so a command that changes a setting or leaves VS Code is checked
 * against what the extension itself knows.
 */

/** Which run "Always approve during guides" may act on, or null when nothing is really waiting. */
export function approveAlwaysTarget(
  runId: string | undefined,
  permissionId: number | undefined,
  runs: {
    /** The guide run: its id, whether it is live, and the ids of the requests waiting on the user. */
    generation: { id: string; live: boolean; pending: readonly number[] } | null;
    /** Whether an answer being asked (by its id) waits on the user for this request. */
    askPending(runId: string | undefined, permissionId: number | undefined): boolean;
  },
): "generation" | "ask" | null {
  if (!runId || permissionId === undefined) return null;
  if (runs.askPending(runId, permissionId)) return "ask";
  const g = runs.generation;
  if (g && g.id === runId && g.live && g.pending.includes(permissionId)) return "generation";
  return null;
}

/** Normalised for comparison: no trailing slash, no query or fragment. */
function normalUrl(url: string): string {
  return url.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
}

/**
 * Whether a URL is one of the pull requests the extension itself knows (the
 * dashboard's, the open guide's, the run's), which open without asking.
 * Anything else, such as a link in agent-written text, asks first.
 */
export function isKnownPullRequestUrl(url: string, known: Iterable<string | null | undefined>): boolean {
  if (!/^https:\/\//i.test(url)) return false;
  const want = normalUrl(url);
  for (const k of known) if (k && normalUrl(k) === want) return true;
  return false;
}
