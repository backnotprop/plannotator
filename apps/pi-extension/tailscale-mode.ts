import type { TailscaleRunner } from "./generated/tailscale.ts";
import {
	disableTailscaleServe,
	enableTailscaleServe,
} from "./generated/tailscale-serve.ts";

let tailscaleModeEnabled = false;

/** Enable or disable tailnet publishing for new Pi browser sessions. */
export function setTailscaleModeEnabled(enabled: boolean): void {
	tailscaleModeEnabled = enabled;
}

export function isTailscaleModeEnabled(): boolean {
	return tailscaleModeEnabled;
}

export interface PublishableBrowserServer {
	port: number;
	url: string;
	stop: () => void;
}

/**
 * Publish one loopback-bound Pi server through `tailscale serve` when the
 * runtime command enabled tailnet mode. The returned stop owns both the serve
 * mapping and the underlying server.
 */
export function publishBrowserServerOverTailscale(
	server: PublishableBrowserServer,
	run?: TailscaleRunner,
): { url: string; stop: () => void } {
	if (!tailscaleModeEnabled) return server;

	let publishedUrl: string;
	try {
		publishedUrl = enableTailscaleServe(server.port, run).url;
	} catch (error) {
		server.stop();
		throw error;
	}

	let stopped = false;
	return {
		url: publishedUrl,
		stop: () => {
			if (stopped) return;
			stopped = true;
			try {
				disableTailscaleServe(server.port, run);
			} finally {
				server.stop();
			}
		},
	};
}

/** Test-only: restore the process-local command state. */
export function resetTailscaleModeForTests(): void {
	tailscaleModeEnabled = false;
}
