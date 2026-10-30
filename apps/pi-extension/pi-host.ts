/**
 * Which host runs this extension: Pi, or Oh My Pi (OMP, a Pi fork that loads
 * this package as an OMP plugin through its legacy-Pi compat layer).
 *
 * Two things differ today. One is the `plannotator` tool's default
 * (AGENT_TOOL_DEFAULTS in packages/shared/config.ts): off on Pi, which sends
 * the full tool definition with every request, on in OMP, which lists an
 * extension tool as one line of its system prompt and loads the schema only
 * when the model reads it. The other is how a message reaches an idle agent
 * (`resolveIdleDeliveryOptions` in current-pi-session.ts). Everything else
 * (the session bridge, the commands, the Inbox tool) is the same extension
 * and still names itself `pi`.
 *
 * Neither host's ExtensionContext names the host, but OMP's ExtensionAPI
 * carries objects Pi's never has: `arktype` (OMP's injected omptype schema
 * builder) and `pi` (OMP's own SDK module). Pi's ExtensionAPI is a plain
 * object of methods with neither. Both must be present, so a Pi that someday
 * adds one of the names does not read as OMP.
 */

export type PiAgentToolHost = "pi" | "oh-my-pi";

/** The host that built `api`, read from the ExtensionAPI object itself. */
export function detectPiHost(api: unknown): PiAgentToolHost {
	if (typeof api !== "object" || api === null) return "pi";
	const candidate = api as { arktype?: unknown; pi?: unknown };
	const hasArktype = typeof candidate.arktype === "function" || (typeof candidate.arktype === "object" && candidate.arktype !== null);
	const hasSdk = typeof candidate.pi === "object" && candidate.pi !== null;
	return hasArktype && hasSdk ? "oh-my-pi" : "pi";
}

let currentHost: PiAgentToolHost = "pi";

/**
 * Record the host for this process. The extension calls it when it loads
 * (every instance: one per session and per /reload), so the review servers
 * it starts report the right tool host to the browser's Settings row.
 */
export function setPiHost(host: PiAgentToolHost): void {
	currentHost = host;
}

/** The host the extension recorded, `pi` until it loads. */
export function currentPiHost(): PiAgentToolHost {
	return currentHost;
}
