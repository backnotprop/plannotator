/**
 * Loopback reverse proxy for live local app annotation — Node transport.
 *
 * The node:http mirror of packages/server/live-proxy.ts, run by the Pi
 * extension (vendored to apps/pi-extension/generated/). Every DECISION —
 * Host/Origin validation, the streaming injector state machine, the
 * CSP/X-Frame-Options policy, the redirect rewrite, the WS origin gate — is
 * imported from ./live-proxy-core and therefore byte-identical to the Bun
 * transport; this file is only the node:http plumbing around them.
 *
 * Transport notes:
 * - Request/response bodies are PIPED, never buffered: the upstream response
 *   streams through a Transform running the shared injector for HTML, and
 *   verbatim otherwise, with backpressure handled by stream.pipeline.
 * - WebSocket passthrough (HMR) rides node's 'upgrade' event: the client's
 *   own handshake (its Sec-WebSocket-Key et al., raw header casing intact)
 *   is replayed upstream over a raw node:net connection, the upstream's 101
 *   is relayed back verbatim, and from then on the two sockets are piped
 *   byte-for-byte — no WS framing library, no pending-message queue (TCP
 *   holds early client bytes until the 101 lands; the 'upgrade' head buffer
 *   is forwarded explicitly). Raw TCP rather than an http.request client on
 *   purpose: 101 handling differs between Node's http client and other
 *   runtimes' node:http shims, while a socket is a socket everywhere. The
 *   upstream connect carries no Origin header, which is exactly why the
 *   Origin gate refuses foreign browser origins BEFORE any upstream contact
 *   (Vite CVE-2025-24010 class).
 *
 * Security posture (identical to the Bun transport; binding is the
 * contract): binds 127.0.0.1 UNCONDITIONALLY — never the shared
 * env-dependent hostname helper — validates Host before any URL parsing or
 * upstream contact (a Host-less HTTP/1.0 request answers the plain 403,
 * never a runtime error), and PLANNOTATOR_URL_HOST is never applied to the
 * proxy origin.
 */

import { createServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { Transform, pipeline } from "node:stream";
import {
  HOP_BY_HOP_HEADERS,
  LIVE_PROXY_BRIDGE_PATH,
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
  type HeaderReader,
  type LiveAppProxy,
  type LiveAppProxyOptions,
} from "./live-proxy-core";

// The literal loopback address is the security contract (see header).
const LOOPBACK_HOST = "127.0.0.1";

/** Read adapter over node's lowercased incoming header object. */
function nodeHeaderReader(headers: IncomingHttpHeaders): HeaderReader {
  return {
    get(name: string): string | null {
      const value = headers[name.toLowerCase()];
      if (value === undefined) return null;
      return Array.isArray(value) ? value.join(", ") : value;
    },
  };
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

/** Outgoing header map (lowercased names; set-cookie may repeat). */
type HeaderRecord = Record<string, string | string[]>;

function copyWithoutHopByHop(headers: IncomingHttpHeaders): HeaderRecord {
  const out: HeaderRecord = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP_HEADERS.includes(name)) continue; // node keys are lowercased
    out[name] = value;
  }
  return out;
}

function writeRawResponse(socket: Socket, statusLine: string, body: string): void {
  try {
    // end(), not write()+destroy(): destroy discards buffered bytes, and the
    // refusal must actually reach the client before the FIN.
    socket.end(
      `HTTP/1.1 ${statusLine}\r\n`
      + "Content-Type: text/plain\r\n"
      + `Content-Length: ${Buffer.byteLength(body)}\r\n`
      + "Connection: close\r\n\r\n"
      + body,
    );
  } catch {
    // Socket already gone: nothing to refuse.
    socket.destroy();
  }
}

function sendForbidden(res: ServerResponse): void {
  res.writeHead(403, { "Content-Type": "text/plain" });
  res.end("Forbidden");
}

/**
 * Start the loopback reverse proxy for one live annotate session on
 * node:http. The caller owns its lifecycle: stop() destroys tracked upgrade
 * sockets and closes the listener (plus its remaining keep-alive
 * connections).
 */
