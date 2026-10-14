/**
 * Bun adapter for the cross-origin write guard (packages/shared/request-origin.ts).
 *
 * Every Bun plan, review, annotate and goal-setup server runs it in `fetch`
 * right after the Host allowlist, before any route: a POST, PUT, PATCH or
 * DELETE that a page on another site sent (a cross-site or same-site
 * `Sec-Fetch-Site`, `Origin: null`, or an Origin naming another host) is
 * refused with 403 before anything is read or launched. A page on another
 * site can send a preflight-free `text/plain` POST, so without this any route
 * that writes, approves or starts a process would be reachable from it.
 *
 * Passes: a request with no Origin (a non-browser client such as an agent's
 * curl, the VS Code extension host, the Claude Code mod), the session's own
 * page, the VS Code panel's cookie proxy (`Sec-Fetch-Site: same-origin`), and
 * an Origin whose hostname `PLANNOTATOR_ALLOWED_HOSTS` names explicitly (a
 * plain-HTTP reverse proxy that rewrites Host; `*` does not count, see
 * `isOriginNamedInAllowedHosts`). GET, HEAD and OPTIONS are left to their
 * routes. The Pi mirror is apps/pi-extension/server/request-origin-guard.ts.
 */

import {
  crossOriginRefusalBody,
  isSameOriginOrNoOrigin,
  isStateChangingMethod,
} from "@plannotator/shared/request-origin";
import { ALLOWED_HOSTS_ENV, isOriginNamedInAllowedHosts, parseAllowedHosts } from "@plannotator/shared/request-host";

/**
 * Whether a request may change state: no Origin, the session's own origin,
 * the VS Code proxy, or an Origin named in PLANNOTATOR_ALLOWED_HOSTS (read on
 * each call).
 */
export function isSameOriginRequest(req: Request): boolean {
  const origin = req.headers.get("origin");
  const site = req.headers.get("sec-fetch-site");
  const host = req.headers.get("host") ?? new URL(req.url).host;
  if (isSameOriginOrNoOrigin(origin, host, site)) return true;
  return isOriginNamedInAllowedHosts(origin, site, parseAllowedHosts(process.env[ALLOWED_HOSTS_ENV]));
}

/** A 403 response when a state-changing request came from another site, else null. */
export function refuseCrossOriginWrite(req: Request): Response | null {
  if (!isStateChangingMethod(req.method)) return null;
  if (isSameOriginRequest(req)) return null;
  return Response.json(crossOriginRefusalBody(), { status: 403 });
}
