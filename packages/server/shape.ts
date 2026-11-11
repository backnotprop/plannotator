/** The Shapes server: Shape's page for people without the Inbox. Loopback-only with a Host check, off (404) unless Shape or Code review is on, same-origin only, and a write with a foreign `serverSession` answers 409. Exits `idleMs` after the last page closes. */
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
export const SHAPE_SERVER_IDLE_MS = 30 * 60_000;
export const SHAPE_SERVER_FILE = "server.json";
export const SHAPE_SERVER_INFO_PATH = "/api/shape-server";

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

export interface ShapeServerInfo {
  shape_server: 1;
  version: string;
  serverSession: string;
  on: boolean;
  pages: number;
}

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;

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

const NOT_BUILT_PAGE = "<!doctype html><meta charset=utf-8><title>Plannotator Shape</title><p>The Shape page is not built. Run the build (apps/inbox build:shape).</p>";

export function shapeServerPath(dataDir: string): string {
  return join(shapesDirOf(dataDir), SHAPE_SERVER_FILE);
}

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536;
}

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

/** Null when the count cannot be read (an older server without the field); the caller then opens a page as if none were. */
export interface RunningShapeServer extends ShapeServerEntry {
  pages: number | null;
}

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

/** Keeps a stopped server's entry (pid 0) if it still names this process, so the next start takes the same port and nothing reads it as running. */
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
  page?: () => string;
  /** The built page gzipped (what the binary embeds): sent as is to gzip-capable browsers, unzipped once for others. */
  pageGzip?: () => Uint8Array;
  shape?: boolean;
  port?: number;
  version?: string;
  idleMs?: number;
  onIdle?: () => void;
  register?: boolean;
  /** Serve boards as stored and change nothing (`plannotator shape frame`): writes answer 405 and the event stream 404. */
  readOnly?: boolean;
  heartbeatMs?: number;
  watchMs?: number;
}

export interface ShapeServer {
  port: number;
  url: string;
  serverSession: string;
  pages: () => number;
  stop: () => void;
}

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
