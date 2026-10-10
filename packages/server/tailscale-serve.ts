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
 *     (background OR foreground — Tailscale prefers foreground handlers)
 *     aborts with an actionable error instead of being stolen; mappings on
 *     other ports are never touched, and unrecognizable `serve status`
 *     output fails closed.
 *   - Mappings this process creates are torn down on normal completion and
 *     on SIGINT/SIGTERM/SIGHUP (the CLI entry routes SIGINT/SIGTERM through
 *     process.exit, which fires "exit" handlers; SIGHUP is routed by THIS
 *     module, installed only once a mapping exists — an unconditional SIGHUP
 *     listener would override the ignored disposition `nohup` depends on and
 *     kill plain nohup'd sessions on terminal close). Teardown failures retry
 *     once, then warn with the exact manual command; a port is only
 *     forgotten after a successful off. `--bg` mappings survive a hard kill
 *     (SIGKILL) or reboot — that is Tailscale's persistence model, and the
 *     warning names the cleanup command for that case too.
 */

import {
  buildServeArgs,
  buildServeOffArgs,
  checkServeStatusPort,
  describeTailscaleFailure,
  extractServeHttpsUrl,
  runTailscale,
  serveStatusProxy,
  TAILSCALE_SERVE_TIMEOUT_MS,
  type TailscaleRunner,
} from "@plannotator/shared/tailscale";
import { allowServedHostname, resetServedHostnamesForTests } from "./request-host-guard";

const activePorts = new Set<number>();
let exitCleanupInstalled = false;
let cleanupRunner: TailscaleRunner = runTailscale;

/** One off attempt plus one retry; true only when the CLI reported success. */
function runServeOff(port: number, run: TailscaleRunner): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = run(buildServeOffArgs(port), TAILSCALE_SERVE_TIMEOUT_MS);
      if (!result.error && result.status === 0) return true;
    } catch {
      // Fall through to the retry / warning.
    }
  }
  return false;
}

function warnLeakedMapping(port: number): void {
  process.stderr.write(
    `[plannotator] Warning: could not remove the tailscale serve mapping for port ${port}. ` +
      `Remove it manually with: tailscale serve --https=${port} off\n`,
  );
}

function cleanupAllServeMappings(): void {
  for (const port of [...activePorts]) {
    if (runServeOff(port, cleanupRunner)) {
      activePorts.delete(port);
    } else {
      warnLeakedMapping(port);
    }
  }
}

function onProcessExit(): void {
  cleanupAllServeMappings();
}

/** SIGHUP (terminal close) routed through process.exit so the "exit" handler
 *  above tears the serve mapping down. 129 = 128 + SIGHUP. */
function onSigHup(): void {
  process.exit(129);
}

/** Why publishing failed, for a caller that words it for its own screen (the Inbox's Settings). */
export class TailscaleServeError extends Error {
  constructor(
    readonly code: "unavailable" | "malformed" | "conflict" | "serve_failed" | "no_url",
    message: string,
  ) {
    super(message);
    this.name = "TailscaleServeError";
  }
}

export interface TailscaleServeOptions {
  /** The tailnet HTTPS port; default the local port (a `--tailscale` session). */
  httpsPort?: number;
  /**
   * Proxy targets this caller made before (`http://127.0.0.1:<its last
   * port>`): a mapping on the HTTPS port that points at one of them is its
   * own and is re-pointed. Any other mapping is never overwritten.
   */
  ownTargets?: readonly string[];
  /**
   * Keep the mapping when this process exits (the Inbox: the person's switch
   * stays on, and the next start re-points it). Default: torn down on exit.
   */
  persist?: boolean;
}

/**
 * Publish a loopback-bound session port over the tailnet. Returns the HTTPS
 * URL tailscale advertises. Throws with an actionable message when the CLI
 * is missing, the daemon is down/logged out, the port already has a serve
 * mapping (background or foreground), the status output is unrecognizable,
 * or the serve output carries no https URL for the requested port.
 */
