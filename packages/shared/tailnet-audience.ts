/**
 * Who sent a request to a session published with `--tailscale` (#2166), for
 * "Ask this session", the one surface such a session keeps for this machine
 * and its owner only.
 *
 * A `--tailscale` session stays loopback-bound; `tailscale serve` proxies the
 * tailnet port to it. What serve guarantees (ipn/ipnlocal/serve.go, the
 * reasoning `inbox/tailnet.ts` records): every request it proxies carries
 * `X-Forwarded-For` with the peer's address, and before proxying it DELETES
 * any incoming `Tailscale-User-Login` / `Tailscale-Headers-Info` /
 * `Tailscale-Funnel-Request` and sets its own. So a request that came through
 * serve can never look local (it cannot shed those headers), and the login it
 * carries is the one Tailscale's own WhoIs gave. Host is never evidence: serve
 * passes the browser's Host through.
 *
 *  - `local`: no mark of serve. It reached the loopback port from this
 *    machine, the same as any local session (a local process could add the
 *    headers, but it can reach the port anyway).
 *  - `owner`: through serve, not funnel, `X-Forwarded-For` is a tailnet
 *    address (every entry in 100.64.0.0/10 or fd7a:115c:a1e0::/48, so a local
 *    reverse proxy that passes a client's headers on cannot make a forged
 *    login the owner), and the login is the one that owns this machine
 *    (`tailscale status --json`, Self.UserID -> LoginName).
 *  - `peer`: through serve and anything else (another login, a tagged device
 *    with no login, a funnel request, or an owner nobody could read).
 *
 * The same marks the Inbox's window port refuses (#1867: a local reverse
 * proxy that sends only loopback `X-Forwarded-For` reads as local).
 */

import { checkTailnetIdentity, normalizeTailnetLogin, TAILSCALE_FUNNEL_HEADER, TAILSCALE_LOGIN_HEADER } from "./inbox/tailnet";
import { isLoopbackForwardedFor } from "./loopback-host";

export type TailnetAudience = "local" | "owner" | "peer";

/** Headers only `tailscale serve` sets on a request it proxies (and deletes from what a client sent). */
const SERVE_HEADERS = [TAILSCALE_LOGIN_HEADER, "tailscale-headers-info", TAILSCALE_FUNNEL_HEADER] as const;

/** Whether a request carries a mark of `tailscale serve` (or of another proxy that forwards a non-loopback client). */
export function cameThroughTailscaleServe(headers: Headers): boolean {
  if (SERVE_HEADERS.some((name) => headers.has(name))) return true;
  const forwardedFor = headers.get("x-forwarded-for");
  return forwardedFor !== null && !isLoopbackForwardedFor(forwardedFor);
}

/** One `X-Forwarded-For` entry without brackets or a port. */
function forwardedAddress(entry: string): string {
  let host = entry.trim();
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    return close > 0 ? host.slice(1, close) : host;
  }
  // IPv4 with a port (100.64.0.1:51234); several colons is a bare IPv6 address.
  if (host.includes(":") && host.indexOf(":") === host.lastIndexOf(":")) host = host.slice(0, host.indexOf(":"));
  return host;
}

/** A Tailscale address: IPv4 100.64.0.0/10 (CGNAT, what Tailscale hands out) or IPv6 fd7a:115c:a1e0::/48. */
export function isTailnetAddress(address: string): boolean {
  const value = address.trim().toLowerCase();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return false;
    return octets[0] === 100 && (octets[1] as number) >= 64 && (octets[1] as number) <= 127;
  }
  return /^fd7a:115c:a1e0(?::|$)/.test(value) && /^[0-9a-f:]+$/.test(value);
}

/** Every `X-Forwarded-For` entry is a Tailscale address (and there is at least one). */
export function forwardedForIsTailnet(headers: Headers): boolean {
  const value = headers.get("x-forwarded-for");
  if (value === null) return false;
  const entries = value.split(",").map(forwardedAddress).filter(Boolean);
  return entries.length > 0 && entries.every(isTailnetAddress);
}

/**
 * Whether a request came through Tailscale (serve, or a mapping left behind by
 * a crashed `--tailscale` session pointing at a later local session on the
 * same port): one of serve's own headers, or an `X-Forwarded-For` entry that is
 * a Tailscale address. Narrower than `cameThroughTailscaleServe`: a local
 * reverse proxy forwarding a LAN client stays as it was in a session that was
 * never published.
 */
export function cameThroughTailscale(headers: Headers): boolean {
  if (SERVE_HEADERS.some((name) => headers.has(name))) return true;
  const value = headers.get("x-forwarded-for");
  return value !== null && value.split(",").map(forwardedAddress).some(isTailnetAddress);
}

/** Who a request is from, for a session whose machine is owned by `ownerLogin` (null: nobody could say). */
export function tailnetAudience(headers: Headers, ownerLogin: string | null): TailnetAudience {
  if (!cameThroughTailscaleServe(headers)) return "local";
  if (!ownerLogin || !forwardedForIsTailnet(headers)) return "peer";
  return checkTailnetIdentity(headers, [normalizeTailnetLogin(ownerLogin)]).ok ? "owner" : "peer";
}
