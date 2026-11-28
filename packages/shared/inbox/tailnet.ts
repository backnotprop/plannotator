/**
 * Plannotator Inbox over the tailnet: the pure checks every request that
 * arrives through `tailscale serve` passes before the window's own routes
 * (packages/server/inbox-tailscale.ts runs them on the tailnet listener).
 *
 * What `tailscale serve` guarantees (ipn/ipnlocal/serve.go,
 * `addTailscaleIdentityHeaders`): before proxying it DELETES any incoming
 * `Tailscale-User-Login`, `-Name`, `-Profile-Pic`, `Tailscale-Funnel-Request`
 * and `Tailscale-Headers-Info`, then sets the login of the peer that opened
 * the connection (Tailscale's own WhoIs on the source address), so a client
 * cannot forge them through serve. A tagged peer gets no identity headers; a
 * funnel request gets `Tailscale-Funnel-Request: ?1` and no identity. The
 * client's own Host header is passed through untouched (the handler is
 * chosen by TLS SNI), so Host is never evidence of where a request came from.
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

/** A refusal names the login Tailscale gave (`login`) when there was one, for the refusal page. */
export type TailnetCheck = { ok: true; login: string } | { ok: false; status: number; code: TailnetRefusalCode; message: string; login?: string };

/** Logins compare case-insensitively (Tailscale logins are e-mail-like). */
export function normalizeTailnetLogin(login: string): string {
  return login.trim().toLowerCase();
}

/**
 * Who sent a request through serve, and whether they may use the Inbox:
 * only a login in `allowed` (the machine's owner; on a tagged machine, which
 * has none, the logins config.json `inboxTailscaleAllow` names as its owner;
 * already normalized). No login means a tagged peer
 * (or a request that did not come through serve): refused. A funnel request
 * is refused whatever it carries, since the Inbox never publishes publicly.
 */
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
      login: decoded.trim(),
      message: `This Inbox opens only for the Tailscale account that owns this computer; ${decoded.trim()} is not that account.`,
    };
  }
  return { ok: true, login };
}

/**
 * The Host a browser sends through serve: the served MagicDNS name with the
 * HTTPS port (a browser omits only the default 443, which the Inbox never
 * uses, so the port must be there and must match).
 */
export function isServedTailnetHost(hostHeader: string | null, servedHostname: string, httpsPort: number): boolean {
  if (!hostHeader) return false;
  const value = hostHeader.trim().toLowerCase();
  const colon = value.lastIndexOf(":");
  if (colon < 0) return false;
  const name = value.slice(0, colon).replace(/\.$/, "");
  const port = value.slice(colon + 1);
  return name === servedHostname.toLowerCase() && /^\d{1,5}$/.test(port) && Number(port) === httpsPort;
}

/**
 * Whether a request that came through serve was opened by this computer itself (a browser here on the tailnet
 * address). Serve sets `X-Forwarded-For` to the connection's source address and never passes a client's own on
 * (ipn/ipnlocal/serve.go, `addProxyForwardedHeaders` with `Header.Set`, inside a `httputil.ReverseProxy`
 * `Rewrite`, which drops any incoming `X-Forwarded-*` first). It is the very address serve's WhoIs reads for
 * `Tailscale-User-Login`, so it is as sure as the owner check: a connection from this computer's own node (its
 * kernel listener on the node's address, used exactly for "connections from the machine itself") carries one of
 * its own addresses (`selfAddresses`, `Self.TailscaleIPs`). Anything else (no header, several, another address)
 * is not this computer.
 */
export function fromOwnTailnetNode(headers: Headers, selfAddresses: readonly string[]): boolean {
  const raw = headers.get("x-forwarded-for");
  if (raw === null || raw.includes(",")) return false;
  let address = raw.trim().toLowerCase();
  if (address.startsWith("::ffff:") && address.includes(".")) address = address.slice("::ffff:".length);
  return address !== "" && selfAddresses.includes(address);
}

/**
 * The tailnet identity is ambient, like a cookie: any page the owner opens
 * on another device could make their browser send a request here. Such a
 * page's requests carry `Sec-Fetch-Site: cross-site` (or `same-site` from
 * another machine of the same tailnet, which shares the `*.ts.net` site), so
 * they are refused, except:
 *  - a top-level navigation (a link to the Inbox opens it; the page then
 *    loads its data same-origin);
 *  - GETs of the attachment HTML asset route, which an attached page drawn
 *    in a sandboxed srcdoc frame (an opaque origin) loads cross-site by
 *    construction, behind its unguessable per-folder token; and the same
 *    route of a linked machine through the forward
 *    (`isForwardedHtmlAssetPath`), for its attached page, behind that
 *    machine's token.
 * Absent header (a non-browser client, or an older browser): allowed; the
 * state-changing routes still check Origin.
 */
export function tailnetFetchSiteAllowed(method: string, path: string, headers: Headers): boolean {
  const site = headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (site !== "cross-site" && site !== "same-site") return true;
  const read = method === "GET" || method === "HEAD";
  if (read && headers.get("sec-fetch-mode")?.trim().toLowerCase() === "navigate" && path === "/") return true;
  if (read && (path.startsWith("/api/html-assets/") || isForwardedHtmlAssetPath(path))) return true;
  return false;
}

/** The forward's HTML asset route: `/api/inbox/m/<machine id>/html-assets/…`, nothing else under the forward. */
const FORWARDED_HTML_ASSET = /^\/api\/inbox\/m\/ibx_[0-9A-HJKMNP-TV-Z]{26}\/html-assets\//;

/**
 * Whether `path` is a linked machine's HTML asset route through this Inbox's forward. An attached page from that
 * machine (in its own tab, or the viewer's frame) is a sandboxed document with an opaque origin, so it loads its
 * folder cross-site by construction, as a local page loads `/api/html-assets/`; the far machine's unguessable
 * per-folder token guards it the same way.
 */
export function isForwardedHtmlAssetPath(path: string): boolean {
  return FORWARDED_HTML_ASSET.test(path);
}
