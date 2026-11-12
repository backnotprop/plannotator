/** Refuses a read from another site: cross-site or same-site `Sec-Fetch-Site`, or an Origin naming another page. A request with neither header passes. */
import { isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";

// A remote agent is started, stopped or trusted only by a press in the Inbox window, never by a cross-site request.
export const INBOX_CROSS_SITE_BODY = { error: "Cross-origin requests are not accepted.", code: "cross_origin" } as const;
export const INBOX_WINDOW_ONLY_BODY = { error: "A folder is trusted in the Inbox window.", code: "window_only" } as const;
export const INBOX_MACHINE_WINDOW_ONLY_BODY = { error: "An agent on another machine is started, stopped or trusted from the Inbox window only.", code: "window_only" } as const;

export function isCrossSiteRequest(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (site === "cross-site" || site === "same-site") return true;
  return !isSameOriginOrNoOrigin(req.headers.get("origin"), req.headers.get("host") ?? "", site ?? null);
}

/** A write only a person's window may make: the page's own Origin, the same host as Host, and this run's `serverSession`. A tightening, not a secret. */
export function isWindowRequest(req: Request, body: Record<string, unknown>, serverSession: string): boolean {
  const from = req.headers.get("origin");
  let fromHost: string | null = null;
  try {
    fromHost = from ? new URL(from).host : null;
  } catch {
    fromHost = null;
  }
  return fromHost !== null && fromHost === (req.headers.get("host") ?? "") && body.serverSession === serverSession;
}
