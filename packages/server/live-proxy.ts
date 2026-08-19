/**
 * Loopback reverse proxy for live local app annotation (phase 1).
 *
 * Mirrors the whole target origin (a local dev server) on a dedicated
 * loopback port and injects the annotation bridge into every HTML response,
 * so the editor can frame the user's own running app and drive the same
 * pinpoint annotation experience the srcdoc surface provides.
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

const LOOPBACK_HOST = "127.0.0.1";

/** Reserved path namespace never forwarded upstream. */
export const LIVE_PROXY_RESERVED_PREFIX = "/__plannotator__/";
export const LIVE_PROXY_BRIDGE_PATH = "/__plannotator__/bridge.js";

/** RFC 7230 hop-by-hop headers, stripped in both directions. */
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

const MAX_PENDING_WS_MESSAGES = 200;

export interface LiveAppProxyOptions {
  /** Upstream dev server origin, e.g. http://localhost:5173 (http, loopback). */
  targetUrl: string;
  /** Editor origins allowed to frame the proxied app (frame-ancestors). */
  editorOrigins: string[];
  /** Fully composed bridge body (config prelude + bootstrap + bridge). */
  bridgeJs: string;
}

export interface LiveAppProxy {
  port: number;
  origin: string;
  stop(): void;
}

type LiveProxySocketData = {
  upstream: WebSocket | null;
  pending: (string | ArrayBuffer)[];
  pathAndQuery: string;
  protocols: string | null;
};

/** True for hostnames that name the local loopback: localhost, the IPv6
 * loopback, or a LITERAL IPv4 address in 127.0.0.0/8. A string-prefix test
 * would also match DNS names like 127.0.0.1.evil.example that resolve
 * anywhere, so the 127/8 rung requires exactly four numeric octets. WHATWG
 * URL parsing canonicalizes numeric spellings (127.1, 0177.0.0.1,
 * 2130706433) to dotted-decimal before a hostname reaches this check. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!octets) return false;
  return Number(octets[1]) <= 255 && Number(octets[2]) <= 255 && Number(octets[3]) <= 255;
}

/** True when the Host header names this proxy on loopback. */
export function isAllowedProxyHost(hostHeader: string | null, port: number): boolean {
  if (!hostHeader) return false;
  return (
    hostHeader === `127.0.0.1:${port}`
    || hostHeader === `localhost:${port}`
    || hostHeader === `[::1]:${port}`
  );
}

/** True when a browser-supplied Origin header names this proxy itself. */
export function isAllowedProxyOrigin(origin: string, port: number): boolean {
  return (
    origin === `http://127.0.0.1:${port}`
    || origin === `http://localhost:${port}`
    || origin === `http://[::1]:${port}`
  );
}

/**
 * Rewrite an absolute redirect Location that names the upstream dev server
 * back to the proxy origin, or return null to pass it through untouched.
 * The match is by loopback hostname plus the upstream's port, not a string
 * prefix, so it covers alternate loopback spellings (target given as
 * localhost:5173, Location saying 127.0.0.1:5173) and never mangles
 * prefix look-alikes (localhost:51730 is a different service). Relative
 * Locations already resolve against the proxy origin and pass through.
 */
