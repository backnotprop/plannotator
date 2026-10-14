/**
 * A read route's refusal of another site: `Sec-Fetch-Site` says cross-site or
 * same-site (a page on another localhost port is the same site), or an Origin
 * names another page. A request with neither header (a non-browser client)
 * and the window's own page pass. Used by the Inbox's search and skills
 * routes; the attachment and message-image routes refuse the same way.
 */
import { isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";

export const INBOX_CROSS_SITE_BODY = { error: "Cross-origin requests are not accepted.", code: "cross_origin" } as const;

export function isCrossSiteRequest(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (site === "cross-site" || site === "same-site") return true;
  return !isSameOriginOrNoOrigin(req.headers.get("origin"), req.headers.get("host") ?? "", site ?? null);
}
