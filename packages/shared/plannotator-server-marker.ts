/**
 * The header every Plannotator server sets on every response (plan, review,
 * annotate, archive, goal setup, the Inbox; Bun and Pi).
 *
 * It exists so a client can tell a Plannotator server from any other local
 * server without reading a body: annotate's live app mode refuses to proxy a
 * Plannotator server (packages/shared/live-proxy-core.ts), both when it
 * probes the target and on every proxied response, because the proxy would
 * hand the proxied page same-origin writes on that server.
 *
 * Pure: no runtime APIs. Vendored to the Pi extension.
 */

/** Header name, lowercase (Headers and node:http compare case-insensitively). */
export const PLANNOTATOR_SERVER_HEADER = "x-plannotator-server";

/** The value is not read: the header's presence is the marker. */
export const PLANNOTATOR_SERVER_HEADER_VALUE = "1";

/** True when a response's headers say it came from a Plannotator server. */
export function hasPlannotatorServerHeader(headers: { get(name: string): string | null }): boolean {
  return headers.get(PLANNOTATOR_SERVER_HEADER) !== null;
}

/**
 * The header annotate's live app proxy adds to every request it forwards
 * upstream. Every Plannotator server refuses a request carrying it before any
 * route, so a write through the proxy never runs on a Plannotator server, even
 * one that took the target's port after the probe. A forged copy can only get
 * its sender refused.
 */
export const PLANNOTATOR_LIVE_PROXY_HEADER = "x-plannotator-live-proxy";

/** The machine-readable code of that refusal (status 403). */
export const LIVE_PROXIED_REFUSED_CODE = "live_proxy_refused";

/** The refusal's text body. */
export const LIVE_PROXIED_REFUSED_MESSAGE =
  "This is a Plannotator server; annotate's live app proxy never fronts one.";

/** True when a request came through annotate's live app proxy. */
export function isLiveProxiedRequest(headers: { get(name: string): string | null }): boolean {
  return headers.get(PLANNOTATOR_LIVE_PROXY_HEADER) !== null;
}