export function startLiveAppProxyNode(opts: LiveAppProxyOptions): Promise<LiveAppProxy> {
  const target = new URL(opts.targetUrl);
  if (target.protocol !== "http:") {
    throw new Error("Live app proxy supports http upstreams only.");
  }
  const targetHost = target.host;
  const targetHostname = target.hostname;
  const targetPort = Number(target.port || "80");
  const frameAncestors = buildFrameAncestorsPolicy(opts.editorOrigins);
  /** Client+upstream sockets of live WS upgrades, destroyed on stop(). */
  const upgradeSockets = new Set<Socket>();
  let warnedEncodedHtml = false;
  let port = 0;

  const server = createServer((req, res) => {
    // Host validation FIRST, before any URL construction: the invariant is
    // "Host validation runs before any upstream contact" for ALL inputs,
    // well-formed or not — a Host-less HTTP/1.0 request answers the plain
    // 403, never a runtime error page.
    const hostHeader = firstHeaderValue(req.headers.host);
    if (!isAllowedProxyHost(hostHeader, port)) {
      sendForbidden(res);
      return;
    }

    // A Host that passed the check should always yield a parseable URL, but
    // parsing must not be the thing that decides: an unparseable request
    // takes the same refusal path rather than any error page.
    let url: URL;
    try {
      url = new URL(req.url ?? "", `http://${hostHeader}`);
    } catch {
      sendForbidden(res);
      return;
    }

    // Reserved namespace: never forwarded upstream.
    if (url.pathname.startsWith(LIVE_PROXY_RESERVED_PREFIX)) {
      if (url.pathname === LIVE_PROXY_BRIDGE_PATH && (req.method === "GET" || req.method === "HEAD")) {
        // The bridge body embeds the per-session token; only same-origin
        // includes and direct navigation may fetch it (see
        // isAllowedBridgeFetchSite in live-proxy-core).
        if (!isAllowedBridgeFetchSite(firstHeaderValue(req.headers["sec-fetch-site"]))) {
          sendForbidden(res);
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(req.method === "HEAD" ? undefined : opts.bridgeJs);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    // Whole-origin forward, streaming both directions.
    const upstreamHeaders = copyWithoutHopByHop(req.headers);
    upstreamHeaders["host"] = targetHost;
    upstreamHeaders["x-forwarded-host"] = hostHeader ?? "";
    upstreamHeaders["x-forwarded-proto"] = "http";
    if (isDocumentIntentRequest(nodeHeaderReader(req.headers))) {
      // HTML must arrive decodable for injection; assets keep encoding.
      upstreamHeaders["accept-encoding"] = "identity";
    }

    const upstreamReq = httpRequest(
      {
        host: targetHostname,
        port: targetPort,
        method: req.method,
        path: url.pathname + url.search,
        headers: upstreamHeaders,
      },
      (upstreamRes) => {
        const responseHeaders = copyWithoutHopByHop(upstreamRes.headers);

        const location = firstHeaderValue(upstreamRes.headers.location);
        if (location) {
          const rewritten = rewriteLoopbackLocation(
            location,
            target,
            `http://${LOOPBACK_HOST}:${port}`,
          );
          if (rewritten !== null) responseHeaders["location"] = rewritten;
        }

        const isHtml = isHtmlContentType(firstHeaderValue(upstreamRes.headers["content-type"]));
        if (isHtml) {
          // Decided posture: drop any app CSP on HTML and replace it with our
          // frame-ancestors policy; non-HTML responses keep their CSP and
          // X-Frame-Options (see applyHtmlFramingHeaders in live-proxy-core).
          applyHtmlFramingHeaders(
            {
              delete: (name) => {
                delete responseHeaders[name];
              },
              set: (name, value) => {
                responseHeaders[name] = value;
              },
            },
            frameAncestors,
          );
        }

        const hasEncoding = !!responseHeaders["content-encoding"];
        if (!isHtml || hasEncoding) {
          if (isHtml && hasEncoding && !warnedEncodedHtml) {
            // Fail open on rendering, closed on injection: the page renders,
            // annotation does not attach on it.
            warnedEncodedHtml = true;
            console.error(
              "[plannotator] Live app proxy: upstream returned content-encoded HTML despite the Accept-Encoding strip; the annotation bridge was not injected.",
            );
          }
          res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
          pipeline(upstreamRes, res, () => {});
          return;
        }

        // Streaming injection of the bridge script tag.
        delete responseHeaders["content-length"];
        const injector = createHtmlInjector(
          `<script src="${LIVE_PROXY_BRIDGE_PATH}"></script>`,
        );
        const inject = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            for (const part of injector.push(chunk)) {
              if (part.length) this.push(Buffer.from(part));
            }
            callback();
          },
          flush(callback) {
            for (const part of injector.flush()) {
              if (part.length) this.push(Buffer.from(part));
            }
            callback();
          },
        });
        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
        pipeline(upstreamRes, inject, res, () => {});
      },
    );

    upstreamReq.on("error", (err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`Live app upstream unreachable: ${err instanceof Error ? err.message : String(err)}`);
    });

    // Stream the request body upstream; GET/HEAD have none by contract.
    if (req.method === "GET" || req.method === "HEAD") {
      upstreamReq.end();
      req.resume();
    } else {
      pipeline(req, upstreamReq, () => {});
    }
  });

  // WebSocket passthrough (HMR): raw duplex piping after the same gate
  // sequence as plain requests — Host first, then the Origin gate, both
  // before any upstream contact.
  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const hostHeader = firstHeaderValue(req.headers.host);
    if (!isAllowedProxyHost(hostHeader, port)) {
      writeRawResponse(socket, "403 Forbidden", "Forbidden");
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "", `http://${hostHeader}`);
    } catch {
      writeRawResponse(socket, "403 Forbidden", "Forbidden");
      return;
    }
    if (url.pathname.startsWith(LIVE_PROXY_RESERVED_PREFIX)) {
      // Reserved namespace is never forwarded upstream, upgrades included.
      writeRawResponse(socket, "404 Not Found", "Not found");
      return;
    }
    if (!isAllowedWsUpgradeOrigin(firstHeaderValue(req.headers.origin), port)) {
      writeRawResponse(socket, "403 Forbidden", "Forbidden");
      return;
    }

    // Replay the client's own handshake upstream over raw TCP so the
    // upstream's Sec-WebSocket-Accept matches the client's key. rawHeaders
    // keeps original casing and repeats; Host is rewritten to the target and
    // Origin is dropped to match the Bun transport's origin-less upstream
    // connect (safe because the gate above already ran).
    let handshake = `GET ${url.pathname + url.search} HTTP/1.1\r\n`;
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i]!;
      const lower = name.toLowerCase();
      if (lower === "host") {
        handshake += `Host: ${targetHost}\r\n`;
        continue;
      }
      if (lower === "origin") continue;
      handshake += `${name}: ${req.rawHeaders[i + 1]}\r\n`;
    }

    const upstreamSocket = netConnect(targetPort, targetHostname);
    upgradeSockets.add(socket);
    upgradeSockets.add(upstreamSocket);

    const teardown = () => {
      upgradeSockets.delete(socket);
      upgradeSockets.delete(upstreamSocket);
      socket.destroy();
      upstreamSocket.destroy();
    };

    upstreamSocket.on("connect", () => {
      upstreamSocket.write(handshake + "\r\n");
    });

    // Accumulate the upstream's response head; once complete, relay it
    // verbatim and decide by status line: 101 pipes both ways, anything else
    // is a refusal relayed to the client before closing. Capped so a
    // malformed upstream cannot buffer unboundedly.
    const MAX_UPGRADE_HEAD_BYTES = 64 * 1024;
    let received = Buffer.alloc(0);
    let established = false;
    const onUpstreamData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const headerEnd = received.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        if (received.length > MAX_UPGRADE_HEAD_BYTES) teardown();
        return;
      }
      upstreamSocket.off("data", onUpstreamData);
      const statusLine = received.subarray(0, received.indexOf("\r\n")).toString("latin1");
      const is101 = /^HTTP\/1\.1 101 /i.test(statusLine);
      socket.write(received);
      if (!is101) {
        // Refusal relayed; nothing further to pipe.
        teardown();
        return;
      }
      established = true;
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    };
    upstreamSocket.on("data", onUpstreamData);

    upstreamSocket.on("close", teardown);
    upstreamSocket.on("error", () => {
      if (!established) {
        writeRawResponse(socket, "502 Bad Gateway", "Live app upstream unreachable");
        upgradeSockets.delete(socket);
        upgradeSockets.delete(upstreamSocket);
        upstreamSocket.destroy();
        return;
      }
      teardown();
    });
    socket.on("close", teardown);
    socket.on("error", teardown);
  });

  // Long-lived streams (SSE) must not be killed by a server-side timer;
  // mirrors the Bun transport's idleTimeout: 0.
  server.requestTimeout = 0;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // The literal loopback address is the security contract (see header).
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Live app proxy failed to bind a loopback port"));
        return;
      }
      port = address.port;
      resolve({
        port,
        // Always the literal loopback origin: PLANNOTATOR_URL_HOST and
        // buildAdvertisedUrl are never applied here.
        origin: `http://${LOOPBACK_HOST}:${port}`,
        stop() {
          for (const s of upgradeSockets) s.destroy();
          upgradeSockets.clear();
          server.close();
          // close() only stops the listener; drain keep-alive connections so
          // a stopped session's sockets die immediately (parity with Bun's
          // server.stop(true)). Guarded: jiti can run under hosts whose
          // node:http lacks closeAllConnections.
          (server as { closeAllConnections?: () => void }).closeAllConnections?.();
        },
      });
    });
  });
}
