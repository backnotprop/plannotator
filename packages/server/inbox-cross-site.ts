/**
 * A read route's refusal of another site: `Sec-Fetch-Site` says cross-site or
 * same-site (a page on another localhost port is the same site), or an Origin
 * names another page. A request with neither header (a non-browser client)
 * and the window's own page pass. Used by the Inbox's search and skills
 * routes; the attachment and message-image routes refuse the same way.
 */
import { isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";

export const INBOX_CROSS_SITE_BODY = { error: "Cross-origin requests are not accepted.", code: "cross_origin" } as const;
export const INBOX_WINDOW_ONLY_BODY = { error: "A folder is trusted in the Inbox window.", code: "window_only" } as const;

export function isCrossSiteRequest(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (site === "cross-site" || site === "same-site") return true;
  return !isSameOriginOrNoOrigin(req.headers.get("origin"), req.headers.get("host") ?? "", site ?? null);
}

/**
 * A write only a person's window may make (answering a permission prompt, trusting a folder): the page's own Origin,
 * the same host as its Host, and this run's `serverSession`. A browser window always sends both; an agent's bare
 * `curl`, an MCP client and the device door send neither. A tightening, not a secret: see "Accepted, not defended"
 * in docs/agent-guides/inbox-launch.md.
 */
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
