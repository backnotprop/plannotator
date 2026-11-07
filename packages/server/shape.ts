/**
 * The Shapes server: Shape's page for people without the Plannotator Inbox
 * (approval "shape-living-board" decision 6; SPEC.md §4, "Server"). One small,
 * long-lived server per data dir serves the standalone page (the grid of
 * boards under a small Plannotator header, then a board) and mounts the same
 * Shape routes the Inbox mounts (shape-routes.ts). `plannotator shape open`
 * starts it, or reuses the one `shapes/server.json` names.
 *
 * Who may reach it:
 *  - Shape or Code review on (config.json, read on every request): both off,
 *    every `/api/shapes` path answers 404, as in the Inbox;
 *  - this computer only: it binds loopback, and the Host check refuses any
 *    other name (a DNS-rebinding page). There is no tailnet listener, so every
 *    request that passes is the person's own (the Inbox's "local" reach;
 *    nobody is a guest here, and the owner is never refused);
 *  - the page's own origin: another site is refused, reads included (a board
 *    names files and folders);
 *  - the page of THIS server: a write carrying another server's
 *    `serverSession` (a tab left open across a restart) answers 409.
 *
 * Lifetime: the port is the last one used, else a free one. It exits
 * `idleMs` (30 minutes) after the last page closed (the page holds the event
 * stream open), or after starting when no page ever opens.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServerSessionNonce, checkServerSession, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { crossOriginRefusalBody, isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";
import { acceptsGzip } from "@plannotator/shared/app-html";
import { gunzipSync } from "node:zlib";
import { shapesDirOf } from "@plannotator/shared/shape/store";
import { SHAPE_EVENTS_PATH } from "@plannotator/shared/shape/routes";
import { shapeBoardsOn } from "@plannotator/shared/shape/switch";
import { createRequestHostGuard } from "./request-host-guard";
import { withPlannotatorServerHeader } from "./plannotator-server-marker";
import { createBunShapeRoutes } from "./shape-routes";

const LOOPBACK = "127.0.0.1";
/** 30 minutes after the last page closed (SPEC.md §4, "Lifetime"). */
export const SHAPE_SERVER_IDLE_MS = 30 * 60_000;
/** The file that names the running Shapes server: `<data>/shapes/server.json`. */
export const SHAPE_SERVER_FILE = "server.json";
/** The server's own answer (`GET`): who it is, for the CLI's reuse check and the page's `serverSession`. */
export const SHAPE_SERVER_INFO_PATH = "/api/shape-server";

/** Person-facing: a write from a page of a server that is no longer the one on this address. */
export const SHAPE_SERVER_SESSION_MISMATCH_ERROR =
  "This Shape page is out of date: a newer Plannotator Shape page runs on the same address. Reload the page to see it; nothing was saved.";

export interface ShapeServerEntry {
  v: 1;
  pid: number;
  port: number;
  url: string;
  version: string;
  started: string;
}

/** What `GET /api/shape-server` answers. */
export interface ShapeServerInfo {
  shape_server: 1;
  version: string;
  serverSession: string;
  /** The boards work: Shape or Code review is on. */
  on: boolean;
  /** Pages open on this server now (each holds the event stream). Bare `plannotator shape` opens no second tab while one is. */
  pages: number;
}

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;

/** The page's policy: the Inbox window's (same viewers, same board), nothing from outside this server. */
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": PAGE_CSP,
} as const;

/** `/` before the page is built (a source run, the server tests). */
const NOT_BUILT_PAGE = "<!doctype html><meta charset=utf-8><title>Plannotator Shape</title><p>The Shape page is not built. Run the build (apps/inbox build:shape).</p>";

export function shapeServerPath(dataDir: string): string {
  return join(shapesDirOf(dataDir), SHAPE_SERVER_FILE);
}

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536;
}

