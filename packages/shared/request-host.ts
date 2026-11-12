import { isLoopbackHostname } from "./loopback-host";

export const ALLOWED_HOSTS_ENV = "PLANNOTATOR_ALLOWED_HOSTS";
export const HOST_NOT_ALLOWED_CODE = "host_not_allowed";

export interface AllowedHostsSetting {
	any: boolean;
	names: string[];
}

export interface PortHostPattern {
	prefix: string;
	suffix: string;
}

export interface RequestHostPolicy {
	remote: boolean;
	extraHosts?: Iterable<string>;
	portHostPatterns?: readonly PortHostPattern[];
	allowed?: AllowedHostsSetting;
}

export function parseAllowedHosts(value: string | null | undefined): AllowedHostsSetting {
	const names: string[] = [];
	let any = false;
	for (const raw of (value ?? "").split(",")) {
		const entry = raw.trim().toLowerCase();
		if (!entry) continue;
		if (entry === "*") {
			any = true;
			continue;
		}
		const normalized = entry.startsWith(".") ? normalizeHostname(entry.slice(1)) : hostnameFromHostHeader(entry);
		if (!normalized) continue;
		names.push(entry.startsWith(".") ? `.${normalized}` : normalized);
	}
	return { any, names };
}

function normalizeHostname(value: string): string | null {
	let host = value.trim().toLowerCase();
	if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
	if (host.endsWith(".")) host = host.slice(0, -1);
	if (!host) return null;
	if (host.includes(":")) return /^[0-9a-f:.]+$/.test(host) ? host : null;
	return /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(host) ? host : null;
}

export function hostnameFromHostHeader(header: string | null | undefined): string | null | undefined {
	if (header === null || header === undefined) return undefined;
	const value = header.trim();
	if (!value) return undefined;
	let hostPart: string;
	let portPart: string | undefined;
	if (value.startsWith("[")) {
		const close = value.indexOf("]");
		if (close < 0) return null;
		hostPart = value.slice(0, close + 1);
		const rest = value.slice(close + 1);
		if (rest) {
			if (!rest.startsWith(":")) return null;
			portPart = rest.slice(1);
		}
	} else {
		const colon = value.indexOf(":");
		if (colon >= 0) {
			if (value.indexOf(":", colon + 1) >= 0) return null;
			hostPart = value.slice(0, colon);
			portPart = value.slice(colon + 1);
		} else {
			hostPart = value;
		}
	}
	if (portPart !== undefined && (!/^\d{1,5}$/.test(portPart) || Number(portPart) > 65535)) return null;
	if (hostPart.startsWith("[") !== hostPart.endsWith("]")) return null;
	if (hostPart.startsWith("[") && !hostPart.slice(1, -1).includes(":")) return null;
	return normalizeHostname(hostPart);
}

export function isIpLiteralHostname(hostname: string): boolean {
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
	if (v4) return v4.slice(1).every((octet) => Number(octet) <= 255);
	return hostname.includes(":") && /^[0-9a-f:.]+$/.test(hostname);
}

function isLoopbackName(hostname: string): boolean {
	return (
		isLoopbackHostname(hostname) ||
		hostname === "::1" ||
		hostname.endsWith(".localhost")
	);
}

const PORT_PLACEHOLDER = "{{port}}";

export function forwardedPortHostPatterns(proxyUri: string | null | undefined): PortHostPattern[] {
	const value = (proxyUri ?? "").trim();
	if (!value) return [];
	const match = /^https?:\/\/([^/?#@]+)/i.exec(value);
	if (!match) return [];
	const authority = match[1];
	const at = authority.indexOf(PORT_PLACEHOLDER);
	if (at < 0 || authority.indexOf(PORT_PLACEHOLDER, at + 1) >= 0) return [];
	const sample = hostnameFromHostHeader(authority.replace(PORT_PLACEHOLDER, "1"));
	if (!sample || sample.includes(":")) return [];
	const host = authority.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
	const placeholderAt = host.indexOf(PORT_PLACEHOLDER);
	if (placeholderAt < 0) return [];
	const prefix = host.slice(0, placeholderAt);
	const suffix = host.slice(placeholderAt + PORT_PLACEHOLDER.length);
	if (!suffix.includes(".") && !prefix.includes(".")) return [];
	return [{ prefix, suffix }];
}

function matchesPortHostPattern(hostname: string, pattern: PortHostPattern): boolean {
	if (!hostname.startsWith(pattern.prefix) || !hostname.endsWith(pattern.suffix)) return false;
	const middle = hostname.slice(pattern.prefix.length, hostname.length - pattern.suffix.length);
	return /^\d{1,5}$/.test(middle);
}

function matchesName(hostname: string, entry: string): boolean {
	if (entry.startsWith(".")) {
		const domain = entry.slice(1);
		return hostname === domain || hostname.endsWith(entry);
	}
	return hostname === entry;
}

export function isAllowedRequestHost(hostHeader: string | null | undefined, policy: RequestHostPolicy): boolean {
	if (policy.allowed?.any) return true;
	const hostname = hostnameFromHostHeader(hostHeader);
	if (hostname === undefined) return true;
	if (hostname === null) return false;
	if (isLoopbackName(hostname)) return true;
	if (policy.remote && isIpLiteralHostname(hostname)) return true;
	for (const extra of policy.extraHosts ?? []) {
		const normalized = normalizeHostname(extra);
		if (normalized && normalized === hostname) return true;
	}
	for (const pattern of policy.portHostPatterns ?? []) {
		if (matchesPortHostPattern(hostname, pattern)) return true;
	}
	for (const entry of policy.allowed?.names ?? []) {
		if (matchesName(hostname, entry)) return true;
	}
	return false;
}

export function isOriginNamedInAllowedHosts(
	originHeader: string | null | undefined,
	fetchSite: string | string[] | null | undefined,
	allowed: AllowedHostsSetting,
): boolean {
	const site = (Array.isArray(fetchSite) ? fetchSite[0] : fetchSite)?.trim();
	if (site) return false;
	const origin = originHeader?.trim();
	if (!origin || origin === "null") return false;
	let parsed: string | null;
	try {
		parsed = normalizeHostname(new URL(origin).hostname);
	} catch {
		return false;
	}
	const hostname = parsed;
	if (!hostname) return false;
	return allowed.names.some((entry) => matchesName(hostname, entry));
}

export function hostNotAllowedMessage(hostHeader: string | null | undefined): string {
	const hostname = hostnameFromHostHeader(hostHeader);
	const named = hostname ? `"${hostname}"` : "in this request";
	return (
		`Plannotator refused this request: the hostname ${named} is not one this session answers on. ` +
		`Open the session at the URL Plannotator printed. If you reach it through a proxy or a forwarded ` +
		`hostname, add that hostname to ${ALLOWED_HOSTS_ENV} (comma-separated; * turns this check off).\n`
	);
}

export function machineHostnames(hostname: string | null | undefined): string[] {
	const full = normalizeHostname(hostname ?? "");
	if (!full || full.includes(":") || isIpLiteralHostname(full)) return [];
	const short = full.split(".")[0];
	const names = [full];
	if (short && short !== full) names.push(short);
	if (short && !names.includes(`${short}.local`)) names.push(`${short}.local`);
	return names;
}
