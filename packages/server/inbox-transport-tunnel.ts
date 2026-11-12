/**
 * The tunnel transport (inbox-transport.ts): plain HTTP to a loopback port
 * the person forwards to the other Inbox's device door themselves
 * (`http://localhost:14433/api/inbox/device/<route>`, an `ssh -L` forward of
 * the port that Inbox's window answers on, where its door answers too).
 * Where the bytes then travel is entirely where the person pointed the
 * forward.
 *
 * Only `http` to a loopback host (`localhost`, `127.0.0.1`, `[::1]`) with an
 * explicit port is taken: never another host, another scheme, or a bare
 * loopback with no port, so a pasted code, an `--address`, a `--back` or a
 * linked machine's `link-back` can never make this Inbox send a pairing
 * secret or a token anywhere but its own loopback — wherever the forward
 * carries them is where the person pointed it.
 */

import type { InboxDoorRequest, InboxPeerTransport, InboxTransportSpec } from "./inbox-transport";

const DOOR = "/api/inbox/device/";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** An address as the person or a pairing link gave it (`localhost:14433`, or a URL), as the origin the link keeps; null when unusable. */
export function checkTunnelAddress(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    return null;
  }
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return null;
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname) || !url.port) return null;
  return url.origin;
}

export function tunnelTransport(spec: Extract<InboxTransportSpec, { kind: "tunnel" }>): InboxPeerTransport {
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
