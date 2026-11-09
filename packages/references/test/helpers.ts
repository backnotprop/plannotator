// Test helpers: a fake provider behind the port's fetch, and a port built
// around it. Nothing inside the package is faked; providers are faked at the
// HTTP boundary only. Fixture values are low-entropy on purpose.

import type { ProviderId } from "../src/contract.ts";
import type { FetchLike, ReferenceCredentialAnswer, ReferencePort } from "../src/port.ts";

export interface SeenCall {
	readonly method: string;
	/** Absolute URL, query kept, fragment dropped. */
	readonly url: string;
	readonly headers: Headers;
	readonly body: string | null;
}

export type Handler = (call: SeenCall) => Response | Promise<Response>;

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

/** A fake provider. Routes are keyed "METHOD absolute-url" (query
 * included). A value is a handler, or a list of handlers served in order
 * (the last one repeats). An unknown route answers 404. */
export function fakeProvider() {
	const routes = new Map<string, Handler[]>();
	const calls: SeenCall[] = [];
	const fetch: FetchLike = async (input, init) => {
		const request = input instanceof Request ? input : null;
		const url = new URL(request !== null ? request.url : input.toString());
		url.hash = "";
		const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
		const headers = new Headers(init?.headers ?? request?.headers);
		let body: string | null = null;
		if (typeof init?.body === "string") body = init.body;
		else if (init?.body instanceof URLSearchParams) body = init.body.toString();
		else if (request !== null && request.body !== null) body = await request.clone().text();
		const call: SeenCall = { method, url: url.href, headers, body };
		calls.push(call);
		const queue = routes.get(`${method} ${url.href}`);
		if (queue === undefined || queue.length === 0) return json(404, { message: "Not Found" });
		const handler = queue.length > 1 ? queue.shift() : queue[0];
		if (handler === undefined) return json(404, { message: "Not Found" });
		return handler(call);
	};
	return {
		fetch,
		calls,
		/** Arm a route. */
		on(key: string, ...handlers: Handler[]): void {
			routes.set(key, handlers);
		},
		reset(): void {
			routes.clear();
			calls.length = 0;
		},
	};
}

/** A port over a fetch. `credentials` answers by "provider host"; a
 * function answers every call. Every credential request is recorded. */
export function makePort(
	fetch: FetchLike,
	credentials:
		| Record<string, ReferenceCredentialAnswer>
		| ((provider: ProviderId, host: string) => Promise<ReferenceCredentialAnswer>) = {},
): ReferencePort & { asked: string[] } {
	const asked: string[] = [];
	return {
		fetch,
		asked,
		async credential(provider, host) {
			asked.push(`${provider} ${host}`);
			if (typeof credentials === "function") return credentials(provider, host);
			return credentials[`${provider} ${host}`] ?? null;
		},
	};
}
