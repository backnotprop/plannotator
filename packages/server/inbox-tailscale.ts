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
 * Lifecycle: published at start when the switch is on, taken down at a clean
 * stop (quit, the stop route, restart to update), and by `uninstall --purge`
 * for a mapping a crashed run left. A mapping this Inbox did not make is never
 * replaced. Tailscale missing, stopped or signed out never stops the Inbox:
 * the reason is kept for Settings, inbox.json and stderr.
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
  TAILSCALE_CLI_TIMEOUT_MS,
  type TailscaleRunner,
} from "@plannotator/shared/tailscale";
import { enableTailscaleServe, TailscaleServeError, takeDownOwnServeMapping } from "./tailscale-serve";
import { INBOX_TAILNET_HTTPS_PORT } from "./inbox-devices";

/** Phones' tailnet HTTPS port (inbox-devices.ts, 8443): the window's mapping never takes it. */
export const PHONES_TAILNET_HTTPS_PORT = INBOX_TAILNET_HTTPS_PORT;

export interface InboxTailscaleState {
  /** Publishing is on (the flag, the env var or the saved switch). */
  on: boolean;
  /** What decides it. */
  source: InboxTailscaleSource;
  /** PLANNOTATOR_INBOX_TAILSCALE when it is set (the switch is locked), else null. */
  env: boolean | null;
  /** The tailnet address while the publication works. */
  url: string | null;
  /** Why the publication is not working. */
  error: string | null;
  /** The Tailscale login that owns this machine, as of the last publish. */
  owner: string | null;
  /** Every login let in: the owner, then config.json `inboxTailscaleAllow`. */
  allowed: string[];
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
  /** `plannotator inbox --tailscale`: on for this run whatever the switch says. */
  flag?: boolean;
  /** A terminal closing a foreground Inbox (SIGHUP) while published: stop cleanly, then exit. */
  onHangup?: () => void;
  maxRequestBodySize?: number;
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
  const state = { url: null as string | null, error: null as string | null, owner: null as string | null, allowed: [] as string[] };

  const resolve = () => resolveInboxTailscale(loadConfig(), process.env, runFlag);

  const snapshot = (): InboxTailscaleState => {
    const { on, source } = resolve();
    return { on, source, env: parseInboxTailscaleEnv() ?? null, url: state.url, error: state.error, owner: state.owner, allowed: [...state.allowed] };
  };

  /** Keep the state in inbox.json (and this run's entry), so a reader of the file sees the address or the reason. */
  const save = (value: InboxRegistryEntry["tailscale"] | undefined) => {
    const entry = { ...(readInboxRegistry(context.dataDir) ?? context.registry()) };
    for (const target of [entry, context.registry()]) {
      if (value) target.tailscale = { ...value };
      else delete target.tailscale;
    }
    writeInboxRegistry(context.dataDir, entry);
  };

