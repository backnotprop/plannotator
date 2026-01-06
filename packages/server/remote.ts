/**
 * Remote session detection and port configuration
 *
 * Environment variables:
 *   PLANNOTATOR_REMOTE - Set to "1" or "true" to force remote mode (preferred)
 *   PLANNOTATOR_PORT   - Fixed port to use (default: random locally, 19432 for remote)
 *
 * Legacy (deprecated):
 *   SSH_TTY, SSH_CONNECTION - Still supported but will log deprecation warning
 */

const DEFAULT_REMOTE_PORT = 19432;

let deprecationWarned = false;

/**
 * Check if running in a remote session (SSH, devcontainer, etc.)
 */
export function isRemoteSession(): boolean {
  // New preferred env var
  const remote = process.env.PLANNOTATOR_REMOTE;
  if (remote === "1" || remote?.toLowerCase() === "true") {
    return true;
  }

  // Legacy: SSH_TTY/SSH_CONNECTION (deprecated)
  if (process.env.SSH_TTY || process.env.SSH_CONNECTION) {
    if (!deprecationWarned) {
      console.error(
        "[Plannotator] Deprecation warning: SSH_TTY/SSH_CONNECTION detection is deprecated."
      );
      console.error(
        "[Plannotator] Use PLANNOTATOR_REMOTE=1 instead for remote/devcontainer sessions.\n"
      );
      deprecationWarned = true;
    }
    return true;
  }

  return false;
}

/**
 * Get the server port to use
 */
export function getServerPort(): number {
  // Explicit port from environment takes precedence
  const envPort = process.env.PLANNOTATOR_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) {
      return parsed;
    }
    console.error(
      `[Plannotator] Warning: Invalid PLANNOTATOR_PORT "${envPort}", using default`
    );
  }

  // Remote sessions use fixed port for port forwarding; local uses random
  return isRemoteSession() ? DEFAULT_REMOTE_PORT : 0;
}
