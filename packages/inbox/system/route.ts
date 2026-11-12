export interface SystemRoutePart {
  system?: string | null;
  sheet?: string | null;
  full?: boolean;
}

export function systemRouteOf(params: URLSearchParams): Required<SystemRoutePart> {
  const system = params.get('system') || null;
  return { system, sheet: system ? params.get('sheet') || null : null, full: system ? params.get('full') === '1' : false };
}

export function systemHashOf(route: SystemRoutePart): string {
  if (!route.system) return '';
  return `&system=${encodeURIComponent(route.system)}` + (route.sheet ? `&sheet=${encodeURIComponent(route.sheet)}` : '') + (route.full ? '&full=1' : '');
}

const NONE: Required<SystemRoutePart> = { system: null, sheet: null, full: false };

export function systemKept(route: SystemRoutePart, shown: boolean): Required<SystemRoutePart> {
  if (!shown || !route.system) return NONE;
  return { system: route.system, sheet: route.sheet ?? null, full: route.full === true };
}

export function systemDropped<R extends SystemRoutePart & { page: string }>(route: R, shown: boolean): R | null {
  if (shown || route.page !== 'reviews' || (!route.system && !route.sheet && !route.full)) return null;
  return { ...route, ...NONE };
}

export function systemEscapeTo<R extends SystemRoutePart & { page: string; stack?: string | null }>(route: R, shown: boolean): R | null {
  if (!shown || route.page !== 'reviews' || !route.system || route.stack) return null;
  if (route.full) return { ...route, full: false };
  return { ...route, ...NONE };
}
