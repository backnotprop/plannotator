/**
 * `--tailscale` publishing (Bun CLI only). The server stays loopback-bound; `tailscale serve` (never funnel) proxies an HTTPS tailnet port to it.
 * One mapping per session port: a pre-existing mapping on our port aborts with an error instead of being stolen, other ports are never touched, and unrecognizable `serve status` output fails closed. Created mappings are torn down on exit and SIGINT/SIGTERM/SIGHUP; SIGHUP is routed here only once a mapping exists, since an unconditional listener would override the ignored disposition `nohup` depends on. A port is forgotten only after a successful off; `--bg` mappings survive SIGKILL or reboot.
 */

import {
  buildServeArgs,
  buildServeOffArgs,
  checkServeStatusPort,
  describeTailscaleFailure,
  explainTailscaleSetup,
  extractServeHttpsUrl,
  runTailscale,
  serveStatusProxy,
  TAILSCALE_SERVE_TIMEOUT_MS,
  type TailscaleRunResult,
  type TailscaleRunner,
} from "@plannotator/shared/tailscale";
import { allowServedHostname, resetServedHostnamesForTests } from "./request-host-guard";
import { handleServerReady, SESSION_READY_LINE_PREFIX } from "./shared-handlers";
import { writeUrlQr } from "./qr";

const activePorts = new Set<number>();
let exitCleanupInstalled = false;
let cleanupRunner: TailscaleRunner = runTailscale;

export interface TailscaleStep {
  args: string[];
  timeoutMs: number;
}

export type TailscaleSteps<T> = Generator<TailscaleStep, T, TailscaleRunResult>;

export type TailscaleRunnerAsync = (args: string[], timeoutMs: number) => TailscaleRunResult | Promise<TailscaleRunResult>;

export function runTailscaleSteps<T>(steps: TailscaleSteps<T>, run: TailscaleRunner): T {
  let next = steps.next();
  while (!next.done) {
    let result: TailscaleRunResult;
    try {
      result = run(next.value.args, next.value.timeoutMs);
    } catch (error) {
      next = steps.throw(error);
      continue;
    }
    next = steps.next(result);
  }
  return next.value;
}

export async function runTailscaleStepsAsync<T>(steps: TailscaleSteps<T>, run: TailscaleRunnerAsync): Promise<T> {
  let next = steps.next();
  while (!next.done) {
    let result: TailscaleRunResult;
    try {
      result = await run(next.value.args, next.value.timeoutMs);
    } catch (error) {
      next = steps.throw(error);
      continue;
    }
    next = steps.next(result);
  }
  return next.value;
}

const step = (args: string[], timeoutMs: number): TailscaleStep => ({ args, timeoutMs });

export function* serveOffSteps(port: number): TailscaleSteps<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = yield step(buildServeOffArgs(port), TAILSCALE_SERVE_TIMEOUT_MS);
      if (!result.error && result.status === 0) return true;
    } catch {
      // Fall through to the retry / warning.
    }
  }
  return false;
}

function runServeOff(port: number, run: TailscaleRunner): boolean {
  return runTailscaleSteps(serveOffSteps(port), run);
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

/** SIGHUP (terminal close) routed through process.exit so the "exit" handler tears the serve mapping down. 129 = 128 + SIGHUP. */
function onSigHup(): void {
  process.exit(129);
}

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
  httpsPort?: number;
  /** Proxy targets this caller made before (`http://127.0.0.1:<its last port>`): a mapping pointing at one is its own and is re-pointed; any other mapping is never overwritten. */
  ownTargets?: readonly string[];
  /** The caller owns the mapping's lifetime (the Inbox), so this module neither registers it for exit cleanup nor adds the served name to the Host allowlist. Default: torn down on exit. */
  persist?: boolean;
}

/** Publish a loopback-bound session port over the tailnet and return the advertised HTTPS URL. Throws an actionable message on any failure. */
export function enableTailscaleServe(
  port: number,
  run: TailscaleRunner = runTailscale,
  options: TailscaleServeOptions = {},
): { url: string } {
  const { url } = runTailscaleSteps(enableServeSteps(port, options), run);
  if (!options.persist) registerServeMapping(new URL(url).hostname, options.httpsPort ?? port, run);
  return { url };
}