export function enableTailscaleServe(
  port: number,
  run: TailscaleRunner = runTailscale,
  options: TailscaleServeOptions = {},
): { url: string } {
  const httpsPort = options.httpsPort ?? port;
  const status = run(["serve", "status", "--json"], TAILSCALE_SERVE_TIMEOUT_MS);
  if (status.error || status.status !== 0) {
    throw new TailscaleServeError("unavailable", `--tailscale: ${describeTailscaleFailure(status)}`);
  }
  const existing = serveStatusProxy(status.stdout, httpsPort);
  if (existing.state === "malformed") {
    throw new TailscaleServeError(
      "malformed",
      "--tailscale: could not parse `tailscale serve status --json` output; " +
        "refusing to modify the serve config. Inspect it with `tailscale serve status`.",
    );
  }
  if (existing.state === "mapped" && !(options.ownTargets ?? []).includes(existing.proxy)) {
    throw new TailscaleServeError(
      "conflict",
      `--tailscale: tailscale serve already routes port ${httpsPort} (background or foreground session). ` +
        `Clear it with \`tailscale serve --https=${httpsPort} off\` if it is stale, ` +
        `or set PLANNOTATOR_PORT to a free port.`,
    );
  }
  const serve = run(buildServeArgs(port, httpsPort), TAILSCALE_SERVE_TIMEOUT_MS);
  if (serve.error || serve.status !== 0) {
    throw new TailscaleServeError("serve_failed", `--tailscale: could not start tailscale serve. ${describeTailscaleFailure(serve)}`);
  }
  const url = extractServeHttpsUrl(`${serve.stdout}\n${serve.stderr}`, httpsPort);
  if (!url) {
    // The mapping may exist even though we could not read a URL for our
    // port; take our own port back down rather than leak it.
    if (!runServeOff(httpsPort, run)) warnLeakedMapping(httpsPort);
    throw new TailscaleServeError(
      "no_url",
      `--tailscale: could not find an https:// URL for port ${httpsPort} in \`tailscale serve\` output.`,
    );
  }
  // The Inbox (persist) publishes a door-only listener that reads no Host, so
  // its window's allowlist never learns the tailnet name.
  if (options.persist) return { url };
  // tailscale serve forwards the browser's Host (the MagicDNS name) to the
  // loopback backend, so the server's Host allowlist must know the name.
  allowServedHostname(new URL(url).hostname);
  activePorts.add(httpsPort);
  cleanupRunner = run;
  if (!exitCleanupInstalled) {
    exitCleanupInstalled = true;
    process.on("exit", onProcessExit);
    // SIGHUP is routed through process.exit ONLY once a mapping exists.
    // Installing any SIGHUP listener overrides the ignored disposition
    // `nohup` relies on, so sessions without a serve mapping must never gain
    // one — `nohup plannotator review &` has to keep surviving terminal
    // close. With a mapping, terminal close must run the exit cleanup above
    // or the `--bg` mapping leaks.
    process.once("SIGHUP", onSigHup);
  }
  return { url };
}

/**
 * Take down a mapping a caller kept with `persist` (the Inbox's switch going
 * off). True when the CLI reported success.
 */
export function removeTailscaleServe(httpsPort: number, run: TailscaleRunner = runTailscale): boolean {
  return runServeOff(httpsPort, run);
}

/**
 * Take down the mapping on `httpsPort` only when it points at one of
 * `targets` (proxy targets this caller made): someone else's mapping on that
 * port is never touched. "none" when there is no such mapping, "failed" when
 * Tailscale could not say or could not remove it.
 */
export function takeDownOwnServeMapping(
  run: TailscaleRunner,
  httpsPort: number,
  targets: readonly string[],
): "removed" | "none" | "failed" {
  if (targets.length === 0) return "none";
  const status = run(["serve", "status", "--json"], TAILSCALE_SERVE_TIMEOUT_MS);
  if (status.error || status.status !== 0) return "failed";
  const existing = serveStatusProxy(status.stdout, httpsPort);
  if (existing.state === "malformed") return "failed";
  if (existing.state !== "mapped" || !targets.includes(existing.proxy)) return "none";
  return runServeOff(httpsPort, run) ? "removed" : "failed";
}

/**
 * Tear down one mapping this process created. No-op for unknown ports. The
 * port is only forgotten after a successful off; a persistent failure warns
 * with the manual command and leaves the port registered so the exit-time
 * cleanup retries it.
 */
export function disableTailscaleServe(port: number, run: TailscaleRunner = runTailscale): void {
  if (!activePorts.has(port)) return;
  if (runServeOff(port, run)) {
    activePorts.delete(port);
  } else {
    warnLeakedMapping(port);
  }
}

/**
 * Test-only: restore module state (registered ports, exit listener, cleanup
 * runner) so a test that published mappings through an injected runner cannot
 * leak an exit-time cleanup against the real CLI. Bun runs every test file in
 * one process; call from afterEach/finally.
 */
export function resetTailscaleServeForTests(): void {
  activePorts.clear();
  resetServedHostnamesForTests();
  cleanupRunner = runTailscale;
  if (exitCleanupInstalled) {
    exitCleanupInstalled = false;
    process.removeListener("exit", onProcessExit);
    process.removeListener("SIGHUP", onSigHup);
  }
}
