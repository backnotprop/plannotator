/**
 * Bun adapter for the Host-header allowlist (packages/shared/request-host.ts).
 * Every Bun server (plan, review, annotate, goal setup) builds one guard at
 * start and runs it first in `fetch`, before any route, so the app HTML, every
 * API and the WebSocket upgrades are covered alike. The Pi mirror is
 * apps/pi-extension/server/request-host-guard.ts.
 */

import os from "node:os";
import { loadConfig, resolveUrlHost } from "@plannotator/shared/config";
import {
  ALLOWED_HOSTS_ENV,
  forwardedPortHostPatterns,
  HOST_NOT_ALLOWED_CODE,
  hostNotAllowedMessage,
  isAllowedRequestHost,
  machineHostnames,
  parseAllowedHosts,
  type RequestHostPolicy,
} from "@plannotator/shared/request-host";
import { isAutoUrlHost, resolveAutoHostCached } from "@plannotator/shared/tailscale";
import { isRemoteSession } from "./remote";

/**
 * Hostnames this process publishes sessions under besides loopback: the
 * `tailscale serve` MagicDNS name of a `--tailscale` session, registered by
 * enableTailscaleServe once serve reports its URL. `tailscale serve` forwards
 * the browser's own Host header to the loopback backend, so without this the
 * tailnet URL would be refused.
 */
const servedHostnames = new Set<string>();

export function allowServedHostname(hostname: string): void {
  if (hostname) servedHostnames.add(hostname.toLowerCase());
}

export function resetServedHostnamesForTests(): void {
  servedHostnames.clear();
}

/** Remote-mode names: the configured urlHost (auto resolved) and this machine's hostname. */
function remoteExtraHosts(): string[] {
  const hosts = machineHostnames(os.hostname());
  try {
    const urlHost = resolveUrlHost(loadConfig());
    const resolved = urlHost && isAutoUrlHost(urlHost) ? resolveAutoHostCached() : urlHost;
    if (resolved) hosts.push(resolved);
  } catch {
    // A broken config never widens the allowlist.
  }
  return hosts;
}

export interface RequestHostGuard {
  /** A 403 response when the request's Host is not allowed, else null. */
  check(req: Request): Response | null;
}

/** Build the guard for one server. Env and config are read once, here. */
export function createRequestHostGuard(): RequestHostGuard {
  const remote = isRemoteSession();
  const allowed = parseAllowedHosts(process.env[ALLOWED_HOSTS_ENV]);
  // A browser IDE's port proxy (code-server, Coder) forwards its own Host.
  const portHostPatterns = forwardedPortHostPatterns(process.env.VSCODE_PROXY_URI);
  // Remote-mode names are resolved on the first request that needs them, so
  // loopback and IP-literal requests never read config or ask Tailscale.
  let remoteHosts: string[] | null = null;
  const allows = (host: string | null): boolean => {
    const policy: RequestHostPolicy = { remote, allowed, portHostPatterns, extraHosts: servedHostnames };
    if (isAllowedRequestHost(host, policy)) return true;
    if (!remote) return false;
    remoteHosts ??= remoteExtraHosts();
    return isAllowedRequestHost(host, { ...policy, extraHosts: remoteHosts });
  };
  return {
    check(req) {
      const host = req.headers.get("host");
      if (allows(host)) return null;
      return new Response(hostNotAllowedMessage(host), {
        status: 403,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
          "X-Plannotator-Error": HOST_NOT_ALLOWED_CODE,
        },
      });
    },
  };
}
