export const PLANNOTATOR_SERVER_HEADER = "x-plannotator-server";

export const PLANNOTATOR_SERVER_HEADER_VALUE = "1";

export function hasPlannotatorServerHeader(headers: { get(name: string): string | null }): boolean {
  return headers.get(PLANNOTATOR_SERVER_HEADER) !== null;
}

export const PLANNOTATOR_LIVE_PROXY_HEADER = "x-plannotator-live-proxy";

export const LIVE_PROXIED_REFUSED_CODE = "live_proxy_refused";

export const LIVE_PROXIED_REFUSED_MESSAGE =
  "This is a Plannotator server; annotate's live app proxy never fronts one.";

export function isLiveProxiedRequest(headers: { get(name: string): string | null }): boolean {
  return headers.get(PLANNOTATOR_LIVE_PROXY_HEADER) !== null;
}
