// Source: apps/rooms/src/external-refs/fetch.ts (Workspaces repo, main 7379b0195de140adc00b4496eefe553a3eec803e).
// Changed: the module-level test seam is gone; the fetcher is the port's, passed in.
//
// The ONE outbound-fetch policy for external references. Every byte an
// adapter exchanges with a provider goes through this wrapper, so tests
// fake providers at exactly this HTTP boundary (the port's fetch) and fake
// nothing inside the package. The wrapper adds a ten-second deadline,
// follows redirects itself (same origin only, at most 20 hops, so a
// credential header or a POST body never crosses to another origin), and
// writes one log line naming host, status and duration only.

import type { FetchLike, ProviderCallLog, ReferencePort } from "./port.ts";

const MAX_SAME_ORIGIN_REDIRECTS = 20;

/** The `user-agent` GitHub and GitLab calls carry when the port names none. */
export const DEFAULT_USER_AGENT = "plannotator-workspaces";

/** The port's user agent, or the default. */
export function providerUserAgent(port: Pick<ReferencePort, "userAgent">): string {
	return port.userAgent ?? DEFAULT_USER_AGENT;
}

/** The default log line: `console.info`, as Workspaces wrote it. */
const consoleLog: ProviderCallLog = (event, fields) => {
	console.info(event, fields);
};

/** One provider call through `fetcher`, under the policy above. `log`
 * receives the one line per call (default `console.info`). */
export async function externalRefsFetch(
	fetcher: FetchLike,
	input: string | URL | Request,
	init?: RequestInit,
	log: ProviderCallLog = consoleLog,
): Promise<Response> {
	const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
	const deadline = AbortSignal.timeout(10_000);
	const signal =
		callerSignal === undefined || callerSignal === null
			? deadline
			: AbortSignal.any([callerSignal, deadline]);
	const started = Date.now();
	const firstUrl = new URL(input instanceof Request ? input.url : input);
	const host = firstUrl.hostname;
	const method = (
		init?.method ?? (input instanceof Request ? input.method : "GET")
	).toUpperCase();
	const redirectMode = init?.redirect ?? (input instanceof Request ? input.redirect : undefined);
	const mayFollow =
		(redirectMode === undefined || redirectMode === "follow") &&
		(method === "GET" ||
			method === "HEAD" ||
			(method === "POST" &&
				(init?.body === undefined ||
					typeof init.body === "string" ||
					init.body instanceof URLSearchParams)));
	let status: number | undefined;
	try {
		let currentInput: string | URL | Request = input;
		let currentUrl = firstUrl;
		for (let hops = 0; ; hops += 1) {
			// A platform's automatic follow forwards custom credential headers and
			// POST bodies across origins. Check every hop before sending another request.
			const replayInput =
				mayFollow && method === "POST" && currentInput instanceof Request
					? currentInput.clone()
					: null;
			const response = await fetcher(currentInput, { ...init, signal, redirect: "manual" });
			status = response.status;
			if (
				!mayFollow ||
				hops >= MAX_SAME_ORIGIN_REDIRECTS ||
				!(method === "POST"
					? response.status === 307 || response.status === 308
					: [301, 302, 303, 307, 308].includes(response.status))
			) {
				return response;
			}
			const location = response.headers.get("location");
			if (location === null) return response;
			let nextUrl: URL;
			try {
				nextUrl = new URL(location, currentUrl);
			} catch {
				return response;
			}
			if (
				nextUrl.origin !== firstUrl.origin ||
				nextUrl.username !== "" ||
				nextUrl.password !== ""
			) {
				return response;
			}
			currentUrl = nextUrl;
			currentInput =
				input instanceof Request ? new Request(nextUrl, replayInput ?? input) : nextUrl;
		}
	} finally {
		// No path, query, headers, request body or credentials in the measurement.
		// A log that throws, or returns a promise that rejects, never turns
		// an answer into a throw or leaves an unhandled rejection.
		try {
			const written: unknown = log("external_ref_provider_call", {
				host,
				status,
				duration_ms: Date.now() - started,
			});
			// Any thenable, not only a native Promise.
			if (
				written !== null &&
				(typeof written === "object" || typeof written === "function") &&
				typeof (written as { then?: unknown }).then === "function"
			) {
				Promise.resolve(written as PromiseLike<unknown>).catch(() => {});
			}
		} catch {
			// The log line is best effort.
		}
	}
}

/** The fetch an adapter uses: the port's fetch behind the policy above,
 * logging to the port's `log` when it has one. The log is called as a
 * method of the port, so a `log` that reads `this` keeps it. */
export function providerFetch(port: Pick<ReferencePort, "fetch" | "log">): FetchLike {
	const log: ProviderCallLog =
		port.log === undefined ? consoleLog : (event, fields) => port.log?.(event, fields);
	return (input, init) => externalRefsFetch(port.fetch, input, init, log);
}
