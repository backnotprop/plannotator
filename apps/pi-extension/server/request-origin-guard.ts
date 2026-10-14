/**
 * node:http adapter for the cross-origin write guard
 * (packages/shared/request-origin.ts, vendored to generated/request-origin.ts).
 * Mirrors packages/server/request-origin-guard.ts: every Pi server (plan,
 * review, annotate) runs it right after the Host allowlist, before any route,
 * and refuses a POST, PUT, PATCH or DELETE that a page on another site sent
 * with 403 before anything is read or launched. An Origin whose hostname
 * PLANNOTATOR_ALLOWED_HOSTS names explicitly (not `*`) also passes.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
	crossOriginRefusalBody,
	isSameOriginOrNoOrigin,
	isStateChangingMethod,
} from "../generated/request-origin.ts";
import { ALLOWED_HOSTS_ENV, isOriginNamedInAllowedHosts, parseAllowedHosts } from "../generated/request-host.ts";

/**
 * Whether a request may change state: no Origin, the session's own origin,
 * the VS Code proxy, or an Origin named in PLANNOTATOR_ALLOWED_HOSTS (read on
 * each call).
 */
export function isSameOriginRequest(req: IncomingMessage): boolean {
	const origin = typeof req.headers.origin === "string" ? req.headers.origin : null;
	const site = req.headers["sec-fetch-site"];
	if (isSameOriginOrNoOrigin(origin, req.headers.host ?? "", site)) return true;
	return isOriginNamedInAllowedHosts(origin, site, parseAllowedHosts(process.env[ALLOWED_HOSTS_ENV]));
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
