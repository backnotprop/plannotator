/**
 * Plannotator Inbox server: one long-lived local process per machine
 * (`plannotator inbox`), Bun-only. Pi and OpenCode are its clients; it needs
 * no node:http mirror.
 *
 * LOCAL ONLY in v1: it always binds 127.0.0.1 and ignores PLANNOTATOR_REMOTE,
 * PLANNOTATOR_PORT and --tailscale. It holds tokens and everything agents
 * sent, so a wide bind with no auth is not acceptable. Port: the last one it
 * had (from the registry) first, else random; never 19432.
 *
 * Security, on every request, in order:
 *  1. The Host allowlist (request-host-guard.ts), local rule: loopback names.
 *  2. `/mcp`: any Origin is refused (a browser is never an MCP client here).
 *  3. Connection routes (`/api/inbox/control/*`): a loopback Host naming this
 *     port, no Origin, and the registry's bearer token (the pull-bridge
 *     pattern).
 *  4. State-changing window routes: `isSameOriginOrNoOrigin`, then the
 *     `serverSession` nonce (409 for a tab left open on an older Inbox).
 * No CORS headers anywhere, so another site cannot read an answer.
 */

import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  INBOX_APP_ID,
  type InboxHealth,
  type InboxLine,
  type InboxProject,
} from "@plannotator/core/inbox-types";
import { toInboxQuestion } from "@plannotator/core/inbox-questions";
import { checkServerSession, createServerSessionNonce, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { extractDirName, extractRepoName } from "@plannotator/core/project";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { isLoopbackHostHeader } from "@plannotator/shared/loopback-host";
import { isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { InboxStore } from "@plannotator/shared/inbox/store";
import {
  createInboxToken,
  readInboxRegistry,
  writeInboxRegistry,
  type InboxRegistryEntry,
} from "@plannotator/shared/inbox/registry";
import { openBrowser } from "./browser";
import { isAddressInUseError } from "./remote";
import { createRequestHostGuard } from "./request-host-guard";
import { createInboxMcpServer } from "./inbox-mcp";
import { inboxStubPageHtml } from "./inbox-page";

const LOOPBACK = "127.0.0.1";
/** Remote mode's fixed port: the Inbox never takes it. */
export const INBOX_FORBIDDEN_PORT = 19432;
const SSE_HEARTBEAT_MS = 15_000;
const DEFAULT_HEALTH_TICK_MS = 60_000;

export interface InboxServerOptions {
  /** Default: `getPlannotatorDataDir()`. */
  dataDir?: string;
  /** The running binary's version; `dev` for a source run. */
  version?: string;
  /**
   * The installed binary to ask for its version on each health tick
   * (`<binary> --version`). Default: the compiled binary itself; none for a
   * source run.
   */
  binaryPath?: string | null;
  healthTickMs?: number;
  /** Called after the stop route was used, once the server has stopped. */
  onStopRequested?: () => void;
}

export interface InboxServer {
  port: number;
  url: string;
  token: string;
  serverSession: string;
  /** The last port could not be reused: notifications must be re-allowed once. */
  portChanged: boolean;
  store: InboxStore;
  registry: InboxRegistryEntry;
  stop: () => void;
}

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

const ERROR_STATUS: Record<string, number> = {
  validation_error: 422,
  message_not_found: 404,
  thread_not_found: 404,
  project_not_found: 404,
  question_not_found: 404,
  question_revision_conflict: 409,
  question_already_sent: 409,
  thread_resolved: 409,
  idempotency_key_reused: 409,
};

function errorResponse(error: unknown): Response {
  if (error instanceof InboxError) {
    return json({ error: error.message, code: error.code, ...error.details }, ERROR_STATUS[error.code] ?? 400);
  }
  return json({ error: "Internal error.", code: "internal_error" }, 500);
}

function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The project root for a path an agent named: realpath, then its git toplevel. */
export async function resolveInboxProjectRoot(path: string): Promise<{ root: string; name: string }> {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new InboxError("validation_error", "project_path: must be an absolute path.", { field: "project_path" });
  }
  let real: string;
  try {
    real = realpathSync(path);
    if (!statSync(real).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new InboxError("validation_error", "project_path: no such folder.", { field: "project_path" });
  }
  let root = real;
  try {
    const proc = Bun.spawn(["git", "-C", real, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code === 0 && out.trim()) root = realpathSync(out.trim());
  } catch {
    // No git: the folder is the project.
  }
  const name = extractRepoName(root) ?? extractDirName(root) ?? "project";
  return { root, name };
}

/** The installed binary's version (`plannotator X` on stdout), or null. */
async function probeBinaryVersion(binaryPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binaryPath, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, 5000);
    child.stdout?.on("data", (chunk) => (out += chunk));
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      const match = /^plannotator\s+(\S+)/.exec(out.trim());
      finish(code === 0 && match ? match[1]! : null);
    });
  });
}

