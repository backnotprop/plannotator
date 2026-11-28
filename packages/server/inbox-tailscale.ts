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
 *     login that owns this machine (single player: nobody else; only a tagged
 *     machine, which has no owner, names its owner in config.json
 *     `inboxTailscaleAllow`); another account gets the refusal page
 *     (`@plannotator/shared/inbox/tailnet-refusal`), a tagged peer (no login)
 *     and a funnel request are refused;
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
 * the window's before the relay sees it. It is recorded (`relay_port`) before it is made,
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
import { checkTailnetIdentity, fromOwnTailnetNode, isServedTailnetHost, normalizeTailnetLogin, tailnetFetchSiteAllowed, type TailnetCheck } from "@plannotator/shared/inbox/tailnet";
import { allowIgnoredLine, tailnetNotOwnerResponse } from "@plannotator/shared/inbox/tailnet-refusal";
import { InboxError } from "@plannotator/shared/inbox/schema";
import {
  describeTailscaleFailure,
  parseTailscaleSelfAddresses,
  parseTailscaleSelfIdentity,
  runTailscale,
  serveStatusProxy,
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
  type TakeDownAnswer,
} from "./tailscale-serve";
import { parseTailscaleBackend, runTailscaleQuietly } from "./inbox-pairing-checks";
import { syncSection } from "./inbox-perf";
import { INBOX_TAILNET_HTTPS_PORTS, INBOX_TAILNET_PORT_RANGE, loopbackPortRefused } from "./inbox-tailnet-door";

/** How many proxy ports the record keeps as the Inbox's own (`made`), for its one https port. */
export const WINDOW_PROXY_PORTS_KEPT = 3;

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
  /** Every login let in: the owner alone, or on a tagged machine (no owner) config.json `inboxTailscaleAllow`. */
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
  /**
   * The window's handler, for a request that passed the tailnet checks. `ownNode`: opened by this computer itself
   * on its tailnet address (`fromOwnTailnetNode`), so it is this computer's own window, not another computer's.
   */
  dispatch: (req: Request, from?: { ownNode: boolean }) => Promise<Response>;
  /** Tests: a scripted `tailscale`. Default: the CLI, as a child process on the request paths (never blocking the Inbox). */
  tailscale?: TailscaleRunner;
  /** `plannotator inbox --tailscale`: on for this run unless PLANNOTATOR_INBOX_TAILSCALE turns it off. */
  flag?: boolean;
  /** A terminal closing a foreground Inbox (SIGHUP) while published: stop cleanly, then exit. */
  onHangup?: () => void;
  maxRequestBodySize?: number;
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

/**
 * Another Tailscale account (or a tagged device with none): the refusal page for a browser, the same words as JSON
 * for an API call, the event stream or `/mcp`. A funnel request keeps its own words (the Inbox is never public).
 */
