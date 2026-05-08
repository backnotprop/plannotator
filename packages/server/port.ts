/**
 * Local-only server port configuration.
 *
 * Uses fixed default port (43000) unless overridden via PLANNOTATOR_PORT.
 * Fixed port enables firewall rules, SSH forwarding, and stable bookmarks.
 */

const DEFAULT_PORT = 43000;

export function isRemoteSession(): boolean {
  return false;
}

export function getServerPort(): number {
  const envPort = process.env.PLANNOTATOR_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!Number.isNaN(parsed) && parsed > 0 && parsed < 65536) {
      return parsed;
    }

    console.error(
      `[Plannotator] Warning: Invalid PLANNOTATOR_PORT "${envPort}", using default ${DEFAULT_PORT}`,
    );
  }

  return DEFAULT_PORT;
}
