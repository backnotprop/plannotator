const DEFAULT_TIMEOUT_MS = 10_000;
const ROAM_API_VERSION = "1.1.2";

interface RoamConfigShape {
	graphName: string;
	graphType: "hosted" | "offline";
	token: string;
	port: number;
}

export interface RoamRequestConfig {
	graphName: string;
	graphType: "hosted" | "offline";
	token: string;
	port: number;
}

export class RoamClientError extends Error {
	override cause?: unknown;

	constructor(message: string, options?: { cause?: unknown }) {
		super(message);
		this.name = new.target.name;
		this.cause = options?.cause;
	}
}

export class RoamConnectionError extends RoamClientError {}
export class RoamAuthError extends RoamClientError {}
export class RoamTimeoutError extends RoamClientError {}

export class RoamVersionMismatchError extends RoamClientError {
	actualVersion?: string;

	constructor(message: string, options?: { actualVersion?: string; cause?: unknown }) {
		super(message, options);
		this.actualVersion = options?.actualVersion;
	}
}

interface RoamEnvelope<T> {
	success?: boolean;
	result?: T;
	error?: string;
	message?: string;
	apiVersion?: string;
	actualApiVersion?: string;
	version?: string;
}

export async function callRoamLocalApi<T>(
	config:
		| RoamRequestConfig
		| Pick<RoamConfigShape, "graphName" | "graphType" | "token" | "port">,
	action: string,
	args: unknown[],
	options: { timeoutMs?: number } = {},
): Promise<T> {
	const payload = await callRoamLocalApiEnvelope<T>(config, action, args, options);
	return payload.result;
}

export async function callRoamLocalApiEnvelope<T>(
	config:
		| RoamRequestConfig
		| Pick<RoamConfigShape, "graphName" | "graphType" | "token" | "port">,
	action: string,
	args: unknown[],
	options: { timeoutMs?: number } = {},
): Promise<{ result: T; apiVersion?: string }> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const controller = new AbortController();
	let didTimeout = false;
	const timeout = setTimeout(() => {
		didTimeout = true;
		controller.abort("timeout");
	}, timeoutMs);

	try {
		const response = await fetch(buildRoamUrl(config), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${config.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				action,
				args,
				expectedApiVersion: ROAM_API_VERSION,
			}),
			signal: controller.signal,
		});

		const payload = await parseRoamResponse<T>(response);
		const actualVersion = extractApiVersion(payload);
		if (actualVersion && !majorMinorMatches(actualVersion, ROAM_API_VERSION)) {
			throw new RoamVersionMismatchError(
				`Roam API version mismatch: expected ${ROAM_API_VERSION}, got ${actualVersion}`,
				{ actualVersion },
			);
		}

		if (response.status === 401 || response.status === 403) {
			throw new RoamAuthError(
				extractErrorMessage(payload, "Roam authentication failed"),
			);
		}

		if (!response.ok) {
			throw new RoamClientError(
				extractErrorMessage(
					payload,
					`Roam request failed with status ${response.status}`,
				),
			);
		}

		if (payload.success === false) {
			throw new RoamClientError(
				extractErrorMessage(payload, "Roam request failed"),
			);
		}

		return {
			result: (payload?.result ?? payload) as T,
			apiVersion: actualVersion,
		};
	} catch (error) {
		if (error instanceof RoamClientError) {
			throw error;
		}
		if (didTimeout || isAbortError(error)) {
			throw new RoamTimeoutError(
				`Roam request timed out after ${timeoutMs}ms`,
				{ cause: error },
			);
		}
		throw new RoamConnectionError("Unable to reach the Roam local API", {
			cause: error,
		});
	} finally {
		clearTimeout(timeout);
	}
}

function buildRoamUrl(config: RoamRequestConfig): string {
	const url = new URL(
		`http://127.0.0.1:${config.port}/api/${encodeURIComponent(config.graphName)}`,
	);
	if (config.graphType === "offline") {
		url.searchParams.set("type", "offline");
	}
	return url.toString();
}

async function parseRoamResponse<T>(response: Response): Promise<RoamEnvelope<T>> {
	const text = await response.text();
	if (!text) {
		return {};
	}

	try {
		return JSON.parse(text) as RoamEnvelope<T>;
	} catch {
		return { error: text };
	}
}

function extractApiVersion(payload: RoamEnvelope<unknown> | undefined): string | undefined {
	if (!payload || typeof payload !== "object") {
		return undefined;
	}
	if (typeof payload.actualApiVersion === "string") return payload.actualApiVersion;
	if (typeof payload.apiVersion === "string") return payload.apiVersion;
	if (typeof payload.version === "string") return payload.version;
	return undefined;
}

function extractErrorMessage(
	payload: RoamEnvelope<unknown> | undefined,
	fallback: string,
): string {
	if (!payload || typeof payload !== "object") {
		return fallback;
	}
	if (typeof payload.error === "string" && payload.error.trim()) return payload.error;
	if (typeof payload.message === "string" && payload.message.trim()) {
		return payload.message;
	}
	return fallback;
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException
		? error.name === "AbortError"
		: error instanceof Error && error.name === "AbortError";
}

function majorMinorMatches(a: string, b: string): boolean {
	const parsedA = parseMajorMinorVersion(a);
	const parsedB = parseMajorMinorVersion(b);
	if (!parsedA || !parsedB) {
		return false;
	}

	return parsedA.major === parsedB.major && parsedA.minor === parsedB.minor;
}

function parseMajorMinorVersion(version: string): { major: number; minor: number } | null {
	const match = version.trim().match(/^(\d+)\.(\d+)(?:\.\d+)?(?:[-+].*)?$/);
	if (!match) {
		return null;
	}

	return {
		major: Number(match[1]),
		minor: Number(match[2]),
	};
}
