import type { InboxDoorRequest, InboxPeerTransport, InboxTransportSpec } from "./inbox-transport";

const DOOR = "/api/inbox/device/";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAGIC_DNS = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.){2,}ts\.net$/i;

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