export function* enableServeSteps(port: number, options: TailscaleServeOptions = {}): TailscaleSteps<{ url: string }> {
  const httpsPort = options.httpsPort ?? port;
  const status = yield step(["serve", "status", "--json"], TAILSCALE_SERVE_TIMEOUT_MS);
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
  const serve = yield step(buildServeArgs(port, httpsPort), TAILSCALE_SERVE_TIMEOUT_MS);
  const failed = Boolean(serve.error) || serve.status !== 0;
  const url = failed ? undefined : extractServeHttpsUrl(`${serve.stdout}\n${serve.stderr}`, httpsPort);
  if (!url) {
    // Serve is off for the tailnet: Tailscale prints its enable link, then exits 0 or waits. No mapping was made, so none to take down.
    const explained = explainTailscaleSetup(serve);
    if (explained) throw new TailscaleServeError("serve_failed", `--tailscale: ${explained}`);
  }
  if (failed) {
    throw new TailscaleServeError("serve_failed", `--tailscale: could not start tailscale serve. ${describeTailscaleFailure(serve)}`);
  }
  if (!url) {
    // The mapping may exist even though no URL could be read for our port: take it down rather than leak it.
    if (!(yield* serveOffSteps(httpsPort))) warnLeakedMapping(httpsPort);
    throw new TailscaleServeError(
      "no_url",
      `--tailscale: could not find an https:// URL for port ${httpsPort} in \`tailscale serve\` output.`,
    );
  }
  return { url };
}

/** A session's (non-`persist`) mapping is torn down on exit. The Inbox (persist) publishes its own tailnet-only listeners that check the tailnet name themselves, so the window port's Host allowlist never learns it. */
function registerServeMapping(hostname: string, httpsPort: number, run: TailscaleRunner): void {
  // tailscale serve forwards the browser's Host (the MagicDNS name) to the backend, so the Host allowlist must know it.
  allowServedHostname(hostname);
  activePorts.add(httpsPort);
  cleanupRunner = run;
  if (!exitCleanupInstalled) {
    exitCleanupInstalled = true;
    process.on("exit", onProcessExit);
    // SIGHUP is routed through process.exit only once a mapping exists: any SIGHUP listener overrides the disposition `nohup` relies on, but with a mapping terminal close must run cleanup or the `--bg` mapping leaks.
    process.once("SIGHUP", onSigHup);
  }
}

/** The URL appears once, on the stable ready line agents grep, then the tailnet line and QR. `handleServerReady` runs with `announce: false` (no second ready line) and `skipBrowserOpen` (the URL is for another device). */
export async function announceTailscaleSession(url: string, port: number): Promise<void> {
  process.stderr.write(`\n  ${SESSION_READY_LINE_PREFIX}${url}\n`);
  process.stderr.write("  Served over your tailnet: open it on your device (the URL above).\n");
  writeUrlQr(url);
  process.stderr.write("\n");
  await handleServerReady(url, false, port, { skipBrowserOpen: true, announce: false });
}

export function removeTailscaleServe(httpsPort: number, run: TailscaleRunner = runTailscale): boolean {
  return runServeOff(httpsPort, run);
}


/** Takes down the mapping on `httpsPort` only when it points at one of `targets`: someone else's mapping is never touched. */
export function takeDownOwnServeMapping(
  run: TailscaleRunner,
  httpsPort: number,
  targets: readonly string[],
): "removed" | "none" | "failed" {
  return runTailscaleSteps(takeDownOwnServeSteps(httpsPort, targets), run);
}

export function* takeDownOwnServeSteps(httpsPort: number, targets: readonly string[]): TailscaleSteps<"removed" | "none" | "failed"> {
  if (targets.length === 0) return "none";
  const status = yield step(["serve", "status", "--json"], TAILSCALE_SERVE_TIMEOUT_MS);
  if (status.error || status.status !== 0) return "failed";
  const existing = serveStatusProxy(status.stdout, httpsPort);
  if (existing.state === "malformed") return "failed";
  if (existing.state !== "mapped" || !targets.includes(existing.proxy)) return "none";
  return (yield* serveOffSteps(httpsPort)) ? "removed" : "failed";
}

/** The port is forgotten only after a successful off; a persistent failure warns with the manual command and stays registered so exit-time cleanup retries. */
export function disableTailscaleServe(port: number, run: TailscaleRunner = runTailscale): void {
  if (!activePorts.has(port)) return;
  if (runServeOff(port, run)) {
    activePorts.delete(port);
  } else {
    warnLeakedMapping(port);
  }
}

/** Test-only: restore module state so a test's injected-runner mappings cannot leak an exit-time cleanup against the real CLI. */
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
