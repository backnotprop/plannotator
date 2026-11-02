/**
 * node:http adapter for `isThisMachineReader`
 * (packages/shared/this-machine-reader.ts, vendored to
 * generated/this-machine-reader.ts): whether a request is a page on this
 * machine, for the reads that reach past the session's roots. Mirrors
 * packages/server/this-machine.ts.
 */

import type { IncomingMessage } from "node:http";
import { isThisMachineReader } from "../generated/this-machine-reader.ts";
import { isRemoteSession } from "./network.ts";

export function isThisMachineRequest(req: IncomingMessage): boolean {
	const headers = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) for (const item of value) headers.append(key, item);
		else headers.set(key, value);
	}
	return isThisMachineReader(isRemoteSession(), headers);
}
