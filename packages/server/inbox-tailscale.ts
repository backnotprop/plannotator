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
 */

import {
  loadConfig,
  parseInboxTailscaleEnv,
  resolveInboxTailscale,
  resolveInboxTailscaleAllow,
  saveConfig,
  type InboxTailscaleSource,
} from "@plannotator/shared/config";
import { readInboxRegistry, writeInboxRegistry, type InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
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
} from "@plannotator/shared/tailscale";
import { enableTailscaleServe, removeTailscaleServe, TailscaleServeError, takeDownOwnServeMapping } from "./tailscale-serve";
import { INBOX_TAILNET_HTTPS_PORT } from "./inbox-devices";

/** Phones' tailnet HTTPS port (inbox-devices.ts, 8443): the window's mapping never takes it. */
export const PHONES_TAILNET_HTTPS_PORT = INBOX_TAILNET_HTTPS_PORT;

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
  tailscale?: TailscaleRunner;
  /** `plannotator inbox --tailscale`: on for this run unless PLANNOTATOR_INBOX_TAILSCALE turns it off. */
  flag?: boolean;
  /** A terminal closing a foreground Inbox (SIGHUP) while published: stop cleanly, then exit. */
  onHangup?: () => void;
  maxRequestBodySize?: number;
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
  const run = context.tailscale ?? runTailscale;
  let runFlag = context.flag === true;
  let listener: ReturnType<typeof Bun.serve> | null = null;
  let servedHostname: string | null = null;
  let httpsPort: number | null = null;
  let warnedExposure = false;
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

  /** Keep the state in inbox.json (and this run's entry), so a reader of the file sees the address or the reason. */
  const save = (value: InboxRegistryEntry["tailscale"] | undefined) => {
    const entry = { ...(readInboxRegistry(context.dataDir) ?? context.registry()) };
    for (const target of [entry, context.registry()]) {
      if (value) target.tailscale = { ...value };
      else delete target.tailscale;
    }
    writeInboxRegistry(context.dataDir, entry);
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
  const scanExposure = (): InboxTailnetExposure[] | undefined => {
    const status = run(["serve", "status", "--json"], TAILSCALE_SERVE_TIMEOUT_MS);
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
   * points at it. Find which (serve status) and say so once.
   */
  const noteServedRequest = () => {
    if (state.exposed.length > 0) return;
    const found = scanExposure();
    state.exposed = found && found.length > 0 ? found : [{ https_port: null, target: null }];
    warnExposure();
  };

  const failureWords = (error: unknown, port: number): string => {
    if (error instanceof TailscaleServeError && error.code === "conflict") {
      return `Another tailscale serve mapping already uses port ${port}, the Inbox's port. The Inbox never replaces it: remove it with "tailscale serve --https=${port} off" if nothing needs it.`;
    }
    const detail = error instanceof Error ? error.message.replace(/^--tailscale:\s*/, "") : String(error);
    return `Tailscale could not publish the Inbox. ${detail}`;
  };

  /** Who may use the published Inbox: the owner of this machine plus the allowlist. Throws the reason when nobody may. */
  const readAllowed = (): { owner: string | null; allowed: string[] } => {
    const status = run(["status", "--json"], TAILSCALE_CLI_TIMEOUT_MS);
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
  const reconcile = (): boolean => {
    const kept = record();
    if (!kept?.https_port || !kept.proxy_port || kept.proxy_port === listener?.port) return true;
    const result = takeDownOwnServeMapping(run, kept.https_port, [`http://127.0.0.1:${kept.proxy_port}`]);
    if (result === "failed") {
      state.error = `Could not remove the tailnet address an earlier run left; it is retried at the next start. Or run "tailscale serve --https=${kept.https_port} off".`;
      keepRecord(state.error);
      return false;
    }
    save({ url: null, error: null });
    return true;
  };

  /** Publish the mapping. Never throws: a failure is kept as `error`. */
  const publish = (): boolean => {
    const port = context.port();
    if (!reconcile()) return false;
    try {
      if (port === PHONES_TAILNET_HTTPS_PORT) throw new Error(`Port ${port} is kept for phones.`);
      const who = readAllowed();
      state.owner = who.owner;
      state.allowed = who.allowed;
      state.exposed = scanExposure() ?? state.exposed;
      warnExposure();
      if (state.exposed.some((e) => e.https_port === port)) throw new Error(exposureWarning(state.exposed));
      const proxyPort = openListener();
      // Recorded before it exists, so a crash between here and a clean stop always leaves a record to take down.
      save({ url: null, error: null, https_port: port, proxy_port: proxyPort });
      const { url } = enableTailscaleServe(proxyPort, run, { httpsPort: port, ownTargets: ownTargets(), persist: true });
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
      const taken = record()?.https_port ? takeDownOwnServeMapping(run, port, targets) : "none";
      if (taken === "failed") keepRecord(state.error);
      else save({ url: null, error: state.error });
      return false;
    }
  };

  /** Take this Inbox's own mapping down (never someone else's). "failed" leaves the listener up and the record kept. */
  const unpublish = (later = false): "removed" | "none" | "failed" => {
    const port = httpsPort ?? record()?.https_port ?? null;
    const result = port === null ? "none" : takeDownOwnServeMapping(run, port, ownTargets());
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
    if (!reconcile()) return;
    if (resolve().on) publish();
    else if (record()) save(undefined);
  };

  /**
   * A clean stop: the mapping and the listener go, so nothing is published
   * while the Inbox is stopped; the switch stays as saved and the next start
   * publishes again. A take-down that fails keeps the record for the next
   * start or `uninstall --purge`.
   */
  const stop = () => {
    if (httpsPort === null && !listener && !record()) return;
    const port = httpsPort;
    if (unpublish() === "failed") {
      keepRecord(`Could not take the tailnet address down; run "tailscale serve --https=${port ?? record()?.https_port} off".`);
      closeListener();
      httpsPort = null;
      guardProcess(false);
      state.url = null;
    } else if (record()) {
      save(undefined);
    }
  };

  /** The window's switch: saved to config.json, applied now. `via`: the request came through the tailnet. */
  const set = (on: boolean, options: { via?: "local" | "tailnet"; replaceExposed?: boolean } = {}): InboxTailscaleState => {
    const env = parseInboxTailscaleEnv();
    if (env !== undefined) {
      throw new InboxError("tailscale_env_decides", `PLANNOTATOR_INBOX_TAILSCALE is set in this Inbox's environment, so it stays ${env ? "on" : "off"}.`);
    }
    if (!on) {
      if (unpublish(options.via === "tailnet") === "failed") {
        throw new InboxError(
          "tailscale_unavailable",
          `Tailscale could not take the Inbox's tailnet address down. Try again, or run "tailscale serve --https=${context.port()} off".`,
        );
      }
      state.error = null;
    }
    if (on && options.replaceExposed) {
      // Only routes that still point at the window's own port, and only because the person asked.
      const exposed = scanExposure();
      if (!exposed) throw new InboxError("tailscale_unavailable", "Tailscale could not say which mapping to replace. Try again.");
      for (const route of exposed) {
        if (route.https_port !== null && !removeTailscaleServe(route.https_port, run)) {
          throw new InboxError("tailscale_unavailable", `Tailscale could not remove the mapping on port ${route.https_port}. Run "tailscale serve --https=${route.https_port} off".`);
        }
      }
      state.exposed = [];
      warnedExposure = false;
    }
    saveConfig({ inboxTailscale: on });
    if (loadConfig().inboxTailscale !== on) throw new InboxError("config_not_saved", "config.json could not be written; nothing changed.");
    // The saved switch decides from now on, not this run's flag.
    runFlag = false;
    if (on) publish();
    else save(undefined);
    return snapshot();
  };

  /** `plannotator inbox --tailscale` against a running Inbox: on for this run, unless the env var keeps it off. */
  const enableForRun = (): InboxTailscaleState => {
    runFlag = true;
    if (resolve().on && !state.url) publish();
    return snapshot();
  };

  return {
    start,
    stop,
    set,
    enableForRun,
    noteServedRequest,
    state: snapshot,
    /** Published only because this run was started (or asked) with `--tailscale`: a restart must pass it on. */
    runOnly: () => runFlag && resolve().source === "flag",
    /** The tailnet-only listener's port while published (tests). */
    listenerPort: () => (listener ? (listener.port as number) : null),
  };
}

export type InboxTailscale = ReturnType<typeof createInboxTailscale>;

/**
 * `uninstall --purge` with the Inbox stopped: take down the window's tailnet
 * mapping a crashed run left, by the ports inbox.json kept. Nothing is
 * spawned when there is none.
 */
export function takeDownInboxTailscale(dataDir: string, run: TailscaleRunner = runTailscale): "removed" | "none" | "failed" {
  const kept = readInboxRegistry(dataDir)?.tailscale;
  if (!kept?.https_port || !kept.proxy_port) return "none";
  return takeDownOwnServeMapping(run, kept.https_port, [`http://127.0.0.1:${kept.proxy_port}`]);
}
