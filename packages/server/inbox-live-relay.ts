/**
 * The prototype relay: a question's running-app prototype on the owner's
 * phone over the tailnet (approval "inbox-question-tradeoffs", the owner,
 * 2026-11-09: "Should serve the prototype so it's viewable on the phone").
 *
 * On this computer the window frames the app's live proxy (inbox-live.ts,
 * one loopback port per app origin, its own origin). A phone cannot reach a
 * loopback port, so through the tailnet the window frames this relay instead:
 * one more `tailscale serve` mapping, `https://<MagicDNS name>:<R>`, made on
 * the owner's first open (inbox-tailscale.ts `openRelay`, which checks the
 * Host and that the request is the machine's owner before anything here).
 *
 * The relay serves the app at its own root, so an app's absolute paths
 * (`/assets/app.js`) work. Which app it relays is chosen by an entry URL the
 * window gets from `GET .../live/:site` (owner only, same origin): it carries
 * a random key of that app's proxy, which the relay puts in a `__Host-`
 * cookie and redirects to the app's page. Every later request goes to the
 * proxy the cookie's key names; a key no running proxy has is refused. So
 * only the origins a question's `Prototype:` lines named (their proxies) are
 * ever relayed, and the URL checks, the reserved ports and the Plannotator
 * refusal stay the proxy's. One app at a time per browser: the window shows
 * one page at a time, and each open re-enters.
 *
 * What changes on the way: the proxy's `frame-ancestors` (the window's local
 * origins) becomes the window's tailnet origin; the bridge is served with the
 * window's tailnet origin as its editor; a loopback `Location` the proxy
 * wrote becomes a path on the relay. WebSockets on the app's own origin (a
 * dev server's hot reload, by default) are relayed too. An app that hard-codes
 * `ws://localhost:…` or another loopback address in its page cannot reach it
 * from a phone (and an https page may not open a ws:// socket): the page
 * shows what it renders without it.
 *
 * Guards: no request from another site (cross-site, or same-site, which
 * another machine of the tailnet shares) except a frame's navigation (the
 * entry, whose key only the owner's window was given, and the page it
 * redirects to); every HTML answer may be framed only by the window's
 * tailnet origin.
 */

import {
  composeLiveBridgeJs,
  HOP_BY_HOP_HEADERS,
  isHtmlContentType,
  LIVE_PROXY_BRIDGE_PATH,
  LIVE_PROXY_MAX_PENDING_WS_MESSAGES,
} from "@plannotator/shared/live-proxy-core";
import type { InboxLiveBridgeSources } from "./inbox-live";

/** The entry: `?k=<the proxy's relay key>&to=<the app's path and query>`. */
export const LIVE_RELAY_ENTER_PATH = "/__plannotator__/relay";
/** `__Host-`: Secure, Path=/, no Domain, so no other port or name can set or read it. */
export const LIVE_RELAY_COOKIE = "__Host-plannotator-relay";

/** A running proxy the relay may reach: the key the window got, the loopback port, the bridge token. */
export interface LiveRelaySite {
  port: number;
  token: string;
}

export interface LiveRelayOptions {
  /** The running proxy a relay key names (and keeps it from idling), or null. */
  siteByKey: (key: string) => LiveRelaySite | null;
  /** The window's tailnet origin, `https://<MagicDNS name>:<port>`, or null when not published. */
  windowOrigin: () => string | null;
  bridge: InboxLiveBridgeSources;
}

type RelaySocketData = {
  port: number;
  pathAndQuery: string;
  protocols: string | null;
  upstream: WebSocket | null;
  pending: (string | ArrayBuffer)[];
};

interface RelayServer {
  upgrade: (req: Request, options: { data: RelaySocketData }) => boolean;
}

interface RelaySocket {
  data: RelaySocketData;
  readyState: number;
  send: (data: string | ArrayBuffer) => void;
  close: () => void;
}

function text(status: number, message: string): Response {
  return new Response(`${message}\n`, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

function cookieKey(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === LIVE_RELAY_COOKIE) return part.slice(at + 1).trim() || null;
  }
  return null;
}

/** The Cookie header without the relay's own cookie (the app never sees it). */
function withoutRelayCookie(header: string | null): string | null {
  if (!header) return null;
  const kept = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${LIVE_RELAY_COOKIE}=`));
  return kept.length ? kept.join("; ") : null;
}

/** A path on this origin only: `/x`, never `//host` or a scheme. */
function safePath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value;
}

function toPayload(data: unknown): string | ArrayBuffer {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return data;
  if (data instanceof Uint8Array) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  return String(data);
}

/** The entry URL the window frames through the tailnet. */
export function liveRelayEnterUrl(relayOrigin: string, key: string, targetUrl: string): string {
  const target = new URL(targetUrl);
  return `${relayOrigin}${LIVE_RELAY_ENTER_PATH}?k=${encodeURIComponent(key)}&to=${encodeURIComponent(target.pathname + target.search)}`;
}

