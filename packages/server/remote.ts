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
import { loadConfig, resolveLocalUrlHostname } from "@plannotator/shared/config";
import { isLocalOnlyAdvertisedUrl, resolveAdvertisedSessionUrl } from "@plannotator/shared/advertised-url";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { anotherComputerBaseUrl, anotherComputerUrl, loadNetworkKey, withNetworkKey, withoutNetworkKey } from "@plannotator/shared/network-key";

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
    /** True when the port came from PLANNOTATOR_PORT, false for the remote-mode default. */
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
    const why = this.fromEnv ? "" : " (remote mode uses a fixed port so it can be forwarded)";
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
 * Remote mode that only SSH turned on (`PLANNOTATOR_REMOTE` unset, `SSH_TTY`
 * or `SSH_CONNECTION` set). The server binds and advertises exactly as in any
 * remote mode, but a request that comes over loopback (the person's own SSH
 * tunnel, or a browser on that machine) is answered as in a local session:
 * `isSshTunnelRequest` in this-machine.ts. `PLANNOTATOR_REMOTE=1` keeps
 * remote mode whole (a proxy on this machine also arrives over loopback).
 */
export function isSshDetectedRemote(): boolean {
  return getRemoteOverride() === null && Boolean(process.env.SSH_TTY || process.env.SSH_CONNECTION);
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
        const hint = isRemoteSession()
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
      const hint = isRemoteSession()
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
  if (loopbackBindForTests) return LOOPBACK_HOST;
  return isRemoteSession() ? "0.0.0.0" : LOOPBACK_HOST;
}

let loopbackBindForTests = false;

/**
 * Tests only: bind loopback even in a remote session, so a test of remote
 * behaviour never listens on every interface (it plays another computer
 * through the network key's peer seam instead). `false` restores the rule.
 */
export function setLoopbackBindForTests(on: boolean): void {
  loopbackBindForTests = on;
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

/**
 * Compose the display-only URL advertised for a bound server port. In a
 * remote session SSH alone turned on, a URL another computer opens directly
 * (a urlHost, a public URL) carries this machine's network key
 * (packages/shared/network-key.ts); a localhost URL never needs it (it only
 * reaches this machine, or a tunnel, which arrives over loopback).
 */
export function buildAdvertisedUrl(port: number): string {
  return withAdvertisedNetworkKey(resolveAdvertisedSessionUrl(port, isRemoteSession()));
}

/** `url` with the network key when an advertised URL would carry it (see buildAdvertisedUrl). */
export function withAdvertisedNetworkKey(url: string): string {
  if (!isSshDetectedRemote() || isLocalOnlyAdvertisedUrl(url)) return url;
  return withNetworkKey(url, loadNetworkKey(getPlannotatorDataDir()));
}

/**
 * The ready-made link for a browser on another computer, with the key: only
 * in a remote session SSH alone turned on, only when the advertised URL is a
 * localhost one (otherwise that URL is the link), and only when the SSH
 * connection's own address is known and still this machine's. Else null.
 */
export function buildAnotherComputerUrl(port: number, advertisedUrl: string): string | null {
  if (!isSshDetectedRemote() || !isLocalOnlyAdvertisedUrl(advertisedUrl)) return null;
  return anotherComputerUrl(port, process.env.SSH_CONNECTION, loadNetworkKey(getPlannotatorDataDir()));
}

/**
 * For the session registry, so `plannotator sessions` can give the person the
 * link (packages/shared/network-key.ts): where another computer opens this
 * session, never with the key. Undefined unless the session asks another
 * computer for the key (a remote session SSH alone turned on); "" when the
 * address is not known.
 */
export function anotherComputerRegistryUrl(port: number, advertisedUrl: string): string | undefined {
  if (!isSshDetectedRemote()) return undefined;
  if (!isLocalOnlyAdvertisedUrl(advertisedUrl)) return withoutNetworkKey(advertisedUrl);
  return anotherComputerBaseUrl(port, process.env.SSH_CONNECTION) ?? "";
}