  /** Proxy targets a mapping of this Inbox's own points at: this run's listener, or the one inbox.json names. */
  const ownTargets = () =>
    [listener?.port, context.registry().tailscale?.proxy_port].filter((p): p is number => typeof p === "number" && p > 0).map((p) => `http://127.0.0.1:${p}`);

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
    const serve = (port: number) =>
      Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, maxRequestBodySize: context.maxRequestBodySize, fetch: listenerFetch } as Parameters<typeof Bun.serve>[0]);
    const last = context.registry().tailscale?.proxy_port;
    try {
      listener = last && last !== context.port() ? serve(last) : serve(0);
    } catch {
      listener = serve(0);
    }
    return listener.port as number;
  };

  const closeListener = () => {
    listener?.stop(true);
    listener = null;
    servedHostname = null;
  };

  // ── Process exit and terminal close while published ──
  //
  // A clean stop takes the mapping down. The exit handler covers a path that
  // ends the process without it (another SIGHUP handler that exits first);
  // SIGHUP is routed only while a mapping exists, so `nohup` keeps working
  // otherwise (the `--tailscale` rule, tailscale-serve.ts).
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

  /** Publish (or re-point) the mapping. Never throws: a failure is kept as `error`. */
  const publish = (): boolean => {
    const port = context.port();
    try {
      if (port === PHONES_TAILNET_HTTPS_PORT) throw new Error(`Port ${port} is kept for phones.`);
      const who = readAllowed();
      state.owner = who.owner;
      state.allowed = who.allowed;
      // The Inbox moved port since a run that did not stop cleanly: that run's mapping is on the old port.
      const earlier = context.registry().tailscale;
      if (earlier?.https_port && earlier.https_port !== port && earlier.proxy_port) {
        takeDownOwnServeMapping(run, earlier.https_port, [`http://127.0.0.1:${earlier.proxy_port}`]);
      }
      const proxyPort = openListener();
      const { url } = enableTailscaleServe(proxyPort, run, { httpsPort: port, ownTargets: ownTargets(), persist: true });
      servedHostname = new URL(url).hostname.toLowerCase();
      httpsPort = port;
      state.url = `${url}/`;
      state.error = null;
      save({ url: state.url, error: null, https_port: port, proxy_port: proxyPort });
      guardProcess(true);
      return true;
    } catch (error) {
      closeListener();
      httpsPort = null;
      guardProcess(false);
      state.url = null;
      state.error = failureWords(error, port);
      // A mapping a crashed run left points at a dead port: take it down rather than leave it.
      const leftover = context.registry().tailscale;
      const taken = leftover?.https_port ? takeDownOwnServeMapping(run, leftover.https_port, ownTargets()) : "none";
      save({
        url: null,
        error: state.error,
        ...(taken === "failed" && leftover?.https_port ? { https_port: leftover.https_port, proxy_port: leftover.proxy_port } : {}),
      });
      return false;
    }
  };

  /** Take this Inbox's own mapping down (never someone else's). "failed" leaves the listener up. */
  const unpublish = (): "removed" | "none" | "failed" => {
    const leftover = context.registry().tailscale;
    const port = httpsPort ?? leftover?.https_port ?? null;
    const result = port === null ? "none" : takeDownOwnServeMapping(run, port, ownTargets());
    if (result === "failed") return result;
    closeListener();
    httpsPort = null;
    guardProcess(false);
    state.url = null;
    return result;
  };

  /** At start: publish when the switch is on; otherwise take down a mapping an earlier run left. */
  const start = () => {
    if (resolve().on) {
      publish();
      return;
    }
    if (context.registry().tailscale) {
      unpublish();
      save(undefined);
    }
  };

  /**
   * A clean stop: the mapping and the listener go, so nothing is published
   * while the Inbox is stopped; the switch stays as saved and the next start
   * publishes again. A take-down that failed keeps the ports in inbox.json for
   * the next start or `uninstall --purge`.
   */
  const stop = () => {
    const port = httpsPort;
    const proxyPort = listener?.port as number | undefined;
    const result = unpublish();
    closeListener();
    httpsPort = null;
    guardProcess(false);
    state.url = null;
    if (result === "failed" && port !== null) {
      save({ url: null, error: `Could not take the tailnet address down; run "tailscale serve --https=${port} off".`, https_port: port, proxy_port: proxyPort });
    } else if (context.registry().tailscale) {
      save(undefined);
    }
  };

  /** The window's switch: saved to config.json, applied now. */
  const set = (on: boolean): InboxTailscaleState => {
    const env = parseInboxTailscaleEnv();
    if (env !== undefined) {
      throw new InboxError("tailscale_env_decides", `PLANNOTATOR_INBOX_TAILSCALE is set in this Inbox's environment, so it stays ${env ? "on" : "off"}.`);
    }
    if (!on) {
      if (unpublish() === "failed") {
        throw new InboxError(
          "tailscale_unavailable",
          `Tailscale could not take the Inbox's tailnet address down. Try again, or run "tailscale serve --https=${context.port()} off".`,
        );
      }
      state.error = null;
    }
    saveConfig({ inboxTailscale: on });
    if (loadConfig().inboxTailscale !== on) throw new InboxError("config_not_saved", "config.json could not be written; nothing changed.");
    // The saved switch decides from now on, not this run's flag.
    runFlag = false;
    if (on) publish();
    else save(undefined);
    return snapshot();
  };

  /** `plannotator inbox --tailscale` against a running Inbox: on for this run. */
  const enableForRun = (): InboxTailscaleState => {
    runFlag = true;
    if (!state.url) publish();
    return snapshot();
  };

  return {
    start,
    stop,
    set,
    enableForRun,
    state: snapshot,
    /** Published only because this run was started (or asked) with `--tailscale`: a restart must pass it on. */
    runOnly: () => runFlag && !resolveInboxTailscale(loadConfig(), process.env, false).on,
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
