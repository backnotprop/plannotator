// packages/server/preview-proxy.ts
import { isLoopbackUrl } from "@plannotator/shared/url-to-markdown";
import { buildLivePreviewInjection } from "@plannotator/ui/components/html-viewer/livePreviewInjection";

export interface PreviewProxy {
  /** The proxy's own base origin, e.g. "http://localhost:53211". */
  origin: string;
  stop: () => void;
}

/** Per-connection state for a proxied HMR WebSocket. */
interface PreviewWsData {
  path: string;
  protocol: string;
  /** Upstream socket to the dev server (opened on `open`). */
  up?: WebSocket;
  /** Messages received before the upstream socket is open. */
  queue: (string | ArrayBufferLike | Uint8Array)[];
}

export function parseTarget(target: string): { httpBase: string; wsBase: string; host: string } {
  if (!isLoopbackUrl(target)) {
    throw new Error(`Live preview target must be a loopback URL, got: ${target}`);
  }
  const u = new URL(target);
  const host = u.host; // includes port
  return {
    httpBase: `${u.protocol}//${host}`,
    wsBase: `${u.protocol === "https:" ? "wss:" : "ws:"}//${host}`,
    host,
  };
}

export function rewriteRequestHeaders(
  incoming: Headers,
  targetHost: string,
  httpBase: string,
  pathname: string,
): Headers {
  const h = new Headers(incoming);
  h.set("host", targetHost);
  if (h.has("origin")) h.set("origin", httpBase);
  if (h.has("referer")) h.set("referer", httpBase + pathname);
  // We decode upstream bodies; drop conditional/range so we always get full HTML to inject into.
  h.delete("if-none-match");
  h.delete("if-modified-since");
  return h;
}

export function injectBridge(html: string, block: string): string {
  if (html.includes("<head>")) return html.replace("<head>", "<head>" + block);
  return block + html;
}

/**
 * Start a per-session reverse proxy in front of a loopback dev server.
 * Forwards HTTP + the HMR WebSocket, and injects the annotation bridge into
 * HTML responses. Bound to 127.0.0.1 (host-only). Throws on a non-loopback target.
 */
export async function startPreviewProxy(target: string): Promise<PreviewProxy> {
  const { httpBase, wsBase, host } = parseTarget(target);
  const block = buildLivePreviewInjection();

  const server = Bun.serve<PreviewWsData>({
    hostname: "127.0.0.1",
    port: 0, // ephemeral
    async fetch(req, srv) {
      const inUrl = new URL(req.url);

      // HMR WebSocket passthrough.
      if ((req.headers.get("upgrade") || "").toLowerCase() === "websocket") {
        const ok = srv.upgrade(req, {
          data: {
            path: inUrl.pathname + inUrl.search,
            protocol: req.headers.get("sec-websocket-protocol") || "",
            queue: [],
          },
        });
        return ok ? undefined : new Response("ws upgrade failed", { status: 400 });
      }

      const outUrl = httpBase + inUrl.pathname + inUrl.search;
      const headers = rewriteRequestHeaders(req.headers, host, httpBase, inUrl.pathname);

      let upstream: Response;
      try {
        upstream = await fetch(outUrl, {
          method: req.method,
          headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
          redirect: "manual", // never follow a redirect off the loopback origin
        });
      } catch {
        return new Response("Live preview: dev server unreachable", { status: 502 });
      }

      const respHeaders = new Headers(upstream.headers);
      respHeaders.delete("content-encoding");
      respHeaders.delete("content-length");

      // Only follow same-origin (loopback) redirects; strip cross-origin Location.
      const loc = respHeaders.get("location");
      if (loc) {
        try {
          const abs = new URL(loc, httpBase);
          if (abs.host !== host) respHeaders.delete("location");
        } catch { respHeaders.delete("location"); }
      }

      const ct = upstream.headers.get("content-type") || "";
      if (ct.includes("text/html")) {
        const html = await upstream.text();
        return new Response(injectBridge(html, block), { status: upstream.status, headers: respHeaders });
      }
      return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
    },
    websocket: {
      open(ws) {
        const { path, protocol } = ws.data;
        const protos = protocol ? protocol.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
        const up = protos ? new WebSocket(wsBase + path, protos) : new WebSocket(wsBase + path);
        ws.data.up = up;
        up.onopen = () => {
          for (const m of ws.data.queue) up.send(m as string);
          ws.data.queue.length = 0;
        };
        up.onmessage = (e) => { try { ws.send(e.data); } catch {} };
        up.onclose = () => { try { ws.close(); } catch {} };
        up.onerror = () => {};
      },
      message(ws, message) {
        const up = ws.data.up;
        if (up && up.readyState === 1) up.send(message as string);
        else ws.data.queue.push(message);
      },
      close(ws) { try { ws.data.up?.close(); } catch {} },
    },
  });

  return {
    origin: `http://localhost:${server.port}`,
    stop: () => server.stop(true),
  };
}
