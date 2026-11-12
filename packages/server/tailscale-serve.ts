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
  ownTargets?: readonly string[];
  persist?: boolean;
}

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
    const explained = explainTailscaleSetup(serve);
    if (explained) throw new TailscaleServeError("serve_failed", `--tailscale: ${explained}`);
  }
  if (failed) {
    throw new TailscaleServeError("serve_failed", `--tailscale: could not start tailscale serve. ${describeTailscaleFailure(serve)}`);
  }
  if (!url) {
    if (!(yield* serveOffSteps(httpsPort))) warnLeakedMapping(httpsPort);
    throw new TailscaleServeError(
      "no_url",
      `--tailscale: could not find an https:// URL for port ${httpsPort} in \`tailscale serve\` output.`,
    );
  }
  return { url };
}

function registerServeMapping(hostname: string, httpsPort: number, run: TailscaleRunner): void {
  allowServedHostname(hostname);
  activePorts.add(httpsPort);
  cleanupRunner = run;
  if (!exitCleanupInstalled) {
    exitCleanupInstalled = true;
    process.on("exit", onProcessExit);
    process.once("SIGHUP", onSigHup);
  }
}

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

export function disableTailscaleServe(port: number, run: TailscaleRunner = runTailscale): void {
  if (!activePorts.has(port)) return;
  if (runServeOff(port, run)) {
    activePorts.delete(port);
  } else {
    warnLeakedMapping(port);
  }
}

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
