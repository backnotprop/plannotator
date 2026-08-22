/**
 * Loopback reverse proxy for live local app annotation — Bun transport.
 *
 * Mirrors the whole target origin (a local dev server) on a dedicated
 * loopback port and injects the annotation bridge into every HTML response,
 * so the editor can frame the user's own running app and drive the same
 * pinpoint annotation experience the srcdoc surface provides.
 *
 * Every DECISION here (Host/Origin validation, injector state machine,
 * CSP/X-Frame-Options policy, redirect rewrite, WS origin gate) lives in
 * @plannotator/shared/live-proxy-core, shared byte-for-byte with the Node
 * transport the Pi extension runs (packages/shared/live-proxy-node.ts).
 * This file is only the Bun.serve plumbing around those decisions.
 *
 * Security posture (binding is the contract, not a default):
 * - Binds 127.0.0.1 UNCONDITIONALLY. Never the shared env-dependent hostname
 *   helper, never any other interface. A proxy bound beyond loopback would
 *   relay the user's authenticated dev app to the network.
 * - Validates the Host header before touching upstream (blunts DNS
 *   rebinding).
 * - Strips app CSP on HTML and replaces it with a frame-ancestors policy
 *   listing exactly the editor origins, which simultaneously defeats app
 *   anti-framing headers and prevents hostile sites from framing the proxy.
 * - PLANNOTATOR_URL_HOST / buildAdvertisedUrl are never applied to the proxy
 *   origin.
 */

import {
  HOP_BY_HOP_HEADERS,
  LIVE_PROXY_BRIDGE_PATH,
  LIVE_PROXY_MAX_PENDING_WS_MESSAGES,
  LIVE_PROXY_RESERVED_PREFIX,
  applyHtmlFramingHeaders,
  buildFrameAncestorsPolicy,
  createHtmlInjector,
  isAllowedBridgeFetchSite,
  isAllowedProxyHost,
  isAllowedWsUpgradeOrigin,
  isDocumentIntentRequest,
  isHtmlContentType,
  rewriteLoopbackLocation,
  type LiveAppProxy,
  type LiveAppProxyOptions,
} from "@plannotator/shared/live-proxy-core";

// Re-export the shared decisions under their historical names: this module
// is the import site for the Bun CLI (annotate-resolution.ts), the annotate
// server, and the transport test suite.
export {
  LIVE_PROXY_BRIDGE_PATH,
  LIVE_PROXY_RESERVED_PREFIX,
  createHtmlInjector,
  isAllowedProxyHost,
  isAllowedProxyOrigin,
  isDocumentIntentRequest,
  isLoopbackHostname,
  rewriteLoopbackLocation,
  type LiveAppProxy,
  type LiveAppProxyOptions,
} from "@plannotator/shared/live-proxy-core";

// The literal loopback address is the security contract (see header).
const LOOPBACK_HOST = "127.0.0.1";

type LiveProxySocketData = {
  upstream: WebSocket | null;
  pending: (string | ArrayBuffer)[];
  pathAndQuery: string;
  protocols: string | null;
};

function stripHopByHop(headers: Headers): void {
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
}

function toWebSocketPayload(data: unknown): string | ArrayBuffer {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return data;
  if (Buffer.isBuffer(data)) {
    return Uint8Array.from(data).buffer;
  }
  if (data instanceof Uint8Array) {
    return data.buffer instanceof ArrayBuffer
      ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      : Uint8Array.from(data).buffer;
  }
  return String(data);
}

/**
 * Start the loopback reverse proxy for one live annotate session.
 * The caller owns its lifecycle: stop() closes tracked WS upstreams and the
 * listener.
 */