export function createLiveRelay(options: LiveRelayOptions) {
  const upstreams = new Set<WebSocket>();

  const fetchHandler = async (req: Request, server: unknown): Promise<Response | undefined> => {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return text(400, "Bad request.");
    }
    const site = req.headers.get("sec-fetch-site")?.trim().toLowerCase();
    // The app's page itself arrives same-site (its frame was navigated from the window's port, through the entry's
    // redirect); only a frame's navigation is let in that way, and an HTML answer may be framed by the window only.
    const frameLoad = req.headers.get("sec-fetch-mode")?.trim().toLowerCase() === "navigate" && req.headers.get("sec-fetch-dest")?.trim().toLowerCase() === "iframe";
    const fromElsewhere = site === "cross-site" || (site === "same-site" && !frameLoad);

    if (url.pathname === LIVE_RELAY_ENTER_PATH) {
      if (req.method !== "GET") return text(405, "Use GET.");
      // The window's wrapper page (the window's own port, so same-site) navigates its frame here; another site never.
      if (site === "cross-site") return text(403, "Requests from other sites are not accepted.");
      const key = url.searchParams.get("k") ?? "";
      if (!options.siteByKey(key)) return text(403, "This prototype is closed. Open it again from the Inbox.");
      return new Response(null, {
        status: 302,
        headers: {
          Location: safePath(url.searchParams.get("to")),
          "Set-Cookie": `${LIVE_RELAY_COOKIE}=${key}; Path=/; Secure; HttpOnly; SameSite=Strict`,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    }

    if (fromElsewhere) return text(403, "Requests from other sites are not accepted.");
    const key = cookieKey(req.headers.get("cookie"));
    const target = key ? options.siteByKey(key) : null;
    if (!target) return text(403, "This prototype is closed. Open it again from the Inbox.");
    const windowOrigin = options.windowOrigin();
    if (!windowOrigin) return text(403, "The Inbox is not published over your tailnet now.");

    if (url.pathname === LIVE_PROXY_BRIDGE_PATH) {
      if (req.method !== "GET" && req.method !== "HEAD") return text(405, "Use GET.");
      // The proxy's bridge names the window's local origins; through the tailnet its editor is the window's tailnet origin.
      const js = composeLiveBridgeJs({ token: target.token, editorOrigins: [windowOrigin], ...options.bridge, nested: true });
      return new Response(req.method === "HEAD" ? null : js, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" } });
    }

    if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
      const upgraded = (server as RelayServer).upgrade(req, {
        data: { port: target.port, pathAndQuery: url.pathname + url.search, protocols: req.headers.get("sec-websocket-protocol"), upstream: null, pending: [] },
      });
      return upgraded ? undefined : text(400, "WebSocket upgrade failed.");
    }

    // To the app's proxy, as this computer's window would ask it.
    const proxyHost = `127.0.0.1:${target.port}`;
    const headers = new Headers(req.headers);
    for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
    for (const name of ["tailscale-user-login", "tailscale-user-name", "tailscale-user-profile-pic", "tailscale-headers-info"]) headers.delete(name);
    headers.set("host", proxyHost);
    const cookie = withoutRelayCookie(req.headers.get("cookie"));
    if (cookie) headers.set("cookie", cookie);
    else headers.delete("cookie");
    let upstream: Response;
    try {
      upstream = await fetch(`http://${proxyHost}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
        redirect: "manual",
        decompress: false,
      } as RequestInit & { decompress: boolean });
    } catch {
      return text(502, "The prototype's app did not answer.");
    }
    const out = new Headers(upstream.headers);
    for (const name of HOP_BY_HOP_HEADERS) out.delete(name);
    const location = out.get("location");
    if (location) {
      for (const origin of [`http://127.0.0.1:${target.port}`, `http://localhost:${target.port}`]) {
        if (location === origin || location.startsWith(`${origin}/`)) {
          out.set("location", location.slice(origin.length) || "/");
          break;
        }
      }
    }
    // The proxy put the window's local origins here; through the tailnet the window is at its tailnet origin.
    if (isHtmlContentType(out.get("content-type"))) out.set("content-security-policy", `frame-ancestors ${windowOrigin}`);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  };

  const websocket = {
    open(ws: RelaySocket) {
      const protocols = ws.data.protocols ? ws.data.protocols.split(",").map((p) => p.trim()).filter(Boolean) : undefined;
      let upstream: WebSocket;
      try {
        upstream = protocols?.length ? new WebSocket(`ws://127.0.0.1:${ws.data.port}${ws.data.pathAndQuery}`, protocols) : new WebSocket(`ws://127.0.0.1:${ws.data.port}${ws.data.pathAndQuery}`);
      } catch {
        ws.close();
        return;
      }
      upstream.binaryType = "arraybuffer";
      ws.data.upstream = upstream;
      upstreams.add(upstream);
      upstream.addEventListener("open", () => {
        const queued = ws.data.pending;
        ws.data.pending = [];
        for (const payload of queued) upstream.send(payload);
      });
      upstream.addEventListener("message", (event) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(toPayload(event.data));
      });
      const end = () => {
        upstreams.delete(upstream);
        if (ws.readyState === WebSocket.OPEN) ws.close();
      };
      upstream.addEventListener("close", end);
      upstream.addEventListener("error", end);
    },
    message(ws: RelaySocket, raw: unknown) {
      const payload = toPayload(raw);
      const upstream = ws.data.upstream;
      if (upstream?.readyState === WebSocket.OPEN) {
        upstream.send(payload);
        return;
      }
      if (ws.data.pending.length >= LIVE_PROXY_MAX_PENDING_WS_MESSAGES) {
        ws.close();
        upstream?.close();
        return;
      }
      ws.data.pending.push(payload);
    },
    close(ws: RelaySocket) {
      ws.data.pending = [];
      const upstream = ws.data.upstream;
      ws.data.upstream = null;
      if (upstream) {
        upstreams.delete(upstream);
        upstream.close();
      }
    },
  };

  return {
    fetch: fetchHandler,
    websocket,
    stop() {
      for (const upstream of upstreams) upstream.close();
      upstreams.clear();
    },
  };
}
