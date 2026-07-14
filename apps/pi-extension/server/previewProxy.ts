// apps/pi-extension/server/previewProxy.ts
//
// Node (`node:http`) port of packages/server/preview-proxy.ts for the Pi
// runtime. Same public interface — `startPreviewProxy(target)` → `{ origin,
// stop() }` — but built on `http.request` + raw-socket WebSocket passthrough
// instead of `Bun.serve` + `fetch`/client `WebSocket`. CLAUDE.md requires both
// runtimes to carry equivalent annotate behavior.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";

import { isLoopbackUrl } from "../generated/url-to-markdown.js";
import { buildLivePreviewInjection } from "../generated/livePreviewInjection.js";

export interface PreviewProxy {
	/** The proxy's own base origin, e.g. "http://localhost:53211". */
	origin: string;
	stop: () => void;
}

export function parseTarget(target: string): {
	protocol: string;
	host: string;
	hostname: string;
	port: number;
	secure: boolean;
} {
	if (!isLoopbackUrl(target)) {
		throw new Error(`Live preview target must be a loopback URL, got: ${target}`);
	}
	const u = new URL(target);
	const secure = u.protocol === "https:";
	return {
		protocol: u.protocol,
		host: u.host, // includes port
		hostname: u.hostname,
		port: u.port ? Number(u.port) : secure ? 443 : 80,
		secure,
	};
}

/**
 * Rewrite the incoming request headers for forwarding to the target: force
 * Host, canonicalize Origin/Referer to the target, force an identity body (Bun's
 * `fetch` transparently decodes; `http.request` does not, so we ask upstream for
 * an uncompressed body we can inject into and stream verbatim), and drop
 * conditional headers so we always get the full HTML to inject into.
 */
export function rewriteRequestHeaders(
	incoming: http.IncomingHttpHeaders,
	targetHost: string,
	httpBase: string,
	pathname: string,
): http.OutgoingHttpHeaders {
	const h: http.OutgoingHttpHeaders = { ...incoming };
	h.host = targetHost;
	if (h.origin !== undefined) h.origin = httpBase;
	if (h.referer !== undefined) h.referer = httpBase + pathname;
	h["accept-encoding"] = "identity";
	delete h["if-none-match"];
	delete h["if-modified-since"];
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
	const { protocol, host, hostname, port, secure } = parseTarget(target);
	const httpBase = `${protocol}//${host}`;
	const block = buildLivePreviewInjection();
	const requester = secure ? https : http;

	// Track live sockets (WS passthrough pairs) so stop() can tear them down.
	const openSockets = new Set<Socket>();

	const server = http.createServer((req, res) => {
		const inUrl = new URL(req.url || "/", "http://127.0.0.1");
		const pathAndQuery = inUrl.pathname + inUrl.search;
		const headers = rewriteRequestHeaders(req.headers, host, httpBase, inUrl.pathname);

		const upstreamReq = requester.request(
			{
				protocol,
				hostname,
				port,
				method: req.method,
				path: pathAndQuery,
				headers,
			},
			(upstreamRes) => {
				const respHeaders: http.OutgoingHttpHeaders = { ...upstreamRes.headers };
				delete respHeaders["content-encoding"];
				delete respHeaders["content-length"];

				// Only follow same-origin (loopback) redirects; strip cross-origin Location.
				const loc = upstreamRes.headers["location"];
				if (typeof loc === "string" && loc) {
					try {
						const abs = new URL(loc, httpBase);
						if (abs.host !== host) delete respHeaders["location"];
					} catch {
						delete respHeaders["location"];
					}
				}

				const ct = (upstreamRes.headers["content-type"] || "").toString();
				if (ct.includes("text/html")) {
					// We re-send a fixed buffer via res.end(), so drop any chunked
					// framing the upstream used for the original body.
					delete respHeaders["transfer-encoding"];
					const chunks: Buffer[] = [];
					upstreamRes.on("data", (c: Buffer) => chunks.push(c));
					upstreamRes.on("end", () => {
						const html = Buffer.concat(chunks).toString("utf-8");
						const body = injectBridge(html, block);
						res.writeHead(upstreamRes.statusCode || 200, respHeaders);
						res.end(body);
					});
					upstreamRes.on("error", () => {
						try {
							res.destroy();
						} catch {}
					});
				} else {
					res.writeHead(upstreamRes.statusCode || 200, respHeaders);
					upstreamRes.pipe(res);
				}
			},
		);

		upstreamReq.on("error", () => {
			if (!res.headersSent) {
				res.writeHead(502, { "content-type": "text/plain" });
			}
			try {
				res.end("Live preview: dev server unreachable");
			} catch {}
		});

		// Forward the request body (no-op for GET/HEAD).
		req.pipe(upstreamReq);
	});

	// HMR WebSocket passthrough via a dependency-free raw-socket pipe.
	server.on("upgrade", (req, clientSocket, head) => {
		openSockets.add(clientSocket as Socket);
		const connect = secure
			? tls.connect({ host: hostname, port, servername: hostname, rejectUnauthorized: false })
			: net.connect({ host: hostname, port });
		const upstreamSocket = connect as Socket;
		openSockets.add(upstreamSocket);

		const cleanup = () => {
			openSockets.delete(clientSocket as Socket);
			openSockets.delete(upstreamSocket);
			try {
				clientSocket.destroy();
			} catch {}
			try {
				upstreamSocket.destroy();
			} catch {}
		};

		upstreamSocket.on("connect", () => {
			// Re-send the upgrade request line + headers with Host rewritten, then
			// forward any already-buffered bytes and pipe both directions. Upstream's
			// "101 Switching Protocols" response flows back through the pipe.
			let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
			const outHeaders: http.IncomingHttpHeaders = { ...req.headers, host };
			for (const [k, v] of Object.entries(outHeaders)) {
				if (v === undefined) continue;
				if (Array.isArray(v)) {
					for (const vv of v) raw += `${k}: ${vv}\r\n`;
				} else {
					raw += `${k}: ${v}\r\n`;
				}
			}
			raw += "\r\n";
			upstreamSocket.write(raw);
			if (head && head.length) upstreamSocket.write(head);
			clientSocket.pipe(upstreamSocket);
			upstreamSocket.pipe(clientSocket);
		});

		upstreamSocket.on("error", cleanup);
		upstreamSocket.on("close", cleanup);
		clientSocket.on("error", cleanup);
		clientSocket.on("close", cleanup);
	});

	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", rejectListen);
			resolveListen();
		});
	});

	const address = server.address() as AddressInfo;
	return {
		origin: `http://localhost:${address.port}`,
		stop: () => {
			for (const s of openSockets) {
				try {
					s.destroy();
				} catch {}
			}
			openSockets.clear();
			try {
				server.close();
			} catch {}
		},
	};
}
