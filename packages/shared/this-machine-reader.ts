/**
 * Whether a request to a plan, annotate or review server is a page on this
 * machine, for the reads that reach past the session's own roots: `/api/doc`
 * documents anywhere (#2291) and the Files sidebar's folders and vaults.
 *
 * All of these must hold:
 *  - the session is not in remote mode (which binds every interface);
 *  - the session is not in a GitHub Codespace (`CODESPACES=true`), whose port
 *    forwarder presents `Host: localhost` to whoever the port is shared with;
 *  - `PLANNOTATOR_ALLOWED_HOSTS` is unset (it exists to put a proxy in front);
 *  - the Host is a loopback or `*.localhost` name, and so is any
 *    `X-Forwarded-Host`;
 *  - no `Forwarded` or `X-Real-IP` header, no `tailscale serve` header, and
 *    any `X-Forwarded-For` lists only loopback (`cameThroughTailscaleServe`).
 * Every other reader keeps the session's roots. A raw TCP forwarder, a VS
 * Code dev tunnel (no variable it is known to set marks it), or a proxy that
 * rewrites Host to loopback and adds none of these headers, looks local:
 * remote setups use remote mode. Cross-site pages are refused by the routes
 * before this.
 *
 * Runtime-agnostic (vendored to Pi as generated/this-machine-reader.ts).
 */

import { isLocalhostSubdomain, isLoopbackHostname } from "./loopback-host";
import { ALLOWED_HOSTS_ENV } from "./request-host";
import { cameThroughTailscaleServe } from "./tailnet-audience";

/** A Host-shaped value naming this machine: a loopback or `*.localhost` name. */
function isLocalHostName(hostHeader: string | null): boolean {
	const host = (hostHeader ?? "").trim().toLowerCase();
	const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.replace(/:\d*$/, "");
	return isLoopbackHostname(name) || isLocalhostSubdomain(name);
}

/** Whether the request is a page on this machine (see the module comment). */
export function isThisMachineReader(remote: boolean, headers: Headers): boolean {
	if (remote) return false;
	if (process.env.CODESPACES?.trim().toLowerCase() === "true") return false;
	if (process.env[ALLOWED_HOSTS_ENV]?.trim()) return false;
	if (!isLocalHostName(headers.get("host"))) return false;
	if (headers.has("x-forwarded-host") && !isLocalHostName(headers.get("x-forwarded-host"))) return false;
	if (headers.has("forwarded") || headers.has("x-real-ip")) return false;
	return !cameThroughTailscaleServe(headers);
}
