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
 *  3. Connection routes (`/api/inbox/control/*`, `/api/inbox/bridge/*`): a
 *     loopback Host naming this port, no Origin, and the registry's bearer
 *     token (the pull-bridge pattern).
 *  4. State-changing window routes: `isSameOriginOrNoOrigin`, then the
 *     `serverSession` nonce (409 for a tab left open on an older Inbox).
 * No CORS headers anywhere, so another site cannot read an answer.
 */

import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  INBOX_APP_ID,
  isInboxId,
  type InboxHealth,
  type InboxLine,
  type InboxListRow,
  type InboxMessage,
  type InboxProject,
} from "@plannotator/core/inbox-types";
import { toInboxQuestion } from "@plannotator/core/inbox-questions";
import { checkServerSession, createServerSessionNonce, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { extractDirName, extractRepoName } from "@plannotator/core/project";
import {
  INBOX_TOOL_HOSTS,
  loadConfig,
  parseInboxToolEnv,
  resolveInboxTool,
  saveConfig,
  configuredInboxTool,
  type AgentToolHost,
  type PlannotatorConfig,
} from "@plannotator/shared/config";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { isLoopbackHostHeader } from "@plannotator/shared/loopback-host";
import { isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxListSections } from "@plannotator/shared/inbox/list";
import {
  INBOX_BRIDGE_EVENT_PATH,
  INBOX_BRIDGE_POLL_MAX_MS,
  INBOX_BRIDGE_POLL_PATH,
  type InboxReplyCommand,
} from "@plannotator/shared/inbox/connection";
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
import {
  handleInboxDecisionRoute,
  INBOX_DECISION_ERROR_STATUS,
  recordDecisionsForReply,
  threadDecisions,
  waitingDecisions,
} from "./inbox-decisions";
import { handleFavicon } from "./shared-handlers";
import { createInboxAttachmentRoutes } from "./inbox-attachments";
import { recordInboxAttachments } from "@plannotator/shared/inbox/attachments";

const LOOPBACK = "127.0.0.1";
/** Remote mode's fixed port: the Inbox never takes it. */
export const INBOX_FORBIDDEN_PORT = 19432;
const SSE_HEARTBEAT_MS = 15_000;
const DEFAULT_HEALTH_TICK_MS = 60_000;
/** `http://localhost:52817`: an origin as the page reports it, nothing more. */
function isPageOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

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
  /**
   * Called after the window's Restart (the "A new version is ready" line),
   * once this server has stopped listening: the caller starts the binary on
   * disk in its place and ends this process. Absent: Restart answers 409.
   */
  onRestartRequested?: () => void;
  /**
   * The window: the built single-file app (`apps/hook/dist/inbox.html`, which
   * the binary embeds). Absent (a source run before `build:hook`, the server
   * tests): `/` answers a one-line page saying so.
   */
  htmlContent?: string;
  /**
   * The argv that runs this CLI (the compiled binary's absolute path, or bun
   * plus the entry script), so the window's connect snippets name a command
   * that works where PATH is not the shell's. Default: the compiled binary,
   * else `plannotator`.
   */
  selfCommand?: readonly string[];
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
  config_not_saved: 500,
  ...INBOX_DECISION_ERROR_STATUS,
  // Attachments and annotations (step 2).
  attachment_not_found: 404,
  attachment_missing: 404,
  attachment_changed_type: 409,
  annotation_not_found: 404,
  annotation_closed: 409,
};

/**
 * The window is a single-file build: its script and styles are inline, so the
 * policy allows inline code from this page only and no other origin. Nothing
 * may frame it, and it may only talk to this server.
 */
const WINDOW_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  // 'self', not 'none': an attached HTML page is drawn in a srcdoc frame,
  // which inherits this policy, with a <base href> at its own folder's
  // asset route on this origin (annotate's #1554 serving path). Without it
  // the base is blocked and the page's frames resolve onto the Inbox.
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

