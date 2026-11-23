/**
 * Reviews' "On this computer" in the address (packages/core/inbox-local-work.ts): the row whose diff is open beside the
 * list, `#reviews&local=<project id>&branch=<name>`, or with no `branch` that project's uncommitted changes. App's
 * routeOf and hashOf read and write it through here; a PR's pane (`&stack=`) wins over it.
 */
export interface LocalOpen {
  project: string;
  /** Null: the project folder's uncommitted changes. */
  branch: string | null;
}

export interface LocalRoutePart {
  local?: LocalOpen | null;
}

export function localRouteOf(params: URLSearchParams): Required<LocalRoutePart> {
  const project = params.get('local') || null;
  return { local: project ? { project, branch: params.get('branch') || null } : null };
}

export function localHashOf(route: LocalRoutePart): string {
  if (!route.local) return '';
  return `&local=${encodeURIComponent(route.local.project)}` + (route.local.branch ? `&branch=${encodeURIComponent(route.local.branch)}` : '');
}

/** The open row's key, as the list keys its rows (`inboxLocalWorkKey`). */
export const localOpenKey = (open: LocalOpen | null | undefined): string | null => (open ? `${open.project}:${open.branch ?? ''}` : null);

/**
 * What PullsPage takes from the address (App's Reviews list): the open stack, the layer its row shows selected (the open
 * one, or the one whose diff closed back to the stack), and an "On this computer" row's diff, never beside a thread.
 */
export function pullsPageAddress(
  route: LocalRoutePart & { stack?: string | null; layer?: string | null; backLayer?: string | null },
  threadId: string | null,
): { stackId: string | null; layerId: string | null; local: LocalOpen | null } {
  return { stackId: route.stack ?? null, layerId: route.layer ?? route.backLayer ?? null, local: threadId ? null : (route.local ?? null) };
}