function refuseIdentity(path: string, identity: Extract<TailnetCheck, { ok: false }>): Response {
  if (identity.code === "tailnet_funnel_refused") return refusal(path, identity.status, identity.code, identity.message);
  return tailnetNotOwnerResponse("Inbox", path, identity.login ?? null, identity.code);
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
  let warnedAllowIgnored = false;
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
    /** This machine's own tailnet addresses, as of the last publish: a request from one is this computer's own window. */
    self: [] as string[],
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
    // The ports this Inbox mapped ride every save while publishing is on, so a take-down that read an empty `serve
    // status` (Tailscale stopped) never forgets a mapping that comes back with Tailscale.
    const made = value && !value.made && record()?.made ? { made: record()!.made } : {};
    const apply = (target: InboxRegistryEntry) => {
      // The relay's record rides every save while its mapping may exist.
      const relay = relayKept !== null ? { relay_port: relayKept } : {};
      if (value) target.tailscale = { ...value, ...made, ...relay };
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
    if (result === "failed" || result === "later") return false;
    saveRelay(null);
    return true;
  };

  /** A take-down still owed (Tailscale was not running): the record keeps its ports, and no words of its own. */
  const keepOwed = () => {
    const kept = record();
    save({ url: null, error: null, ...(kept?.https_port ? { https_port: kept.https_port, proxy_port: kept.proxy_port } : {}) });
  };

  /** The record with its ports kept (a mapping may exist), and why. */
  const keepRecord = (error: string) => {
    const kept = record();
    save({ url: null, error, ...(kept?.https_port ? { https_port: kept.https_port, proxy_port: kept.proxy_port } : {}) });
  };

  /**
   * Proxy ports this Inbox mapped before (`made`) that a connect found dead just before a publish (`probeLeftover`,
   * without blocking): a mapping a crash or an unclean stop left on one of them is still the Inbox's.
   */
  const deadPorts = new Set<number>();

  /**
   * Proxy targets a mapping of this Inbox's own points at: this run's listener, the one inbox.json names, and a port it
   * mapped before on this https port (`made`) found dead (`deadPorts`). A port found alive, or never probed, is not.
   */
  const ownTargets = () => {
    const mine = listener?.port;
    const kept = record();
    const ports = [mine, kept?.proxy_port].filter((p): p is number => typeof p === "number" && p > 0);
    if (kept?.made && kept.made.https_port === context.port()) for (const p of kept.made.proxy_ports) if (!ports.includes(p) && deadPorts.has(p)) ports.push(p);
    return ports.map((p) => `http://127.0.0.1:${p}`);
  };
  /** `made` for the https port `port` with `proxies` added at the end, the newest `WINDOW_PROXY_PORTS_KEPT`; another https port starts over. */
  const madeWith = (port: number, ...proxies: (number | undefined)[]): { https_port: number; proxy_ports: number[] } => {
    const kept = record()?.made;
    const out = (kept && kept.https_port === port ? kept.proxy_ports : []).filter((p) => !proxies.includes(p));
    for (const p of proxies) if (typeof p === "number" && p > 0 && !out.includes(p)) out.push(p);
    return { https_port: port, proxy_ports: out.slice(-WINDOW_PROXY_PORTS_KEPT) };
  };
  /**
   * Before a publish, without blocking: the mapping on the Inbox's port, when it points at a proxy port this Inbox made
   * (not this run's listener), is probed; a refused connect puts it in `deadPorts`.
   */
  const probeLeftover = async () => {
    deadPorts.clear();
    const kept = record()?.made;
    const port = context.port();
    if (!kept || kept.https_port !== port || kept.proxy_ports.length === 0) return;
    let serve: TailscaleRunResult;
    try {
      serve = await runAsync(["serve", "status", "--json"], TAILSCALE_SERVE_TIMEOUT_MS);
    } catch {
      return;
    }
    if (serve.error || serve.status !== 0) return;
    const mapped = serveStatusProxy(serve.stdout, port);
    const proxy = mapped.state === "mapped" ? /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(mapped.proxy)?.[1] : undefined;
    const leftover = proxy === undefined ? null : Number(proxy);
    if (leftover === null || leftover === listener?.port || !kept.proxy_ports.includes(leftover)) return;
    if (await loopbackPortRefused(leftover)) deadPorts.add(leftover);
  };

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
    if (!identity.ok) return refuseIdentity(path, identity);
    if (!tailnetFetchSiteAllowed(req.method, path, req.headers)) {
      return refusal(path, 403, "cross_site", "Requests from other sites are not accepted.");
    }
    return context.dispatch(req, { ownNode: fromOwnTailnetNode(req.headers, state.self) });
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
  let retryMode: "wait" | "stuck" | "owed" = "wait";
  let retryStep = 0;
  /** A publish found another mapping on the port that may be a dead one of this Inbox's own: look at once. */
  let probeSoon = false;
  /** The look is probing and publishing: a conflict it meets is final for this round. */
  let probing = false;
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

  /**
   * Who may use the published Inbox: the Tailscale login that owns this machine, and nobody else (single player).
   * Only where Tailscale names no owner (a tagged device) does config.json `inboxTailscaleAllow` say who the owner is;
   * on a machine with an owner it is ignored, said once on stderr. Throws the reason when nobody may.
   */
  const readAllowed = function* (): TailscaleSteps<{ owner: string | null; allowed: string[]; self: string[] }> {
    const status = yield step(["status", "--json"], TAILSCALE_CLI_TIMEOUT_MS);
    observe(status);
    if (status.error || status.status !== 0) throw new Error(describeTailscaleFailure(status));
    const identity = parseTailscaleSelfIdentity(status.stdout);
    if (!identity) throw new Error("Could not read `tailscale status --json`.");
    const owner = identity.login ? normalizeTailnetLogin(identity.login) : null;
    const extra = resolveInboxTailscaleAllow(loadConfig());
    if (owner && extra.some((login) => login !== owner) && !warnedAllowIgnored) {
      warnedAllowIgnored = true;
      process.stderr.write(`[plannotator] ${allowIgnoredLine(owner)}\n`);
    }
    const allowed = owner ? [owner] : extra;
    if (allowed.length === 0) {
      throw new Error(
        identity.tagged
          ? "This machine is a tagged Tailscale device, so it has no owner to let in. Add your Tailscale login to inboxTailscaleAllow in config.json."
          : "Tailscale did not say who owns this machine. Add your Tailscale login to inboxTailscaleAllow in config.json.",
      );
    }
    return { owner, allowed, self: parseTailscaleSelfAddresses(status.stdout) };
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
    // Tailscale not running: nothing to take down yet. The record stays as it is, without words of its own; the
    // publish that follows says why it could not publish, as it always has, and the take-down runs once Tailscale does.
    if (result === "later") return true;
    if (result === "failed") {
      state.error = `Could not remove the tailnet address an earlier run left; it is retried at the next start. Or run "tailscale serve --https=${kept.https_port} off".`;
      keepRecord(state.error);
      return false;
    }
    // The port stays known as one this Inbox made (`made`), so a mapping that is still there later is known as its own.
    save({ url: null, error: null, made: madeWith(kept.https_port, kept.proxy_port) });
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
      state.self = who.self;
      state.exposed = (yield* scanExposure()) ?? state.exposed;
      warnExposure();
      if (state.exposed.some((e) => e.https_port === port)) throw new Error(exposureWarning(state.exposed));
      const proxyPort = openListener();
      // Recorded before it exists, so a crash between here and a clean stop always leaves a record to take down.
      save({ url: null, error: null, https_port: port, proxy_port: proxyPort, made: madeWith(port, record()?.https_port === port ? record()?.proxy_port : undefined, proxyPort) });
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
      // Another mapping on the port, perhaps a dead one of this Inbox's own: a look without blocking can tell (`probeLeftover`).
      const made = record()?.made;
      const mine = listener?.port;
      if (error instanceof TailscaleServeError && error.code === "conflict" && !probing && made?.https_port === port && made.proxy_ports.some((p) => p !== mine)) probeSoon = true;
      const targets = ownTargets();
      closeListener();
      httpsPort = null;
      guardProcess(false);
      // The mapping may have been made before the failure (no URL in serve's answer): take it down, or keep the record.
      const taken = record()?.https_port ? yield* takeDownOwnServeSteps(port, targets) : "none";
      if (taken === "failed" || taken === "later") keepRecord(state.error);
      else {
        // Refused before `tailscale serve` ran (another mapping on the port, or serve could not be read): nothing ever
        // pointed at this attempt's listener, so its port leaves `made`. Kept, each failed try would push out the
        // port a leftover of this Inbox's own points at before the look can take it back (#3591).
        const neverServed = error instanceof TailscaleServeError && (error.code === "conflict" || error.code === "malformed" || error.code === "unavailable");
        const kept = record()?.made;
        const trimmed = neverServed && mine !== undefined && kept ? { made: { https_port: kept.https_port, proxy_ports: kept.proxy_ports.filter((p) => p !== mine) } } : {};
        save({ url: null, error: state.error, ...trimmed });
      }
      return false;
    }
  };

  /**
   * Take this Inbox's own mapping down (never someone else's). "failed" leaves the listener up and the record kept.
   * "later" (Tailscale not running) closes the listener (a mapping Tailscale brings back answers 502); the caller keeps
   * the record as a take-down still owed (`owedTakeDown`).
   */
  const unpublish = function* (later = false): TailscaleSteps<TakeDownAnswer> {
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
        else if (owedTakeDown()) keepOwed();
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
  /**
   * A mapping of this Inbox's own may still exist (the record keeps a port that is not this run's listener, or the
   * relay's), from a switch-off, stop or start while Tailscale was not running.
   */
  const owedTakeDown = () => {
    const kept = record();
    return !!kept && ((!!kept.https_port && !!kept.proxy_port && kept.proxy_port !== listener?.port) || !!kept.relay_port);
  };
  /** The switch is off and a take-down is owed: a status-only look until Tailscale runs, then the take-down. */
  const owedWanted = () => !stopped && !cliMissing && !resolve().on && owedTakeDown();
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
    const soon = probeSoon;
    probeSoon = false;
    if (!retryWanted()) {
      if (owedWanted()) {
        retryMode = "owed";
        retryStep = 0;
        arm(INBOX_TAILSCALE_REPUBLISH.waitMs[0]!);
      }
      return;
    }
    if (soon) {
      // Once, at once: the look probes the mapping on the port, then publishes.
      retryMode = "stuck";
      arm(0);
    } else if (triedReady) {
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
    if (retryMode === "owed") return owedLook();
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
    probing = true;
    try {
      await probeLeftover();
      if (!retryWanted()) return;
      published = await runTailscaleStepsAsync(publish(true), runAsync);
    } finally {
      probing = false;
      deadPorts.clear();
      afterAttempt();
    }
    if (published) context.onRepublished?.();
  };

  /** One look for a take-down still owed: only the status while Tailscale is not running, then the take-down. */
  const owedLook = async () => {
    if (!owedWanted()) return;
    let status: TailscaleRunResult;
    try {
      status = await runAsync(["status", "--json"], TAILSCALE_CLI_TIMEOUT_MS);
    } catch (error) {
      status = { status: null, stdout: "", stderr: "", error: error instanceof Error ? error : new Error(String(error)) };
    }
    cliMissing = (status.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
    if (!owedWanted()) return;
    const waits = INBOX_TAILSCALE_REPUBLISH.waitMs;
    if (!ready(status)) {
      retryStep = Math.min(retryStep + 1, waits.length - 1);
      return arm(waits[retryStep]!);
    }
    await runTailscaleStepsAsync(reconcile(), runAsync);
    if (resolve().on) return afterAttempt();
    if (!owedTakeDown()) {
      if (record()) save(undefined);
      return;
    }
    // Still owed with Tailscale running: the take-down failed (its words are kept); the slow look.
    if (owedWanted()) arm(INBOX_TAILSCALE_REPUBLISH.stuckMs);
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
    const result = runTailscaleSteps(unpublish(), run);
    // Tailscale not running: the record keeps its ports, and the next start (or its look) takes the mapping down.
    if (result === "later") {
      keepOwed();
      return { failedPort: null };
    }
    if (result === "failed") {
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
      // Taken down, or found gone: the ports it mapped (`made`) stay known until the switch goes off. "Found gone" can
      // be a read Tailscale got wrong as the computer shut down, and Tailscale brings back its saved serve config at
      // the next boot: the next start then re-points that mapping as its own instead of refusing it (#3591).
      else if (record()?.made) save({ url: null, error: null });
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
    let owed = false;
    if (!on) {
      const result = yield* unpublish(options.via === "tailnet");
      // Tailscale not running: the switch turns off all the same; the take-down is owed (`owedLook`).
      owed = result === "later";
      if (result === "failed") {
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
    else if (owed) keepOwed();
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
              if (!identity.ok) return refuseIdentity("/", identity);
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
  // Tailscale not running: the uninstall cannot wait for it, so it says as for a failure.
  if (relay === "failed" || window === "failed" || relay === "later" || window === "later") return "failed";
  return relay === "removed" || window === "removed" ? "removed" : "none";
}
