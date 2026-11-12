export function isLocalhostSubdomain(hostname: string): boolean {
	return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+localhost$/i.test(hostname);
}

export function isLocalhostHostname(hostname: string): boolean {
	return hostname.toLowerCase() === "localhost" || isLocalhostSubdomain(hostname);
}

export function isLoopbackHostname(hostname: string): boolean {
	const host = hostname.toLowerCase();
	if (host === "localhost" || host === "::1" || host === "[::1]") return true;
	const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!octets) return false;
	return Number(octets[1]) <= 255 && Number(octets[2]) <= 255 && Number(octets[3]) <= 255;
}

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
			host = host.slice(0, host.indexOf(":"));
		}
		return isLoopbackHostname(host);
	});
}

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