function startOnLoopback(fetch: Parameters<typeof Bun.serve>[0]["fetch"], preferred: number | null): { server: ReturnType<typeof Bun.serve>; portChanged: boolean } {
  const serve = (port: number) =>
    Bun.serve({ hostname: LOOPBACK, port, idleTimeout: 0, fetch } as Parameters<typeof Bun.serve>[0]);
  let portChanged = false;
  if (preferred && preferred !== INBOX_FORBIDDEN_PORT) {
    try {
      return { server: serve(preferred), portChanged: false };
    } catch (error) {
      if (!isAddressInUseError(error)) throw error;
      portChanged = true;
    }
  }
  for (;;) {
    const server = serve(0);
    if (server.port !== INBOX_FORBIDDEN_PORT) return { server, portChanged };
    server.stop(true);
  }
}

/** Start the Inbox server and write the registry. */
export async function startInboxServer(options: InboxServerOptions = {}): Promise<InboxServer> {
  const dataDir = options.dataDir ?? getPlannotatorDataDir();
  const version = options.version ?? "dev";
  const store = InboxStore.open(dataDir);
  const serverSession = createServerSessionNonce();
  const token = createInboxToken();
  const hostGuard = createRequestHostGuard({ localOnly: true });
  const previous = readInboxRegistry(dataDir);
  let port = 0;
  let baseUrl = "";
  let update: InboxHealth["update"] = null;
  let portChanged = false;
  const statusListeners = new Set<() => void>();

  const projectLocks = new Map<string, Promise<InboxProject>>();
  const resolveProject = async (path: string): Promise<InboxProject> => {
    const { root, name } = await resolveInboxProjectRoot(path);
    const existing = store.projectByRoot(root);
    if (existing) return existing;
    // One creation per root even when two calls race through the await above.
    let pending = projectLocks.get(root);
    if (!pending) {
      pending = Promise.resolve().then(() => store.ensureProject({ name, root }));
      projectLocks.set(root, pending);
      pending.finally(() => projectLocks.delete(root));
    }
    return pending;
  };

  const mcp = createMcpHandler(
    () => createInboxMcpServer({ store, baseUrl: () => baseUrl, resolveProject }),
    { legacy: "stateless" },
  );

  const health = (): InboxHealth => ({ ok: true, app: INBOX_APP_ID, version, serverSession, pid: process.pid, update });

  const listModel = () => ({
    serverSession,
    version,
    cursor: store.cursor(),
    update,
    notice: portChanged ? "The Inbox moved to a new port: allow notifications again on this page." : null,
    projects: store.listProjects().map((project) => ({ project, threads: store.threadsOf(project.id) })),
  });

  const eventPayload = (line: InboxLine) => {
    switch (line.kind) {
      case "project":
        return { seq: line.seq, kind: line.kind, id: line.id, project: line.record };
      case "message":
        return { seq: line.seq, kind: line.kind, id: line.id, message: line.record };
      case "question": {
        const root = store.message(store.message(line.record.message_id)?.thread_id ?? "");
        return { seq: line.seq, kind: line.kind, id: line.id, question: toInboxQuestion(line.record, root?.resolved_at != null) };
      }
    }
  };

  const eventStream = (req: Request, url: URL): Response => {
    const raw = url.searchParams.get("cursor") ?? req.headers.get("last-event-id");
    const parsed = raw === null ? null : Number(raw);
    const cursor = parsed !== null && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    const encoder = new TextEncoder();
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (text: string) => {
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            cleanup();
          }
        };
        const sendLine = (line: InboxLine) => send(`id: ${line.seq}\nevent: record\ndata: ${JSON.stringify(eventPayload(line))}\n\n`);
        send(`retry: 2000\nevent: hello\ndata: ${JSON.stringify({ serverSession, cursor: store.cursor() })}\n\n`);
        if (cursor !== null) for (const line of store.changesSince(cursor)) sendLine(line);
        const unsubscribe = store.subscribe(sendLine);
        const onStatus = () => send(`event: status\ndata: ${JSON.stringify({ update })}\n\n`);
        statusListeners.add(onStatus);
        const heartbeat = setInterval(() => send(": ping\n\n"), SSE_HEARTBEAT_MS);
        cleanup = () => {
          clearInterval(heartbeat);
          unsubscribe();
          statusListeners.delete(onStatus);
        };
        req.signal.addEventListener("abort", () => {
          cleanup();
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        });
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        Connection: "keep-alive",
      },
    });
  };

  let stopRequested = false;
  let server: ReturnType<typeof Bun.serve>;

  const readBody = async (req: Request): Promise<Record<string, unknown>> => {
    try {
      const value = await req.json();
      return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    } catch {
      throw new InboxError("validation_error", "body: expected a JSON object.");
    }
  };

  const fetch = async (req: Request): Promise<Response> => {
    const refused = hostGuard.check(req);
    if (refused) return refused;
    // An HTTP/1.0 request with no Host passes the guard (a non-browser client)
    // but leaves Bun a relative req.url; read it against this server.
    let url: URL;
    try {
      url = new URL(req.url, `http://127.0.0.1:${port}`);
    } catch {
      return json({ error: "Bad request.", code: "bad_request" }, 400);
    }
    const path = url.pathname;
    const origin = req.headers.get("origin");

    if (path === "/mcp") {
      if (origin !== null) {
        return json({ error: "Browser requests are not accepted on /mcp.", code: "origin_not_allowed" }, 403);
      }
      return mcp.fetch(req);
    }

    if (path.startsWith("/api/inbox/control/")) {
      if (!isLoopbackHostHeader(req.headers.get("host"), port)) {
        return json({ error: "Connection routes answer only this machine.", code: "forbidden_host" }, 403);
      }
      if (origin !== null) return json({ error: "Browser requests are not accepted here.", code: "origin_not_allowed" }, 403);
      const match = /^Bearer\s+(\S+)$/i.exec((req.headers.get("authorization") ?? "").trim());
      if (!match || !tokensEqual(match[1]!, token)) {
        return json({ error: "Missing or wrong Inbox token.", code: "unauthorized" }, 401);
      }
      if (path === "/api/inbox/control/stop") {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        if (!stopRequested) {
          stopRequested = true;
          setTimeout(() => {
            stop();
            options.onStopRequested?.();
          }, 50);
        }
        return json({ ok: true, stopping: true });
      }
      return json({ error: "Not found", code: "not_found" }, 404);
    }

    if (req.method === "POST" && path.startsWith("/api/")) {
      if (!isSameOriginOrNoOrigin(origin, req.headers.get("host") ?? "", req.headers.get("sec-fetch-site"))) {
        return json({ error: "Cross-origin requests are not accepted.", code: "cross_origin" }, 403);
      }
    }

    try {
      if (path === "/api/inbox/health" && req.method === "GET") return json(health());
      if (path === "/api/inbox/projects" && req.method === "GET") return json(listModel());
      if (path === "/api/inbox/events" && req.method === "GET") return eventStream(req, url);

      const threadMatch = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)$/.exec(path);
      if (threadMatch && req.method === "GET") {
        const thread = store.thread(threadMatch[1]!);
        if (!thread) return json({ error: "No such thread.", code: "thread_not_found" }, 404);
        return json({ serverSession, cursor: store.cursor(), thread });
      }

      const messageMatch = /^\/api\/inbox\/messages\/([A-Za-z0-9_]+)\/(picks|reply|resolve)$/.exec(path);
      if (messageMatch) {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(), 409);
        const messageId = messageMatch[1]!;
        switch (messageMatch[2]) {
          case "picks": {
            const questions = store.savePicks(messageId, body.questions as never);
            return json({ message_id: messageId, questions, reply: null });
          }
          case "reply": {
            const result = store.sendReply(messageId, {
              words: typeof body.words === "string" ? body.words : undefined,
              questions: (body.questions as never) ?? [],
              idempotency_key: body.idempotency_key as string,
            });
            return json({ message_id: messageId, questions: result.questions, reply: result.reply, replayed: result.replayed });
          }
          case "resolve": {
            if (body.resolved !== undefined && typeof body.resolved !== "boolean") {
              throw new InboxError("validation_error", "resolved: must be a boolean.");
            }
            const thread = store.resolveThread(messageId, body.resolved !== false);
            return json({ thread });
          }
        }
      }

      if (path === "/" && (req.method === "GET" || req.method === "HEAD")) {
        const nonce = createServerSessionNonce();
        return new Response(req.method === "HEAD" ? null : inboxStubPageHtml(nonce), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
          },
        });
      }

      if (path.startsWith("/api/")) return json({ error: "Not found", code: "not_found" }, 404);
      return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" } });
    } catch (error) {
      return errorResponse(error);
    }
  };

  const started = startOnLoopback(fetch, previous?.port ?? null);
  server = started.server;
  portChanged = started.portChanged;
  port = server.port as number;
  baseUrl = `http://localhost:${port}/`;

  const registry: InboxRegistryEntry = {
    v: 1,
    pid: process.pid,
    port,
    url: baseUrl,
    version,
    token,
    serverSession,
    startedAt: new Date().toISOString(),
  };
  writeInboxRegistry(dataDir, registry);

  const binaryPath = options.binaryPath !== undefined ? options.binaryPath : version !== "dev" ? process.execPath : null;
  let tick: ReturnType<typeof setInterval> | null = null;
  // Running the compiled binary costs ~0.2 s of CPU and a ~440 MB peak RSS
  // (it parses the embedded apps), so it runs only when the file on disk
  // changed since the last probe; an unchanged file keeps its last answer.
  let probedSignature: string | null = null;
  const checkUpdate = async () => {
    if (!binaryPath) return;
    let signature: string;
    try {
      const stat = statSync(binaryPath);
      signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return;
    }
    if (signature === probedSignature) return;
    probedSignature = signature;
    const onDisk = await probeBinaryVersion(binaryPath);
    if (onDisk === null) probedSignature = null;
    const next = onDisk && onDisk !== version ? { available: true as const, version: onDisk } : null;
    if (JSON.stringify(next) !== JSON.stringify(update)) {
      update = next;
      for (const listener of statusListeners) listener();
    }
  };
  if (binaryPath) {
    void checkUpdate();
    tick = setInterval(() => void checkUpdate(), options.healthTickMs ?? DEFAULT_HEALTH_TICK_MS);
  }

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (tick) clearInterval(tick);
    void mcp.close().catch(() => {});
    server.stop(true);
  };

  return { port, url: baseUrl, token, serverSession, portChanged, store, registry, stop };
}

/** Print where the Inbox is, and open it when a person asked for it. */
export async function handleInboxServerReady(
  inbox: Pick<InboxServer, "url" | "portChanged">,
  options: { open: boolean },
): Promise<void> {
  process.stderr.write(`Plannotator Inbox: ${inbox.url}\n`);
  if (inbox.portChanged) {
    process.stderr.write("The Inbox could not reuse its last port; allow notifications again when the page asks.\n");
  }
  if (options.open && process.env.PLANNOTATOR_SKIP_BROWSER_OPEN !== "1") await openBrowser(inbox.url);
}
