/**
 * The cheap cross-origin guard the servers' state-changing endpoints share: it runs on every POST, PUT, PATCH and DELETE before any route.
 * A request passes with no Origin (a non-browser client), an Origin naming the host it was sent to, or `Sec-Fetch-Site: same-origin` (set by the browser, not page script; keeps reverse proxies that rewrite Host working). It is refused when the browser marked it `cross-site` or `same-site`, and `Origin: null` never passes.
 * Pure and dependency-free.
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

export function isStateChangingMethod(method: string | null | undefined): boolean {
  const m = (method ?? "").toUpperCase();
  return m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";
}

export const CROSS_ORIGIN_REFUSED_CODE = "cross_origin";

export function crossOriginRefusalBody(): { ok: false; error: string; code: string } {
  return { ok: false, error: "Cross-origin requests are not allowed", code: CROSS_ORIGIN_REFUSED_CODE };
}
