/**
 * node:http adapter for the cross-origin write guard
 * (packages/shared/request-origin.ts, vendored to generated/request-origin.ts).
 * Mirrors packages/server/request-origin-guard.ts: every Pi server (plan,
 * review, annotate) runs it right after the Host allowlist, before any route,
 * and refuses a POST, PUT, PATCH or DELETE that a page on another site sent
 * with 403 before anything is read or launched.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
	crossOriginRefusalBody,
	isSameOriginOrNoOrigin,
	isStateChangingMethod,
} from "../generated/request-origin.ts";

/** Whether a request may change state: same origin, the VS Code proxy, or no Origin. */
export function isSameOriginRequest(req: IncomingMessage): boolean {
	const origin = typeof req.headers.origin === "string" ? req.headers.origin : null;
	return isSameOriginOrNoOrigin(origin, req.headers.host ?? "", req.headers["sec-fetch-site"]);
}

/** Answers 403 and returns true when a state-changing request came from another site. */
export function refuseCrossOriginWrite(req: IncomingMessage, res: ServerResponse): boolean {
	if (!isStateChangingMethod(req.method)) return false;
	if (isSameOriginRequest(req)) return false;
	const body = JSON.stringify(crossOriginRefusalBody());
	res.writeHead(403, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(body),
	});
	res.end(body);
	return true;
}
