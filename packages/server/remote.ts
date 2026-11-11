/**
 * Remote session detection and port configuration
 *
 * Environment variables:
 *   PLANNOTATOR_REMOTE - Set to "1"/"true" to force remote, "0"/"false" to force local
 *   PLANNOTATOR_PORT   - Fixed port or inclusive range (default: random locally, 19432 for remote or SSH)
 *
 * SSH (SSH_TTY, SSH_CONNECTION) with PLANNOTATOR_REMOTE unset is no longer
 * remote mode: the server binds loopback, so only the person's own forwarded
 * connection reaches it, and every feature stays on. It keeps what an SSH
 * session needs: the fixed port to forward, no browser launched on this
 * computer, and no Open in (it would open an app on this computer's screen).
 */

import { parsePortSelection } from "@plannotator/shared/port-range";
import { loadConfig, resolveLocalUrlHostname } from "@plannotator/shared/config";
import { resolveAdvertisedSessionUrl } from "@plannotator/shared/advertised-url";

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

/**
 * Every configured port is taken. `message` keeps the historical text (Pi's
 * self-preemption and tests match it); `cliMessage` is the one line a CLI
 * prints instead of a stack trace.
 */
export class PortInUseError extends Error {
  constructor(
    message: string,
    readonly port: number,
    /** The configured range, when PLANNOTATOR_PORT names one. */
    readonly range: readonly [number, number] | null,
    /** True when the port came from PLANNOTATOR_PORT, false for the remote or SSH default. */
    readonly fromEnv: boolean,
  ) {
    super(message);
    this.name = "PortInUseError";
  }

  get cliMessage(): string {
    if (this.range) {
      return `Plannotator: every port in PLANNOTATOR_PORT ${this.range[0]}-${this.range[1]} is already in use, most likely by other Plannotator sessions. Finish or close one, or widen the range.`;
    }
    const what = this.fromEnv
      ? `port ${this.port} (PLANNOTATOR_PORT)`
      : `port ${this.port}`;
    const why = this.fromEnv ? "" : " (a remote or SSH session uses a fixed port so it can be forwarded)";
    return `Plannotator: ${what} is already in use, most likely by another Plannotator session${why}. Finish or close that session, or set PLANNOTATOR_PORT to a different port.`;
  }
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
 * Remote mode: PLANNOTATOR_REMOTE=1. The server binds every interface, so
 * anyone who can reach the URL can use the page, and the features that would
 * let them drive this computer stay off. SSH alone does not turn it on
 * (see isSshSession).
 */
export function isRemoteSession(): boolean {
  return getRemoteOverride() === true;
}

/**
 * Over SSH with PLANNOTATOR_REMOTE unset. The person is not at this
 * computer's screen, but the server binds loopback, so the page reaches it
 * only through their own forwarded connection: every feature works, only the
 * screen-bound ones (opening a browser here, Open in) do not.
 */
export function isSshSession(): boolean {
  return getRemoteOverride() === null && Boolean(process.env.SSH_TTY || process.env.SSH_CONNECTION);
}

/** Remote mode or SSH: no browser on this computer's screen, and a fixed port to forward. */
export function isRemoteOrSsh(): boolean {
  return isRemoteSession() || isSshSession();
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

  // Remote and SSH sessions use a fixed port for port forwarding; local uses random
  return {
    ports: [isRemoteOrSsh() ? DEFAULT_REMOTE_PORT : 0],
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
  const fromEnv = Boolean(process.env.PLANNOTATOR_PORT && parsePortSelection(process.env.PLANNOTATOR_PORT));
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
        const hint = isRemoteOrSsh()
          ? " (set PLANNOTATOR_PORT to use different port)"
          : "";
        throw new PortInUseError(
          `Port ${port} in use after ${MAX_FIXED_PORT_RETRIES} retries${hint}`,
          port,
          null,
          fromEnv,
        );
      }

      const first = configuredPorts[0] as number;
      const last = configuredPorts.at(-1) as number;
      const hint = isRemoteOrSsh()
        ? " (set PLANNOTATOR_PORT to use a different port or range)"
        : "";
      throw new PortInUseError(
        `Port selection ${first}-${last} exhausted${hint}`,
        port,
        [first, last],
        true,
      );
    }
  }

  throw new Error("Failed to start server");
}

/**
 * Bind local sessions to loopback. Remote sessions bind every interface so other
 * devices and published Docker ports can reach them; `ssh -L` and editor port
 * forwards reach loopback.
 */
export function getServerHostname(): string {
  return isRemoteSession() ? "0.0.0.0" : LOOPBACK_HOST;
}

/**
 * The localhost subdomain sessions are advertised at (`urlHost:
 * "plannotator.localhost"`, #2184), or undefined. Servers read it once at
 * start and hand it to the loopback Host checks of the routes a page calls
 * (Ask this session, `/api/update`), so a page at that name is "this computer".
 */
export function getLocalUrlHostname(): string | undefined {
  return resolveLocalUrlHostname(loadConfig());
}

/** Compose the display-only URL advertised for a bound server port. */
export function buildAdvertisedUrl(port: number): string {
  return resolveAdvertisedSessionUrl(port, isRemoteSession());
}
