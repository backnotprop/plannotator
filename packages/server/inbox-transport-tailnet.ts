/**
 * The tailnet transport (inbox-transport.ts): HTTPS to the other Inbox's
 * device door at `https://<MagicDNS name>:8443/api/inbox/device/<route>`,
 * the door "Reach from my tailnet" publishes with `tailscale serve`. The
 * certificate is Tailscale's real one, so the default TLS check holds.
 *
 * Only a MagicDNS name (`<machine>.<tailnet>.ts.net`) over https is taken:
 * never another host, a bare IP or `localhost`, so a pasted code, an
 * `--address`, or a linked machine's `link-back` can never make this Inbox
 * send a pairing secret or a token off the tailnet. Plain `http://` to a
 * loopback host is taken only inside a test sandbox
 * (`PLANNOTATOR_TEST_SANDBOX`), where two Inboxes on one computer stand in
 * for two machines.
 */

import type { InboxDoorRequest, InboxPeerTransport, InboxTransportSpec } from "./inbox-transport";

const DOOR = "/api/inbox/device/";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** `<machine>.<tailnet>.ts.net`. */
const MAGIC_DNS = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.){2,}ts\.net$/i;

/** An address as the person or a pairing link gave it (`mini.tail1234.ts.net:8443`, or a URL), as the origin the link keeps; null when unusable. */
export function checkTailnetAddress(raw: string, env: Record<string, string | undefined> = process.env): string | null {
  const text = raw.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return null;
  if (url.protocol === "https:" && MAGIC_DNS.test(url.hostname)) return url.origin;
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname) && env.PLANNOTATOR_TEST_SANDBOX) return url.origin;
  return null;
}

export function tailnetTransport(spec: Extract<InboxTransportSpec, { kind: "tailnet" }>): InboxPeerTransport {
  const origin = spec.url;
  const url = (route: string, search: string) => `${origin}${DOOR}${route}${search}`;
  return {
    spec,
    request: (route: string, search: string, init: InboxDoorRequest) =>
      fetch(url(route, search), { method: init.method, headers: init.headers, body: init.body ?? undefined, signal: init.signal, redirect: "error" }),
    events: (headers: Record<string, string>, search: string, signal: AbortSignal) =>
      fetch(url("events", search), { method: "GET", headers: { Accept: "text/event-stream", ...headers }, signal, redirect: "error" }),
    describe: () => new URL(origin).host,
  };
}
