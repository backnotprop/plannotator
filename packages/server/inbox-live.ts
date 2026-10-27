/**
 * Plannotator Inbox: running local sites shown in a thread ("live sites"),
 * through annotate's loopback live proxy (`./live-proxy`). Bun-only, like the
 * rest of the Inbox.
 *
 * Two entry points name a site: an agent's `send_message` `live_sites`
 * (recorded on its message), and the person opening one from a thread
 * (recorded on the thread's root, `opened_live_sites`). Both run the same
 * checks before anything is written (`checkInboxLiveUrl`, then the live
 * probe), and a site opens only when the person asks for it.
 *
 * Proxies: one per target ORIGIN, shared by every thread that shows it,
 * started on the first open, kept alive by the open pane's ping, stopped
 * after `idleMs` with no open or ping (10 minutes) and always when the Inbox
 * stops. Each proxy has its own bridge token (16 random bytes) and its
 * `frame-ancestors` names exactly this Inbox's two loopback origins; a proxy
 * never outlives the Inbox process, so that port cannot go stale. Reopening
 * after an idle stop starts a new proxy with a new port and token; comments
 * are kept by site and page, not by proxy, so nothing is lost.
 *
 * Security:
 * - A target is http, a loopback host, no credentials, and never a port of
 *   Plannotator itself: this Inbox, its own proxies, and every port the data
 *   dir's registries name (`listPlannotatorServerPorts`). The probe also
 *   refuses a response carrying the Plannotator server header, and the
 *   proxy refuses one on every response (#2190). A proxied Plannotator page
 *   would otherwise get same-origin writes on that server.
 * - Every route here is a window route on the loopback port: through the
 *   tailnet it answers `403 local_only`, and the device door does not list
 *   it. The proxy binds 127.0.0.1 and relays the person's signed-in dev
 *   app, so it is this computer's own window's business only.
 * - Reads and writes alike refuse another site's page
 *   (`isSameOriginOrNoOrigin`: `Sec-Fetch-Site: same-site` too, since the
 *   proxied app is same-site with the window on another localhost port).
 * - The window's own policy names no proxy port: it frames the site's
 *   same-origin wrapper page (`GET .../live/:site/frame`), whose policy
 *   frames that one proxy origin (`liveFrameCsp`). An HTML attachment's
 *   srcdoc frame navigating itself is checked against the window's policy,
 *   so a `http://localhost:*` there would reach every local port.
 * - The token reaches only the window (`GET .../live/:site`). The proxied
 *   app's own scripts can read it (the bridge runs in the app's realm); what
 *   a forged bridge message can do is open a comment draft in the person's
 *   pane, which is saved only by the person and sent only by their Send.
 */

