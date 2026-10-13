/**
 * The cheap cross-origin guard the servers' state-changing endpoints share
 * (config writes, review progress, guide share links, the CallDiff install).
 *
 * A browser attaches `Origin` to every cross-origin POST, including the
 * "simple" `text/plain` ones that skip a CORS preflight, so a page on another
 * site could otherwise write the user's config through a request the server
 * never sees as foreign. A request passes when:
 *  - it carries no Origin header (a non-browser client, which already has the
 *    user's own access);
 *  - its Origin names the host the request was sent to; or
 *  - the browser itself marked it `Sec-Fetch-Site: same-origin`. That header
 *    is set by the browser and cannot be set by page script, and it is what
 *    keeps a reverse proxy working: the VS Code extension's cookie proxy
 *    (apps/vscode-extension/src/cookie-proxy.ts) serves the page from its own
 *    origin and rewrites Host to this server's address, so Origin and Host
 *    differ although the page is the session's own.
 * `Origin: null` (a sandboxed frame, a file:// page) never passes, and
 * neither does `same-site` or `cross-site`.
 *
 * Pure and dependency-free; vendored to Pi (generated/request-origin.ts).
 */
export function isSameOriginOrNoOrigin(
  originHeader: string | null | undefined,
  requestHost: string,
  fetchSite?: string | string[] | null,
): boolean {
  if (!originHeader) return true;
  if (originHeader.trim() === "null") return false;
  const site = Array.isArray(fetchSite) ? fetchSite[0] : fetchSite;
  if (site?.trim().toLowerCase() === "same-origin") return true;
  try {
    return new URL(originHeader).host === requestHost;
  } catch {
    return false;
  }
}
