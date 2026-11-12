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
