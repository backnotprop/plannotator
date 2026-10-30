/**
 * One origin for the Inbox window.
 *
 * A browser keeps its notification permission (and cookies and storage) per
 * origin, and `http://127.0.0.1:<port>` and `http://localhost:<port>` are two
 * origins for the same server. The Inbox advertises and opens localhost by
 * default, or the configured *.localhost hostname, so its links and window
 * use the same notification permission and preference cookies. A page loaded
 * at another loopback spelling of THIS port (`127.x.y.z`, `[::1]`, localhost)
 * is sent to that canonical address.
 *
 * Only a browser's top-level navigation to `/` is redirected (`Sec-Fetch-Mode:
 * navigate` and `Sec-Fetch-Dest: document`), so APIs, the event stream, the
 * device door, MCP, connection routes and any client without fetch metadata
 * (curl, the tests' fetches) are answered where they asked. The tailnet
 * listener never gets here (its requests carry `via: "tailnet"`), and any name
 * that is not a loopback literal (`inbox.plannotator.localhost`, a
 * `PLANNOTATOR_ALLOWED_HOSTS` name) is left alone, so a proxy that rewrites
 * Host to a name never loops. The fragment (`#thread=…`) is kept by the
 * browser across the redirect; the query is carried in `Location`. 307 and
 * `no-store`: never cached, since another server may hold this port later.
 */

import { loadConfig, resolveLocalUrlHostname } from "@plannotator/shared/config";
import { isLoopbackHostHeader } from "@plannotator/shared/loopback-host";

/** The hostname the Inbox opens when no localhost subdomain is configured. */
export const INBOX_CANONICAL_HOSTNAME = "localhost";

/**
 * `http://localhost:<port>/`, or `http://<name>:<port>/` when `urlHost` /
 * PLANNOTATOR_URL_HOST names a localhost subdomain (`plannotator.localhost`,
 * #2184): the Inbox's one address on this computer. Any other url host (a
 * tailnet name, an IP) is for remote sessions and never changes it. The
 * Inbox reads it once at start, for its registry, links and redirect.
 */
export function inboxCanonicalBaseUrl(port: number): string {
  return `http://${resolveLocalUrlHostname(loadConfig()) ?? INBOX_CANONICAL_HOSTNAME}:${port}/`;
}

/**
 * The redirect for a top-level navigation of `/` that reached this port by
 * another loopback spelling (`127.x.y.z`, `[::1]`, and `localhost` when a
 * subdomain is configured), or null to answer the request as it is.
 * `canonicalBaseUrl` is the start-time address (inboxCanonicalBaseUrl), so a
 * config change while the Inbox runs never moves its window.
 */
export function inboxCanonicalRedirect(req: Request, url: URL, canonicalBaseUrl: string, via: "local" | "tailnet"): Response | null {
  if (via !== "local") return null;
  if (req.method !== "GET" || url.pathname !== "/") return null;
  if (req.headers.get("sec-fetch-mode") !== "navigate" || req.headers.get("sec-fetch-dest") !== "document") return null;
  const target = new URL(canonicalBaseUrl);
  const port = Number(target.port);
  const host = req.headers.get("host");
  // Only the plain loopback names and the configured subdomain: any other
  // name (another *.localhost, a proxy's own) is answered where it asked.
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
