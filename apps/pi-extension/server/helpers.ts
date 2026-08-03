/**
 * Core HTTP helpers for Pi extension servers.
 * parseBody, json, handleApiNotFound, html, send, toWebRequest
 */

import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";

export function parseBody(
	req: IncomingMessage,
): Promise<Record<string, unknown>> {
	return new Promise((resolve) => {
		let data = "";
		req.on("data", (chunk: string) => (data += chunk));
		req.on("end", () => {
			try {
				resolve(JSON.parse(data));
			} catch {
				resolve({});
			}
		});
	});
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

export function html(
	res: import("node:http").ServerResponse,
	content: string,
): void {
	res.writeHead(200, { "Content-Type": "text/html" });
	res.end(content);
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
