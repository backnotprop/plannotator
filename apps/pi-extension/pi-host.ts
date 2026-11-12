export type PiAgentToolHost = "pi" | "oh-my-pi";

export function detectPiHost(api: unknown): PiAgentToolHost {
	if (typeof api !== "object" || api === null) return "pi";
	const candidate = api as { arktype?: unknown; pi?: unknown };
	const hasArktype = typeof candidate.arktype === "function" || (typeof candidate.arktype === "object" && candidate.arktype !== null);
	const hasSdk = typeof candidate.pi === "object" && candidate.pi !== null;
	return hasArktype && hasSdk ? "oh-my-pi" : "pi";
}

let currentHost: PiAgentToolHost = "pi";

export function setPiHost(host: PiAgentToolHost): void {
	currentHost = host;
}

export function currentPiHost(): PiAgentToolHost {
	return currentHost;
}
