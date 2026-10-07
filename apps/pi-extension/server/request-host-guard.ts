/**
 * node:http adapter for the Host-header allowlist
 * (packages/shared/request-host.ts, vendored to generated/request-host.ts).
 * Mirrors packages/server/request-host-guard.ts: every Pi server (plan,
 * review, annotate) builds one guard at start, refuses a disallowed Host
 * before any route, and guards WebSocket upgrades too (the annotate agent
 * terminal attaches its own `upgrade` listener, which never sees a refused
 * request). Pi has no `--tailscale`, so there are no served hostnames here.
 */

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import os from "node:os";
import { loadConfig, resolveUrlHost } from "../generated/config.ts";
import {
	ALLOWED_HOSTS_ENV,
	HOST_NOT_ALLOWED_CODE,
	hostNotAllowedMessage,
	isAllowedRequestHost,
	machineHostnames,
	parseAllowedHosts,
	type RequestHostPolicy,
} from "../generated/request-host.ts";
import { isAutoUrlHost, resolveAutoHostCached } from "../generated/tailscale.ts";
import { isRemoteSession } from "./network.ts";

function remoteExtraHosts(): string[] {
	const hosts = machineHostnames(os.hostname());
	try {
		const urlHost = resolveUrlHost(loadConfig());
		const resolved = urlHost && isAutoUrlHost(urlHost) ? resolveAutoHostCached() : urlHost;
		if (resolved) hosts.push(resolved);
	} catch {
		// A broken config never widens the allowlist.
	}
	return hosts;
}

function hostHeader(req: IncomingMessage): string | undefined {
	const value = req.headers.host;
	return typeof value === "string" ? value : undefined;
}

export interface PiRequestHostGuard {
	/** Answers 403 and returns true when the request's Host is not allowed. */
	refuse(req: IncomingMessage, res: ServerResponse): boolean;
	/** Refuse disallowed WebSocket upgrades on `server` (call before it listens). */
	attach(server: Server): void;
}

/** Build the guard for one server. Env and config are read once, here. */
export function createRequestHostGuard(): PiRequestHostGuard {
	const remote = isRemoteSession();
	const allowed = parseAllowedHosts(process.env[ALLOWED_HOSTS_ENV]);
	// Remote-mode names are resolved on the first request that needs them, so
	// loopback and IP-literal requests never read config or ask Tailscale.
	let remoteHosts: string[] | null = null;
	const allows = (req: IncomingMessage): boolean => {
		const host = hostHeader(req);
		const policy: RequestHostPolicy = { remote, allowed };
		if (isAllowedRequestHost(host, policy)) return true;
		if (!remote) return false;
		remoteHosts ??= remoteExtraHosts();
		return isAllowedRequestHost(host, { ...policy, extraHosts: remoteHosts });
	};

	return {
		attach(server) {
			// node:http hands an upgrade to EVERY `upgrade` listener, so a
			// prepended listener cannot stop the others. Intercept the event.
			const emit = server.emit.bind(server) as (event: string | symbol, ...args: unknown[]) => boolean;
			server.emit = ((event: string | symbol, ...args: unknown[]) => {
				if (event === "upgrade") {
					const req = args[0] as IncomingMessage;
					const socket = args[1] as Duplex;
					if (!allows(req)) {
						const body = hostNotAllowedMessage(hostHeader(req));
						socket.end(
							`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
						);
						return true;
					}
				}
				return emit(event, ...args);
			}) as typeof server.emit;
		},
		refuse(req, res) {
			if (allows(req)) return false;
			const body = hostNotAllowedMessage(hostHeader(req));
			res.writeHead(403, {
				"Content-Type": "text/plain; charset=utf-8",
				"X-Content-Type-Options": "nosniff",
				"X-Plannotator-Error": HOST_NOT_ALLOWED_CODE,
				"Content-Length": Buffer.byteLength(body),
			});
			res.end(body);
			return true;
		},
	};
}
