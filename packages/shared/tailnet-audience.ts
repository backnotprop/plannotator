/**
 * Who sent a request to a `--tailscale` session. `tailscale serve` deletes incoming `Tailscale-User-Login` / `Tailscale-Headers-Info` / `Tailscale-Funnel-Request` and sets its own, and every proxied request carries `X-Forwarded-For`, so a request through serve can never look local. Host is never evidence.
 * `local`: no mark of serve. `owner`: through serve (not funnel), every `X-Forwarded-For` entry is a tailnet address, and the login owns this machine or is in `inboxTailscaleAllow`. `peer`: everything else.
 */

import { checkTailnetIdentity, normalizeTailnetLogin, TAILSCALE_FUNNEL_HEADER, TAILSCALE_LOGIN_HEADER } from "./inbox/tailnet";
import { isLoopbackForwardedFor } from "./loopback-host";

export type TailnetAudience = "local" | "owner" | "peer";

const SERVE_HEADERS = [TAILSCALE_LOGIN_HEADER, "tailscale-headers-info", TAILSCALE_FUNNEL_HEADER] as const;

export function cameThroughTailscaleServe(headers: Headers): boolean {
  if (SERVE_HEADERS.some((name) => headers.has(name))) return true;
  const forwardedFor = headers.get("x-forwarded-for");
  return forwardedFor !== null && !isLoopbackForwardedFor(forwardedFor);
}

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

export function forwardedForIsTailnet(headers: Headers): boolean {
  const value = headers.get("x-forwarded-for");
  if (value === null) return false;
  const entries = value.split(",").map(forwardedAddress).filter(Boolean);
  return entries.length > 0 && entries.every(isTailnetAddress);
}

/** Narrower than `cameThroughTailscaleServe`: a local reverse proxy forwarding a LAN client stays as it was in a session never published. Also catches a mapping left by a crashed `--tailscale` session pointing at a later local session on the same port. */
export function cameThroughTailscale(headers: Headers): boolean {
  if (SERVE_HEADERS.some((name) => headers.has(name))) return true;
  const value = headers.get("x-forwarded-for");
  return value !== null && value.split(",").map(forwardedAddress).some(isTailnetAddress);
}

/** Empty `ownerLogins`: nobody is the owner. */
export function tailnetAudience(headers: Headers, ownerLogins: readonly string[]): TailnetAudience {
  if (!cameThroughTailscaleServe(headers)) return "local";
  if (ownerLogins.length === 0 || !forwardedForIsTailnet(headers)) return "peer";
  return checkTailnetIdentity(headers, ownerLogins.map(normalizeTailnetLogin)).ok ? "owner" : "peer";
}
