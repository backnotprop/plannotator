/** Bun adapter for the cross-origin write guard: runs right after the Host allowlist and refuses with 403 a state-changing request sent by a page on another site. Requests with no Origin (non-browser clients), the session's own page and the VS Code proxy pass. */

import {
  crossOriginRefusalBody,
  isSameOriginOrNoOrigin,
  isStateChangingMethod,
} from "@plannotator/shared/request-origin";
import { ALLOWED_HOSTS_ENV, isOriginNamedInAllowedHosts, parseAllowedHosts } from "@plannotator/shared/request-host";

export function isSameOriginRequest(req: Request): boolean {
  const origin = req.headers.get("origin");
  const site = req.headers.get("sec-fetch-site");
  const host = req.headers.get("host") ?? new URL(req.url).host;
  if (isSameOriginOrNoOrigin(origin, host, site)) return true;
  return isOriginNamedInAllowedHosts(origin, site, parseAllowedHosts(process.env[ALLOWED_HOSTS_ENV]));
}

export function refuseCrossOriginWrite(req: Request): Response | null {
  if (!isStateChangingMethod(req.method)) return null;
  if (isSameOriginRequest(req)) return null;
  return Response.json(crossOriginRefusalBody(), { status: 403 });
}
