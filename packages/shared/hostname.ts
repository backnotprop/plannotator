/**
 * Shared hostname-resolution logic for user-facing server URLs.
 *
 * The only runtime-specific dependency is spawning `tailscale status`, which
 * each runtime injects (Bun.spawn for the Bun server, node:child_process for
 * the Pi extension). Everything else — env-var priority, memoization, and
 * DNSName parsing — lives here so the two runtimes can't drift.
 */

/**
 * Parse the Tailscale DNS name out of `tailscale status --self --json` output.
 * Returns null if the JSON is malformed or carries no usable DNSName.
 */
export function parseTailscaleDnsName(json: string): string | null {
  try {
    const data = JSON.parse(json);
    // DNSName has a trailing dot, e.g. "a4000.chaco-dory.ts.net."
    const dnsName = data?.Self?.DNSName;
    if (typeof dnsName === "string" && dnsName.length > 1) {
      return dnsName.replace(/\.$/, "");
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

export interface HostnameResolverDeps {
  /** True when running in a remote session (gates the Tailscale probe). */
  isRemoteSession: () => boolean;
  /** Spawn `tailscale status` and resolve its hostname, or null. */
  detectTailscaleHostname: () => Promise<string | null>;
  /** Read the explicit hostname override. Defaults to PLANNOTATOR_HOSTNAME. */
  getEnvHostname?: () => string | undefined;
}

export interface HostnameResolver {
  /**
   * Resolve the hostname for user-facing URLs.
   * Priority: PLANNOTATOR_HOSTNAME → Tailscale → "localhost".
   */
  resolve: () => Promise<string>;
  /** Reset the memoized hostname. Test-only — production resolves once. */
  reset: () => void;
}

/**
 * Build a memoizing hostname resolver.
 *
 * A successfully resolved hostname (explicit or Tailscale) is cached for the
 * process lifetime. The "localhost" fallback is intentionally NOT cached so a
 * probe that ran before tailscaled was ready can still succeed on a later
 * call — this matters for the long-lived Pi extension process, which would
 * otherwise be stuck on read-only share links for its whole lifetime. The
 * one-shot Bun CLI resolves once regardless, so the behavior is unchanged
 * there.
 */
export function createHostnameResolver(
  deps: HostnameResolverDeps,
): HostnameResolver {
  const getEnvHostname =
    deps.getEnvHostname ?? (() => process.env.PLANNOTATOR_HOSTNAME);
  let cached: string | undefined;

  return {
    reset() {
      cached = undefined;
    },
    async resolve(): Promise<string> {
      if (cached !== undefined) return cached;

      // 1. Explicit env var
      const envHostname = getEnvHostname();
      if (envHostname) {
        cached = envHostname;
        return envHostname;
      }

      // 2. Auto-detect Tailscale (remote sessions only)
      if (deps.isRemoteSession()) {
        const tsHostname = await deps.detectTailscaleHostname();
        if (tsHostname) {
          cached = tsHostname;
          return tsHostname;
        }
      }

      // 3. Fallback — not cached, so a later probe can still resolve.
      return "localhost";
    },
  };
}
