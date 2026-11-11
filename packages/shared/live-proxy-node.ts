/** node:http live-app proxy; decisions come from ./live-proxy-core. Binds 127.0.0.1 unconditionally and validates Host before any upstream contact. */

import { createLiveProxyPortAttempts, getLiveProxyPortSelection } from "./live-proxy-port";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { Transform, pipeline } from "node:stream";
import {
  HOP_BY_HOP_HEADERS,
  LIVE_PROXY_BRIDGE_PATH,
  LIVE_PROXY_PLANNOTATOR_UPSTREAM_MESSAGE,
  LIVE_PROXY_RESERVED_PREFIX,
  PLANNOTATOR_LIVE_PROXY_HEADER,
  applyHtmlFramingHeaders,
  assertLiveTargetNotEditor,
  buildFrameAncestorsPolicy,
  createHtmlInjector,
  isAllowedBridgeFetchSite,
  isAllowedProxyHost,
  isAllowedWsUpgradeOrigin,
  isDocumentIntentRequest,
  isHtmlContentType,
  isPlannotatorUpstreamResponse,
  rewriteLoopbackLocation,
  type HeaderReader,
  type LiveAppProxy,
  type LiveAppProxyOptions,
} from "./live-proxy-core";

// The literal loopback address is the security contract.
const LOOPBACK_HOST = "127.0.0.1";

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

type HeaderRecord = Record<string, string | string[]>;

function copyWithoutHopByHop(headers: IncomingHttpHeaders): HeaderRecord {
  const out: HeaderRecord = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP_HEADERS.includes(name)) continue;
    out[name] = value;
  }
  return out;
}

function writeRawResponse(socket: Socket, statusLine: string, body: string): void {
  try {
    // end(), not write()+destroy(): destroy discards buffered bytes before the refusal reaches the client.
    socket.end(
      `HTTP/1.1 ${statusLine}\r\n`
      + "Content-Type: text/plain\r\n"
      + `Content-Length: ${Buffer.byteLength(body)}\r\n`
      + "Connection: close\r\n\r\n"
      + body,
    );
  } catch {
    socket.destroy();
  }
}

function sendForbidden(res: ServerResponse): void {
  res.writeHead(403, { "Content-Type": "text/plain" });
  res.end("Forbidden");
}

export async function startLiveAppProxyNode(opts: LiveAppProxyOptions): Promise<LiveAppProxy> {
  const target = new URL(opts.targetUrl);
  if (target.protocol !== "http:") {
    throw new Error("Live app proxy supports http upstreams only.");
  }
  assertLiveTargetNotEditor(opts.targetUrl, opts.editorOrigins);
  const targetHost = target.host;
  const targetHostname = target.hostname;
  const targetPort = Number(target.port || "80");
  const frameAncestors = buildFrameAncestorsPolicy(opts.editorOrigins);
  const upgradeSockets = new Set<Socket>();
  let warnedEncodedHtml = false;
  let port = 0;

  const server = createServer((req, res) => {
    // Host validation runs before any URL parsing or upstream contact, so a Host-less HTTP/1.0 request gets the plain 403.
    const hostHeader = firstHeaderValue(req.headers.host);
    if (!isAllowedProxyHost(hostHeader, port)) {
      sendForbidden(res);
      return;
    }

    // An unparseable request takes the same refusal path.
    let url: URL;
    try {
      url = new URL(req.url ?? "", `http://${hostHeader}`);
    } catch {
      sendForbidden(res);
      return;
    }

    if (url.pathname.startsWith(LIVE_PROXY_RESERVED_PREFIX)) {
      if (url.pathname === LIVE_PROXY_BRIDGE_PATH && (req.method === "GET" || req.method === "HEAD")) {
        // The bridge body embeds the per-session token: only same-origin includes and direct navigation may fetch it.
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

    const upstreamHeaders = copyWithoutHopByHop(req.headers);
    upstreamHeaders["host"] = targetHost;
    upstreamHeaders["x-forwarded-host"] = hostHeader ?? "";
    upstreamHeaders["x-forwarded-proto"] = "http";
    upstreamHeaders[PLANNOTATOR_LIVE_PROXY_HEADER] = "1";
    if (isDocumentIntentRequest(nodeHeaderReader(req.headers))) {
      // HTML must arrive decodable for injection.
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
        // Never relay a Plannotator server's response.
        if (isPlannotatorUpstreamResponse(nodeHeaderReader(upstreamRes.headers))) {
          upstreamRes.resume();
          res.writeHead(502, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
          res.end(LIVE_PROXY_PLANNOTATOR_UPSTREAM_MESSAGE);
          return;
        }
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
          // Drop the app's CSP on HTML and replace it with our frame-ancestors policy.
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
            // Fail open on rendering, closed on injection.
            warnedEncodedHtml = true;
            console.error(
              "[plannotator] Live app proxy: upstream returned content-encoded HTML despite the Accept-Encoding strip; the annotation bridge was not injected.",
            );
          }
          res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
          pipeline(upstreamRes, res, () => {});
          return;
        }

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

    if (req.method === "GET" || req.method === "HEAD") {
      upstreamReq.end();
      req.resume();
    } else {
      pipeline(req, upstreamReq, () => {});
    }
  });

  // WebSocket passthrough: Host first, then the Origin gate, before any upstream contact.
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
      writeRawResponse(socket, "404 Not Found", "Not found");
      return;
    }
    if (!isAllowedWsUpgradeOrigin(firstHeaderValue(req.headers.origin), port)) {
      writeRawResponse(socket, "403 Forbidden", "Forbidden");
      return;
    }

    // Replay the client's handshake over raw TCP so Sec-WebSocket-Accept matches; Host is rewritten and Origin dropped (the gate already ran).
    let handshake = `GET ${url.pathname + url.search} HTTP/1.1\r\n`;
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i]!;
      const lower = name.toLowerCase();
      if (lower === "host") {
        handshake += `Host: ${targetHost}\r\n`;
        continue;
      }
      if (lower === "origin") continue;
      if (lower === PLANNOTATOR_LIVE_PROXY_HEADER) continue;
      handshake += `${name}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    // The live proxy header makes a Plannotator upstream refuse the upgrade.
    handshake += `${PLANNOTATOR_LIVE_PROXY_HEADER}: 1\r\n`;

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

    // Accumulate the upstream's response head, capped so a malformed upstream cannot buffer unboundedly.
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

  // Long-lived streams (SSE) must not be killed by a server-side timer.
  server.requestTimeout = 0;

  const selection = getLiveProxyPortSelection();
  const attempts = createLiveProxyPortAttempts(selection);
  let listening = false;
  for (const candidate of selection.ports) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.removeListener("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(candidate, LOOPBACK_HOST);
      });
      listening = true;
      break;
    } catch (error) {
      attempts.failed(candidate, error);
    }
  }
  if (!listening) throw attempts.exhausted();

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Live app proxy failed to bind a loopback port");
  }
  port = address.port;
  return {
    port,
    // Always the literal loopback origin.
    origin: `http://${LOOPBACK_HOST}:${port}`,
    stop() {
      for (const s of upgradeSockets) s.destroy();
      upgradeSockets.clear();
      server.close();
      // close() only stops the listener; drain keep-alive connections. Guarded: some hosts' node:http lacks closeAllConnections.
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    },
  };
}
