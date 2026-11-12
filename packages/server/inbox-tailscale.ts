/**
 * Plannotator Inbox over the tailnet ("Over your tailnet"): `plannotator
 * inbox --tailscale`, PLANNOTATOR_INBOX_TAILSCALE, config.json
 * `inboxTailscale`. Mounted by packages/server/inbox.ts.
 *
 * The Inbox stays loopback-bound. `tailscale serve` (HTTPS, tailnet only,
 * never funnel) publishes `https://<MagicDNS name>:<the Inbox's port>` and
 * proxies it to a SECOND loopback listener that nothing but the tailnet is
 * pointed at; the window's own port is unchanged. The socket, not a header,
 * says a request came through the tailnet: serve passes the client's Host
 * through, so a peer could otherwise claim `Host: 127.0.0.1:<port>`.
 *
 * Every request on that listener passes, in order:
 *  1. Host is the served MagicDNS name and port (what a browser sends);
 *  2. `Tailscale-User-Login` (set by serve, never forgeable through it) is the
 *     machine owner's login or one in config.json `inboxTailscaleAllow`; a
 *     tagged peer (no login) and a funnel request are refused;
 *  3. no cross-site or same-site `Sec-Fetch-Site` except a top-level
 *     navigation and the attachment asset route (the identity is ambient);
 * then it is handed to the window's handler marked as tailnet, which refuses
 * `/mcp`, the connection routes, the device door and anything that widens the
 * Inbox's exposure, and applies the window's own guards (same origin, then
 * the `serverSession` nonce).
 *
 * Lifecycle. The mapping is recorded in inbox.json (`tailscale.https_port`,
 * `proxy_port`) BEFORE it is made, so a crash (kill -9, OOM, reboot) always
 * leaves a record of it. Every start first takes down a recorded mapping
 * whose proxy port is not this run's (a dead ephemeral port that any later
 * local server could bind); a take-down that fails keeps the record, for the
 * next start or `uninstall --purge`. A clean stop (quit, the stop route,
 * restart to update) takes it down too. A mapping this Inbox did not make is
 * never replaced, except one that points at the window's own port (the
 * manual `tailscale serve --https=<port> http://127.0.0.1:<port>`), which
 * exposes the whole Inbox and is replaced only when the person asks.
 * Tailscale missing, stopped or signed out never stops the Inbox: the reason
 * is kept for Settings, inbox.json and stderr.
 *
 * Publishing again by itself. While the switch is on and the last publish
 * failed, a timer looks again: with Tailscale not ready then (not running,
 * signed out, starting, or nobody to let in), `tailscale status --json` alone
 * every 30 s, backing off to every 5 minutes, and the publish as soon as it
 * is ready; with Tailscale ready and the publish still failing (a mapping on
 * the port, a refused serve), the whole publish once every 30 minutes. It
 * stops once published, switched off, stopping, or with no `tailscale` CLI
 * at all; no timer runs otherwise. A publish it makes tells the windows.
 *
 * The prototype relay (`openRelay`, inbox-live-relay.ts). A question's
 * running-app prototype is proxied on a loopback port of its own, which a
 * phone cannot reach. While published, the owner's first open of one makes a
 * second mapping, `https://<MagicDNS name>:<R>` to a loopback listener on
 * port R, and every request there passes the same Host and owner checks as
 * the window's (only the machine's owner, never a login the allowlist adds)
 * before the relay sees it. It is recorded (`relay_port`) before it is made,
 * taken down with the window's mapping, and a run's leftover is taken down at
 * the next start, as the window's is.
 */

