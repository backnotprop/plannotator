/** Bun adapter for the Host-header allowlist; runs first in `fetch`, before any route. */

import os from "node:os";
import { loadConfig, resolvePublicUrl, resolveUrlHost } from "@plannotator/shared/config";
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

/** Hostnames published besides loopback: the `tailscale serve` name registered by enableTailscaleServe. Serve forwards the browser's own Host, so without this the tailnet URL is refused. */
const servedHostnames = new Set<string>();

export function allowServedHostname(hostname: string): void {
  if (hostname) servedHostnames.add(hostname.toLowerCase());
}

export function resetServedHostnamesForTests(): void {
  servedHostnames.clear();
}

function remoteExtraHosts(): string[] {
  const hosts = machineHostnames(os.hostname());
  try {
    const config = loadConfig();
    const urlHost = resolveUrlHost(config);
    const resolved = urlHost && isAutoUrlHost(urlHost) ? resolveAutoHostCached() : urlHost;
    if (resolved) hosts.push(resolved);
    // A reverse proxy in front of PLANNOTATOR_PUBLIC_URL may forward the browser's Host.
    const publicUrl = resolvePublicUrl(config);
    if (publicUrl) hosts.push(new URL(publicUrl).hostname);
  } catch {
    // A broken config never widens the allowlist.
  }
  return hosts;
}

export interface RequestHostGuard {
  check(req: Request): Response | null;
}

/** Env and config are read once, here. `localOnly` (the Inbox) applies the local-mode rule whatever the environment. */
export function createRequestHostGuard(options: { localOnly?: boolean } = {}): RequestHostGuard {
  const remote = options.localOnly ? false : isRemoteSession();
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
