import { loadConfig, resolvePublicUrl, resolveUrlHost } from "./config";
import { parsePortSelection } from "./port-range";
import { isAutoUrlHost, resolveAutoHostCached } from "./tailscale";
import { isLocalhostHostname } from "./loopback-host";

const LOCAL_ONLY_HOSTS = new Set(["localhost", "0.0.0.0", "[::]", "[::1]"]);
const IPV4_LOOPBACK_RE = /^127(?:\.\d{1,3}){3}$/;
const IPV4_MAPPED_LOOPBACK_RE = /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/;

let warnedLocalAdvertisedUrlOverride = false;

function localhostUrl(port: number): string {
  return `http://localhost:${port}`;
}

/** The public origin fronts one port: the fixed port or a range's first. PLANNOTATOR_PORT=0 (random) never matches. */
function publicUrlAppliesToPort(port: number): boolean {
  const configured = process.env.PLANNOTATOR_PORT;
  if (!configured) {
    return true;
  }
  const selection = parsePortSelection(configured);
  return selection === null || port === selection.ports[0];
}

/**
 * Resolve a display-only session URL. Precedence:
 *   remote: public URL (fixed/range-start port) → urlHost:<port> → localhost.
 *     A localhost urlHost (`plannotator.localhost`, #2184) counts as unset here:
 *     it names this computer's browser only, so remote users never get it.
 *   local: a localhost urlHost (`plannotator.localhost`, Settings' "Open
 *     Plannotator at plannotator.localhost") → localhost. The public URL and any
 *     other urlHost are ignored with a once-per-process warning: a local
 *     session binds loopback, so a proxy or tailnet name cannot reach it.
 */
export function resolveAdvertisedSessionUrl(port: number, isRemote: boolean): string {
  const config = loadConfig();

  if (!isRemote) {
    const configuredHost = resolveUrlHost(config);
    const localHost =
      configuredHost !== undefined && isLocalhostHostname(configuredHost) ? configuredHost : undefined;
    const override = resolvePublicUrl(config) ?? (localHost === undefined ? configuredHost : undefined);
    if (override !== undefined && !warnedLocalAdvertisedUrlOverride) {
      warnedLocalAdvertisedUrlOverride = true;
      process.stderr.write(
        `[plannotator] Warning: advertised URL override ${JSON.stringify(override)} ignored — this is a local session, so the server binds loopback and only localhost or *.localhost names are supported. Set PLANNOTATOR_REMOTE=1 to use the override.\n`,
      );
    }
    return localHost === undefined ? localhostUrl(port) : `http://${localHost}:${port}`;
  }

  if (publicUrlAppliesToPort(port)) {
    const publicUrl = resolvePublicUrl(config);
    if (publicUrl !== undefined) {
      return publicUrl;
    }
  }

  const configuredHost = resolveUrlHost(config);
  const remoteHost =
    configuredHost !== undefined && isLocalhostHostname(configuredHost) ? undefined : configuredHost;
  const host =
    remoteHost !== undefined && isAutoUrlHost(remoteHost)
      ? resolveAutoHostCached()
      : remoteHost;
  return host === undefined ? localhostUrl(port) : `http://${host}:${port}`;
}

/** Return whether an advertised URL still points only at the server machine. */
export function isLocalOnlyAdvertisedUrl(value: string): boolean {
  if (!URL.canParse(value)) {
    return true;
  }
  const hostname = new URL(value).hostname.toLowerCase().replace(/\.$/, "");
  return (
    LOCAL_ONLY_HOSTS.has(hostname) ||
    hostname.endsWith(".localhost") ||
    IPV4_LOOPBACK_RE.test(hostname) ||
    IPV4_MAPPED_LOOPBACK_RE.test(hostname)
  );
}
