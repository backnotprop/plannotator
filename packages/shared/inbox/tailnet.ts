/**
 * Checks every request arriving through `tailscale serve` passes before the window's routes.
 * `tailscale serve` deletes any incoming `Tailscale-User-*` and `Tailscale-Funnel-Request` headers, then sets the login of the peer that opened the connection, so a client cannot forge them. A tagged peer gets no identity headers; a funnel request gets `Tailscale-Funnel-Request: ?1`. The client's Host header passes through untouched (the handler is chosen by TLS SNI), so Host is never evidence of where a request came from.
 */

import { decodeTailscaleHeaderValue } from "../tailscale";

export const TAILSCALE_LOGIN_HEADER = "tailscale-user-login";
export const TAILSCALE_FUNNEL_HEADER = "tailscale-funnel-request";

export type TailnetRefusalCode =
  | "tailnet_funnel_refused"
  | "tailnet_identity_required"
  | "tailnet_identity_refused"
  | "forbidden_host"
  | "cross_site";

export type TailnetCheck = { ok: true; login: string } | { ok: false; status: number; code: TailnetRefusalCode; message: string };

export function normalizeTailnetLogin(login: string): string {
  return login.trim().toLowerCase();
}

/** Only a login in `allowed` may use the Inbox. No login (a tagged peer, or a request not through serve) is refused, and so is any funnel request: the Inbox never publishes publicly. */
export function checkTailnetIdentity(headers: Headers, allowed: readonly string[]): TailnetCheck {
  if (headers.has(TAILSCALE_FUNNEL_HEADER)) {
    return { ok: false, status: 403, code: "tailnet_funnel_refused", message: "The Inbox is never published to the internet (tailscale funnel)." };
  }
  const raw = headers.get(TAILSCALE_LOGIN_HEADER);
  const decoded = raw === null ? null : decodeTailscaleHeaderValue(raw);
  if (decoded === null || decoded.trim() === "") {
    return {
      ok: false,
      status: 403,
      code: "tailnet_identity_required",
      message: "This Inbox answers only its owner's Tailscale login, and this request carries none (a tagged device, or not through tailscale serve).",
    };
  }
  const login = normalizeTailnetLogin(decoded);
  if (!allowed.includes(login)) {
    return {
      ok: false,
      status: 403,
      code: "tailnet_identity_refused",
      message: `This Inbox answers only its owner's Tailscale login; ${decoded.trim()} is not allowed. Add it to inboxTailscaleAllow in config.json to let it in.`,
    };
  }
  return { ok: true, login };
}

/** The Host a browser sends through serve: the MagicDNS name with the HTTPS port (a browser omits only the default 443, which the Inbox never uses). */
export function isServedTailnetHost(hostHeader: string | null, servedHostname: string, httpsPort: number): boolean {
  if (!hostHeader) return false;
  const value = hostHeader.trim().toLowerCase();
  const colon = value.lastIndexOf(":");
  if (colon < 0) return false;
  const name = value.slice(0, colon).replace(/\.$/, "");
  const port = value.slice(colon + 1);
  return name === servedHostname.toLowerCase() && /^\d{1,5}$/.test(port) && Number(port) === httpsPort;
}

/** The tailnet identity is ambient, like a cookie, so cross-site requests (`Sec-Fetch-Site: cross-site`, or `same-site` from another machine on the tailnet) are refused, except top-level navigations and GETs of the attachment HTML asset route (a sandboxed srcdoc frame loads it cross-site, behind an unguessable per-folder token). An absent header (a non-browser client) is allowed; state-changing routes still check Origin. */
export function tailnetFetchSiteAllowed(method: string, path: string, headers: Headers): boolean {
  const site = headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (site !== "cross-site" && site !== "same-site") return true;
  const read = method === "GET" || method === "HEAD";
  if (read && headers.get("sec-fetch-mode")?.trim().toLowerCase() === "navigate" && path === "/") return true;
  if (read && path.startsWith("/api/html-assets/")) return true;
  return false;
}
