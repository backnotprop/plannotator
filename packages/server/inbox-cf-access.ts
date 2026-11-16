import { loadConfig } from "@plannotator/shared/config";
import { updateOwnInboxRegistry, type InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import { DOOR_SECRET_HEADER, resolveCfAccess, type CfAccessSettings } from "@plannotator/shared/inbox/cf-access";
import { createCfAccessVerifier, type CfAccessKeysFetch } from "@plannotator/shared/inbox/cf-access-verify";
import { pickDoorRoute, readDoorSession, type DoorSession } from "@plannotator/shared/inbox/cf-access-door";
import { injectDoorBase } from "@plannotator/shared/inbox/door-base-shim";
import { createCfTunnel, type CfTunnelOptions, type CfTunnelState } from "./cf-tunnel";

export interface InboxCfAccessState {
  on: boolean;
  configured: boolean;
  url: string | null;
  sessionsUrl: string | null;
  error: string | null;
  port: number | null;
  allowed: string[];
  tunnel: CfTunnelState | null;
}

export interface InboxCfAccessContext {
  dataDir: string;
  registry: () => InboxRegistryEntry;
  dispatch: (req: Request) => Promise<Response>;
  forbiddenPort: (port: number) => boolean;
  maxRequestBodySize?: number;
  fetchKeys?: CfAccessKeysFetch;
  now?: () => number;
  log?: (line: string) => void;
  note?: (event: string, data: Record<string, unknown>) => void;
  tunnel?: Partial<CfTunnelOptions> | false;
  sessionAlive?: (pid: number) => boolean;
}

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

function refusal(path: string, status: number, code: string, message: string): Response {
  if (path.includes("/api/") || path === "/mcp") {
    return new Response(JSON.stringify({ error: message, code }), { status, headers: { ...HEADERS, "Content-Type": "application/json; charset=utf-8" } });
  }
  return new Response(`${message}\n`, { status, headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
}

const ended = (path: string) => refusal(path, 410, "session_ended", "This Plannotator session has ended.");

function withoutCfCookie(value: string): string {
  return value
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "" && !/^CF_Authorization=/i.test(part))
    .join("; ");
}

export function scrubDoorHeaders(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower.startsWith("cf-") || lower.startsWith("tailscale-") || lower.startsWith("x-forwarded-") || lower.startsWith(DOOR_SECRET_HEADER) || HOP_BY_HOP.has(lower)) return;
    if (lower === "cookie") {
      const kept = withoutCfCookie(value);
      if (kept) headers.append(name, kept);
      return;
    }
    headers.append(name, value);
  });
  headers.set("x-forwarded-proto", "https");
  return headers;
}

function rebuild(req: Request, url: string, headers: Headers): Request {
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? req.body : null,
    signal: req.signal,
    redirect: "manual",
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);
}

function wantsDocument(req: Request, path: string): boolean {
  const dest = req.headers.get("sec-fetch-dest")?.toLowerCase();
  return dest === "document" || dest === "iframe" || path === "/" || path.endsWith(".html");
}

function doorLocation(location: string, port: number, base: string, host: string): string {
  let target: URL;
  try {
    target = new URL(location, `http://127.0.0.1:${port}/`);
  } catch {
    return location;
  }
  const local = (target.hostname === "127.0.0.1" || target.hostname === "localhost") && target.port === String(port);
  if (!local && !(location.startsWith("/") && !location.startsWith("//"))) return location;
  const path = target.pathname.startsWith(`${base}/`) ? target.pathname : `${base}${target.pathname}`;
  return local ? `https://${host}${path}${target.search}${target.hash}` : `${path}${target.search}${target.hash}`;
}

async function proxyToSession(req: Request, session: DoorSession, path: string, search: string, settings: CfAccessSettings): Promise<Response> {
  if (req.headers.get("upgrade")) return refusal(path, 501, "upgrade_unsupported", "Live connections are not relayed through Cloudflare Access.");
  const base = `/s/${session.key}`;
  const headers = scrubDoorHeaders(req.headers);
  headers.set("host", settings.sessionHost!);
  headers.set(DOOR_SECRET_HEADER, session.secret);
  const document = wantsDocument(req, path);
  if (document) headers.set("accept-encoding", "identity");
  let upstream: Response;
  try {
    upstream = await fetch(rebuild(req, `http://127.0.0.1:${session.port}${path}${search}`, headers), { decompress: false } as RequestInit);
  } catch {
    return ended(path);
  }
  const out = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name.toLowerCase())) out.append(name, value);
  });
  const location = out.get("location");
  if (location) out.set("location", doorLocation(location, session.port, base, settings.sessionHost!));
  const type = out.get("content-type") ?? "";
  if (document && /^text\/html/i.test(type) && !out.get("content-encoding") && req.method !== "HEAD") {
    const html = injectDoorBase(await upstream.text(), base);
    out.delete("etag");
    out.delete("content-length");
    return new Response(html, { status: upstream.status, headers: out });
  }
  return new Response(req.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers: out });
}

