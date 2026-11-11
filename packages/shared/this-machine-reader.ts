/**
 * Whether a request is a page on this machine, for reads past the session's own roots. All must hold: not remote mode; not a GitHub Codespace (its forwarder presents `Host: localhost`); `PLANNOTATOR_ALLOWED_HOSTS` unset; Host and any `X-Forwarded-Host` are loopback or `*.localhost`; no `Forwarded`, `X-Real-IP` or serve header, and any `X-Forwarded-For` lists only loopback.
 * Raw TCP forwarders and proxies that rewrite Host look local: remote setups use remote mode. Vendored to Pi.
 */

import { isLocalhostSubdomain, isLoopbackHostname } from "./loopback-host";
import { ALLOWED_HOSTS_ENV } from "./request-host";
import { cameThroughTailscaleServe } from "./tailnet-audience";

function isLocalHostName(hostHeader: string | null): boolean {
	const host = (hostHeader ?? "").trim().toLowerCase();
	const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.replace(/:\d*$/, "");
	return isLoopbackHostname(name) || isLocalhostSubdomain(name);
}

export function isThisMachineReader(remote: boolean, headers: Headers): boolean {
	if (remote) return false;
	if (process.env.CODESPACES?.trim().toLowerCase() === "true") return false;
	if (process.env[ALLOWED_HOSTS_ENV]?.trim()) return false;
	if (!isLocalHostName(headers.get("host"))) return false;
	if (headers.has("x-forwarded-host") && !isLocalHostName(headers.get("x-forwarded-host"))) return false;
	if (headers.has("forwarded") || headers.has("x-real-ip")) return false;
	return !cameThroughTailscaleServe(headers);
}