export function rewriteLoopbackLocation(
  location: string,
  target: URL,
  proxyOrigin: string,
): string | null {
  if (!/^http:\/\//i.test(location)) return null;
  let locUrl: URL;
  try {
    locUrl = new URL(location);
  } catch {
    return null;
  }
  if (!isLoopbackHostname(locUrl.hostname)) return null;
  if ((locUrl.port || "80") !== (target.port || "80")) return null;
  return proxyOrigin + locUrl.pathname + locUrl.search + locUrl.hash;
}

/** Document-intent requests get Accept-Encoding stripped so HTML arrives
 * decodable for injection; asset requests keep their encoding untouched. */
export function isDocumentIntentRequest(headers: Headers): boolean {
  const dest = headers.get("sec-fetch-dest");
  if (dest === "document" || dest === "iframe" || dest === "frame") return true;
  const accept = headers.get("accept");
  return !!accept && accept.includes("text/html");
}

// --- Streaming HTML injection -----------------------------------------------
//
// Injects exactly one script tag per document, in priority order:
//  1. immediately after the end of the first <head ...> open tag (so
//     streaming SSR gets the bridge before the body streams),
//  2. before </head> when no head open tag was seen,
//  3. appended at end of stream when neither appears.
// Byte-level scan (the markers are ASCII, safe in UTF-8) holding back at most
// 8 bytes across chunk boundaries; a head open tag split across chunks is
// handled by a state machine rather than unbounded buffering.

const HEAD_OPEN = "<head";
const HEAD_CLOSE = "</head>";
const HOLDBACK = 8;

type InjectorState = "searching" | "in-head-open-tag" | "done";

export function createHtmlInjector(injection: string) {
  const encoder = new TextEncoder();
  const injectionBytes = encoder.encode(injection);
  let state: InjectorState = "searching";
  let carry = new Uint8Array(0);

  function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  function lowerAt(buf: Uint8Array, index: number): number {
    const byte = buf[index]!;
    return byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
  }

  function matchesAt(buf: Uint8Array, index: number, marker: string): boolean {
    if (index + marker.length > buf.length) return false;
    for (let i = 0; i < marker.length; i++) {
      if (lowerAt(buf, index + i) !== marker.charCodeAt(i)) return false;
    }
    return true;
  }

  /** True when the byte after "<head" terminates the tag name. */
  function isHeadBoundary(byte: number): boolean {
    return byte === 0x3e /* > */
      || byte === 0x2f /* / */
      || byte === 0x20
      || byte === 0x09
      || byte === 0x0a
      || byte === 0x0c
      || byte === 0x0d;
  }

  /** Process buffered bytes, returning output and retaining a small carry. */
  function scan(buf: Uint8Array, flush: boolean): Uint8Array[] {
    const out: Uint8Array[] = [];
    let cursor = 0;

    while (cursor < buf.length && state !== "done") {
      if (state === "in-head-open-tag") {
        const gt = buf.indexOf(0x3e, cursor);
        if (gt === -1) {
          out.push(buf.subarray(cursor));
          cursor = buf.length;
          buf = new Uint8Array(0);
          break;
        }
        out.push(buf.subarray(cursor, gt + 1));
        out.push(injectionBytes);
        state = "done";
        cursor = gt + 1;
        break;
      }

      // searching: look for the earliest full or partial marker.
      let emitted = false;
      for (let i = cursor; i < buf.length; i++) {
        if (lowerAt(buf, i) !== 0x3c /* < */) continue;
        // Full </head> (no head open tag seen): inject before it.
        if (matchesAt(buf, i, HEAD_CLOSE)) {
          out.push(buf.subarray(cursor, i));
          out.push(injectionBytes);
          state = "done";
          cursor = i;
          emitted = true;
          break;
        }
        // <head followed by a boundary char: enter the open tag.
        if (matchesAt(buf, i, HEAD_OPEN) && i + HEAD_OPEN.length < buf.length) {
          if (isHeadBoundary(buf[i + HEAD_OPEN.length]!)) {
            out.push(buf.subarray(cursor, i));
            cursor = i;
            state = "in-head-open-tag";
            emitted = true;
            break;
          }
          continue; // <header> etc.
        }
        // Partial marker at the buffer tail: defer to the holdback below.
      }
      if (!emitted && state === "searching") break;
    }

    if (state === "done") {
      // Everything after the injection point passes through untouched.
      if (cursor < buf.length) out.push(buf.subarray(cursor));
      carry = new Uint8Array(0);
      return out;
    }

    if (state === "in-head-open-tag") {
      // scan() loop above consumed the buffer searching for '>'.
      if (cursor < buf.length) {
        out.push(buf.subarray(cursor));
      }
      carry = new Uint8Array(0);
      return out;
    }

    // searching: hold back the trailing bytes that could begin a marker.
    if (flush) {
      out.push(buf.subarray(cursor));
      out.push(injectionBytes);
      state = "done";
      carry = new Uint8Array(0);
      return out;
    }
    const keepFrom = Math.max(cursor, buf.length - HOLDBACK);
    out.push(buf.subarray(cursor, keepFrom));
    carry = buf.slice(keepFrom);
    return out;
  }

  return {
    push(chunk: Uint8Array): Uint8Array[] {
      const buf = carry.length ? concat(carry, chunk) : chunk;
      carry = new Uint8Array(0);
      return scan(buf, false);
    },
    flush(): Uint8Array[] {
      const buf = carry;
      carry = new Uint8Array(0);
      if (state === "done") return buf.length ? [buf] : [];
      if (state === "in-head-open-tag") {
        // Stream ended inside the head open tag: emit what we have plus the
        // injection so the bridge still ships.
        state = "done";
        const encoderOut: Uint8Array[] = [];
        if (buf.length) encoderOut.push(buf);
        encoderOut.push(injectionBytes);
        return encoderOut;
      }
      return scan(buf, true);
    },
  };
}

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
  const frameAncestors = `frame-ancestors ${opts.editorOrigins.join(" ")}`;
  const wsUpstreams = new Set<WebSocket>();
  let warnedEncodedHtml = false;

  const server = Bun.serve<LiveProxySocketData>({
    // The literal loopback address is the security contract (see header).
    hostname: LOOPBACK_HOST,
    port: 0,
    idleTimeout: 0,

    async fetch(req, srv) {
      const url = new URL(req.url);

      // Host validation first: anything not naming this loopback proxy is
      // refused before any upstream contact or upgrade.
      if (!isAllowedProxyHost(req.headers.get("host"), srv.port!)) {
        return new Response("Forbidden", { status: 403, headers: { "Content-Type": "text/plain" } });
      }

      // Reserved namespace: never forwarded upstream.
      if (url.pathname.startsWith(LIVE_PROXY_RESERVED_PREFIX)) {
        if (url.pathname === LIVE_PROXY_BRIDGE_PATH && (req.method === "GET" || req.method === "HEAD")) {
          // The bridge body embeds the per-session token, and a <script src>
          // include is not subject to CORS: a hostile page that guesses the
          // proxy port could otherwise read the token off the config global.
          // Browsers stamp subresource requests with Sec-Fetch-Site; only the
          // proxied page's own same-origin include (and direct navigation)
          // passes. Header-less clients (curl, tests) pass; this is defense
          // in depth on top of the parent's source and origin checks.
          const fetchSite = req.headers.get("sec-fetch-site");
          if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
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

      // WebSocket passthrough (HMR): upgrade after Host validation.
      if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
        // Browsers stamp cross-site WS connects with their Origin, and the
        // upstream connection below carries no Origin header at all. Piping
        // a hostile page's connect through would launder it into exactly the
        // origin-less shape dev servers trust as a non-browser client
        // (bypassing e.g. Vite's CVE-2025-24010 cross-site WS protection).
        // An Origin, when present, must name this proxy itself; header-less
        // clients (non-browser tools) pass.
        const wsOrigin = req.headers.get("origin");
        if (wsOrigin !== null && !isAllowedProxyOrigin(wsOrigin, srv.port!)) {
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

      const contentType = responseHeaders.get("content-type") ?? "";
      const isHtml = contentType.includes("text/html");

      if (isHtml) {
        // Decided posture: drop any app CSP on HTML and replace it with our
        // frame-ancestors policy. Amending an arbitrary CSP correctly for the
        // injected script plus a runtime <style> is unpredictable; dev
        // servers almost never ship CSP, and this is a dev-only loopback
        // proxy. Non-HTML responses keep their CSP, and their
        // X-Frame-Options: the anti-framing strip exists solely so the
        // editor can frame the app document, and the frame-ancestors
        // replacement lands only on HTML, so a non-HTML response must keep
        // whatever framing protection the app shipped with it.
        responseHeaders.delete("x-frame-options");
        responseHeaders.delete("content-security-policy");
        responseHeaders.delete("content-security-policy-report-only");
        responseHeaders.set("content-security-policy", frameAncestors);
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
        if (ws.data.pending.length >= MAX_PENDING_WS_MESSAGES) {
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
