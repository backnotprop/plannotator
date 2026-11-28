/**
 * Loopback requests never go through a proxy.
 *
 * Bun's `fetch` (and Bun 1.3's node:http) sends `http://127.0.0.1`
 * and `http://localhost` through `http_proxy` / `HTTP_PROXY` / `ALL_PROXY`
 * when the person's shell exports one (VPN and proxy tools do). The proxy
 * cannot reach this machine's loopback, so every health check against a
 * running Inbox failed: `inbox status` said "not running" while it served,
 * a send started a second Inbox in the same data folder, and the person's
 * own Inbox then exited (#3350).
 *
 * Two forms, for two kinds of process:
 * - The CLI owns its process: `bypassProxyForLoopback(process.env)` at start
 *   adds the loopback names to `NO_PROXY` / `no_proxy`. Bun reads them at
 *   each request, and every child the CLI starts (the detached Inbox,
 *   `inbox mcp`, git, agents) inherits them.
 * - Code that runs inside someone else's process (the OpenCode plugin, the
 *   Pi extension) must not change that process's environment: it passes
 *   `directFetchInit(init)`, which adds `proxy: false` (Bun 1.4: "connects
 *   directly, even when HTTP_PROXY / HTTPS_PROXY / ALL_PROXY are set").
 *   Node's fetch ignores the key; it uses no proxy unless NODE_USE_ENV_PROXY
 *   is set.
 *
 * Runtime-agnostic and import-free: vendored into the Pi extension.
 */

/** The names Bun's NO_PROXY match needs for this machine's own servers. */
export const LOOPBACK_NO_PROXY_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "::1"];

/** `value` with every loopback name added that it does not already hold (case-insensitive), existing entries kept in order. */
export function withLoopbackNoProxy(value: string | undefined): string {
	const entries = (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
	const held = new Set(entries.map((entry) => entry.toLowerCase()));
	for (const host of LOOPBACK_NO_PROXY_HOSTS) if (!held.has(host)) entries.push(host);
	return entries.join(",");
}

/**
 * Add the loopback names to `NO_PROXY` and `no_proxy` in `env`. When only one
 * of the two is set, both get its entries, so a runtime that reads the other
 * spelling first does not lose them. When both are set, each keeps its own.
 */
export function bypassProxyForLoopback(env: Record<string, string | undefined>): void {
	const upper = env.NO_PROXY;
	const lower = env.no_proxy;
	env.NO_PROXY = withLoopbackNoProxy(upper ?? lower);
	env.no_proxy = withLoopbackNoProxy(lower ?? upper);
}

/** `init` for a loopback `fetch` from a host process: a direct connection, whatever proxy the environment names. */
export function directFetchInit<T extends object>(init: T): T {
	return { ...init, proxy: false } as T;
}
