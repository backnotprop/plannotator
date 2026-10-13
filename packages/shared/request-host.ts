/**
 * Host-header allowlist every Plannotator server applies to EVERY request
 * (API, app HTML, WebSocket upgrades) before routing.
 *
 * The same-origin check on write endpoints (`isSameOriginOrNoOrigin`,
 * request-origin.ts) compares Origin with Host, which cannot tell the
 * session's own page from a page served under some other DNS name that
 * happens to resolve to this machine: both carry matching Origin and Host.
 * The Host header still names the hostname the browser used, so refusing
 * names this session does not answer on closes that gap for every endpoint at
 * once. IP literals and loopback names cannot be re-pointed by DNS, so they
 * are what the rule is built from.
 *
 * The rule:
 *  - No Host header: allowed (a non-browser HTTP/1.0 client; browsers always
 *    send one).
 *  - Loopback names (`localhost`, `*.localhost`, 127.0.0.0/8 literals,
 *    `[::1]`): allowed in every mode.
 *  - Remote mode (wide bind): also any IPv4 or IPv6 literal (a LAN address,
 *    a container address), plus `extraHosts` (the configured urlHost and this
 *    machine's own hostname, supplied by the runtime adapter).
 *  - `extraHosts` in any mode: names a runtime learned it is served on (the
 *    `tailscale serve` MagicDNS name of a `--tailscale` session).
 *  - `portHostPatterns` in any mode: the per-port hostnames of a browser IDE's
 *    port proxy (code-server, Coder), read from the `{{port}}` template in the
 *    `VSCODE_PROXY_URI` the IDE sets (`forwardedPortHostPatterns`). Such a
 *    proxy reaches a loopback-bound server and forwards its own Host.
 *  - `PLANNOTATOR_ALLOWED_HOSTS`: a comma list of extra hostnames (a leading
 *    dot matches the domain and its subdomains); `*` turns the check off.
 *  - Everything else, including a malformed Host, is refused.
 *
 * The port is deliberately not compared: forwarded ports (`ssh -L`, VS Code
 * port forwarding, `docker -p`) legitimately arrive with a different port,
 * and a hostile name is refused by its hostname alone.
 *
 * Pure and dependency-free apart from loopback-host.ts; vendored to Pi
 * (generated/request-host.ts).
 */

import { isLoopbackHostname } from "./loopback-host";

export const ALLOWED_HOSTS_ENV = "PLANNOTATOR_ALLOWED_HOSTS";
export const HOST_NOT_ALLOWED_CODE = "host_not_allowed";

export interface AllowedHostsSetting {
	/** `*`: the Host check is off. */
	any: boolean;
	/** Lower-cased hostnames; an entry starting with `.` matches a suffix. */
	names: string[];
}

/** A hostname shape `<prefix><port digits><suffix>` (see forwardedPortHostPatterns). */
export interface PortHostPattern {
	prefix: string;
	suffix: string;
}

export interface RequestHostPolicy {
	/** Remote mode: the server binds every interface. */
	remote: boolean;
	/** Hostnames this session is served on besides loopback (see above). */
	extraHosts?: Iterable<string>;
	/** Per-port proxy hostnames of a browser IDE (see above). */
	portHostPatterns?: readonly PortHostPattern[];
	/** Parsed `PLANNOTATOR_ALLOWED_HOSTS`. */
	allowed?: AllowedHostsSetting;
}

/** Parse `PLANNOTATOR_ALLOWED_HOSTS`. Empty or unset allows nothing extra. */
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
		// A plain entry may carry a port (`proxy.example.com:8443`); the port is
		// never compared, so it is dropped rather than voiding the entry.
		const normalized = entry.startsWith(".") ? normalizeHostname(entry.slice(1)) : hostnameFromHostHeader(entry);
		if (!normalized) continue;
		names.push(entry.startsWith(".") ? `.${normalized}` : normalized);
	}
	return { any, names };
}

/** Lower-case, drop a trailing dot and IPv6 brackets; null when not a plausible hostname. */
function normalizeHostname(value: string): string | null {
	let host = value.trim().toLowerCase();
	if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
	if (host.endsWith(".")) host = host.slice(0, -1);
	if (!host) return null;
	if (host.includes(":")) return /^[0-9a-f:.]+$/.test(host) ? host : null;
	return /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(host) ? host : null;
}

/**
 * The hostname a Host header names: lower-cased, without port, brackets or a
 * trailing dot. `undefined` when there is no header, `null` when malformed.
 */
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

/** True for an IPv4 dotted-quad or an IPv6 literal (as returned by hostnameFromHostHeader). */
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

/**
 * Hostname patterns from a browser IDE's port-proxy template,
 * `VSCODE_PROXY_URI` (code-server and Coder set it, e.g.
 * `https://{{port}}--main--ws--me.coder.example.com/`). Only a template whose
 * HOSTNAME holds `{{port}}` yields a pattern: a path-based proxy
 * (`./proxy/{{port}}/`) serves under the IDE's own host and a prefix path,
 * which Plannotator's root-relative URLs do not support anyway. The value
 * comes from the environment the IDE started, never from a request, and names
 * the IDE's own proxy domain.
 */
export function forwardedPortHostPatterns(proxyUri: string | null | undefined): PortHostPattern[] {
	const value = (proxyUri ?? "").trim();
	if (!value) return [];
	const match = /^https?:\/\/([^/?#@]+)/i.exec(value);
	if (!match) return [];
	const authority = match[1];
	const at = authority.indexOf(PORT_PLACEHOLDER);
	if (at < 0 || authority.indexOf(PORT_PLACEHOLDER, at + 1) >= 0) return [];
	// Validate with a sample port in the placeholder's place, then split.
	const sample = hostnameFromHostHeader(authority.replace(PORT_PLACEHOLDER, "1"));
	if (!sample || sample.includes(":")) return [];
	const host = authority.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
	const placeholderAt = host.indexOf(PORT_PLACEHOLDER);
	if (placeholderAt < 0) return [];
	const prefix = host.slice(0, placeholderAt);
	const suffix = host.slice(placeholderAt + PORT_PLACEHOLDER.length);
	// A bare `{{port}}` host, or one with no dot outside the port, would match
	// short local names; require a real domain around it.
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

/** Whether a request carrying `hostHeader` may be answered under `policy`. */
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

/** Plain-text body of the 403 a refused request gets. */
export function hostNotAllowedMessage(hostHeader: string | null | undefined): string {
	const hostname = hostnameFromHostHeader(hostHeader);
	const named = hostname ? `"${hostname}"` : "in this request";
	return (
		`Plannotator refused this request: the hostname ${named} is not one this session answers on. ` +
		`Open the session at the URL Plannotator printed. If you reach it through a proxy or a forwarded ` +
		`hostname, add that hostname to ${ALLOWED_HOSTS_ENV} (comma-separated; * turns this check off).\n`
	);
}

/**
 * The machine's own hostnames for remote mode: the full name, its first label,
 * and the first label under `.local` (the mDNS name another device on the LAN
 * types; `os.hostname()` omits it on Linux and often on macOS). `.local` is
 * resolved by multicast DNS on the local link only (RFC 6762), so it cannot be
 * pointed at this machine from outside the network.
 */
export function machineHostnames(hostname: string | null | undefined): string[] {
	const full = normalizeHostname(hostname ?? "");
	if (!full || full.includes(":") || isIpLiteralHostname(full)) return [];
	const short = full.split(".")[0];
	const names = [full];
	if (short && short !== full) names.push(short);
	if (short && !names.includes(`${short}.local`)) names.push(`${short}.local`);
	return names;
}
