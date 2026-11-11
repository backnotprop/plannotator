/** Host-header check for endpoints that must only answer the local machine: a DNS-rebinding page carries its own name in Host, so require a loopback name AND this server's port. No imports, so Pi can load it under Node's strip-only TypeScript. */

/** A name under `.localhost` with a non-empty label in front (`a.b.localhost`); not `localhost` itself. */
export function isLocalhostSubdomain(hostname: string): boolean {
	return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+localhost$/i.test(hostname);
}

export function isLocalhostHostname(hostname: string): boolean {
	return hostname.toLowerCase() === "localhost" || isLocalhostSubdomain(hostname);
}

/** True for localhost, the IPv6 loopback, or a literal IPv4 in 127.0.0.0/8. The 127/8 rung requires exactly four numeric octets: a prefix test would match DNS names like 127.0.0.1.evil.example. */
export function isLoopbackHostname(hostname: string): boolean {
	const host = hostname.toLowerCase();
	if (host === "localhost" || host === "::1" || host === "[::1]") return true;
	const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!octets) return false;
	return Number(octets[1]) <= 255 && Number(octets[2]) <= 255 && Number(octets[3]) <= 255;
}

/** True when every address in an `X-Forwarded-For` value is loopback (optional port); anything else, missing or empty is false. */
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

/** True when `hostHeader` is a loopback name followed by exactly this server's port. `localName` is the one extra localhost subdomain accepted. */
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
