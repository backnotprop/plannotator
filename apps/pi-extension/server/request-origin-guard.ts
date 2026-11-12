import type { IncomingMessage, ServerResponse } from "node:http";
import {
	crossOriginRefusalBody,
	isSameOriginOrNoOrigin,
	isStateChangingMethod,
} from "../generated/request-origin.ts";
import { ALLOWED_HOSTS_ENV, isOriginNamedInAllowedHosts, parseAllowedHosts } from "../generated/request-host.ts";

export function isSameOriginRequest(req: IncomingMessage): boolean {
	const origin = typeof req.headers.origin === "string" ? req.headers.origin : null;
	const site = req.headers["sec-fetch-site"];
	if (isSameOriginOrNoOrigin(origin, req.headers.host ?? "", site)) return true;
	return isOriginNamedInAllowedHosts(origin, site, parseAllowedHosts(process.env[ALLOWED_HOSTS_ENV]));
}

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