/** `/` before the window is built (a source run, the server tests). */
const NOT_BUILT_PAGE =
  '<!doctype html><meta charset="utf-8"><title>Plannotator Inbox</title><p data-inbox-not-built>The Inbox window is not built: run <code>bun run build:hook</code>.</p>';

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
    () =>
      createInboxMcpServer({
        store,
        baseUrl: () => baseUrl,
        resolveProject,
        recordAttachments: (paths, project, base) =>
          recordInboxAttachments(store.dir, paths, { base, projectRoot: project.root, at: new Date().toISOString() }),
      }),
    { legacy: "stateless" },
  );

  const health = (): InboxHealth => ({ ok: true, app: INBOX_APP_ID, version, serverSession, pid: process.pid, update });

  /** The sidebar's folders: every project, with its thread and unread counts. */
  const projectFolders = (rows: readonly InboxListRow[] = store.listRows()) => {
    return store.listProjects().map((project) => {
      const mine = rows.filter((row) => row.project.id === project.id);
      return { ...project, threads: mine.length, unread: mine.filter((row) => row.unread).length };
    });
  };

  /**
   * The list model: one row per thread, placed in the approved sections, with
   * the project as a label and an optional filter (`?project=prj_...`), which
   * keeps the sections and drops other projects' rows.
   */
  const listModel = (projectFilter: string | null) => {
    // One pass over the store feeds both the folders' counts and the sections.
    const rows = store.listRows();
    return {
      serverSession,
      version,
      cursor: store.cursor(),
      update,
      notice: portChanged ? "The Inbox moved to a new port: allow notifications again on this page." : null,
      projects: projectFolders(rows),
      project: projectFilter,
      sections: inboxListSections(projectFilter ? rows.filter((row) => row.project.id === projectFilter) : rows),
      /** Questions in every project that record a decision once answered and sent: the sidebar's Decisions count. */
      decisions_waiting: waitingDecisions(store).length,
    };
  };

  const projectFilterOf = (url: URL): string | null => {
    const value = url.searchParams.get("project");
    if (value === null || value === "") return null;
    if (!isInboxId("prj", value)) throw new InboxError("validation_error", "project: a prj_ id.", { field: "project" });
    if (!store.project(value)) throw new InboxError("project_not_found", `No project ${value}.`);
    return value;
  };

  const selfCommand = options.selfCommand?.length
    ? [...options.selfCommand]
    : version !== "dev"
      ? [process.execPath]
      : ["plannotator"];

  /** The agent tool knob per host: the effective value, and whether the env var decides it. */
  const inboxToolState = () => {
    const config = loadConfig();
    const env = parseInboxToolEnv();
    const hosts = Object.fromEntries(INBOX_TOOL_HOSTS.map((host) => [host, resolveInboxTool(config, process.env, host)])) as Record<AgentToolHost, boolean>;
    return { hosts, env: env ?? null };
  };

  /** The browser notifications (record 6.x, 7.2), resolved from config.json: on and not dismissed unless set. */
  const notificationsState = () => {
    const value = loadConfig().inboxNotifications;
    const saved = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return {
      enabled: saved.enabled !== false,
      dismissed: saved.dismissed === true,
      allowed_origin: typeof saved.allowedOrigin === "string" ? saved.allowedOrigin : null,
    };
  };

  /** Save the fields named, keeping the others as they are. */
  const saveNotifications = (input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new InboxError("validation_error", "notifications: an object.", { field: "notifications" });
    }
    const current = loadConfig().inboxNotifications;
    const next: NonNullable<PlannotatorConfig["inboxNotifications"]> =
      current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
    for (const [field, value] of Object.entries(input as Record<string, unknown>)) {
      switch (field) {
        case "enabled":
        case "dismissed":
          if (typeof value !== "boolean") throw new InboxError("validation_error", `notifications.${field}: must be a boolean.`, { field: `notifications.${field}` });
          next[field] = value;
          break;
        case "allowed_origin":
          if (value !== null && (typeof value !== "string" || !isPageOrigin(value))) {
            throw new InboxError("validation_error", "notifications.allowed_origin: an http origin or null.", { field: "notifications.allowed_origin" });
          }
          next.allowedOrigin = value as string | null;
          break;
        default:
          throw new InboxError("validation_error", `notifications.${field}: not a setting (enabled, dismissed, allowed_origin).`, { field: `notifications.${field}` });
      }
    }
    saveConfig({ inboxNotifications: next });
    if (JSON.stringify(loadConfig().inboxNotifications) !== JSON.stringify(next)) {
      throw new InboxError("config_not_saved", "config.json could not be written; nothing changed.");
    }
    return notificationsState();
  };

  /** What Settings and the connect snippets read. */
  const settingsModel = () => ({
    serverSession,
    version,
    port,
    url: baseUrl,
    mcp_url: `http://127.0.0.1:${port}/mcp`,
    /** The stdio MCP entry as argv: `<this CLI> inbox mcp`. */
    mcp_command: [...selfCommand, "inbox", "mcp"],
    home: homedir(),
    data_dir: dataDir,
    inbox_tool: inboxToolState(),
    notifications: notificationsState(),
    store: store.diskUsage(),
  });

  /** Save the knob for the hosts named, keeping the others as they are. */
  const saveInboxTool = (input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new InboxError("validation_error", "inbox_tool: an object of host to boolean.", { field: "inbox_tool" });
    }
    const config = loadConfig();
    const next: Partial<Record<AgentToolHost, boolean>> = {};
    for (const host of INBOX_TOOL_HOSTS) {
      const current = configuredInboxTool(config, host);
      if (current !== undefined) next[host] = current;
    }
    for (const [host, value] of Object.entries(input as Record<string, unknown>)) {
      if (!(INBOX_TOOL_HOSTS as readonly string[]).includes(host)) {
        throw new InboxError("validation_error", `inbox_tool.${host}: not a host (claude-code, pi, opencode).`, { field: `inbox_tool.${host}` });
      }
      if (typeof value !== "boolean") {
        throw new InboxError("validation_error", `inbox_tool.${host}: must be a boolean.`, { field: `inbox_tool.${host}` });
      }
      next[host as AgentToolHost] = value;
    }
    saveConfig({ inboxTool: next });
    const saved = loadConfig();
    for (const [host, value] of Object.entries(next)) {
      if (configuredInboxTool(saved, host as AgentToolHost) !== value) {
        throw new InboxError("config_not_saved", "config.json could not be written; nothing changed.");
      }
    }
    return inboxToolState();
  };

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
      case "decision":
        return { seq: line.seq, kind: line.kind, id: line.id, decision: line.record };
      case "annotation":
        return { seq: line.seq, kind: line.kind, id: line.id, annotation: line.record };
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

  // ── Agent connections: the reply wake (step 6) ──
  //
  // A connection (the Claude Code mod) long-polls for the person's replies to
  // its session's messages and posts `delivered` once a reply entered the
  // session as a turn. Nothing is queued in memory: the replies a session
  // waits for are read from the store (`pendingReplies`), so a reply is handed
  // out again on every poll until it is delivered or an agent read it, and it
  // survives an Inbox restart.
  const threadPageUrl = (base: string, threadId: string) => `${base}#thread=${threadId}`;
  const replyCommand = (reply: InboxMessage): InboxReplyCommand => ({
    type: "reply",
    id: reply.id,
    thread_id: reply.thread_id,
    reply_to: reply.reply_to!,
    subject: store.message(reply.thread_id)?.subject ?? null,
    body: reply.body,
    url: threadPageUrl(baseUrl, reply.thread_id),
  });

  const bridgeSession = (body: Record<string, unknown>): string => {
    const session = typeof body.session === "string" ? body.session.trim() : "";
    if (!session) throw new InboxError("validation_error", "session: the agent session id is required.", { field: "session" });
    return session;
  };

  /** `{ session, waitMs? }`: answers at once when a reply waits, else holds up to 25 s for one. */
  const bridgePoll = async (req: Request): Promise<Response> => {
    const body = await readBody(req);
    const session = bridgeSession(body);
    const requested = typeof body.waitMs === "number" && Number.isFinite(body.waitMs) ? body.waitMs : 0;
    const waitMs = Math.min(Math.max(requested, 0), INBOX_BRIDGE_POLL_MAX_MS);
    const commands = () => store.pendingReplies(session).map(replyCommand);
    const now = commands();
    if (now.length > 0 || waitMs === 0) return json({ commands: now });
    return new Promise<Response>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        req.signal.removeEventListener("abort", finish);
        resolve(json({ commands: commands() }));
      };
      const timer = setTimeout(finish, waitMs);
      const unsubscribe = store.subscribe((line) => {
        if (line.kind === "message" && line.record.author.kind === "person" && store.pendingReplies(session).length > 0) finish();
      });
      req.signal.addEventListener("abort", finish);
    });
  };

  /** `{ session, host, type: "delivered", id }`: the reply entered the session as a turn. */
  const bridgeEvent = async (req: Request): Promise<Response> => {
    const body = await readBody(req);
    const session = bridgeSession(body);
    if (body.type !== "delivered" || typeof body.id !== "string") {
      throw new InboxError("validation_error", 'type: "delivered" with the reply id is the only event.', { field: "type" });
    }
    const host = typeof body.host === "string" && body.host.trim() ? body.host.trim() : "agent";
    const reply = store.recordDelivery(body.id, { host, session });
    return json({ ok: true, delivery: reply.delivery });
  };

  let stopRequested = false;
  let server: ReturnType<typeof Bun.serve>;
  let attachmentRoutes: ReturnType<typeof createInboxAttachmentRoutes>;

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

    if (path.startsWith("/api/inbox/control/") || path.startsWith("/api/inbox/bridge/")) {
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
      if (path === INBOX_BRIDGE_POLL_PATH || path === INBOX_BRIDGE_EVENT_PATH) {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        try {
          return await (path === INBOX_BRIDGE_POLL_PATH ? bridgePoll(req) : bridgeEvent(req));
        } catch (error) {
          return errorResponse(error);
        }
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
      if (path === "/api/inbox/threads" && req.method === "GET") return json(listModel(projectFilterOf(url)));
      if (path === "/api/inbox/projects" && req.method === "GET") return json({ serverSession, cursor: store.cursor(), projects: projectFolders() });
      if (path === "/api/inbox/events" && req.method === "GET") return eventStream(req, url);
      if (path === "/api/inbox/restart") {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(), 409);
        if (!options.onRestartRequested) {
          return json({ error: "This Inbox cannot restart itself; quit it and run plannotator inbox.", code: "restart_unavailable" }, 409);
        }
        if (!stopRequested) {
          stopRequested = true;
          setTimeout(() => {
            stop();
            options.onRestartRequested?.();
          }, 50);
        }
        return json({ ok: true, restarting: true });
      }
      if (path === "/api/inbox/settings") {
        if (req.method === "GET") return json(settingsModel());
        if (req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(), 409);
        if (body.inbox_tool === undefined && body.notifications === undefined) {
          throw new InboxError("validation_error", "body: inbox_tool or notifications is required.");
        }
        const notifications = body.notifications === undefined ? notificationsState() : saveNotifications(body.notifications);
        const inboxTool = body.inbox_tool === undefined ? inboxToolState() : saveInboxTool(body.inbox_tool);
        return json({ inbox_tool: inboxTool, notifications });
      }

      const threadMatch = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)$/.exec(path);
      if (threadMatch && req.method === "GET") {
        const thread = store.thread(threadMatch[1]!);
        if (!thread) return json({ error: "No such thread.", code: "thread_not_found" }, 404);
        const decisionIds = thread.messages.flatMap((m) => (m.questions ?? []).map((q) => q.decision_id));
        return json({ serverSession, cursor: store.cursor(), thread, decisions: threadDecisions(store, decisionIds) });
      }

      const seenMatch = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/seen$/.exec(path);
      if (seenMatch) {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(), 409);
        return json({ thread: store.markSeen(seenMatch[1]!) });
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
              feedback: typeof body.feedback === "string" ? body.feedback : undefined,
              annotation_ids: body.annotation_ids as never,
            });
            // Step 3: the sent answers whose decision switch is on become
            // decisions, after the reply landed; a refused one never undoes it.
            const decisions = recordDecisionsForReply(store, result.reply.id);
            return json({
              message_id: messageId,
              questions: store.questionsOf(messageId),
              reply: result.reply,
              replayed: result.replayed,
              decisions: decisions.recorded,
              decisions_refused: decisions.refused,
            });
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

      // ── Step 3: decisions (packages/server/inbox-decisions.ts) ──
      const decisionResponse = await handleInboxDecisionRoute(req, url, {
        store,
        serverSession,
        readBody,
        json,
        staleTab: (body) => (checkServerSession(body, serverSession) === "mismatch" ? json(serverSessionMismatchBody(), 409) : null),
      });
      if (decisionResponse) return decisionResponse;

      if (path === "/" && (req.method === "GET" || req.method === "HEAD")) {
        const page = options.htmlContent ?? NOT_BUILT_PAGE;
        return new Response(req.method === "HEAD" ? null : page, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": WINDOW_CSP,
          },
        });
      }
      if (path === "/favicon.png" && req.method === "GET") return handleFavicon();

      // Step 2: attachments by id, annotations, the HTML asset route, delete
      // thread and delete project (packages/server/inbox-attachments.ts).
      const attached = await attachmentRoutes(req, url);
      if (attached) return attached;

      if (path.startsWith("/api/")) return json({ error: "Not found", code: "not_found" }, 404);
      return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" } });
    } catch (error) {
      return errorResponse(error);
    }
  };

  attachmentRoutes = createInboxAttachmentRoutes({ store, serverSession, readBody });
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
