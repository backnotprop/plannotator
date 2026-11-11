import {
  composeLiveBridgeJs,
  HOP_BY_HOP_HEADERS,
  isHtmlContentType,
  LIVE_PROXY_BRIDGE_PATH,
  LIVE_PROXY_MAX_PENDING_WS_MESSAGES,
} from "@plannotator/shared/live-proxy-core";
import type { InboxLiveBridgeSources } from "./inbox-live";

export const LIVE_RELAY_ENTER_PATH = "/__plannotator__/relay";
export const LIVE_RELAY_COOKIE = "__Host-plannotator-relay";

export interface LiveRelaySite {
  port: number;
  token: string;
}

export interface LiveRelayOptions {
  siteByKey: (key: string) => LiveRelaySite | null;
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
      const js = composeLiveBridgeJs({ token: target.token, editorOrigins: [windowOrigin], ...options.bridge, nested: true });
      return new Response(req.method === "HEAD" ? null : js, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" } });
    }

    if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
      const upgraded = (server as RelayServer).upgrade(req, {
        data: { port: target.port, pathAndQuery: url.pathname + url.search, protocols: req.headers.get("sec-websocket-protocol"), upstream: null, pending: [] },
      });
      return upgraded ? undefined : text(400, "WebSocket upgrade failed.");
    }

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
