import { loadConfig, resolvePublicUrl, resolveUrlHost } from "./config";
import { parsePortSelection } from "./port-range";
import { isAutoUrlHost, resolveAutoHostCached } from "./tailscale";

const LOCAL_ONLY_HOSTS = new Set(["localhost", "0.0.0.0", "[::]", "[::1]"]);
const IPV4_LOOPBACK_RE = /^127(?:\.\d{1,3}){3}$/;
const IPV4_MAPPED_LOOPBACK_RE = /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/;

let warnedLocalAdvertisedUrlOverride = false;

function localhostUrl(port: number): string {
  return `http://localhost:${port}`;
}

function publicUrlAppliesToPort(port: number): boolean {
  const configured = process.env.PLANNOTATOR_PORT;
  if (!configured) {
    return true;
  }
  const selection = parsePortSelection(configured);
  return selection?.kind !== "range" || port === selection.ports[0];
}

/** Resolve a display-only session URL; public origins apply only to remote fixed/range-start ports. */
export function resolveAdvertisedSessionUrl(port: number, isRemote: boolean): string {
  const config = loadConfig();

  if (!isRemote) {
    const override = resolvePublicUrl(config) ?? resolveUrlHost(config);
    if (override !== undefined && !warnedLocalAdvertisedUrlOverride) {
      warnedLocalAdvertisedUrlOverride = true;
      process.stderr.write(
        `[plannotator] Warning: advertised URL override ${JSON.stringify(override)} ignored — this is a local session, so the server binds loopback and only localhost is reachable. Set PLANNOTATOR_REMOTE=1 to use the override.\n`,
      );
    }
    return localhostUrl(port);
  }

  if (publicUrlAppliesToPort(port)) {
    const publicUrl = resolvePublicUrl(config);
    if (publicUrl !== undefined) {
      return publicUrl;
    }
  }

  const configuredHost = resolveUrlHost(config);
  const host =
    configuredHost !== undefined && isAutoUrlHost(configuredHost)
      ? resolveAutoHostCached()
      : configuredHost;
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
