/**
 * node:http adapter for the network key (packages/shared/network-key.ts,
 * #956), the Pi mirror of packages/server/network-key-guard.ts. Every Pi
 * session server (plan, review, annotate) builds one guard at start, calls
 * `refuse` right after the Host allowlist in its handler, before any route,
 * and `attach` before it listens, so WebSocket upgrades are covered too. On
 * only in a remote session that SSH alone turned on (`isSshDetectedRemote`).
 */

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { getPlannotatorDataDir } from "../generated/data-dir.ts";
import {
	loadNetworkKey,
	NETWORK_KEY_REFUSAL_HTML,
	NETWORK_KEY_REQUIRED_CODE,
	networkKeyRefusalBody,
	networkKeyVerdict,
	type NetworkKeyVerdict,
} from "../generated/network-key.ts";
import { requestUrl } from "./helpers.ts";
import { isSshDetectedRemote } from "./network.ts";

export interface PiNetworkKeyGuard {
	/** Answers the request (401, or the cookie-setting redirect) and returns true when it may not go on. */
	refuse(req: IncomingMessage, res: ServerResponse): boolean;
	/** Refuse WebSocket upgrades without the key on `server` (call before it listens). */
	attach(server: Server): void;
}

function header(req: IncomingMessage, name: string): string | undefined {
	const value = req.headers[name];
	return Array.isArray(value) ? value.join(", ") : value;
}

/** Build the guard for one server. Env is read once, here. */
export function createNetworkKeyGuard(): PiNetworkKeyGuard {
	if (!isSshDetectedRemote()) return { refuse: () => false, attach: () => {} };
	const key = loadNetworkKey(getPlannotatorDataDir());
	const verdictOf = (req: IncomingMessage, upgrade: boolean): NetworkKeyVerdict => {
		// Parsed once, exactly as the routes parse it (helpers.ts requestUrl).
		let url: URL;
		try {
			url = requestUrl(req);
		} catch {
			return { kind: "refuse", page: false };
		}
		return networkKeyVerdict(
			{
				method: req.method ?? "GET",
				pathname: url.pathname,
				search: url.search,
				peer: req.socket?.remoteAddress,
				cookie: header(req, "cookie"),
				secFetchDest: header(req, "sec-fetch-dest"),
				accept: header(req, "accept"),
				upgrade,
			},
			key,
		);
	};
	return {
		attach(server) {
			// node:http hands an upgrade to EVERY `upgrade` listener, so intercept
			// the event (as request-host-guard.ts does).
			const emit = server.emit.bind(server) as (event: string | symbol, ...args: unknown[]) => boolean;
			server.emit = ((event: string | symbol, ...args: unknown[]) => {
				if (event === "upgrade") {
					const req = args[0] as IncomingMessage;
					const socket = args[1] as Duplex;
					if (verdictOf(req, true).kind === "refuse") {
						const body = networkKeyRefusalBody().error;
						socket.end(
							`HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain; charset=utf-8\r\nX-Plannotator-Error: ${NETWORK_KEY_REQUIRED_CODE}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
						);
						return true;
					}
				}
				return emit(event, ...args);
			}) as typeof server.emit;
		},
		refuse(req, res) {
			const verdict = verdictOf(req, false);
			if (verdict.kind === "pass") return false;
			if (verdict.kind === "keep") {
				res.writeHead(303, {
					Location: verdict.location,
					"Set-Cookie": verdict.setCookie,
					"Cache-Control": "no-store",
					"Referrer-Policy": "no-referrer",
				});
				res.end();
				return true;
			}
			const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Plannotator-Error": NETWORK_KEY_REQUIRED_CODE };
			if (verdict.page) {
				res.writeHead(401, { ...headers, "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(NETWORK_KEY_REFUSAL_HTML) });
				res.end(req.method === "HEAD" ? undefined : NETWORK_KEY_REFUSAL_HTML);
				return true;
			}
			const body = JSON.stringify(networkKeyRefusalBody());
			res.writeHead(401, { ...headers, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
			res.end(body);
			return true;
		},
	};
}
