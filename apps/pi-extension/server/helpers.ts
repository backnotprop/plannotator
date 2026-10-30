/**
 * Core HTTP helpers for Pi extension servers.
 * parseBody, parseJsonBody, json, handleApiNotFound, serveApp, send, toWebRequest
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { PackedApp } from "../generated/packed-app.ts";

/** The raw request body as text (for endpoints where an empty body is meaningful, e.g. all-optional JSON). */
export function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk: string) => (data += chunk));
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});
}

export async function parseBody(
	req: IncomingMessage,
): Promise<Record<string, unknown>> {
	try {
		return JSON.parse(await readBody(req));
	} catch {
		return {};
	}
}

/**
 * Decode a request body as JSON and reject malformed input.
 *
 * Use this for endpoints where an empty object is a valid command and parse
 * failure must remain distinguishable from that command. Legacy endpoints
 * continue to use {@link parseBody}, which deliberately falls back to `{}`.
 */
export async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
	return JSON.parse(await readBody(req));
}

export function json(
	res: import("node:http").ServerResponse,
	data: unknown,
	status = 200,
): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(data));
}

/** Return the shared JSON response for an unmatched API route. */
export function handleApiNotFound(
	res: import("node:http").ServerResponse,
	path: string,
): void {
	json(res, { error: "Not found", path }, 404);
}

/**
 * Serve the built app to every route no other handler claimed: a chunk or
 * asset packed into it under `/assets/`, else the page itself (SPA). Remote
 * sessions get the page and text chunks compressed when the client accepts
 * br/gzip (#1617); local sessions get them unchanged. Mirrors the Bun servers'
 * `packedAppResponse` (generated/packed-app.ts, shared with them).
 */
export async function serveApp(
	app: PackedApp,
	req: IncomingMessage,
	res: ServerResponse,
	pathname: string,
	compress: boolean,
): Promise<void> {
	const answer = await app.answer(pathname, req.method, req.headers["accept-encoding"], compress);
	res.writeHead(answer.status, answer.headers);
	res.end(answer.body);
}

export function send(
	res: import("node:http").ServerResponse,
	body: string | Buffer,
	status = 200,
	headers: Record<string, string> = {},
): void {
	res.writeHead(status, headers);
	res.end(body);
}

export function requestUrl(req: IncomingMessage): URL {
	return new URL(req.url ?? "/", "http://localhost");
}

export function toWebRequest(req: IncomingMessage): Request {
	const headers = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			for (const item of value) headers.append(key, item);
		} else {
			headers.set(key, value);
		}
	}

	const init: RequestInit & { duplex?: "half" } = {
		method: req.method,
		headers,
	};

	if (req.method !== "GET" && req.method !== "HEAD") {
		init.body = Readable.toWeb(req) as unknown as BodyInit;
		init.duplex = "half";
	}

	return new Request(`http://localhost${req.url ?? "/"}`, init);
}