/** The entry `shapes/server.json` holds, or null (absent, unreadable, or not one). Its process may be gone. */
export function readShapeServerEntry(dataDir: string): ShapeServerEntry | null {
  try {
    const value = JSON.parse(readFileSync(shapeServerPath(dataDir), "utf8")) as Partial<ShapeServerEntry>;
    if (!value || typeof value !== "object" || value.v !== 1 || !isPort(value.port) || typeof value.pid !== "number") return null;
    return {
      v: 1,
      pid: value.pid,
      port: value.port,
      url: typeof value.url === "string" ? value.url : `http://${LOOPBACK}:${value.port}`,
      version: typeof value.version === "string" ? value.version : "",
      started: typeof value.started === "string" ? value.started : "",
    };
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A running Shapes server and, from the same answer, how many pages are open on it: null when that cannot be read
 * (an older server without the field), and the caller then opens a page as if none were.
 */
export interface RunningShapeServer extends ShapeServerEntry {
  pages: number | null;
}

/**
 * The running Shapes server of this data dir, or null: its process is alive and
 * its port answers as a Shapes server. A stale `server.json` (its pid gone, or
 * another program on the port) reads as none.
 */
export async function runningShapeServer(dataDir: string, timeoutMs = 1500): Promise<RunningShapeServer | null> {
  const entry = readShapeServerEntry(dataDir);
  if (!entry || !isProcessAlive(entry.pid)) return null;
  try {
    const response = await fetch(`http://${LOOPBACK}:${entry.port}${SHAPE_SERVER_INFO_PATH}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const info = (await response.json()) as Partial<ShapeServerInfo>;
    if (info.shape_server !== 1) return null;
    const pages = typeof info.pages === "number" && Number.isInteger(info.pages) && info.pages >= 0 ? info.pages : null;
    return { ...entry, pages };
  } catch {
    return null;
  }
}

function writeEntry(dataDir: string, entry: ShapeServerEntry): void {
  const dir = shapesDirOf(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = shapeServerPath(dataDir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * A stopped server's entry, if it still names this process (a newer server's entry is left alone): kept, with no
 * process (pid 0), so the next start takes the same port and nothing reads it as running.
 */
function retireOwnEntry(dataDir: string, pid: number, port: number): void {
  const entry = readShapeServerEntry(dataDir);
  if (!entry || entry.pid !== pid || entry.port !== port) return;
  try {
    writeEntry(dataDir, { ...entry, pid: 0 });
  } catch {
    rmSync(shapeServerPath(dataDir), { force: true });
  }
}

export interface ShapeServerOptions {
  dataDir: string;
  /** The built page (`apps/hook/dist/shape.html`). Absent (and no `pageGzip`): a short "not built" page. */
  page?: () => string;
  /**
   * The built page gzipped (`apps/hook/dist/shape.html.gz`, what the binary embeds). Sent as it is, with
   * `Content-Encoding: gzip`, to a browser that takes gzip; unzipped once and kept for one that does not.
   */
  pageGzip?: () => Uint8Array;
  /** Shape on, decided here instead of config.json `inboxShape` (tests). Absent: config.json decides on every request. */
  shape?: boolean;
  /** The port to try first. Absent: the last one used (`server.json`), else a free one. */
  port?: number;
  version?: string;
  /** How long with no page open before `onIdle` (default 30 minutes). */
  idleMs?: number;
  /** No page has been open for `idleMs`. Absent: nothing (the caller stops it). */
  onIdle?: () => void;
  /** Write `shapes/server.json` (default true). */
  register?: boolean;
  /**
   * Serve the boards as stored and change nothing (`plannotator shape frame`'s throwaway server): every write
   * answers 405, and the event stream 404, so a page reads once and a headless browser is never held open.
   */
  readOnly?: boolean;
  heartbeatMs?: number;
  watchMs?: number;
}

export interface ShapeServer {
  port: number;
  url: string;
  serverSession: string;
  /** Pages open now (event streams). */
  pages: () => number;
  stop: () => void;
}

/** Start the Shapes server (SPEC.md §4). */
export async function startShapeServer(options: ShapeServerOptions): Promise<ShapeServer> {
  const { dataDir } = options;
  const version = options.version ?? "";
  const serverSession = createServerSessionNonce();
  const shapeOn = () => options.shape ?? shapeBoardsOn();
  const hostGuard = createRequestHostGuard({ localOnly: true });
  const shapes = createBunShapeRoutes({ dataDir, heartbeatMs: options.heartbeatMs, watchMs: options.watchMs });
  const idleMs = options.idleMs ?? SHAPE_SERVER_IDLE_MS;

  let open = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (open === 0) options.onIdle?.();
    }, idleMs);
    (idleTimer as { unref?: () => void }).unref?.();
  };
  const pageOpened = () => {
    open++;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };
  const pageClosed = () => {
    open = Math.max(0, open - 1);
    if (open === 0) armIdle();
  };

  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });
  const crossSite = (req: Request): Response | null =>
    isSameOriginOrNoOrigin(req.headers.get("origin"), req.headers.get("host") ?? "", req.headers.get("sec-fetch-site"))
      ? null
      : json(crossOriginRefusalBody(), 403);
  let unzippedPage: Buffer | undefined;

  const fetchHandler = async (req: Request): Promise<Response> => {
    const refused = hostGuard.check(req);
    if (refused) return refused;
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/" || path === "/index.html") {
      if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "method not allowed" }, 405);
      if (options.pageGzip) {
        const gz = options.pageGzip();
        if (acceptsGzip(req.headers.get("accept-encoding"))) {
          return new Response(gz as BodyInit, { headers: { ...PAGE_HEADERS, "Content-Encoding": "gzip", Vary: "Accept-Encoding" } });
        }
        unzippedPage ??= gunzipSync(gz);
        return new Response(unzippedPage as BodyInit, { headers: { ...PAGE_HEADERS, Vary: "Accept-Encoding" } });
      }
      return new Response(options.page?.() ?? NOT_BUILT_PAGE, { headers: PAGE_HEADERS });
    }

    if (path === SHAPE_SERVER_INFO_PATH) {
      if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
      const blocked = crossSite(req);
      if (blocked) return blocked;
      return json({ shape_server: 1, version, serverSession, on: shapeOn(), pages: open } satisfies ShapeServerInfo);
    }

    if (path === "/api/shapes" || path.startsWith("/api/shapes/")) {
      // Off: as if absent, like the Inbox.
      if (!shapeOn()) return json({ error: "Not found", code: "not_found" }, 404);
      if (options.readOnly) {
        if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "read only", code: "read_only" }, 405);
        if (path === SHAPE_EVENTS_PATH) return json({ error: "Not found", code: "not_found" }, 404);
      }
      const blocked = crossSite(req);
      if (blocked) return blocked;
      if (req.method === "POST") {
        const body = await req.clone().json().catch(() => null);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(SHAPE_SERVER_SESSION_MISMATCH_ERROR), 409);
      }
      const answered = await shapes.route(req, url);
      if (!answered) return json({ error: "Not found", code: "not_found" }, 404);
      if (path === SHAPE_EVENTS_PATH && answered.ok) {
        // The page holds this stream open: one open page until the browser drops it (the request's abort).
        pageOpened();
        let closed = false;
        req.signal.addEventListener("abort", () => {
          if (closed) return;
          closed = true;
          pageClosed();
        });
      }
      return answered;
    }

    return json({ error: "Not found", code: "not_found" }, 404);
  };

  const serve = (port: number) =>
    Bun.serve(withPlannotatorServerHeader({ hostname: LOOPBACK, port, idleTimeout: 0, fetch: fetchHandler }) as Parameters<typeof Bun.serve>[0]);

  const preferred = options.port ?? readShapeServerEntry(dataDir)?.port ?? 0;
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = serve(preferred);
  } catch (error) {
    if (preferred === 0) throw error;
    // The last port is taken now: any free one.
    server = serve(0);
  }
  const port = server.port as number;
  const url = `http://${LOOPBACK}:${port}`;
  if (options.register !== false) writeEntry(dataDir, { v: 1, pid: process.pid, port, url, version, started: new Date().toISOString() });
  armIdle();

  let stopped = false;
  return {
    port,
    url,
    serverSession,
    pages: () => open,
    stop() {
      if (stopped) return;
      stopped = true;
      if (idleTimer) clearTimeout(idleTimer);
      server.stop(true);
      if (options.register !== false) retireOwnEntry(dataDir, process.pid, port);
    },
  };
}
