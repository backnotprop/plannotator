/**
 * System's part of the Reviews address (approval "system-inbox", screens 4a and 4b): `&system=<project id>` for the
 * drawing open in the pane, `&sheet=<code>` for the sheet on screen, `&full=1` for the full window. App's routeOf and
 * hashOf read and write these through here, and its Escape ladder and every new Reviews address follow these rules.
 *
 * While System does not show (off, or Code review off), none of it holds: a leftover link is dropped, never carried
 * into a new address, and Escape is today's.
 */

export interface SystemRoutePart {
  system?: string | null;
  sheet?: string | null;
  full?: boolean;
}

/** The drawing's part of a Reviews address: `sheet` and `full` only with a drawing. */
export function systemRouteOf(params: URLSearchParams): Required<SystemRoutePart> {
  const system = params.get('system') || null;
  return { system, sheet: system ? params.get('sheet') || null : null, full: system ? params.get('full') === '1' : false };
}

/** The address's tail for the drawing (`&system=…&sheet=…&full=1`), empty with none. */
export function systemHashOf(route: SystemRoutePart): string {
  if (!route.system) return '';
  return `&system=${encodeURIComponent(route.system)}` + (route.sheet ? `&sheet=${encodeURIComponent(route.sheet)}` : '') + (route.full ? '&full=1' : '');
}

const NONE: Required<SystemRoutePart> = { system: null, sheet: null, full: false };

/**
 * What a new Reviews address keeps of the drawing: a PR opened from it (in the pane or the full window) closes back
 * to it as it was. Nothing while System does not show, or beside a thread.
 */
export function systemKept(route: SystemRoutePart, shown: boolean): Required<SystemRoutePart> {
  if (!shown || !route.system) return NONE;
  return { system: route.system, sheet: route.sheet ?? null, full: route.full === true };
}

/** A Reviews address holding a drawing while System does not show: the same address without it (null when clean). */
export function systemDropped<R extends SystemRoutePart & { page: string }>(route: R, shown: boolean): R | null {
  if (shown || route.page !== 'reviews' || (!route.system && !route.sheet && !route.full)) return null;
  return { ...route, ...NONE };
}

/**
 * Escape on Reviews with a drawing open: the full window first, then the drawing. Null when Escape is not System's:
 * System not shown, no drawing, or a PR's pane open over it. (The drawing's own Escape, a card or a sheet inside, runs
 * in SystemView first; App keeps its own guards for fields, menus and dialogs.)
 */
export function systemEscapeTo<R extends SystemRoutePart & { page: string; stack?: string | null }>(route: R, shown: boolean): R | null {
  if (!shown || route.page !== 'reviews' || !route.system || route.stack) return null;
  if (route.full) return { ...route, full: false };
  return { ...route, ...NONE };
}
