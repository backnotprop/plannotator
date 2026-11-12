import type { FetchLike, ProviderCallLog, ReferencePort } from "./port.ts";

const MAX_SAME_ORIGIN_REDIRECTS = 20;

export const DEFAULT_USER_AGENT = "plannotator-workspaces";

export function providerUserAgent(port: Pick<ReferencePort, "userAgent">): string {
	return port.userAgent ?? DEFAULT_USER_AGENT;
}

const consoleLog: ProviderCallLog = (event, fields) => {
	console.info(event, fields);
};

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
		try {
			const written: unknown = log("external_ref_provider_call", {
				host,
				status,
				duration_ms: Date.now() - started,
			});
			if (
				written !== null &&
				(typeof written === "object" || typeof written === "function") &&
				typeof (written as { then?: unknown }).then === "function"
			) {
				Promise.resolve(written as PromiseLike<unknown>).catch(() => {});
			}
		} catch {
		}
	}
}

export function providerFetch(port: Pick<ReferencePort, "fetch" | "log">): FetchLike {
	const log: ProviderCallLog =
		port.log === undefined ? consoleLog : (event, fields) => port.log?.(event, fields);
	return (input, init) => externalRefsFetch(port.fetch, input, init, log);
}