export function startLiveAppProxy(opts: LiveAppProxyOptions): LiveAppProxy {
  const target = new URL(opts.targetUrl);
  if (target.protocol !== "http:") {
    throw new Error("Live app proxy supports http upstreams only.");
  }
  const targetOrigin = target.origin;
  const targetHost = target.host;
  const frameAncestors = buildFrameAncestorsPolicy(opts.editorOrigins);
  const wsUpstreams = new Set<WebSocket>();
  let warnedEncodedHtml = false;

  const server = Bun.serve<LiveProxySocketData>({
    // The literal loopback address is the security contract (see header).
    hostname: LOOPBACK_HOST,
    port: 0,
    idleTimeout: 0,

    async fetch(req, srv) {
      // Host validation FIRST, before req.url is even parsed: an HTTP/1.0
      // request with no Host header leaves req.url a bare "/", and letting
      // `new URL` throw on it hands the client Bun's ~67KB internal error
      // page (stack trace and all) from a port whose whole contract is that
      // it refuses anything not naming this loopback proxy. The invariant is
      // "Host validation runs before any upstream contact" for ALL inputs,
      // well-formed or not.
      if (!isAllowedProxyHost(req.headers.get("host"), srv.port!)) {
        return new Response("Forbidden", { status: 403, headers: { "Content-Type": "text/plain" } });
      }

      // A Host that passed the check should always yield a parseable URL, but
      // parsing must not be the thing that decides: an unparseable request
      // takes the same refusal path rather than any error page.
      let url: URL;
      try {
        url = new URL(req.url);
      } catch {
        return new Response("Forbidden", { status: 403, headers: { "Content-Type": "text/plain" } });
      }

      // Reserved namespace: never forwarded upstream.
      if (url.pathname.startsWith(LIVE_PROXY_RESERVED_PREFIX)) {
        if (url.pathname === LIVE_PROXY_BRIDGE_PATH && (req.method === "GET" || req.method === "HEAD")) {
          // The bridge body embeds the per-session token; only same-origin
          // includes and direct navigation may fetch it (see
          // isAllowedBridgeFetchSite in live-proxy-core).
          if (!isAllowedBridgeFetchSite(req.headers.get("sec-fetch-site"))) {
            return new Response("Forbidden", { status: 403, headers: { "Content-Type": "text/plain" } });
          }
          return new Response(req.method === "HEAD" ? null : opts.bridgeJs, {
            headers: {
              "Content-Type": "text/javascript; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        }
        return new Response("Not found", { status: 404 });
      }

      // WebSocket passthrough (HMR): upgrade after Host validation. The
      // Origin gate keeps a hostile page's cross-site connect from being
      // laundered into the origin-less shape dev servers trust (see
      // isAllowedWsUpgradeOrigin in live-proxy-core).
      if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
        if (!isAllowedWsUpgradeOrigin(req.headers.get("origin"), srv.port!)) {
          return new Response("Forbidden", { status: 403, headers: { "Content-Type": "text/plain" } });
        }
        const upgraded = srv.upgrade(req, {
          data: {
            upstream: null,
            pending: [],
            pathAndQuery: url.pathname + url.search,
            protocols: req.headers.get("sec-websocket-protocol"),
          },
        });
        if (upgraded) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // Whole-origin forward.
      const upstreamUrl = targetOrigin + url.pathname + url.search;
      const upstreamHeaders = new Headers(req.headers);
      stripHopByHop(upstreamHeaders);
      upstreamHeaders.set("host", targetHost);
      upstreamHeaders.set("x-forwarded-host", req.headers.get("host") ?? "");
      upstreamHeaders.set("x-forwarded-proto", "http");
      if (isDocumentIntentRequest(req.headers)) {
        // HTML must arrive decodable for injection; assets keep encoding.
        // "identity" rather than a bare delete: Bun's outbound fetch would
        // otherwise re-add its own Accept-Encoding default.
        upstreamHeaders.set("accept-encoding", "identity");
      }

      let upstreamResponse: Response;
      try {
        upstreamResponse = await fetch(upstreamUrl, {
          method: req.method,
          headers: upstreamHeaders,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
          // The app's redirects reach the browser; loopback-absolute
          // Locations on the target origin are rewritten to the proxy below.
          redirect: "manual",
          // Relay bodies byte-identically: transparent decompression would
          // corrupt encoded passthrough (decoded bytes under an encoding
          // header).
          decompress: false,
        } as RequestInit & { decompress: boolean });
      } catch (err) {
        return new Response(
          `Live app upstream unreachable: ${err instanceof Error ? err.message : String(err)}`,
          { status: 502, headers: { "Content-Type": "text/plain" } },
        );
      }

      const responseHeaders = new Headers(upstreamResponse.headers);
      stripHopByHop(responseHeaders);

      const location = responseHeaders.get("location");
      if (location) {
        const rewritten = rewriteLoopbackLocation(
          location,
          target,
          `http://${LOOPBACK_HOST}:${srv.port}`,
        );
        if (rewritten !== null) responseHeaders.set("location", rewritten);
      }

      const isHtml = isHtmlContentType(responseHeaders.get("content-type"));

      if (isHtml) {
        // Decided posture: drop any app CSP on HTML and replace it with our
        // frame-ancestors policy; non-HTML responses keep their CSP and
        // X-Frame-Options (see applyHtmlFramingHeaders in live-proxy-core).
        applyHtmlFramingHeaders(responseHeaders, frameAncestors);
      }

      const hasEncoding = !!responseHeaders.get("content-encoding");
      if (!isHtml || hasEncoding || !upstreamResponse.body) {
        if (isHtml && hasEncoding && !warnedEncodedHtml) {
          // Fail open on rendering, closed on injection: the page renders,
          // annotation does not attach on it.
          warnedEncodedHtml = true;
          console.error(
            "[plannotator] Live app proxy: upstream returned content-encoded HTML despite the Accept-Encoding strip; the annotation bridge was not injected.",
          );
        }
        return new Response(upstreamResponse.body, {
          status: upstreamResponse.status,
          headers: responseHeaders,
        });
      }

      // Streaming injection of the bridge script tag.
      responseHeaders.delete("content-length");
      const injector = createHtmlInjector(
        `<script src="${LIVE_PROXY_BRIDGE_PATH}"></script>`,
      );
      const upstreamBody = upstreamResponse.body;
      const injected = new ReadableStream<Uint8Array>({
        async start(controller) {
          const reader = upstreamBody.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              for (const part of injector.push(value)) {
                if (part.length) controller.enqueue(part);
              }
            }
            for (const part of injector.flush()) {
              if (part.length) controller.enqueue(part);
            }
            controller.close();
          } catch (err) {
            controller.error(err);
          }
        },
        cancel(reason) {
          void upstreamBody.cancel(reason).catch(() => {});
        },
      });

      return new Response(injected, {
        status: upstreamResponse.status,
        headers: responseHeaders,
      });
    },

    websocket: {
      open(ws) {
        const wsUrl = `ws://${targetHost}${ws.data.pathAndQuery}`;
        const protocols = ws.data.protocols
          ? ws.data.protocols.split(",").map((p) => p.trim()).filter(Boolean)
          : undefined;
        let upstream: WebSocket;
        try {
          upstream = protocols && protocols.length
            ? new WebSocket(wsUrl, protocols)
            : new WebSocket(wsUrl);
        } catch {
          ws.close();
          return;
        }
        ws.data.upstream = upstream;
        wsUpstreams.add(upstream);

        upstream.addEventListener("open", () => {
          const queued = ws.data.pending;
          ws.data.pending = [];
          for (const payload of queued) upstream.send(payload);
        });

        upstream.addEventListener("message", (event) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(toWebSocketPayload(event.data));
          }
        });

        upstream.addEventListener("close", () => {
          wsUpstreams.delete(upstream);
          if (ws.readyState === WebSocket.OPEN) ws.close();
        });

        upstream.addEventListener("error", () => {
          wsUpstreams.delete(upstream);
          if (ws.readyState === WebSocket.OPEN) ws.close();
        });
      },
      message(ws, raw) {
        const payload = toWebSocketPayload(raw);
        const upstream = ws.data.upstream;
        if (upstream?.readyState === WebSocket.OPEN) {
          upstream.send(payload);
          return;
        }
        if (ws.data.pending.length >= LIVE_PROXY_MAX_PENDING_WS_MESSAGES) {
          // Overflow closes both sides rather than buffering unboundedly.
          ws.close();
          if (upstream) upstream.close();
          return;
        }
        ws.data.pending.push(payload);
      },
      close(ws) {
        ws.data.pending = [];
        const upstream = ws.data.upstream;
        ws.data.upstream = null;
        if (upstream) {
          wsUpstreams.delete(upstream);
          upstream.close();
        }
      },
    },
  });

  const port = server.port!;
  return {
    port,
    // Always the literal loopback origin: PLANNOTATOR_URL_HOST and
    // buildAdvertisedUrl are never applied here.
    origin: `http://${LOOPBACK_HOST}:${port}`,
    stop() {
      for (const upstream of wsUpstreams) upstream.close();
      wsUpstreams.clear();
      server.stop(true);
    },
  };
}
