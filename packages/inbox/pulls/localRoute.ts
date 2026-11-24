/**
 * Reviews' "On this computer" in the address (packages/core/inbox-local-work.ts): the row whose diff is open beside the
 * list, `#reviews&local=<project id>&branch=<name>`, with no `branch` that project's uncommitted changes, or
 * `&local=<project id>&folder=<folder>` a folder's whole work opened from the group's + (`local=` empty: a folder picked
 * through "Another folder…", in no project). App's routeOf and hashOf read and write it through here; a PR's pane
 * (`&stack=`) wins over it.
 */
export interface LocalOpen {
  /** "" only with `folder`: a folder in no project. */
  project: string;
  /** Null: the project folder's uncommitted changes (or, with `folder`, that folder's work). */
  branch: string | null;
  /** A worktree folder, or a folder picked through "Another folder…" (`~/…`). */
  folder?: string | null;
}

export interface LocalRoutePart {
  local?: LocalOpen | null;
}

export function localRouteOf(params: URLSearchParams): Required<LocalRoutePart> {
  const project = params.get('local') || null;
  const folder = params.has('local') ? params.get('folder') || null : null;
  if (folder) return { local: { project: project ?? '', branch: null, folder } };
  return { local: project ? { project, branch: params.get('branch') || null } : null };
}

export function localHashOf(route: LocalRoutePart): string {
  if (!route.local) return '';
  if (route.local.folder) return `&local=${encodeURIComponent(route.local.project)}&folder=${encodeURIComponent(route.local.folder)}`;
  return `&local=${encodeURIComponent(route.local.project)}` + (route.local.branch ? `&branch=${encodeURIComponent(route.local.branch)}` : '');
}

/** The open row's key, as the list keys its rows (`inboxLocalWorkKey`). */
export const localOpenKey = (open: LocalOpen | null | undefined): string | null => (open ? (open.folder ? `${open.project}::${open.folder}` : `${open.project}:${open.branch ?? ''}`) : null);

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
