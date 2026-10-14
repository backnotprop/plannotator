/**
 * The cheap cross-origin guard the servers' state-changing endpoints share.
 * Every plan, review, annotate and goal-setup server (Bun and Pi) runs it on
 * every POST, PUT, PATCH and DELETE before any route (`isStateChangingMethod`),
 * and the Inbox on its window writes.
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
 * It is refused, whatever Origin says (present, absent or matching), when the
 * browser marked it `Sec-Fetch-Site: cross-site` or `same-site`: the browser
 * computed that from the page that sent it, and a page on another site (or on
 * another localhost port) is never the session's own. `Origin: null` (a
 * sandboxed frame, a file:// page) never passes either.
 *
 * Pure and dependency-free; vendored to Pi (generated/request-origin.ts).
 */
export function isSameOriginOrNoOrigin(
  originHeader: string | null | undefined,
  requestHost: string,
  fetchSite?: string | string[] | null,
): boolean {
  const site = (Array.isArray(fetchSite) ? fetchSite[0] : fetchSite)?.trim().toLowerCase();
  if (site === "cross-site" || site === "same-site") return false;
  if (!originHeader) return true;
  if (originHeader.trim() === "null") return false;
  if (site === "same-origin") return true;
  try {
    return new URL(originHeader).host === requestHost;
  } catch {
    return false;
  }
}

/**
 * Methods that change state. The servers refuse these from another site
 * before routing; GET, HEAD and OPTIONS are left to their routes.
 */
export function isStateChangingMethod(method: string | null | undefined): boolean {
  const m = (method ?? "").toUpperCase();
  return m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";
}

/** The machine-readable code a cross-origin refusal carries. */
export const CROSS_ORIGIN_REFUSED_CODE = "cross_origin";

/** The JSON body of a cross-origin refusal (status 403). */
export function crossOriginRefusalBody(): { ok: false; error: string; code: string } {
  return { ok: false, error: "Cross-origin requests are not allowed", code: CROSS_ORIGIN_REFUSED_CODE };
}
