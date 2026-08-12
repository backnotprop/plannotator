/**
 * Remote session detection and port configuration
 *
 * Environment variables:
 *   PLANNOTATOR_REMOTE - Set to "1"/"true" to force remote, "0"/"false" to force local
 *   PLANNOTATOR_PORT   - Fixed port or inclusive range (default: random locally, 19432 for remote)
 *
 * Legacy (still supported): SSH_TTY, SSH_CONNECTION
 */

import { parsePortSelection } from "@plannotator/shared/port-range";
import { loadConfig, resolveUrlHost } from "@plannotator/shared/config";
import { isAutoUrlHost, resolveAutoHostCached } from "@plannotator/shared/tailscale";

const DEFAULT_REMOTE_PORT = 19432;
const LOOPBACK_HOST = "127.0.0.1";
const MAX_FIXED_PORT_RETRIES = 5;
const PORT_RETRY_DELAY_MS = 500;

/** Return whether a runtime listen failure represents an occupied address. */
export function isAddressInUseError(err: unknown): boolean {
  return err instanceof Error && (
    (err as NodeJS.ErrnoException).code === "EADDRINUSE" ||
    err.message.includes("EADDRINUSE")
  );
}

function getRemoteOverride(): boolean | null {
  const remote = process.env.PLANNOTATOR_REMOTE;
  if (remote === undefined) {
    return null;
  }

  if (remote === "1" || remote?.toLowerCase() === "true") {
    return true;
  }

  if (remote === "0" || remote?.toLowerCase() === "false") {
    return false;
  }

  return null;
}

/**
 * Check if running in a remote session (SSH, devcontainer, etc.)
 */
export function isRemoteSession(): boolean {
  const remoteOverride = getRemoteOverride();
  if (remoteOverride !== null) {
    return remoteOverride;
  }

  // Legacy: SSH_TTY/SSH_CONNECTION (deprecated, silent)
  if (process.env.SSH_TTY || process.env.SSH_CONNECTION) {
    return true;
  }

  return false;
}

/**
 * Get the server ports to try, in order.
 */
export function getServerPorts(): number[] {
  return getServerPortConfiguration().ports;
}

function getServerPortConfiguration(): {
  ports: number[];
  isRange: boolean;
} {
  const envPort = process.env.PLANNOTATOR_PORT;
  if (envPort) {
    const parsed = parsePortSelection(envPort);
    if (parsed) {
      return { ports: parsed.ports, isRange: parsed.kind === "range" };
    }
    console.error(
      `[Plannotator] Warning: Invalid PLANNOTATOR_PORT "${envPort}", using default`
    );
  }

  // Remote sessions use fixed port for port forwarding; local uses random
  return {
    ports: [isRemoteSession() ? DEFAULT_REMOTE_PORT : 0],
    isRange: false,
  };
}

/**
 * Get the first configured server port.
 */
export function getServerPort(): number {
  return getServerPorts()[0];
}

/**
 * Start a Bun server on the first available configured port.
 *
 * Bounded ranges advance immediately after EADDRINUSE. A fixed port retains
 * the existing five-attempt retry behavior for transient conflicts.
 */
export async function startBunServerOnAvailablePort<TServer>(
  startServer: (port: number) => TServer,
): Promise<TServer> {
  const { ports: configuredPorts, isRange } = getServerPortConfiguration();
  const portsToTry = isRange
    ? configuredPorts
    : Array(MAX_FIXED_PORT_RETRIES).fill(configuredPorts[0]);

  for (const [index, port] of portsToTry.entries()) {
    try {
      return startServer(port);
    } catch (error: unknown) {
      if (!isAddressInUseError(error)) {
        throw error;
      }

      if (index < portsToTry.length - 1) {
        if (!isRange) {
          await Bun.sleep(PORT_RETRY_DELAY_MS);
        }
        continue;
      }

      if (!isRange) {
        const hint = isRemoteSession()
          ? " (set PLANNOTATOR_PORT to use different port)"
          : "";
        throw new Error(
          `Port ${port} in use after ${MAX_FIXED_PORT_RETRIES} retries${hint}`,
        );
      }

      const configured = `${configuredPorts[0]}-${configuredPorts.at(-1)}`;
      const hint = isRemoteSession()
        ? " (set PLANNOTATOR_PORT to use a different port or range)"
        : "";
      throw new Error(`Port selection ${configured} exhausted${hint}`);
    }
  }

  throw new Error("Failed to start server");
}

/**
 * Bind local sessions to loopback, but keep remote sessions reachable via the
 * container or host network interface for SSH/devcontainer/Docker forwarding.
 */
export function getServerHostname(): string {
  return isRemoteSession() ? "0.0.0.0" : LOOPBACK_HOST;
}

/** True when the advertised-URL host is overridden away from localhost. */
export function isUrlHostOverridden(): boolean {
  const host = resolveUrlHost(loadConfig());
  if (host === undefined) return false;
  if (isAutoUrlHost(host)) return isRemoteSession() && resolveAutoHostCached() !== undefined;
  return true;
}

let warnedLocalUrlHost = false;

/**
 * Compose the URL advertised to the user for a bound port (issue #657).
 * Display-only: the PLANNOTATOR_URL_HOST / urlHost override changes what is
 * printed and opened, never which interface the server listens on
 * (getServerHostname). Remote sessions only: a local session binds loopback,
 * so honoring the override would advertise (and auto-open) a URL nothing is
 * listening on — the override is ignored with a once-per-process warning.
 * The "auto" sentinel resolves the host from Tailscale (resolveAutoHost).
 * Same-machine subprocesses must not use this — they get a loopback URL so a
 * tailnet-only hostname can't break local agent jobs.
 */
export function buildAdvertisedUrl(port: number): string {
  const host = resolveUrlHost(loadConfig());
  if (host === undefined) return `http://localhost:${port}`;
  if (!isRemoteSession()) {
    if (!warnedLocalUrlHost) {
      warnedLocalUrlHost = true;
      process.stderr.write(
        `[plannotator] Warning: advertised URL host ${JSON.stringify(host)} ignored — this is a local session, so the server binds loopback and only localhost is reachable. Set PLANNOTATOR_REMOTE=1 to use the override.\n`,
      );
    }
    return `http://localhost:${port}`;
  }
  const resolved = isAutoUrlHost(host) ? resolveAutoHostCached() : host;
  if (resolved === undefined) return `http://localhost:${port}`;
  return `http://${resolved}:${port}`;
}