import { createHash, randomBytes } from "node:crypto";
import { startLiveAppProxy, type LiveAppProxy } from "./live-proxy";
import {
  buildLiveAppUrl,
  buildLiveEditorOrigins,
  composeLiveBridgeJs,
  isLoopbackHostname,
  liveAppDraftIdentity,
  liveTargetPort,
} from "@plannotator/shared/live-proxy-core";
import { LiveProxyPortError } from "@plannotator/shared/live-proxy-port";
import { probeLiveAppTarget } from "@plannotator/shared/live-probe";
import { listPlannotatorServerPorts } from "@plannotator/shared/plannotator-ports";
import { isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { INBOX_LIVE_SITES_MAX, INBOX_LIVE_URL_MAX, type InboxLiveSiteRef } from "@plannotator/core/inbox-types";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";

/** The live bridge's sources. The CLI passes them as it does for annotate, so the server never imports ui. */
export interface InboxLiveBridgeSources {
  bridgeScript: string;
  bridgeBootstrap: string;
  annotationCss: string;
}

/** A proxy with no open and no ping for this long stops. */
export const INBOX_LIVE_IDLE_MS = 10 * 60_000;

/** The paths this module answers (all under a thread). */
const LIVE_PATH = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/live(?:\/(liv_[0-9a-f]{16})(?:\/(ping|annotations|frame))?)?$/;

/** True for every path this module owns, so the server can keep them off the tailnet before anything else. */
export function isInboxLivePath(path: string): boolean {
  return /^\/api\/inbox\/threads\/[^/]+\/live(\/|$)/.test(path);
}

/** A live site ready to frame: what the window needs, the token included. */
export interface InboxLiveSiteWire {
  id: string;
  url: string;
  origin: string;
  /** The proxy under its localhost spelling, with the site's path and query: what the wrapper frames. */
  app_url: string;
  /**
   * What the window frames: this Inbox's wrapper page for the site
   * (`GET .../live/:site/frame`, same origin), whose own policy names this
   * proxy's port and nothing else (`liveFrameCsp`).
   */
  frame_url: string;
  /** The proxy's origin the bridge posts from. */
  proxy_origin: string;
  /** This proxy's bridge token. */
  token: string;
  opened_by: InboxLiveSiteRef["opened_by"];
}

/** `liv_` + 16 hex of the URL's normalized identity (annotate's draft identity): one id per site, in every thread. */
export function inboxLiveSiteId(url: string): string {
  return `liv_${createHash("sha256").update(liveAppDraftIdentity(url)).digest("hex").slice(0, 16)}`;
}

/**
 * The wrapper page's policy: it frames this one proxy port and nothing else,
 * and runs no script. The window's own policy keeps `frame-src` at its own
 * origin: a srcdoc frame (an HTML attachment) is checked against the window's
 * policy when it navigates ITSELF, and a meta policy in its document does not
 * cover that, so a window policy naming `http://localhost:*` would let any
 * attachment send its frame to any local port (#2258's review, M1).
 */
export function liveFrameCsp(proxyOrigin: string): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `frame-src ${proxyOrigin}`,
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The wrapper page: one full-size frame on the proxy. Its only frame is the bridge's window (HtmlViewer's `liveNested`). */
function liveFramePage(site: InboxLiveSiteWire): Response {
  const body =
    '<!doctype html><html><head><meta charset="utf-8"><title>Live site</title>'
    + "<style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style>"
    + `</head><body><iframe src="${escapeAttribute(site.app_url)}" title="${escapeAttribute(site.url)}"></iframe></body></html>`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": liveFrameCsp(site.proxy_origin),
      "X-Frame-Options": "SAMEORIGIN",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });
}

function refuse(message: string): never {
  throw new InboxError("validation_error", `url: ${message}`, { field: "url" });
}

/**
 * The checks every entry point runs before any request reaches the site: an
 * http URL on a loopback host, no credentials, not one of `reservedPorts`
 * (Plannotator's own). Returns the URL without its fragment.
 */
export function checkInboxLiveUrl(raw: unknown, reservedPorts: Iterable<number>): URL {
  if (typeof raw !== "string" || raw.trim() === "") refuse("a running local site's address, e.g. http://localhost:5173/.");
  if (raw.length > INBOX_LIVE_URL_MAX) refuse(`at most ${INBOX_LIVE_URL_MAX} characters.`);
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    refuse(`${raw.trim()} is not an address; give one like http://localhost:5173/.`);
  }
  if (url.protocol === "https:") refuse("needs an http:// address (the local proxy does not reach https sites).");
  if (url.protocol !== "http:") refuse("only an http:// address on this computer opens live.");
  if (!isLoopbackHostname(url.hostname)) refuse(`${url.host} is not this computer: only localhost, 127.x or [::1] open live.`);
  if (url.username || url.password) refuse("no user name or password in the address.");
  const port = liveTargetPort(url);
  for (const reserved of reservedPorts) {
    if (reserved === port) refuse(`port ${port} is Plannotator's own; it is never shown live.`);
  }
  url.hash = "";
  return url;
}

interface ProxyEntry {
  origin: string;
  proxy: LiveAppProxy;
  token: string;
  lastUsed: number;
}

export interface InboxLiveSitesOptions {
  store: InboxStore;
  serverSession: string;
  /** The data dir whose registries name the other Plannotator servers' ports. */
  dataDir: string;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
  errorResponse: (error: unknown) => Response;
  localOnly: () => Response;
  /** This Inbox's window port: frame-ancestors, and never a target. */
  port: () => number;
  /** Null: the Inbox was started without the bridge (a source run without the CLI); sites are listed but do not open. */
  bridge: InboxLiveBridgeSources | null;
  idleMs?: number;
  /** The probe's fetch (tests). */
  fetchImpl?: typeof fetch;
  /** The clock (tests). */
  now?: () => number;
}

