/** The header every Plannotator server sets on every response, so a client can tell it from another local server without reading a body. Pure: no runtime APIs. */

export const PLANNOTATOR_SERVER_HEADER = "x-plannotator-server";

/** The value is not read: the header's presence is the marker. */
export const PLANNOTATOR_SERVER_HEADER_VALUE = "1";

export function hasPlannotatorServerHeader(headers: { get(name: string): string | null }): boolean {
  return headers.get(PLANNOTATOR_SERVER_HEADER) !== null;
}

/** Header the live app proxy adds to forwarded requests. Every Plannotator server refuses a request carrying it, so a write through the proxy never runs on one. */
export const PLANNOTATOR_LIVE_PROXY_HEADER = "x-plannotator-live-proxy";

export const LIVE_PROXIED_REFUSED_CODE = "live_proxy_refused";

export const LIVE_PROXIED_REFUSED_MESSAGE =
  "This is a Plannotator server; annotate's live app proxy never fronts one.";

export function isLiveProxiedRequest(headers: { get(name: string): string | null }): boolean {
  return headers.get(PLANNOTATOR_LIVE_PROXY_HEADER) !== null;
}
