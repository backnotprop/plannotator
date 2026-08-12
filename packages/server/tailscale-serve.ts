/**
 * `--tailscale` session publishing (Bun CLI only).
 *
 * The server stays LOOPBACK-bound — this is not remote mode. `tailscale
 * serve` reverse-proxies an HTTPS tailnet port to 127.0.0.1, so the session
 * is reachable from the user's other tailnet devices with TLS while nothing
 * listens beyond loopback (and nothing is ever exposed publicly — this is
 * serve, never funnel).
 *
 * Invariants:
 *   - One serve mapping per session port. A pre-existing mapping on our port
 *     aborts with an actionable error instead of being stolen; mappings on
 *     other ports are never touched.
 *   - Every mapping this process creates is torn down on every exit path:
 *     normal completion, SIGINT/SIGTERM (the CLI entry routes both through
 *     process.exit, which fires "exit" handlers), and errors.
 */

import {
  buildServeArgs,
  buildServeOffArgs,
  describeTailscaleFailure,
  extractServeHttpsUrl,
  runTailscale,
  serveStatusHasPort,
  TAILSCALE_SERVE_TIMEOUT_MS,
  type TailscaleRunner,
} from "@plannotator/shared/tailscale";

const activePorts = new Set<number>();
let exitCleanupInstalled = false;
let cleanupRunner: TailscaleRunner = runTailscale;

function cleanupAllServeMappings(): void {
  for (const port of [...activePorts]) {
    activePorts.delete(port);
    try {
      cleanupRunner(buildServeOffArgs(port), TAILSCALE_SERVE_TIMEOUT_MS);
    } catch {
      // Best effort during process exit; the mapping dies with the tailnet
      // node's serve config reset at worst.
    }
  }
}

/**
 * Publish a loopback-bound session port over the tailnet. Returns the HTTPS
 * URL tailscale advertises. Throws with an actionable message when the CLI
 * is missing, the daemon is down/logged out, the port already has a serve
 * mapping, or the serve output cannot be parsed.
 */
export function enableTailscaleServe(
  port: number,
  run: TailscaleRunner = runTailscale,
): { url: string } {
  const status = run(["serve", "status", "--json"], TAILSCALE_SERVE_TIMEOUT_MS);
  if (status.error || status.status !== 0) {
    throw new Error(`--tailscale: ${describeTailscaleFailure(status)}`);
  }
  if (serveStatusHasPort(status.stdout, port)) {
    throw new Error(
      `--tailscale: tailscale serve already routes port ${port}. ` +
        `Clear it with \`tailscale serve --https=${port} off\` if it is stale, ` +
        `or set PLANNOTATOR_PORT to a free port.`,
    );
  }
  const serve = run(buildServeArgs(port), TAILSCALE_SERVE_TIMEOUT_MS);
  if (serve.error || serve.status !== 0) {
    throw new Error(`--tailscale: could not start tailscale serve. ${describeTailscaleFailure(serve)}`);
  }
  const url = extractServeHttpsUrl(`${serve.stdout}\n${serve.stderr}`);
  if (!url) {
    // The mapping may exist even though we could not read its URL; take our
    // own port back down rather than leak it.
    run(buildServeOffArgs(port), TAILSCALE_SERVE_TIMEOUT_MS);
    throw new Error("--tailscale: could not find an https:// URL in `tailscale serve` output.");
  }
  activePorts.add(port);
  cleanupRunner = run;
  if (!exitCleanupInstalled) {
    exitCleanupInstalled = true;
    process.on("exit", cleanupAllServeMappings);
  }
  return { url };
}

/** Tear down one mapping this process created. No-op for unknown ports. */
export function disableTailscaleServe(port: number, run: TailscaleRunner = runTailscale): void {
  if (!activePorts.delete(port)) return;
  run(buildServeOffArgs(port), TAILSCALE_SERVE_TIMEOUT_MS);
}
