/**
 * node:http adapter for `isThisMachineReader`
 * (packages/shared/this-machine-reader.ts, vendored to
 * generated/this-machine-reader.ts): whether a request is a page on this
 * machine, for the reads that reach past the session's roots. Mirrors
 * packages/server/this-machine.ts, including `isSshTunnelRequest`: in a remote
 * session only SSH turned on, a request whose TCP peer is loopback, with a
 * loopback Host and no proxy header, is answered as in a local session.
 */

import type { IncomingMessage } from "node:http";
import { isLoopbackPeerAddress, isThisMachineReader } from "../generated/this-machine-reader.ts";
import { isRemoteSession, isSshDetectedRemote } from "./network.ts";

function headersOf(req: IncomingMessage): Headers {
	const headers = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) for (const item of value) headers.append(key, item);
		else headers.set(key, value);
	}
	return headers;
}

/** In a remote session only SSH turned on: whether this request came over loopback with a loopback Host and no proxy header. */
export function isSshTunnelRequest(req: IncomingMessage): boolean {
	return isSshDetectedRemote() && isLoopbackPeerAddress(req.socket?.remoteAddress) && isThisMachineReader(false, headersOf(req));
}

export function isThisMachineRequest(req: IncomingMessage): boolean {
	return isThisMachineReader(isRemoteSession() && !isSshTunnelRequest(req), headersOf(req));
}
