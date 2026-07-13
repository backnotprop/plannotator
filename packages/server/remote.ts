/**
 * Remote session detection and port configuration
 *
 * Environment variables:
 *   PLANNOTATOR_REMOTE - Set to "1"/"true" to force remote, "0"/"false" to force local
 *   PLANNOTATOR_PORT   - Fixed port or inclusive range (default: random locally, 19432 for remote)
 *
 * Legacy (still supported): SSH_TTY, SSH_CONNECTION
 */

const DEFAULT_REMOTE_PORT = 19432;
const LOOPBACK_HOST = "127.0.0.1";

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
  const envPort = process.env.PLANNOTATOR_PORT;
  if (envPort) {
    const value = envPort.trim();
    const range = /^(\d+)-(\d+)$/.exec(value);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start >= 1 && end < 65536 && start <= end) {
        return Array.from({ length: end - start + 1 }, (_, index) => start + index);
      }
    } else {
      const parsed = parseInt(value, 10);
      if (!Number.isNaN(parsed) && parsed >= 0 && parsed < 65536) {
        return [parsed];
      }
    }
    console.error(
      `[Plannotator] Warning: Invalid PLANNOTATOR_PORT "${envPort}", using default`
    );
  }

  // Remote sessions use fixed port for port forwarding; local uses random
  return [isRemoteSession() ? DEFAULT_REMOTE_PORT : 0];
}

/**
 * Get the first configured server port.
 */
export function getServerPort(): number {
  return getServerPorts()[0];
}

/**
 * Bind local sessions to loopback, but keep remote sessions reachable via the
 * container or host network interface for SSH/devcontainer/Docker forwarding.
 */
export function getServerHostname(): string {
  return isRemoteSession() ? "0.0.0.0" : LOOPBACK_HOST;
}