import {
  loadConfig,
  parseInboxTailscaleEnv,
  resolveInboxTailscale,
  resolveInboxTailscaleAllow,
  saveConfig,
  type InboxTailscaleSource,
} from "@plannotator/shared/config";
import { readInboxRegistry, updateOwnInboxRegistry, type InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import { checkTailnetIdentity, isServedTailnetHost, normalizeTailnetLogin, tailnetFetchSiteAllowed } from "@plannotator/shared/inbox/tailnet";
import { InboxError } from "@plannotator/shared/inbox/schema";
import {
  describeTailscaleFailure,
  parseTailscaleSelfIdentity,
  runTailscale,
  serveStatusRoutes,
  serveTargetIsLoopbackPort,
  TAILSCALE_CLI_TIMEOUT_MS,
  TAILSCALE_SERVE_TIMEOUT_MS,
  type TailscaleRunner,
  type TailscaleRunResult,
} from "@plannotator/shared/tailscale";
import {
  enableServeSteps,
  runTailscaleSteps,
  runTailscaleStepsAsync,
  serveOffSteps,
  TailscaleServeError,
  takeDownOwnServeMapping,
  takeDownOwnServeSteps,
  type TailscaleRunnerAsync,
  type TailscaleStep,
  type TailscaleSteps,
} from "./tailscale-serve";
import { parseTailscaleBackend, runTailscaleQuietly } from "./inbox-pairing-checks";
import { syncSection } from "./inbox-perf";
import { INBOX_TAILNET_HTTPS_PORTS, INBOX_TAILNET_PORT_RANGE } from "./inbox-tailnet-door";

/** The ports the device door may take (inbox-tailnet-door.ts, 8443 to 8450): the window's mapping never takes one. */
export const isDoorTailnetPort = (port: number): boolean => INBOX_TAILNET_HTTPS_PORTS.includes(port);

/**
 * Publishing again by itself while the switch is on and the last publish failed. Tailscale not ready: a status
 * read after each wait in turn, the last one repeated. Ready but the publish still failed: the next try after
 * `stuckMs`, since the reason (a mapping on the port, a refused serve) is not Tailscale's state.
 */
export const INBOX_TAILSCALE_REPUBLISH = {
  waitMs: [30_000, 60_000, 120_000, 240_000, 300_000] as readonly number[],
  stuckMs: 30 * 60_000,
};

/** The retry's clock: tests pass their own. The default never keeps the process alive. */
export interface InboxTailscaleTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const defaultTimers: InboxTailscaleTimers = {
  set: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A serve route that points at the window's own port: it hands the tailnet the whole Inbox, `/mcp` included. */
export interface InboxTailnetExposure {
  /** The tailnet port serve listens on; null when a request showed the exposure but serve could not be read. */
  https_port: number | null;
  target: string | null;
}

export interface InboxTailscaleState {
  /** Publishing is on (the env var, the flag or the saved switch). */
  on: boolean;
  /** What decides it. */
  source: InboxTailscaleSource;
  /** PLANNOTATOR_INBOX_TAILSCALE when it is set (it decides, and the switch is locked), else null. */
  env: boolean | null;
  /** The tailnet address while the publication works. */
  url: string | null;
  /** Why the publication is not working. */
  error: string | null;
  /** The Tailscale login that owns this machine, as of the last publish. */
  owner: string | null;
  /** Every login let in: the owner, then config.json `inboxTailscaleAllow`. */
  allowed: string[];
  /** Serve routes that point at the window's own port (the manual workaround): each exposes the whole Inbox. */
  exposed: InboxTailnetExposure[];
}

export interface InboxTailscaleContext {
  dataDir: string;
  /** The window's loopback port: also the tailnet HTTPS port. */
  port: () => number;
  /** This run's registry entry (written in place, then saved). */
  registry: () => InboxRegistryEntry;
  /** The window's handler, for a request that passed the tailnet checks. */
  dispatch: (req: Request) => Promise<Response>;
  /** Tests: a scripted `tailscale`. Default: the CLI, as a child process on the request paths (never blocking the Inbox). */
  tailscale?: TailscaleRunner;
  /** `plannotator inbox --tailscale`: on for this run unless PLANNOTATOR_INBOX_TAILSCALE turns it off. */
  flag?: boolean;
  /** A terminal closing a foreground Inbox (SIGHUP) while published: stop cleanly, then exit. */
  onHangup?: () => void;
  maxRequestBodySize?: number;
  /** The tailnet listener just opened: the window starts compressing its page for it (#2032). */
  onListen?: () => void;
  /** Published by itself, after an earlier publish failed (Tailscale came back): the windows hear the new state. */
  onRepublished?: () => void;
  /** Tests: the retry's clock. Default: unref'd timers. */
  timers?: InboxTailscaleTimers;
}

/** The words for a route that exposes the window's own port, for Settings and stderr. */
export function exposureWarning(exposed: readonly InboxTailnetExposure[]): string {
  const ports = exposed.map((e) => e.https_port).filter((p): p is number => p !== null);
  const where = ports.length ? ` (tailscale serve port ${ports.join(", ")})` : "";
  return (
    `A tailscale serve mapping${where} points at the Inbox's own port. It exposes the whole Inbox, its agent tools (MCP) included, ` +
    "to everyone on your tailnet, so the Inbox refuses every request that comes through it. Replace it with the owner-only address."
  );
}

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function refusal(path: string, status: number, code: string, message: string): Response {
  if (path.startsWith("/api/") || path === "/mcp") {
    return new Response(JSON.stringify({ error: message, code }), { status, headers: JSON_HEADERS });
  }
  return new Response(`${message}\n`, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

export function createInboxTailscale(context: InboxTailscaleContext) {
  // The same command sequences run two ways (tailscale-serve.ts): at once at the start, the stop and the exit, and
  // without blocking the event loop for the window's switch, `--tailscale` against a running Inbox, and a served
  // request's exposure scan.
  const runAtOnce = context.tailscale ?? runTailscale;
  const run: TailscaleRunner = (args, timeoutMs) => syncSection(`tailscale:${args.slice(0, 2).join(" ")}`, () => runAtOnce(args, timeoutMs));
  const runAsync: TailscaleRunnerAsync = context.tailscale ?? runTailscaleQuietly;
  const step = (args: string[], timeoutMs: number): TailscaleStep => ({ args, timeoutMs });
  let runFlag = context.flag === true;
  let listener: ReturnType<typeof Bun.serve> | null = null;
  let servedHostname: string | null = null;
  let httpsPort: number | null = null;
  let warnedExposure = false;
  /** The prototype relay's listener (port R, also its tailnet HTTPS port) and its origin while mapped. */
  let relayListener: ReturnType<typeof Bun.serve> | null = null;
  let relayOrigin: string | null = null;
  /** The relay port while its mapping may exist (this run's, or one a run before left and not yet taken down). */
  let relayKept: number | null = null;
  const state = {
    url: null as string | null,
    error: null as string | null,
    owner: null as string | null,
    allowed: [] as string[],
    exposed: [] as InboxTailnetExposure[],
  };

  const resolve = () => resolveInboxTailscale(loadConfig(), process.env, runFlag);

  const snapshot = (): InboxTailscaleState => {
    const { on, source } = resolve();
    return {
      on,
      source,
      env: parseInboxTailscaleEnv() ?? null,
      url: state.url,
      error: state.error,
      owner: state.owner,
      allowed: [...state.allowed],
      exposed: state.exposed.map((e) => ({ ...e })),
    };
  };

  const record = () => context.registry().tailscale;

  /**
   * Keep the state in inbox.json (and this run's entry), so a reader of the
   * file sees the address or the reason. The file only while it is still this
   * Inbox's: a stopping Inbox must never write its own pid over the entry of
   * one that started since, nor make a removed data folder again.
   */
  const save = (value: InboxRegistryEntry["tailscale"] | undefined) => {
    const apply = (target: InboxRegistryEntry) => {
      // The relay's record rides every save while its mapping may exist.
      const relay = relayKept !== null ? { relay_port: relayKept } : {};
      if (value) target.tailscale = { ...value, ...relay };
      else if (relayKept !== null) target.tailscale = { url: null, error: null, ...relay };
      else delete target.tailscale;
    };
    apply(context.registry());
    updateOwnInboxRegistry(context.dataDir, context.registry().serverSession, apply);
  };

  /** Record or forget the relay's port, the rest of the record kept. */
  const saveRelay = (port: number | null) => {
    relayKept = port;
    const kept = record();
    save(kept ? { url: kept.url, error: kept.error, ...(kept.https_port ? { https_port: kept.https_port, proxy_port: kept.proxy_port } : {}) } : undefined);
  };

  /** Take the relay's mapping down (this run's, or a leftover). False when it may still exist: the record stays. */
  const takeDownRelay = function* (): TailscaleSteps<boolean> {
    const port = relayListener ? (relayListener.port as number) : (relayKept ?? record()?.relay_port ?? null);
    relayOrigin = null;
    if (relayListener) {
      relayListener.stop(true);
      relayListener = null;
    }
    if (port === null) return true;
    relayKept = port;
    const result = yield* takeDownOwnServeSteps(port, [`http://127.0.0.1:${port}`]);
    if (result === "failed") return false;
    saveRelay(null);
    return true;
  };

  /** The record with its ports kept (a mapping may exist), and why. */
  const keepRecord = (error: string) => {
    const kept = record();
    save({ url: null, error, ...(kept?.https_port ? { https_port: kept.https_port, proxy_port: kept.proxy_port } : {}) });
  };

  /** Proxy targets a mapping of this Inbox's own points at: this run's listener, or the one inbox.json names. */
  const ownTargets = () =>
    [listener?.port, record()?.proxy_port].filter((p): p is number => typeof p === "number" && p > 0).map((p) => `http://127.0.0.1:${p}`);

  // ── The tailnet-only listener ──

  const listenerFetch = async (req: Request): Promise<Response> => {
    let path = "/";
    try {
      path = new URL(req.url, "http://127.0.0.1").pathname;
    } catch {
      return refusal("/api/", 400, "bad_request", "Bad request.");
    }
    if (!servedHostname || httpsPort === null || !isServedTailnetHost(req.headers.get("host"), servedHostname, httpsPort)) {
      return refusal(path, 403, "forbidden_host", "This address answers only its tailnet name.");
    }
    const identity = checkTailnetIdentity(req.headers, state.allowed);
    if (!identity.ok) return refusal(path, identity.status, identity.code, identity.message);
    if (!tailnetFetchSiteAllowed(req.method, path, req.headers)) {
      return refusal(path, 403, "cross_site", "Requests from other sites are not accepted.");
    }
    return context.dispatch(req);
  };

  const openListener = (): number => {
    if (listener) return listener.port as number;
    listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      maxRequestBodySize: context.maxRequestBodySize,
      fetch: listenerFetch,
    } as Parameters<typeof Bun.serve>[0]);
    context.onListen?.();
    return listener.port as number;
  };

  /**
   * Close the tailnet listener. `later`: the request that asked (the switch
   * turned off through the tailnet) is answered on this listener, so it
   * closes once that answer is on its way.
   */
  const closeListener = (later = false) => {
    const closing = listener;
    listener = null;
    servedHostname = null;
    if (!closing) return;
    if (later) setTimeout(() => closing.stop(true), 250);
    else closing.stop(true);
  };

  // ── Process exit and terminal close while published ──
  //
  // A clean stop takes the mapping down. The exit handler covers a path that
  // ends the process without it (another SIGHUP handler that exits first);
  // SIGHUP is routed only while a mapping exists, so `nohup` keeps working
  // otherwise (the `--tailscale` rule, tailscale-serve.ts). While published,
  // `nohup plannotator inbox --tailscale &` therefore ends with the terminal.
  const onExit = () => {
    if (relayKept !== null) takeDownOwnServeMapping(run, relayKept, [`http://127.0.0.1:${relayKept}`]);
    if (httpsPort !== null) takeDownOwnServeMapping(run, httpsPort, ownTargets());
  };
  const onHangup = () => {
    if (context.onHangup) context.onHangup();
    else process.exit(129);
  };
  const guardProcess = (on: boolean) => {
    process.removeListener("exit", onExit);
    process.removeListener("SIGHUP", onHangup);
    if (on) {
      process.on("exit", onExit);
      process.once("SIGHUP", onHangup);
    }
  };

  // ── Routes pointing at the window's own port (the manual workaround) ──

  /** Read serve's routes and keep those that land on the window's port. Undefined when serve cannot be read. */
  const scanExposure = function* (): TailscaleSteps<InboxTailnetExposure[] | undefined> {
    const status = yield step(["serve", "status", "--json"], TAILSCALE_SERVE_TIMEOUT_MS);
    if (status.error || status.status !== 0) return undefined;
    const routes = serveStatusRoutes(status.stdout);
    if (!routes) return undefined;
    const port = context.port();
    const seen = new Set<number>();
    const exposed: InboxTailnetExposure[] = [];
    for (const route of routes) {
      if (!serveTargetIsLoopbackPort(route.target, port) || seen.has(route.port)) continue;
      seen.add(route.port);
      exposed.push({ https_port: route.port, target: route.target });
    }
    return exposed;
  };

  const warnExposure = () => {
    if (warnedExposure || state.exposed.length === 0) return;
    warnedExposure = true;
    process.stderr.write(`[plannotator] ${exposureWarning(state.exposed)} Settings > Over your tailnet offers it.\n`);
  };

  /**
   * The window's port refused a request that came through serve: a mapping
   * points at it. Find which (serve status) and say so once. The refusal
   * answers at once; the scan runs after it, one at a time.
   */
  let scanning = false;
  const noteServedRequest = () => {
    if (state.exposed.length > 0 || scanning) return;
    scanning = true;
    void serial(async () => {
      if (state.exposed.length > 0) return;
      const found = await runTailscaleStepsAsync(scanExposure(), runAsync);
      state.exposed = found && found.length > 0 ? found : [{ https_port: null, target: null }];
      warnExposure();
    })
      .catch(() => {})
      .finally(() => {
        scanning = false;
      });
  };

  const failureWords = (error: unknown, port: number): string => {
    if (error instanceof TailscaleServeError && error.code === "conflict") {
      return `Another tailscale serve mapping already uses port ${port}, the Inbox's port. The Inbox never replaces it: remove it with "tailscale serve --https=${port} off" if nothing needs it.`;
    }
    const detail = error instanceof Error ? error.message.replace(/^--tailscale:\s*/, "") : String(error);
    return `Tailscale could not publish the Inbox. ${detail}`;
  };

  // ── Publishing again by itself (INBOX_TAILSCALE_REPUBLISH) ──

  const timers = context.timers ?? defaultTimers;
  let retryTimer: unknown = null;
  /** "wait": Tailscale was not ready at the last try, so only its status is read. "stuck": it was, and the publish failed anyway. */
  let retryMode: "wait" | "stuck" = "wait";
  let retryStep = 0;
  /** Tailscale was ready (`ready`) when the last publish was tried: its failure was for another reason. */
  let triedReady = false;
  /** No `tailscale` command at all: nothing to wait for, as before this retry existed. */
  let cliMissing = false;

  /** Running, and someone may be let in (the owner, or a login in `inboxTailscaleAllow`). */
  const ready = (status: TailscaleRunResult): boolean => {
    if (status.error || status.status !== 0) return false;
    const backend = parseTailscaleBackend(status.stdout);
    if (backend.state !== "running") return false;
    return backend.login !== null || resolveInboxTailscaleAllow(loadConfig()).length > 0;
  };
  const observe = (status: TailscaleRunResult) => {
    cliMissing = (status.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
    triedReady = ready(status);
  };

  /** Who may use the published Inbox: the owner of this machine plus the allowlist. Throws the reason when nobody may. */
  const readAllowed = function* (): TailscaleSteps<{ owner: string | null; allowed: string[] }> {
    const status = yield step(["status", "--json"], TAILSCALE_CLI_TIMEOUT_MS);
    observe(status);
    if (status.error || status.status !== 0) throw new Error(describeTailscaleFailure(status));
    const identity = parseTailscaleSelfIdentity(status.stdout);
    if (!identity) throw new Error("Could not read `tailscale status --json`.");
    const owner = identity.login ? normalizeTailnetLogin(identity.login) : null;
    const extra = resolveInboxTailscaleAllow(loadConfig());
    const allowed = owner ? [owner, ...extra.filter((login) => login !== owner)] : extra;
    if (allowed.length === 0) {
      throw new Error(
        identity.tagged
          ? "This machine is a tagged Tailscale device, so it has no owner to let in. Add your Tailscale login to inboxTailscaleAllow in config.json."
          : "Tailscale did not say who owns this machine. Add your Tailscale login to inboxTailscaleAllow in config.json.",
      );
    }
    return { owner, allowed };
  };

  /**
   * Take down a recorded mapping whose proxy port is not this run's (the
   * last run's, dead or about to be). False when it may still exist: the
   * record is kept, with the reason.
   */
  const reconcile = function* (): TailscaleSteps<boolean> {
    // A relay mapping a run before left: down first. A failure keeps its record for the next start; the window still publishes.
    const leftRelay = record()?.relay_port;
    if (leftRelay && !relayListener) {
      relayKept = leftRelay;
      yield* takeDownRelay();
    }
    const kept = record();
    if (!kept?.https_port || !kept.proxy_port || kept.proxy_port === listener?.port) return true;
    const result = yield* takeDownOwnServeSteps(kept.https_port, [`http://127.0.0.1:${kept.proxy_port}`]);
    if (result === "failed") {
      state.error = `Could not remove the tailnet address an earlier run left; it is retried at the next start. Or run "tailscale serve --https=${kept.https_port} off".`;
      keepRecord(state.error);
      return false;
    }
    save({ url: null, error: null });
    return true;
  };

  /** Publish the mapping. Never throws: a failure is kept as `error`. `seenReady`: Tailscale was just read as ready. */
  const publish = function* (seenReady = false): TailscaleSteps<boolean> {
    triedReady = seenReady;
    const port = context.port();
    if (!(yield* reconcile())) return false;
    try {
      if (isDoorTailnetPort(port)) throw new Error(`Port ${port} is kept for the Inbox's door (${INBOX_TAILNET_PORT_RANGE}).`);
      const who = yield* readAllowed();
      state.owner = who.owner;
      state.allowed = who.allowed;
      state.exposed = (yield* scanExposure()) ?? state.exposed;
      warnExposure();
      if (state.exposed.some((e) => e.https_port === port)) throw new Error(exposureWarning(state.exposed));
      const proxyPort = openListener();
      // Recorded before it exists, so a crash between here and a clean stop always leaves a record to take down.
      save({ url: null, error: null, https_port: port, proxy_port: proxyPort });
      const { url } = yield* enableServeSteps(proxyPort, { httpsPort: port, ownTargets: ownTargets(), persist: true });
      servedHostname = new URL(url).hostname.toLowerCase();
      httpsPort = port;
      state.url = `${url}/`;
      state.error = null;
      save({ url: state.url, error: null, https_port: port, proxy_port: proxyPort });
      guardProcess(true);
      return true;
    } catch (error) {
      state.url = null;
      state.error = failureWords(error, port);
      const targets = ownTargets();
      closeListener();
      httpsPort = null;
      guardProcess(false);
      // The mapping may have been made before the failure (no URL in serve's answer): take it down, or keep the record.
      const taken = record()?.https_port ? yield* takeDownOwnServeSteps(port, targets) : "none";
      if (taken === "failed") keepRecord(state.error);
      else save({ url: null, error: state.error });
      return false;
    }
  };

  /** Take this Inbox's own mapping down (never someone else's). "failed" leaves the listener up and the record kept. */
  const unpublish = function* (later = false): TailscaleSteps<"removed" | "none" | "failed"> {
    // The relay goes with the window's address; a failure keeps its record for the next start.
    if (relayListener || relayKept !== null) yield* takeDownRelay();
    const port = httpsPort ?? record()?.https_port ?? null;
    const result = port === null ? "none" : yield* takeDownOwnServeSteps(port, ownTargets());
    if (result === "failed") return result;
    closeListener(later);
    httpsPort = null;
    guardProcess(false);
    state.url = null;
    return result;
  };

  /**
   * At start: take down any mapping a run that did not stop cleanly left,
   * then publish when the switch is on. A take-down that fails keeps the
   * record (never forgotten), and nothing is published over it this run.
   */
  const start = () => {
    triedReady = false;
    runTailscaleSteps(
      (function* () {
        if (!(yield* reconcile())) return;
        if (resolve().on) yield* publish();
        else if (record()) save(undefined);
      })(),
      run,
    );
    afterAttempt();
  };

  const cancelRetry = () => {
    if (retryTimer !== null) timers.clear(retryTimer);
    retryTimer = null;
  };
  /** Worth looking again: on, not published, not stopping, and a `tailscale` to ask. */
  const retryWanted = () => !stopped && !state.url && !cliMissing && resolve().on;
  const arm = (ms: number) => {
    cancelRetry();
    retryTimer = timers.set(() => {
      retryTimer = null;
      void serial(retry).catch(() => {});
    }, ms);
  };
  /** After every publish (or a change that may have made one): the next look, or none. */
  const afterAttempt = () => {
    cancelRetry();
    if (!retryWanted()) return;
    if (triedReady) {
      retryMode = "stuck";
      arm(INBOX_TAILSCALE_REPUBLISH.stuckMs);
    } else {
      retryMode = "wait";
      retryStep = 0;
      arm(INBOX_TAILSCALE_REPUBLISH.waitMs[0]!);
    }
  };
  /** One look, one at a time with the switch's changes. Quiet while Tailscale is not ready: nothing saved, nothing printed. */
  const retry = async () => {
    if (!retryWanted()) return;
    if (retryMode === "wait") {
      let status: TailscaleRunResult;
      try {
        status = await runAsync(["status", "--json"], TAILSCALE_CLI_TIMEOUT_MS);
      } catch (error) {
        status = { status: null, stdout: "", stderr: "", error: error instanceof Error ? error : new Error(String(error)) };
      }
      cliMissing = (status.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
      if (!retryWanted()) return;
      if (!ready(status)) {
        const waits = INBOX_TAILSCALE_REPUBLISH.waitMs;
        retryStep = Math.min(retryStep + 1, waits.length - 1);
        arm(waits[retryStep]!);
        return;
      }
    }
    let published = false;
    try {
      published = await runTailscaleStepsAsync(publish(true), runAsync);
    } finally {
      afterAttempt();
    }
    if (published) context.onRepublished?.();
  };

  // ── The request paths' changes, one at a time ──

  /** Changes made without blocking (the switch, `--tailscale`, a scan), each after the one before. */
  let queue: Promise<unknown> = Promise.resolve();
  let pending = 0;
  let stopped = false;
  const serial = <T>(change: () => Promise<T>): Promise<T> => {
    pending += 1;
    const ran = queue.then(() => {
      if (stopped) throw new InboxError("tailscale_unavailable", "The Inbox is stopping.");
      return change();
    });
    queue = ran
      .catch(() => {})
      .then(() => {
        pending -= 1;
        // The stop came while a change ran: what that change published goes down now.
        if (stopped && pending === 0) stopNow();
      });
    return ran;
  };

  /**
   * A clean stop: the mapping and the listener go, so nothing is published
   * while the Inbox is stopped; the switch stays as saved and the next start
   * publishes again. A take-down that fails keeps the record for the next
   * start or `uninstall --purge`, and answers its port (`failedPort`) so a
   * caller with nobody else to tell can print the manual command.
   */
  const stop = (): { failedPort: number | null } => {
    stopped = true;
    cancelRetry();
    return stopNow();
  };
  const stopNow = (): { failedPort: number | null } => {
    if (httpsPort === null && !listener && !record()) return { failedPort: null };
    const port = httpsPort ?? record()?.https_port ?? null;
    if (runTailscaleSteps(unpublish(), run) === "failed") {
      keepRecord(`Could not take the tailnet address down; run "tailscale serve --https=${port} off".`);
      closeListener();
      httpsPort = null;
      guardProcess(false);
      state.url = null;
      return { failedPort: port };
    }
    // A change still running may publish after this: its record stays for the next start until it is down.
    if (record()) {
      if (pending > 0) keepRecord(`Stopped while publishing; the tailnet address is taken down at the next start, or run "tailscale serve --https=${port} off".`);
      else save(undefined);
    }
    return { failedPort: null };
  };

  /** The window's switch: saved to config.json, applied now. `via`: the request came through the tailnet. */
  const set = (on: boolean, options: { via?: "local" | "tailnet"; replaceExposed?: boolean } = {}): Promise<InboxTailscaleState> =>
    serial(() => runTailscaleStepsAsync(setSteps(on, options), runAsync).finally(afterAttempt));
  const setSteps = function* (on: boolean, options: { via?: "local" | "tailnet"; replaceExposed?: boolean }): TailscaleSteps<InboxTailscaleState> {
    const env = parseInboxTailscaleEnv();
    if (env !== undefined) {
      throw new InboxError("tailscale_env_decides", `PLANNOTATOR_INBOX_TAILSCALE is set in this Inbox's environment, so it stays ${env ? "on" : "off"}.`);
    }
    if (!on) {
      if ((yield* unpublish(options.via === "tailnet")) === "failed") {
        throw new InboxError(
          "tailscale_unavailable",
          `Tailscale could not take the Inbox's tailnet address down. Try again, or run "tailscale serve --https=${context.port()} off".`,
        );
      }
      state.error = null;
    }
    if (on && options.replaceExposed) {
      // Only routes that still point at the window's own port, and only because the person asked.
      const exposed = yield* scanExposure();
      if (!exposed) throw new InboxError("tailscale_unavailable", "Tailscale could not say which mapping to replace. Try again.");
      for (const route of exposed) {
        if (route.https_port !== null && !(yield* serveOffSteps(route.https_port))) {
          throw new InboxError("tailscale_unavailable", `Tailscale could not remove the mapping on port ${route.https_port}. Run "tailscale serve --https=${route.https_port} off".`);
        }
      }
      state.exposed = [];
      warnedExposure = false;
    }
    saveConfig({ inboxTailscale: on });
    if (loadConfig().inboxTailscale !== on) throw new InboxError("config_not_saved", "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.");
    // The saved switch decides from now on, not this run's flag.
    runFlag = false;
    if (on) yield* publish();
    else save(undefined);
    return snapshot();
  };

  /** `plannotator inbox --tailscale` against a running Inbox: on for this run, unless the env var keeps it off. */
  const enableForRun = (): Promise<InboxTailscaleState> =>
    serial(() =>
      runTailscaleStepsAsync(
        (function* () {
          runFlag = true;
          if (resolve().on && !state.url) yield* publish();
          return snapshot();
        })(),
        runAsync,
      ).finally(afterAttempt),
    );

  /**
   * The prototype relay's origin, `https://<MagicDNS name>:<R>`, mapped on first use (inbox-live-relay.ts hands its
   * handlers). Every request reaching `handlers.fetch` named the relay's Host and came from the machine's owner.
   */
  const openRelay = (handlers: InboxTailnetRelayHandlers): Promise<string> =>
    serial(() =>
      runTailscaleStepsAsync(
        (function* (): TailscaleSteps<string> {
          if (!state.url || !servedHostname) throw new InboxError("tailscale_unavailable", "The Inbox is not published over your tailnet now.");
          if (relayListener && relayOrigin) return relayOrigin;
          const hostname = servedHostname;
          const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            idleTimeout: 0,
            maxRequestBodySize: context.maxRequestBodySize,
            fetch(req: Request, srv: unknown) {
              const port = relayListener ? (relayListener.port as number) : -1;
              if (!isServedTailnetHost(req.headers.get("host"), hostname, port)) {
                return refusal("/", 403, "forbidden_host", "This address answers only its tailnet name.");
              }
              const identity = checkTailnetIdentity(req.headers, state.allowed);
              if (!identity.ok) return refusal("/", identity.status, identity.code, identity.message);
              if (!isOwner(req.headers)) return refusal("/", 403, "owner_only", "A prototype opens only for this computer's owner.");
              return handlers.fetch(req, srv);
            },
            websocket: handlers.websocket,
          } as unknown as Parameters<typeof Bun.serve>[0]);
          relayListener = server;
          const port = server.port as number;
          // Recorded before it exists, as the window's mapping is.
          saveRelay(port);
          try {
            yield* enableServeSteps(port, { httpsPort: port, ownTargets: [`http://127.0.0.1:${port}`], persist: true });
          } catch (error) {
            yield* takeDownRelay();
            throw new InboxError("tailscale_unavailable", `Tailscale could not serve the prototype to your tailnet. ${error instanceof Error ? error.message.replace(/^--tailscale:\s*/, "") : String(error)}`);
          }
          relayOrigin = `https://${hostname}:${port}`;
          return relayOrigin;
        })(),
        runAsync,
      ),
    );

  const isOwner = (headers: Headers): boolean => {
    const identity = checkTailnetIdentity(headers, state.allowed);
    if (!identity.ok) return false;
    return state.owner === null || normalizeTailnetLogin(identity.login) === state.owner;
  };

  return {
    start,
    stop,
    set,
    openRelay,
    /** The window's tailnet origin while published (the relay's pages name it as their only frame ancestor). */
    windowOrigin: (): string | null => (servedHostname && httpsPort !== null && state.url ? `https://${servedHostname}:${httpsPort}` : null),
    /** The relay's listener port while it is up (tests). */
    relayPort: () => (relayListener ? (relayListener.port as number) : null),
    enableForRun,
    noteServedRequest,
    state: snapshot,
    /** Published only because this run was started (or asked) with `--tailscale`: a restart must pass it on. */
    runOnly: () => runFlag && resolve().source === "flag",
    /** A retry is waiting to look again (tests). */
    retrying: () => retryTimer !== null,
    /** The tailnet-only listener's port while published (tests). */
    listenerPort: () => (listener ? (listener.port as number) : null),
    /**
     * A request the listener let in came from the machine's owner, not a login
     * config.json `inboxTailscaleAllow` added: only the owner may send
     * Feedback (inbox-feedback.ts). A machine Tailscale names no owner for (a
     * tagged device, or an untagged one whose owner `tailscale status` does
     * not report) is published only for its allowlist, the person who uses
     * it: there every allowed login is the owner. "Ask this session" follows
     * the same rule (`readTailnetOwners` in session-tailnet.ts).
     */
    isOwnerRequest: isOwner,
  };
}

export type InboxTailscale = ReturnType<typeof createInboxTailscale>;

/** The prototype relay's request and WebSocket handlers (inbox-live-relay.ts), behind the relay's own checks. */
export interface InboxTailnetRelayHandlers {
  fetch: (req: Request, server: unknown) => Response | undefined | Promise<Response | undefined>;
  websocket: unknown;
}

/**
 * `uninstall --purge` with the Inbox stopped: take down the window's tailnet
 * mapping a crashed run left, by the ports inbox.json kept. Nothing is
 * spawned when there is none.
 */
export function takeDownInboxTailscale(dataDir: string, run: TailscaleRunner = runTailscale): "removed" | "none" | "failed" {
  const kept = readInboxRegistry(dataDir)?.tailscale;
  // The prototype relay's mapping too (its target is the loopback listener on the same port number).
  const relay = kept?.relay_port ? takeDownOwnServeMapping(run, kept.relay_port, [`http://127.0.0.1:${kept.relay_port}`]) : "none";
  const window = kept?.https_port && kept.proxy_port ? takeDownOwnServeMapping(run, kept.https_port, [`http://127.0.0.1:${kept.proxy_port}`]) : "none";
  if (relay === "failed" || window === "failed") return "failed";
  return relay === "removed" || window === "removed" ? "removed" : "none";
}
