/**
 * Host-header check for endpoints that must only answer the local machine.
 *
 * "Ask this session" injects real turns into the user's agent session, so its
 * Ask AI requests must come from a page loaded on loopback. A DNS-rebinding
 * page (evil.example resolved to 127.0.0.1) reaches the same socket but
 * carries its own name in the Host header; requiring a loopback name AND this
 * server's port refuses it. The bridge is already off in remote, SSH and
 * tailnet sessions, where a non-loopback Host is legitimate.
 *
 * Runtime-agnostic (vendored to Pi): plain string handling, no imports, so
 * Pi's AI runtime can load it under Node's strip-only TypeScript too.
 */

/**
 * A name under `.localhost` with at least one non-empty label in front
 * (`plannotator.localhost`, `a.b.localhost`), the shape browsers resolve to
 * loopback themselves (RFC 6761). Not `localhost` itself, not `.localhost`,
 * not `a..localhost`. Used for a dedicated cookie hostname (#2184).
 */
export function isLocalhostSubdomain(hostname: string): boolean {
	return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+localhost$/i.test(hostname);
}

/** `localhost` or a localhost subdomain (isLocalhostSubdomain). */
export function isLocalhostHostname(hostname: string): boolean {
	return hostname.toLowerCase() === "localhost" || isLocalhostSubdomain(hostname);
}

/** True for hostnames that name the local loopback: localhost, the IPv6
 * loopback, or a LITERAL IPv4 address in 127.0.0.0/8. A string-prefix test
 * would also match DNS names like 127.0.0.1.evil.example that resolve
 * anywhere, so the 127/8 rung requires exactly four numeric octets. WHATWG
 * URL parsing canonicalizes numeric spellings (127.1, 0177.0.0.1,
 * 2130706433) to dotted-decimal before a hostname reaches this check. */
export function isLoopbackHostname(hostname: string): boolean {
	const host = hostname.toLowerCase();
	if (host === "localhost" || host === "::1" || host === "[::1]") return true;
	const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!octets) return false;
	return Number(octets[1]) <= 255 && Number(octets[2]) <= 255 && Number(octets[3]) <= 255;
}

/**
 * True when every address in an `X-Forwarded-For` value is a loopback
 * address (an optional port allowed). A local reverse proxy (nginx, Caddy,
 * portless) adds loopback addresses; `tailscale serve` adds the peer's own
 * address, so anything else, or a missing or empty value, is false (#1867).
 */
export function isLoopbackForwardedFor(headerValue: string | null | undefined): boolean {
	if (!headerValue) return false;
	const parts = headerValue.split(",").map((p) => p.trim()).filter(Boolean);
	if (parts.length === 0) return false;
	return parts.every((part) => {
		let host = part;
		if (host.startsWith("[")) {
			const close = host.indexOf("]");
			if (close > 0) host = host.slice(0, close + 1);
		} else if (host.includes(":") && host.indexOf(":") === host.lastIndexOf(":")) {
			// IPv4 with a port (127.0.0.1:8080); several colons is a bare IPv6 address.
			host = host.slice(0, host.indexOf(":"));
		}
		return isLoopbackHostname(host);
	});
}

/**
 * True when `hostHeader` is `<loopback name>:<port>`: `localhost`, any
 * `127.x.y.z` literal, or `[::1]`, followed by exactly this server's port.
 * A missing port, another port, or any other name is refused.
 *
 * `localName` is the localhost subdomain the session was advertised at
 * (`urlHost: "plannotator.localhost"`, #2184): that one name is accepted
 * too. No other subdomain is, and without it the check is the plain
 * loopback one.
 */
export function isLoopbackHostHeader(
	hostHeader: string | null | undefined,
	port: number | null | undefined,
	localName?: string | null,
): boolean {
	if (!hostHeader || typeof port !== "number" || !Number.isInteger(port) || port <= 0) return false;
	const value = hostHeader.trim();
	let hostname: string;
	let portText: string;
	if (value.startsWith("[")) {
		const close = value.indexOf("]");
		if (close < 0) return false;
		hostname = value.slice(0, close + 1);
		const rest = value.slice(close + 1);
		if (!rest.startsWith(":")) return false;
		portText = rest.slice(1);
	} else {
		const colon = value.lastIndexOf(":");
		if (colon < 0 || value.indexOf(":") !== colon) return false;
		hostname = value.slice(0, colon);
		portText = value.slice(colon + 1);
	}
	if (!/^\d{1,5}$/.test(portText) || Number(portText) !== port) return false;
	if (isLoopbackHostname(hostname)) return true;
	return (
		typeof localName === "string" &&
		isLocalhostSubdomain(localName) &&
		hostname.toLowerCase() === localName.toLowerCase()
	);
}
