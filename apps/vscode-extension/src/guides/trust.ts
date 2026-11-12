export function approveAlwaysTarget(
  runId: string | undefined,
  permissionId: number | undefined,
  runs: {
    generation: { id: string; live: boolean; pending: readonly number[] } | null;
    askPending(runId: string | undefined, permissionId: number | undefined): boolean;
  },
): "generation" | "ask" | null {
  if (!runId || permissionId === undefined) return null;
  if (runs.askPending(runId, permissionId)) return "ask";
  const g = runs.generation;
  if (g && g.id === runId && g.live && g.pending.includes(permissionId)) return "generation";
  return null;
}

function normalUrl(url: string): string {
  return url.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
}

export function isKnownPullRequestUrl(url: string, known: Iterable<string | null | undefined>): boolean {
  if (!/^https:\/\//i.test(url)) return false;
  const want = normalUrl(url);
  for (const k of known) if (k && normalUrl(k) === want) return true;
  return false;
}
