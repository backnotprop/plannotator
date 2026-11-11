/** Redirects a top-level navigation of `/` on another loopback spelling to one canonical origin, so notification permission and cookies stay in one place. */

import { loadConfig, resolveLocalUrlHostname } from "@plannotator/shared/config";
import { isLoopbackHostHeader } from "@plannotator/shared/loopback-host";

export const INBOX_CANONICAL_HOSTNAME = "localhost";

/** The Inbox's one address on this computer, read once at start. */
export function inboxCanonicalBaseUrl(port: number): string {
  return `http://${resolveLocalUrlHostname(loadConfig()) ?? INBOX_CANONICAL_HOSTNAME}:${port}/`;
}

/** The redirect for a top-level navigation of `/` that reached this port by another loopback spelling, or null. */
export function inboxCanonicalRedirect(req: Request, url: URL, canonicalBaseUrl: string, via: "local" | "tailnet"): Response | null {
  if (via !== "local") return null;
  if (req.method !== "GET" || url.pathname !== "/") return null;
  if (req.headers.get("sec-fetch-mode") !== "navigate" || req.headers.get("sec-fetch-dest") !== "document") return null;
  const target = new URL(canonicalBaseUrl);
  const port = Number(target.port);
  const host = req.headers.get("host");
  if (!host || !isLoopbackHostHeader(host, port, target.hostname)) return null;
  if (target.host === host.trim().toLowerCase()) return null;
  return new Response(null, {
    status: 307,
    headers: {
      Location: `${target.href}${url.search}`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