export function createInboxCfAccess(context: InboxCfAccessContext) {
  const log = context.log ?? ((line: string) => process.stderr.write(line));
  let listener: ReturnType<typeof Bun.serve> | null = null;
  let settings: CfAccessSettings | null = null;
  const tunnel = context.tunnel === false ? null : createCfTunnel({ dataDir: context.dataDir, log, onChange: () => saveTunnel(), ...(context.tunnel ?? {}) });
  const state = { on: false, configured: false, url: null as string | null, error: null as string | null };

  const record = (): InboxRegistryEntry["cloudflare_access"] | undefined =>
    state.on ? { url: state.url, error: state.error, ...(listener ? { port: listener.port as number } : {}), ...(tunnel ? { tunnel: tunnel.state() } : {}) } : undefined;

  const save = () => {
    const value = record();
    const apply = (target: InboxRegistryEntry) => {
      if (value) target.cloudflare_access = value;
      else delete target.cloudflare_access;
    };
    apply(context.registry());
    updateOwnInboxRegistry(context.dataDir, context.registry().serverSession, apply);
  };
  const saveTunnel = () => {
    if (state.on) save();
  };

  const fail = (error: string) => {
    state.url = null;
    state.error = error;
    save();
    log(`[plannotator] Cloudflare Access: not open. ${error} The Inbox runs on this computer as usual.\n`);
  };

  const live = (key: string): DoorSession | null => readDoorSession(context.dataDir, key, context.sessionAlive);

  const handler = (active: CfAccessSettings, verifier: ReturnType<typeof createCfAccessVerifier>) => async (req: Request): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch {
      return refusal("/api/", 400, "bad_request", "Bad request.");
    }
    const path = url.pathname;
    const checked = await verifier.check(req.method, path, req.headers);
    if (!checked.ok) return refusal(path, checked.status, checked.code, checked.message);
    const sessions = new Map<string, DoorSession>();
    const navigate = req.headers.get("sec-fetch-mode")?.toLowerCase() === "navigate";
    const route = pickDoorRoute(checked.world, path, req.headers.get("referer"), active.sessionHost ?? "", (key) => {
      const found = live(key);
      if (found) sessions.set(key, found);
      return found !== null;
    }, navigate);
    if (route.kind === "ended") return ended(path);
    if (route.kind === "wrong_origin") return refusal(path, 403, "wrong_origin", checked.world === "inbox" ? "Sessions open at their own address." : "The Inbox opens at its own address.");
    if (route.kind === "inbox") return context.dispatch(rebuild(req, req.url, scrubDoorHeaders(req.headers)));
    if (route.via === "referer") context.note?.("door_referer_fallback", { route: path.split("/").slice(0, 3).join("/") });
    return proxyToSession(req, sessions.get(route.key)!, route.path, url.search, active);
  };

  const start = () => {
    if (listener) return;
    const resolved = resolveCfAccess(loadConfig(), process.env, context.forbiddenPort);
    state.on = resolved.on;
    state.configured = resolved.configured;
    if (!resolved.on) {
      state.url = null;
      state.error = null;
      if (context.registry().cloudflare_access) save();
      return;
    }
    if (!resolved.settings) return fail(resolved.error);
    const active = resolved.settings;
    const verifier = createCfAccessVerifier(active, { fetchKeys: context.fetchKeys, now: context.now });
    try {
      listener = Bun.serve({
        hostname: "127.0.0.1",
        port: active.port,
        idleTimeout: 0,
        maxRequestBodySize: context.maxRequestBodySize,
        fetch: handler(active, verifier),
      } as Parameters<typeof Bun.serve>[0]);
    } catch (error) {
      listener = null;
      const code = (error as NodeJS.ErrnoException)?.code ?? "";
      const busy = /EADDRINUSE|in use/i.test(`${code} ${error instanceof Error ? error.message : String(error)}`);
      return fail(busy ? `Port ${active.port} is in use by another program.` : `Could not listen on 127.0.0.1:${active.port}.`);
    }
    settings = active;
    state.url = `https://${active.host}/`;
    state.error = null;
    tunnel?.start();
    save();
  };

  const stop = () => {
    tunnel?.stop();
    const closing = listener;
    listener = null;
    settings = null;
    closing?.stop(true);
    state.url = null;
    if (context.registry().cloudflare_access) {
      delete context.registry().cloudflare_access;
      updateOwnInboxRegistry(context.dataDir, context.registry().serverSession, (target) => {
        delete target.cloudflare_access;
      });
    }
  };

  const restart = () => {
    stop();
    start();
  };

  const snapshot = (): InboxCfAccessState => ({
    on: state.on,
    configured: state.configured,
    url: state.url,
    sessionsUrl: settings?.sessionHost && state.url ? `https://${settings.sessionHost}/` : null,
    error: state.error,
    port: listener ? (listener.port as number) : null,
    allowed: settings ? [...settings.allow] : [],
    tunnel: tunnel && state.on ? tunnel.state() : null,
  });

  return { start, stop, restart, state: snapshot, listenerPort: () => (listener ? (listener.port as number) : null) };
}

export type InboxCfAccess = ReturnType<typeof createInboxCfAccess>;
