/**
 * Remote session detection, port configuration, and hostname resolution
 *
 * Environment variables:
 *   PLANNOTATOR_REMOTE   - Set to "1"/"true" to force remote, "0"/"false" to force local
 *   PLANNOTATOR_PORT     - Fixed port to use (default: random)
 *   PLANNOTATOR_HOSTNAME - Explicit hostname for remote URLs (e.g. "mybox.ts.net")
 *
 * Legacy (still supported): SSH_TTY, SSH_CONNECTION
 *
 * When Tailscale is available, the server URL uses the Tailscale hostname
 * so remote users can connect directly without port forwarding. This also
 * allows random ports, so parallel sessions work.
 */

const LOOPBACK_HOST = "127.0.0.1";

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
 * Get the server port to use.
 *
 * Always uses a random port (0) unless PLANNOTATOR_PORT is explicitly set.
 * The old default of 19432 for remote is no longer needed since we resolve
 * the actual hostname (Tailscale/explicit) instead of relying on port forwarding.
 */
export function getServerPort(): number {
  // Explicit port from environment takes precedence
  const envPort = process.env.PLANNOTATOR_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed >= 0 && parsed < 65536) {
      return parsed;
    }
    console.error(
      `[Plannotator] Warning: Invalid PLANNOTATOR_PORT "${envPort}", using default`
    );
  }

  return 0;
}

/**
 * Bind local sessions to loopback, but keep remote sessions reachable via the
 * container or host network interface (Tailscale/SSH/devcontainer/Docker).
 */
export function getServerHostname(): string {
  return isRemoteSession() ? "0.0.0.0" : LOOPBACK_HOST;
}

let cachedHostname: string | null | undefined;

/**
 * Reset the memoized hostname. Test-only — production resolves once per process.
 */
export function resetServerUrlHostnameCache(): void {
  cachedHostname = undefined;
}

/**
 * Get the hostname to use in user-facing server URLs.
 *
 * Priority:
 *   1. PLANNOTATOR_HOSTNAME env var (explicit override)
 *   2. Tailscale hostname (auto-detected via `tailscale status`)
 *   3. "localhost" (fallback)
 */
export async function getServerUrlHostname(): Promise<string> {
  if (cachedHostname !== undefined) {
    return cachedHostname ?? "localhost";
  }

  // 1. Explicit env var
  const envHostname = process.env.PLANNOTATOR_HOSTNAME;
  if (envHostname) {
    cachedHostname = envHostname;
    return envHostname;
  }

  // 2. Auto-detect Tailscale
  if (isRemoteSession()) {
    const tsHostname = await detectTailscaleHostname();
    if (tsHostname) {
      cachedHostname = tsHostname;
      return tsHostname;
    }
  }

  // 3. Fallback
  cachedHostname = null;
  return "localhost";
}

/**
 * Detect the Tailscale DNS name by running `tailscale status --self --json`.
 * Returns null if Tailscale is not available or not running.
 */
async function detectTailscaleHostname(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["tailscale", "status", "--self", "--json"], {
      stdout: "pipe",
      stderr: "ignore",
    });

    // Guard against a wedged tailscaled: kill the probe if it neither prints
    // nor exits within the timeout so callers (writeRemoteShareLink) never hang.
    const timer = setTimeout(() => proc.kill(), 3_000);

    let text: string;
    let exitCode: number;
    try {
      text = await new Response(proc.stdout).text();
      exitCode = await proc.exited;
    } finally {
      clearTimeout(timer);
    }
    if (exitCode !== 0) return null;

    const data = JSON.parse(text);
    // DNSName has a trailing dot, e.g. "a4000.chaco-dory.ts.net."
    const dnsName = data?.Self?.DNSName;
    if (typeof dnsName === "string" && dnsName.length > 1) {
      return dnsName.replace(/\.$/, "");
    }

    return null;
  } catch {
    return null;
  }
}