export interface InboxLiveSites {
  /** Answers a live route, or null when the path is not one. */
  route: (req: Request, path: string, via: "local" | "tailnet") => Promise<Response | null>;
  /**
   * send_message's `live_sites`: checked and probed before anything is written; refusals are `validation_error` on `live_sites`.
   * `probing: false` (a replay of a message already sent): the shape checks only, no request to any site.
   */
  recordLiveSites: (urls: readonly string[], probing?: boolean) => Promise<Omit<InboxLiveSiteRef, "opened_at">[]>;
  /** Stop every proxy; none starts after. Called when the Inbox stops. */
  stop: () => void;
  /** The proxies running now (tests, and the reserved ports). */
  running: () => { origin: string; port: number }[];
  /** Stop the proxies idle past `idleMs` now (the sweep's step; tests). */
  sweep: () => void;
}

export function createInboxLiveSites(options: InboxLiveSitesOptions): InboxLiveSites {
  const { store, json, errorResponse } = options;
  const idleMs = options.idleMs ?? INBOX_LIVE_IDLE_MS;
  const now = options.now ?? Date.now;
  const proxies = new Map<string, ProxyEntry>();
  let stopped = false;

  /** Plannotator's own ports, read at each check: this Inbox, its proxies, and every server the registries name. */
  const reservedPorts = (): number[] => [
    options.port(),
    ...[...proxies.values()].map((entry) => entry.proxy.port),
    ...listPlannotatorServerPorts(options.dataDir),
  ];

  const sweep = () => {
    const at = now();
    for (const [origin, entry] of proxies) {
      if (at - entry.lastUsed >= idleMs) {
        entry.proxy.stop();
        proxies.delete(origin);
      }
    }
  };
  const timer = setInterval(sweep, Math.max(25, Math.min(idleMs, 60_000)));
  (timer as { unref?: () => void }).unref?.();

  const proxyFor = (url: URL): ProxyEntry => {
    if (stopped) throw new InboxError("live_unavailable", "The Inbox is stopping.");
    if (!options.bridge) throw new InboxError("live_unavailable", "This Inbox was started without the live bridge; start it with `plannotator inbox`.");
    const known = proxies.get(url.origin);
    if (known) {
      known.lastUsed = now();
      return known;
    }
    const token = randomBytes(16).toString("hex");
    const editorOrigins = buildLiveEditorOrigins(options.port());
    let proxy: LiveAppProxy;
    try {
      proxy = startLiveAppProxy({
        targetUrl: `${url.origin}/`,
        editorOrigins,
        // `nested`: the window frames the proxy through its wrapper page (`liveFramePage`), so the bridge's editor is its grandparent.
        bridgeJs: composeLiveBridgeJs({ token, editorOrigins, ...options.bridge, nested: true }),
        // Never PLANNOTATOR_LIVE_PORT (annotate's one port): several sites run at once.
        anyFreePort: true,
      });
    } catch (error) {
      if (error instanceof LiveProxyPortError) throw new InboxError("live_unavailable", error.message);
      // assertLiveTargetNotEditor: the Inbox's own address.
      throw new InboxError("validation_error", `url: ${error instanceof Error ? error.message : String(error)}`, { field: "url" });
    }
    const entry: ProxyEntry = { origin: url.origin, proxy, token, lastUsed: now() };
    proxies.set(url.origin, entry);
    return entry;
  };

  const wire = (threadId: string, site: InboxLiveSiteRef): InboxLiveSiteWire => {
    // Checked again at every open: a port may have become Plannotator's since the site was recorded.
    const url = checkInboxLiveUrl(site.url, reservedPorts().filter((port) => port !== proxies.get(new URL(site.url).origin)?.proxy.port));
    const entry = proxyFor(url);
    return {
      id: site.id,
      url: site.url,
      origin: url.origin,
      app_url: buildLiveAppUrl(entry.proxy.port, url.href),
      frame_url: `/api/inbox/threads/${encodeURIComponent(threadId)}/live/${site.id}/frame`,
      proxy_origin: `http://localhost:${entry.proxy.port}`,
      token: entry.token,
      opened_by: site.opened_by,
    };
  };

  /**
   * The probe annotate runs (3 s, HTML, status < 500, redirects followed only
   * on the same loopback origin and judged before each request), refusing
   * Plannotator. One answer for "nothing there", "not HTML" and "redirected
   * elsewhere", so the refusal does not tell an agent what else listens on
   * this computer's ports.
   */
  const probe = async (url: URL): Promise<void> => {
    const result = await probeLiveAppTarget(url.href, url, options.fetchImpl, { plannotatorPorts: reservedPorts() });
    if (result.plannotator) refuse(`port ${liveTargetPort(url)} is Plannotator's own; it is never shown live.`);
    if (!result.liveEligible) {
      throw new InboxError("live_not_answering", `${url.href} did not answer with a web page from that address; start the dev server and try again.`, { field: "url" });
    }
  };

  const recordLiveSites = async (urls: readonly string[], probing = true): Promise<Omit<InboxLiveSiteRef, "opened_at">[]> => {
    if (urls.length > INBOX_LIVE_SITES_MAX) {
      throw new InboxError("validation_error", `live_sites: at most ${INBOX_LIVE_SITES_MAX} sites in one message.`, { field: "live_sites" });
    }
    const out: Omit<InboxLiveSiteRef, "opened_at">[] = [];
    for (const raw of urls) {
      try {
        const url = checkInboxLiveUrl(raw, probing ? reservedPorts() : []);
        if (probing) await probe(url);
        const id = inboxLiveSiteId(url.href);
        if (!out.some((site) => site.id === id)) out.push({ id, url: url.href, opened_by: "agent" });
      } catch (error) {
        // One refusal refuses the whole send, naming the site, as an attachment does.
        if (error instanceof InboxError) {
          throw new InboxError("validation_error", `live_sites: ${typeof raw === "string" ? raw : ""}: ${error.message.replace(/^url: /, "")}`, { field: "live_sites" });
        }
        throw error;
      }
    }
    return out;
  };

  const siteOf = (threadId: string, siteId: string): InboxLiveSiteRef => {
    const site = store.liveSites(threadId).find((candidate) => candidate.id === siteId);
    if (!site) throw new InboxError("live_site_not_found", "This thread shows no such site.");
    return site;
  };

  const route = async (req: Request, path: string, via: "local" | "tailnet"): Promise<Response | null> => {
    if (!isInboxLivePath(path)) return null;
    // The proxy relays the person's signed-in app on this computer: never through the tailnet.
    if (via === "tailnet") return options.localOnly();
    // Another site's page (the proxied app is same-site with this window) never reads or writes here.
    if (!isSameOriginOrNoOrigin(req.headers.get("origin"), req.headers.get("host") ?? "", req.headers.get("sec-fetch-site"))) {
      return json({ error: "Cross-origin requests are not accepted.", code: "cross_origin" }, 403);
    }
    const match = LIVE_PATH.exec(path);
    if (!match) return json({ error: "Not found", code: "not_found" }, 404);
    const [, threadId, siteId, action] = match as unknown as [string, string, string | undefined, string | undefined];
    try {
      const root = store.message(threadId);
      if (!root || root.thread_id !== root.id) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
      if (!siteId) {
        if (req.method === "GET") return json({ sites: store.liveSites(threadId) });
        if (req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
        const body = await options.readBody(req);
        if (checkServerSession(body, options.serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        const url = checkInboxLiveUrl(body.url, reservedPorts());
        await probe(url);
        const site = store.openLiveSite(threadId, { id: inboxLiveSiteId(url.href), url: url.href });
        return json({ site: wire(threadId, site) });
      }
      if (!action) {
        if (req.method !== "GET") return json({ error: "Use GET." }, 405);
        return json({ site: wire(threadId, siteOf(threadId, siteId)) });
      }
      if (action === "frame") {
        // The window's frame for the site: same origin only (the checks above), opening its proxy as GET .../live/:site does.
        if (req.method !== "GET") return json({ error: "Use GET." }, 405);
        return liveFramePage(wire(threadId, siteOf(threadId, siteId)));
      }
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      if (action === "ping") {
        const site = siteOf(threadId, siteId);
        const entry = proxies.get(new URL(site.url).origin);
        if (entry) entry.lastUsed = now();
        return json({ running: entry !== undefined });
      }
      const body = await options.readBody(req);
      if (checkServerSession(body, options.serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
      return json({ annotation: store.saveLiveAnnotation(threadId, siteId, body.annotation) });
    } catch (error) {
      return errorResponse(error);
    }
  };

  const stop = () => {
    stopped = true;
    clearInterval(timer);
    for (const entry of proxies.values()) entry.proxy.stop();
    proxies.clear();
  };

  return {
    route,
    recordLiveSites,
    stop,
    sweep,
    running: () => [...proxies.values()].map((entry) => ({ origin: entry.origin, port: entry.proxy.port })),
  };
}
