/**
 * Plannotator Inbox server: one long-lived local process per machine
 * (`plannotator inbox`), Bun-only. Pi and OpenCode are its clients; it needs
 * no node:http mirror.
 *
 * LOCAL ONLY by default: it always binds 127.0.0.1 and ignores
 * PLANNOTATOR_REMOTE and PLANNOTATOR_PORT. It holds tokens and everything
 * agents sent, so a wide bind with no auth is not acceptable. "Over your
 * tailnet" (`plannotator inbox --tailscale`, PLANNOTATOR_INBOX_TAILSCALE,
 * config.json `inboxTailscale`; inbox-tailscale.ts) publishes the window
 * through `tailscale serve` to a second loopback listener that lets in only
 * the Tailscale login that owns this machine, and hands it no connection
 * route, no `/mcp` and no device door (`via: "tailnet"` below). A
 * paired phone reaches it through the device door only, over a path the
 * person switched on ("Reach from my tailnet": a door-only listener that
 * `tailscale serve` points at, inbox-devices.ts; "Reach from this Wi-Fi": a
 * door-only TLS listener on every interface, inbox-lan.ts). All of the phone
 * surface exists only when PLANNOTATOR_INBOX_PHONES (or config.json
 * `inboxPhones`) turns it on, until the iPhone app ships. Port: the
 * last one it had (from the registry) first, else random; never 19432.
 *
 * Security, on every request, in order:
 *  1. The Host allowlist (request-host-guard.ts), local rule: loopback names.
 *     The device door, `/api/inbox/device/*` (no Origin, a phone's bearer
 *     token, an allowlist), sits beside the window here; the tailnet and the
 *     Wi-Fi reach it through their own door-only listeners, never here.
 *     The tailnet listener checks its own Host (the served MagicDNS name),
 *     the owner's `Tailscale-User-Login` and `Sec-Fetch-Site` instead, then
 *     hands the request here marked `tailnet`.
 *  2. `/mcp`: any Origin and any non-loopback Host is refused (a browser is
 *     never an MCP client here), and the tailnet never reaches it.
 *  3. Connection routes (`/api/inbox/control/*`, `/api/inbox/bridge/*`): a
 *     loopback Host naming this port, no Origin, and the registry's bearer
 *     token (the pull-bridge pattern).
 *  4. State-changing window routes: `isSameOriginOrNoOrigin`, then the
 *     `serverSession` nonce (409 for a tab left open on an older Inbox).
 * No CORS headers anywhere, so another site cannot read an answer.
 */

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  INBOX_APP_ID,
  INBOX_SOUND_DEFAULT_VOLUME,
  inboxAgentName,
  isInboxId,
  isInboxSoundVolume,
  type InboxHealth,
  type InboxLine,
  type InboxListRow,
  type InboxMessage,
  type InboxProject,
  type InboxProjectRepo,
} from "@plannotator/core/inbox-types";
import { checkServerSession, createServerSessionNonce, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { extractDirName, extractRepoName } from "@plannotator/core/project";
import {
  INBOX_TOOL_HOSTS,
  loadConfig,
  parseAutoUpdateEnv,
  parseInboxToolEnv,
  parseUpdateCheckEnv,
  resolveAutoUpdate,
  resolveUpdateCheck,
  resolveInboxPhones,
  resolveInboxTool,
  saveConfig,
  configuredInboxTool,
  configuredInboxReminder,
  resolveInboxReminder,
  type InboxToolHost,
  type PlannotatorConfig,
  type ThemeConfig,
} from "@plannotator/shared/config";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { normalizeStableVersion, readUpdateState } from "@plannotator/shared/update-check";
import { isLoopbackHostHeader } from "@plannotator/shared/loopback-host";
import { isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxArchivedRows, inboxListSections, inboxRowArchived } from "@plannotator/shared/inbox/list";
import {
  INBOX_BRIDGE_EVENT_PATH,
  INBOX_BRIDGE_POLL_MAX_MS,
  INBOX_BRIDGE_POLL_PATH,
  INBOX_MAX_REQUEST_BYTES,
  type InboxReplyCommand,
} from "@plannotator/shared/inbox/connection";
import {
  createInboxToken,
  inboxRegistryPath,
  probeInboxData,
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
  waitingDecisionCount,
} from "./inbox-decisions";
import { inboxGuideRoute } from "./inbox-guides";
import { createInboxRepoCache } from "./inbox-repos";
import { handleFavicon } from "./shared-handlers";
import { createInboxAttachmentRoutes } from "./inbox-attachments";
import { inboxMessageImageRoute } from "./inbox-message-images";
import { recordInboxAttachments, sweepStaleInboxSendTemps } from "@plannotator/shared/inbox/attachments";
import { createInboxLiveSessions } from "./inbox-sessions";
import { createInboxDevices, DOOR_PREFIX } from "./inbox-devices";
import type { PairingProbes } from "./inbox-pairing-checks";
import { createInboxRelay } from "./inbox-relay";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { createInboxTailscale, PHONES_TAILNET_HTTPS_PORT, type InboxTailscale } from "./inbox-tailscale";
import { createInboxUpdates, type InboxUpdatesOptions } from "./inbox-updates";
import {
  agentSpec,
  connectInboxAgents,
  createAgentEnvironment,
  createAgentEnvironmentFor,
  displayPath,
  inboxAgentReach,
  inboxConnectDisabled,
  readInboxAgents,
  setInboxAgentReach,
  setInboxTool,
  writeInboxAgents,
  type AgentEnvironment,
} from "./inbox-agents";
import { addInboxNote, INBOX_NOTE_BLOCK, inboxNotesDisabled, markNotesAsked, noteCandidateIds, notesAsked, noteStatus, removeInboxNote } from "./inbox-agent-notes";
import {
  INBOX_AGENT_IDS,
  INBOX_AGENT_LABELS,
  INBOX_NOTE_AGENT_IDS,
  type InboxAgentId,
  type InboxConnectReport,
  type InboxNoteAgentId,
} from "@plannotator/core/inbox-types";

/** Where a request came in: the window's loopback port, or the tailnet-only listener `tailscale serve` points at. */
type RequestVia = "local" | "tailnet";

/** Headers `tailscale serve` sets on every proxied request (X-Forwarded-For always; the identity for a user's device). */
const SERVE_HEADERS = ["tailscale-headers-info", "tailscale-user-login", "x-forwarded-for"] as const;

const LOOPBACK = "127.0.0.1";
/** A palette id as packages/ui/themes names them (`plannotator`, `tokyo-night`). */
const THEME_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Remote mode's fixed port: the Inbox never takes it. */
export const INBOX_FORBIDDEN_PORT = 19432;
const SSE_HEARTBEAT_MS = 15_000;
const DEFAULT_HEALTH_TICK_MS = 60_000;
/**
 * How often the Inbox checks that `inbox.json` is still there and still its
 * own (`probeInboxData`); two misses in a row end it, so an Inbox whose data
 * folder was removed stops within about twice this. A check that cannot tell
 * (EACCES, EIO, ...) is neither a miss nor a pass.
 */
export const INBOX_DATA_CHECK_MS = 5_000;
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
   * Called once the Inbox found its data folder or `inbox.json` gone, or
   * `inbox.json` naming another Inbox (`probeInboxData`), after it has
   * stopped: nothing can find it and it has no store, so the caller ends the
   * process. Absent: the server only stops.
   */
  onDataGone?: (reason: string) => void;
  /** How often that is checked. Default `INBOX_DATA_CHECK_MS`. Tests shorten it. */
  dataCheckMs?: number;
  /**
   * Called after the window's Restart (the "A new version is ready" line),
   * once this server has stopped listening: the caller starts the binary on
   * disk in its place and ends this process. Absent: Restart answers 409.
   */
  onRestartRequested?: () => void;
  /**
   * The update control's seams (packages/server/inbox-updates.ts): the
   * release fetch, the installer, whether the binary is the install script's,
   * the sessions list and the clock. Defaults: the real ones. Tests inject.
   */
  updates?: Pick<InboxUpdatesOptions, "fetchRelease" | "launchInstaller" | "isManaged" | "listSessions" | "now" | "probeVersion">;
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
  /** The phone door's clock (packages/server/inbox-devices.ts): the pairing offer's expiry. Default: the wall clock. */
  now?: () => Date;
  /** How "Reach from my tailnet" runs the `tailscale` CLI. Default: the CLI on PATH. */
  tailscale?: TailscaleRunner;
  /** Tests: how step 1 of Pair a phone reads this computer (packages/server/inbox-pairing-checks.ts). Default: its own tools. */
  pairingProbes?: Partial<PairingProbes>;
  /**
   * Phones: pairing, the device door, the tailnet and Wi-Fi listeners, the
   * relay and Settings' Phones block. Default: `resolveInboxPhones`
   * (PLANNOTATOR_INBOX_PHONES, then config.json `inboxPhones`, else off).
   * Off, none of it exists: its routes answer the unknown-route 404 and
   * nothing listens, connects, spawns or makes a certificate.
   */
  phones?: boolean;
  /**
   * `plannotator inbox --tailscale`: publish over the tailnet for this run
   * whatever PLANNOTATOR_INBOX_TAILSCALE / config.json `inboxTailscale` say
   * (packages/server/inbox-tailscale.ts). Default false.
   */
  publishTailnet?: boolean;
  /** Tests: how a project root's `origin` is read (default `readInboxProjectRepo`, inbox-repos.ts). */
  readProjectRepo?: (root: string) => Promise<InboxProjectRepo | null>;
  /**
   * How long after a Mark read the asking agents are told what it closed (the
   * window's Undo lasts 7 s). Default `INBOX_SET_ASIDE_DELAY_MS`. Tests shorten it.
   */
  setAsideDelayMs?: number;
  /**
   * Where the agents the Inbox connects itself to live (home, environment,
   * PATH, running their CLIs; inbox-agents.ts). Default: this process's.
   * Tests give temp folders and fake CLIs.
   */
  agentEnvironment?: AgentEnvironment;
}

/**
 * After a Mark read, the set-aside note waits out the window's 7 s Undo with
 * 3 s to spare (a slow click, a slow network), so an Undo never reaches an agent.
 */
export const INBOX_SET_ASIDE_DELAY_MS = 10_000;

/** Settings' Archived block: rows per page of `GET /api/inbox/threads/archived`, and the most one page may ask for. */
export const INBOX_ARCHIVED_PAGE = 50;
export const INBOX_ARCHIVED_PAGE_MAX = 200;

export interface InboxServer {
  port: number;
  url: string;
  token: string;
  serverSession: string;
  /** The last port could not be reused: notifications must be re-allowed once. */
  portChanged: boolean;
  store: InboxStore;
  registry: InboxRegistryEntry;
  /** "Over your tailnet": its state, the window's switch and the run's flag. */
  tailscale: InboxTailscale;
  /**
   * Connect the agents on this computer (inbox-agents.ts): what
   * `plannotator inbox` runs, here or over `/api/inbox/control/connect`. One
   * run at a time; a call while one runs gets that run's report.
   */
  connectAgents: () => Promise<InboxConnectReport>;
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
  // Replaced questions: answering one the agent superseded, or superseding
  // an id that names no open question of the thread.
  question_superseded: 422,
  invalid_supersedes: 422,
  // A pick on a question a Mark read closed: Move back first.
  question_set_aside: 409,
  thread_resolved: 409,
  idempotency_key_reused: 409,
  config_not_saved: 500,
  ...INBOX_DECISION_ERROR_STATUS,
  // Attachments and annotations (step 2).
  attachment_not_found: 404,
  attachment_missing: 404,
  attachment_changed_type: 409,
  attachment_not_text: 415,
  attachment_not_image: 415,
  attachment_too_large: 413,
  annotation_not_allowed: 422,
  annotation_not_found: 404,
  annotation_closed: 409,
  // A comment on a guided review's diff, on a message that carries none.
  guide_not_found: 404,
  // New message (step 8).
  session_not_live: 409,
  // Over your tailnet (packages/server/inbox-tailscale.ts).
  tailscale_env_decides: 409,
  tailscale_unavailable: 409,
  local_only: 403,
};

/**
 * The window is a single-file build: its script and styles are inline, so the
 * policy allows inline code from this page only and no other origin. Nothing
 * may frame it, and it may only talk to this server.
 */
const WINDOW_CSP = [
  "default-src 'self'",
  // 'wasm-unsafe-eval' lets the Graphviz engine (@viz-js/viz) compile its
  // WebAssembly; it does not allow eval() or new Function().
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
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

function startOnLoopback(fetch: Parameters<typeof Bun.serve>[0]["fetch"], preferred: number | null): { server: ReturnType<typeof Bun.serve>; portChanged: boolean } {
  const serve = (port: number) =>
    Bun.serve({ hostname: LOOPBACK, port, idleTimeout: 0, maxRequestBodySize: INBOX_MAX_REQUEST_BYTES, fetch } as Parameters<typeof Bun.serve>[0]);
  let portChanged = false;
  // Never remote mode's port, and never Phones' tailnet HTTPS port: the
  // window's tailnet mapping uses the Inbox's own port, so the two never meet.
  const forbidden = (port: number) => port === INBOX_FORBIDDEN_PORT || port === PHONES_TAILNET_HTTPS_PORT;
  if (preferred && !forbidden(preferred)) {
    try {
      return { server: serve(preferred), portChanged: false };
    } catch (error) {
      if (!isAddressInUseError(error)) throw error;
      portChanged = true;
    }
  }
  for (;;) {
    const server = serve(0);
    if (!forbidden(server.port as number)) return { server, portChanged };
    server.stop(true);
  }
}

/**
 * Whether an Inbox ran on this machine before this start, from evidence that
 * predates it (read before this start writes the version, the store or the
 * registry): the version an earlier Inbox recorded (0.28.12 and later), the
 * registry every Inbox writes, a project in the store, or a setting the Inbox
 * page wrote. Builds 0.28.7 to 0.28.11 recorded no version, so the version
 * alone would call their people fresh.
 */
export function inboxUsedBefore(dataDir: string): boolean {
  try {
    if (readUpdateState(dataDir).inboxVersion) return true;
  } catch {}
  if (existsSync(inboxRegistryPath(dataDir))) return true;
  try {
    if (readdirSync(join(dataDir, "inbox", "projects")).length > 0) return true;
  } catch {}
  const config = loadConfig();
  return config.inboxNotifications !== undefined || config.inboxTool !== undefined;
}

/** Start the Inbox server and write the registry. */
export async function startInboxServer(options: InboxServerOptions = {}): Promise<InboxServer> {
  const dataDir = options.dataDir ?? getPlannotatorDataDir();
  const version = options.version ?? "dev";
  // Read before the store, the update state and the registry are written below.
  const usedBefore = inboxUsedBefore(dataDir);
  let previousInboxVersion: string | null = null;
  try {
    previousInboxVersion = readUpdateState(dataDir).inboxVersion ?? null;
  } catch {}
  const store = InboxStore.open(dataDir);
  // A send a crash interrupted leaves a temp blob; the next start removes it once it is stale.
  sweepStaleInboxSendTemps(store.dir);
  const serverSession = createServerSessionNonce();
  // Mark read: the note to the asking agents goes once the Undo window has passed.
  const setAsideDelayMs = options.setAsideDelayMs ?? INBOX_SET_ASIDE_DELAY_MS;
  const setAsideTimers = new Set<ReturnType<typeof setTimeout>>();
  const tellSetAside = (threadId: string) => {
    try {
      store.tellSetAside(threadId, setAsideDelayMs);
    } catch (error) {
      process.stderr.write(`Inbox: the set-aside note for ${threadId} was not written: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };
  const scheduleSetAside = (threadId: string) => {
    const timer = setTimeout(() => {
      setAsideTimers.delete(timer);
      tellSetAside(threadId);
    }, setAsideDelayMs + 50);
    (timer as { unref?: () => void }).unref?.();
    setAsideTimers.add(timer);
  };
  const token = createInboxToken();
  // Read once per start: the phone surface stays hidden until the iPhone app ships.
  const phonesOn = options.phones ?? resolveInboxPhones(loadConfig());
  const hostGuard = createRequestHostGuard({ localOnly: true });
  const previous = readInboxRegistry(dataDir);
  let port = 0;
  let baseUrl = "";
  let portChanged = false;
  const statusListeners = new Set<() => void>();
  const binaryPath = options.binaryPath !== undefined ? options.binaryPath : version !== "dev" ? process.execPath : null;
  // The sidebar's Update button (packages/server/inbox-updates.ts): the daily
  // release check, the binary on disk, Update now, Remind me tomorrow.
  const updates = createInboxUpdates({
    dataDir,
    version,
    binaryPath,
    healthTickMs: options.healthTickMs ?? DEFAULT_HEALTH_TICK_MS,
    ...options.updates,
    onChange: () => {
      for (const listener of statusListeners) listener();
    },
  });

  // Each project's git `origin` (#1840), for the window's `#123` links:
  // resolved for every known project once the server listens (below) and
  // when a project is first seen, never while a request waits (inbox-repos.ts).
  const repos = createInboxRepoCache(options.readProjectRepo ? { read: options.readProjectRepo } : {});

  const projectLocks = new Map<string, Promise<InboxProject>>();
  const resolveProject = async (path: string): Promise<InboxProject> => {
    const { root, name } = await resolveInboxProjectRoot(path);
    const existing = store.projectByRoot(root);
    if (existing) return existing;
    void repos.refresh(root);
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
          recordInboxAttachments(store.dir, paths, { base, at: new Date().toISOString() }),
        // An open wait_for_reply keeps its session present (never "ended").
        presence: { seen: (session) => live.seenOverMcp(session), hold: (session) => live.holdOverMcp(session) },
      }),
    { legacy: "stateless", maxRequestBodySize: INBOX_MAX_REQUEST_BYTES },
  );

  const health = (): InboxHealth => ({ ok: true, app: INBOX_APP_ID, version, serverSession, pid: process.pid, update: updates.current() });

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
  const listModel = (projectFilter: string | null, archived: "include" | "exclude") => {
    // One pass over the store feeds both the folders' counts and the sections.
    const rows = store.listRows();
    const scoped = projectFilter ? rows.filter((row) => row.project.id === projectFilter) : rows;
    return {
      serverSession,
      version,
      cursor: store.cursor(),
      update: updates.current(),
      /** This Inbox started on a newer version than the last one: the sidebar's "What's new in X" link. */
      updated: updates.updated(),
      notice: portChanged ? "The Inbox moved to a new port: allow notifications again on this page." : null,
      projects: projectFolders(rows),
      project: projectFilter,
      // `?archived=exclude` (the window): archived threads leave every section,
      // Quiet included, and Settings lists them (GET /api/inbox/threads/archived).
      // Without it they stay in Quiet, as an older window and the phone expect.
      sections: inboxListSections(archived === "exclude" ? scoped.filter((row) => !inboxRowArchived(row)) : scoped),
      /** Questions in every project that record a decision once answered and sent: the sidebar's Decisions count. */
      decisions_waiting: waitingDecisionCount(store),
    };
  };

  const projectFilterOf = (url: URL): string | null => {
    const value = url.searchParams.get("project");
    if (value === null || value === "") return null;
    if (!isInboxId("prj", value)) throw new InboxError("validation_error", "project: a prj_ id.", { field: "project" });
    if (!store.project(value)) throw new InboxError("project_not_found", `No project ${value}.`);
    return value;
  };

  /** `?archived=include|exclude` on the list: where archived threads go. Default `include` (in Quiet). */
  const archivedModeOf = (url: URL): "include" | "exclude" => {
    const value = url.searchParams.get("archived");
    if (value === null || value === "" || value === "include") return "include";
    if (value === "exclude") return "exclude";
    throw new InboxError("validation_error", "archived: include or exclude.", { field: "archived" });
  };

  /** A whole number from a query parameter, within bounds; absent or empty is the default. */
  const queryCount = (url: URL, name: string, fallback: number, min: number, max: number): number => {
    const value = url.searchParams.get(name);
    if (value === null || value === "") return fallback;
    const n = /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      throw new InboxError("validation_error", `${name}: a whole number from ${min} to ${max}.`, { field: name });
    }
    return n;
  };

  /**
   * Settings' Archived block: the archived threads, newest archived first, a
   * page at a time (`offset`, `limit` up to 200), with every project that has
   * any and how many, for its project filter. `total` is the count in the
   * filtered scope, so the page says how many lie beyond it.
   */
  const archivedModel = (url: URL) => {
    const projectFilter = projectFilterOf(url);
    const offset = queryCount(url, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = queryCount(url, "limit", INBOX_ARCHIVED_PAGE, 1, INBOX_ARCHIVED_PAGE_MAX);
    const archived = inboxArchivedRows(store.listRows());
    const counts = new Map<string, { id: string; name: string; archived: number }>();
    for (const row of archived) {
      const entry = counts.get(row.project.id) ?? { id: row.project.id, name: row.project.name, archived: 0 };
      entry.archived += 1;
      counts.set(row.project.id, entry);
    }
    const scoped = projectFilter ? archived.filter((row) => row.project.id === projectFilter) : archived;
    return {
      serverSession,
      cursor: store.cursor(),
      project: projectFilter,
      projects: [...counts.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
      total: scoped.length,
      offset,
      limit,
      threads: scoped.slice(offset, offset + limit),
    };
  };

  const selfCommand = options.selfCommand?.length
    ? [...options.selfCommand]
    : version !== "dev"
      ? [process.execPath]
      : ["plannotator"];

  /** The agents on this computer (inbox-agents.ts): connected by `plannotator inbox`, one run at a time. */
  // A test that starts an Inbox without its own agent environment gets an empty scratch one
  // (no PATH, a home inside its data dir): nothing reads or runs the person's real agents.
  const agentEnvironment =
    options.agentEnvironment ??
    (process.env.PLANNOTATOR_TEST_SANDBOX
      ? createAgentEnvironmentFor({ platform: process.platform, homeDir: join(dataDir, "agents-home"), env: { HOME: join(dataDir, "agents-home"), PATH: "" } })
      : createAgentEnvironment());
  let connecting: Promise<InboxConnectReport> | null = null;
  const connectAgents = (): Promise<InboxConnectReport> => {
    connecting ??= connectInboxAgents({ dataDir, selfCommand, environment: agentEnvironment }).finally(() => {
      connecting = null;
    });
    return connecting;
  };
  /** What the window reads about the agents: the records (paths shown with ~), the last run's report, and whether a run is going. */
  const agentsModel = async () => {
    const file = readInboxAgents(dataDir);
    const records = Object.fromEntries(
      Object.entries(file.agents).map(([id, record]) => [id, { ...record, path: displayPath(record!.path, agentEnvironment) }]),
    );
    const config = loadConfig();
    const env = agentEnvironment.env as NodeJS.ProcessEnv;
    const toolEnv = parseInboxToolEnv(env);
    const notesOff = inboxNotesDisabled(agentEnvironment.env);
    const options = { dataDir, selfCommand, environment: agentEnvironment };
    const agents = await Promise.all(
      INBOX_AGENT_IDS.map(async (id) => {
        const detected = agentSpec(id).detect(agentEnvironment);
        const reach = await inboxAgentReach(id, options);
        const host = (INBOX_TOOL_HOSTS as readonly string[]).includes(id) ? (id as InboxToolHost) : null;
        // The Inbox tool switch of the three Plannotator hosts stays reachable whether or not the agent was found.
        const tool = host ? { on: resolveInboxTool(config, env, host), locked: toolEnv !== undefined } : null;
        const reminder = host ? { on: resolveInboxReminder(config, env, host), locked: toolEnv !== undefined, needs_tool: !resolveInboxTool(config, env, host) } : null;
        // With PLANNOTATOR_INBOX_NOTES=0 only a note already written is listed, so it can still be turned off.
        const status = (INBOX_NOTE_AGENT_IDS as readonly string[]).includes(id) ? noteStatus(id as InboxNoteAgentId, dataDir, agentEnvironment) : null;
        const note = status && (!notesOff || status.state === "added" || status.state === "edited") ? status : null;
        return { id, label: INBOX_AGENT_LABELS[id], detected, reach, tool, reminder, note };
      }),
    );
    return {
      agents,
      records,
      last_report: file.last_report ?? null,
      connecting: connecting !== null,
      connect_env_off: inboxConnectDisabled(agentEnvironment.env),
      notes_env_off: notesOff,
      tool_env: toolEnv ?? null,
      notes_offered: loadConfig().inboxAgentNotes?.offered === true,
      notes_asked: await notesAsked(options),
      note_text: INBOX_NOTE_BLOCK,
    };
  };

  /** Settings → Agents: one agent's switches (reach, reminder, note). Each applies to that agent's next session. */
  const saveAgent = async (body: Record<string, unknown>) => {
    const id = body.agent;
    if (typeof id !== "string" || !(INBOX_AGENT_IDS as readonly string[]).includes(id)) {
      throw new InboxError("validation_error", "agent: one of the agents the Inbox knows.", { field: "agent" });
    }
    const agent = id as InboxAgentId;
    for (const field of ["reach", "tool", "reminder", "note"] as const) {
      if (body[field] !== undefined && typeof body[field] !== "boolean") throw new InboxError("validation_error", `${field}: a boolean.`, { field });
    }
    if (body.reach === undefined && body.tool === undefined && body.reminder === undefined && body.note === undefined) {
      throw new InboxError("validation_error", "body: reach, tool, reminder or note is required.");
    }
    const problems: string[] = [];
    if (typeof body.reach === "boolean") {
      const problem = await setInboxAgentReach(agent, body.reach, { dataDir, selfCommand, environment: agentEnvironment });
      if (problem) problems.push(problem);
    }
    if (typeof body.tool === "boolean") {
      if (!(INBOX_TOOL_HOSTS as readonly string[]).includes(agent)) throw new InboxError("validation_error", "tool: only Claude Code, Pi and OpenCode have one.", { field: "tool" });
      const problem = setInboxTool(agent as InboxToolHost, body.tool, agentEnvironment);
      if (problem) problems.push(problem);
    }
    if (typeof body.reminder === "boolean") {
      if (!(INBOX_TOOL_HOSTS as readonly string[]).includes(agent)) throw new InboxError("validation_error", "reminder: only Claude Code, Pi and OpenCode have one.", { field: "reminder" });
      if (parseInboxToolEnv(agentEnvironment.env as NodeJS.ProcessEnv) !== undefined) problems.push("PLANNOTATOR_INBOX_TOOL decides this");
      else {
        const current = loadConfig().inboxReminder;
        const next: Partial<Record<InboxToolHost, boolean>> = {};
        for (const host of INBOX_TOOL_HOSTS) {
          const value = configuredInboxReminder({ inboxReminder: current }, host);
          if (value !== undefined) next[host] = value;
        }
        next[agent as InboxToolHost] = body.reminder;
        saveConfig({ inboxReminder: next });
        if (configuredInboxReminder(loadConfig(), agent as InboxToolHost) !== body.reminder) problems.push("Plannotator's config.json can't be written");
      }
    }
    if (typeof body.note === "boolean") {
      if (!(INBOX_NOTE_AGENT_IDS as readonly string[]).includes(agent)) throw new InboxError("validation_error", "note: this agent has no instructions file.", { field: "note" });
      if (inboxNotesDisabled(agentEnvironment.env) && body.note) throw new InboxError("notes_disabled", "PLANNOTATOR_INBOX_NOTES=0 is set: notes are off.");
      // Adding one needs the agent here, as the note dialog and --notes ask; switching one off never does.
      if (body.note && !agentSpec(agent).detect(agentEnvironment)) {
        problems.push(`${INBOX_AGENT_LABELS[agent]} was not found on this computer`);
      } else {
        const change = body.note ? addInboxNote(agent as InboxNoteAgentId, dataDir, agentEnvironment) : removeInboxNote(agent as InboxNoteAgentId, dataDir, agentEnvironment);
        if (!change.ok) problems.push(change.reason);
        // A yes in Settings answers the note dialog for this agent: removing the note later never asks again.
        else if (body.note) await markNotesAsked([agent as InboxNoteAgentId], { dataDir, selfCommand, environment: agentEnvironment });
      }
    }
    return { ...(await agentsModel()), error: problems.length ? problems.join("; ") : null };
  };

  /**
   * The note dialog's answer: add the notes the person ticked (none for Not
   * now or Don't add a note). `asked` names the agents the dialog showed:
   * each is asked once, except one whose add failed, which is asked again.
   * Without `asked` (an older window) the agents that can take a note now
   * count as asked. `seen`: the dialog's band showed the last run's news.
   */
  const answerNotes = async (body: Record<string, unknown>) => {
    const isNoteList = (value: unknown) => Array.isArray(value) && value.every((id) => typeof id === "string" && (INBOX_NOTE_AGENT_IDS as readonly string[]).includes(id));
    const add = body.add;
    if (!isNoteList(add)) {
      throw new InboxError("validation_error", "add: a list of agents (claude-code, codex, gemini, pi, opencode).", { field: "add" });
    }
    if (body.asked !== undefined && !isNoteList(body.asked)) {
      throw new InboxError("validation_error", "asked: a list of agents (claude-code, codex, gemini, pi, opencode).", { field: "asked" });
    }
    if (body.seen !== undefined && typeof body.seen !== "boolean") throw new InboxError("validation_error", "seen: a boolean.", { field: "seen" });
    const adding = [...new Set(add as InboxNoteAgentId[])];
    if (inboxNotesDisabled(agentEnvironment.env) && adding.length > 0) throw new InboxError("notes_disabled", "PLANNOTATOR_INBOX_NOTES=0 is set: notes are off.");
    const options = { dataDir, selfCommand, environment: agentEnvironment };
    // Read before adding: an agent whose note is added is no longer a candidate.
    const shown = (body.asked as InboxNoteAgentId[] | undefined) ?? (await noteCandidateIds(options));
    const results = adding.map((agent) =>
      // Never a file for an agent that is not on this computer.
      agentSpec(agent).detect(agentEnvironment)
        ? addInboxNote(agent, dataDir, agentEnvironment)
        : ({ ok: false, agent, reason: `${INBOX_AGENT_LABELS[agent]} was not found on this computer`, path: null } as const),
    );
    const failed = new Set(results.filter((result) => !result.ok).map((result) => result.agent));
    await markNotesAsked([...new Set([...shown, ...adding])].filter((id) => !failed.has(id)), options);
    if (body.seen === true) {
      const file = readInboxAgents(dataDir);
      if (file.last_report && !file.last_report.seen) writeInboxAgents(dataDir, { ...file, last_report: { ...file.last_report, seen: true } });
    }
    return { results, ...(await agentsModel()) };
  };

  /** The agent tool knob per host: the effective value, and whether the env var decides it. */
  const inboxToolState = () => {
    const config = loadConfig();
    const env = parseInboxToolEnv();
    const hosts = Object.fromEntries(INBOX_TOOL_HOSTS.map((host) => [host, resolveInboxTool(config, process.env, host)])) as Record<InboxToolHost, boolean>;
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

  /** Save the fields named, keeping the others as they are. `validateOnly`: check the input and write nothing. */
  const saveNotifications = (input: unknown, validateOnly = false) => {
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
    if (validateOnly) return notificationsState();
    saveConfig({ inboxNotifications: next });
    if (JSON.stringify(loadConfig().inboxNotifications) !== JSON.stringify(next)) {
      throw new InboxError("config_not_saved", "config.json could not be written; nothing changed.");
    }
    return notificationsState();
  };

  /**
   * The question sound (the "Ding-dong"), resolved from config.json: on, at
   * 60, unless set. `dialog_shown_for`: the version the one-time dialog was
   * shown for, or that a fresh install was marked with; null while it never
   * was. `dialog_due`: the dialog waits for a page on this computer to claim it.
   */
  const soundState = () => {
    const value = loadConfig().inboxSound;
    const saved = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const shownFor = typeof saved.dialogShownFor === "string" && saved.dialogShownFor !== "" ? saved.dialogShownFor : null;
    return {
      enabled: saved.enabled !== false,
      volume: isInboxSoundVolume(saved.volume) ? saved.volume : INBOX_SOUND_DEFAULT_VOLUME,
      dialog_shown_for: shownFor,
      dialog_due: shownFor === null && typeof saved.dialogDueFor === "string" && saved.dialogDueFor !== "",
    };
  };

  /** The sound's config entry as it is on disk, to merge a change into. */
  const savedSound = (): NonNullable<PlannotatorConfig["inboxSound"]> => {
    const current = loadConfig().inboxSound;
    return current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
  };

  /** Save `enabled` / `volume`, keeping the rest. `validateOnly`: check the input and write nothing. */
  const saveSound = (input: unknown, validateOnly = false) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new InboxError("validation_error", "sound: an object.", { field: "sound" });
    }
    const next = savedSound();
    for (const [field, value] of Object.entries(input as Record<string, unknown>)) {
      switch (field) {
        case "enabled":
          if (typeof value !== "boolean") throw new InboxError("validation_error", "sound.enabled: must be a boolean.", { field: "sound.enabled" });
          next.enabled = value;
          break;
        case "volume":
          if (!isInboxSoundVolume(value)) {
            throw new InboxError("validation_error", "sound.volume: a whole number from 10 to 100.", { field: "sound.volume" });
          }
          next.volume = value;
          break;
        default:
          // The dialog's marks are the server's to write (below), never the page's.
          throw new InboxError("validation_error", `sound.${field}: not a setting (enabled, volume).`, { field: `sound.${field}` });
      }
    }
    if (validateOnly) return soundState();
    saveConfig({ inboxSound: next });
    if (JSON.stringify(loadConfig().inboxSound) !== JSON.stringify(next)) {
      throw new InboxError("config_not_saved", "config.json could not be written; nothing changed.");
    }
    return soundState();
  };

  /**
   * Plannotator's appearance (config.json `theme`, the same value plan
   * review, code review and annotate read and write through POST
   * /api/config): the mode and the palette for each half. The Inbox's
   * light/dark toggle and its Settings row write it here, so a choice made in
   * the Inbox holds in the next plan review too, and one made there holds
   * here. null: never chosen (the cookies, else the OS, decide).
   */
  const themeState = (): ThemeConfig | null => {
    const theme = loadConfig().theme;
    return theme && typeof theme === "object" ? theme : null;
  };

  const saveTheme = (input: unknown, validateOnly = false) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new InboxError("validation_error", "theme: { mode?, light?, dark? }.", { field: "theme" });
    }
    const next: ThemeConfig = {};
    for (const [field, value] of Object.entries(input as Record<string, unknown>)) {
      switch (field) {
        case "mode":
          if (value !== "light" && value !== "dark" && value !== "system") {
            throw new InboxError("validation_error", "theme.mode: light, dark or system.", { field: "theme.mode" });
          }
          next.mode = value;
          break;
        case "light":
        case "dark":
          // A palette id (packages/ui/themes); the page resolves an unknown one to its default.
          if (typeof value !== "string" || !THEME_ID.test(value)) {
            throw new InboxError("validation_error", `theme.${field}: a palette id.`, { field: `theme.${field}` });
          }
          next[field] = value;
          break;
        default:
          throw new InboxError("validation_error", `theme.${field}: not a setting (mode, light, dark).`, { field: `theme.${field}` });
      }
    }
    if (Object.keys(next).length === 0) throw new InboxError("validation_error", "theme: mode, light or dark is required.", { field: "theme" });
    if (validateOnly) return themeState();
    saveConfig({ theme: next });
    const saved = themeState();
    if (!saved || Object.entries(next).some(([key, value]) => saved[key as keyof ThemeConfig] !== value)) {
      throw new InboxError("config_not_saved", "config.json could not be written; nothing changed.");
    }
    return saved;
  };

  /**
   * The one-time sound dialog, claimed by the page that will show it: a
   * compare-and-set from `dialogDueFor` to `dialogShownFor`, so of several
   * tabs (or a reload) only the first ever gets `show: true`. Only on this
   * computer: a page that came through the tailnet (a phone, most likely)
   * never shows it and leaves it for the next page opened here. The server is
   * one process and this runs with no await, so two claims cannot interleave.
   */
  const claimSoundDialog = (via: RequestVia): boolean => {
    if (via !== "local" || !soundState().dialog_due) return false;
    const { dialogDueFor, ...rest } = savedSound();
    saveConfig({ inboxSound: { ...rest, dialogShownFor: dialogDueFor } });
    // Not written (a read-only data dir): showing it anyway would show it on every load.
    return loadConfig().inboxSound?.dialogShownFor === dialogDueFor;
  };

  // Release builds decide the dialog at start, from what was here before:
  // - a fresh install (no Inbox ran here) never sees it: it is marked shown,
  //   and the notification ask line says the sound is on;
  // - someone who used an earlier Inbox, on this version for the first time
  //   (or after a build that recorded no version), gets it due, kept in
  //   config.json until a page on this computer claims it, so a start that
  //   ends before any window opens (a --background start) does not lose it.
  if (normalizeStableVersion(version) !== null) {
    const sound = soundState();
    if (sound.dialog_shown_for === null && !sound.dialog_due) {
      if (!usedBefore) saveConfig({ inboxSound: { ...savedSound(), dialogShownFor: version } });
      else if (previousInboxVersion !== version) saveConfig({ inboxSound: { ...savedSound(), dialogDueFor: version } });
    }
  }

  /** The two update switches (PLANNOTATOR_UPDATE_CHECK, PLANNOTATOR_AUTO_UPDATE): the effective value and whether the env decides. */
  const updatesState = () => {
    const config = loadConfig();
    return {
      update_check: { on: resolveUpdateCheck(config), env: parseUpdateCheckEnv() ?? null },
      auto_update: { on: resolveAutoUpdate(config), env: parseAutoUpdateEnv() ?? null },
    };
  };

  /** Save `update_check` / `auto_update` (booleans) into config.json. `validateOnly`: check and write nothing. */
  const saveUpdateSwitches = (body: Record<string, unknown>, validateOnly = false) => {
    const toSave: { updateCheck?: boolean; autoUpdate?: boolean } = {};
    for (const [field, key] of [["update_check", "updateCheck"], ["auto_update", "autoUpdate"]] as const) {
      if (body[field] === undefined) continue;
      if (typeof body[field] !== "boolean") throw new InboxError("validation_error", `${field}: must be a boolean.`, { field });
      toSave[key] = body[field] as boolean;
    }
    if (validateOnly || Object.keys(toSave).length === 0) return updatesState();
    saveConfig(toSave);
    const saved = loadConfig();
    if ((toSave.updateCheck !== undefined && saved.updateCheck !== toSave.updateCheck) || (toSave.autoUpdate !== undefined && saved.autoUpdate !== toSave.autoUpdate)) {
      throw new InboxError("config_not_saved", "config.json could not be written; nothing changed.");
    }
    return updatesState();
  };

  /** What Settings and the connect snippets read. */
  const settingsModel = (via: RequestVia) => ({
    serverSession,
    /** Over your tailnet: the switch, the address or why not, and who may open it. */
    tailscale: tailscale.state(),
    /** Whether this page reached the Inbox through the tailnet (the switch cannot be turned on from there). */
    via,
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
    /** The question sound: the Settings row, and whether the one-time dialog was shown. */
    sound: soundState(),
    /** Settings → About: update notices and automatic updates. */
    updates: updatesState(),
    /** Plannotator's appearance (config.json `theme`), shared with plan review; null when never chosen. */
    theme: themeState(),
    store: store.diskUsage(),
    /** Whether this Inbox serves phones; the window shows the Phones block only then. */
    phones: phonesOn,
  });

  /** Save the knob for the hosts named, keeping the others as they are. `validateOnly`: check the input and write nothing. */
  const saveInboxTool = (input: unknown, validateOnly = false) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new InboxError("validation_error", "inbox_tool: an object of host to boolean.", { field: "inbox_tool" });
    }
    const config = loadConfig();
    const next: Partial<Record<InboxToolHost, boolean>> = {};
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
      next[host as InboxToolHost] = value;
    }
    if (validateOnly) return inboxToolState();
    saveConfig({ inboxTool: next });
    const saved = loadConfig();
    for (const [host, value] of Object.entries(next)) {
      if (configuredInboxTool(saved, host as InboxToolHost) !== value) {
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
      case "question":
        // The store's one question state: a question an agent asked after the archive line is live (notifications, the sound).
        return { seq: line.seq, kind: line.kind, id: line.id, question: store.questionWire(line.record) };
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
        const onStatus = () => send(`event: status\ndata: ${JSON.stringify({ update: updates.current() })}\n\n`);
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
  const replyCommand = (reply: InboxMessage): InboxReplyCommand => {
    // A reply the person sent to another session because the one that asked
    // had ended: the wake says so, naming the agent that asked.
    const asked = reply.to && reply.reply_to ? store.message(reply.reply_to) : null;
    // Named from the host (`Claude Code`), never from the name the agent gave
    // itself: this line goes into another session's prompt.
    const redirected =
      asked && asked.author.kind === "agent" && asked.author.session !== reply.to!.session
        ? asked.author.host
          ? inboxAgentName({ kind: "agent", host: asked.author.host, name: null })
          : "agent"
        : null;
    return {
      type: reply.to && !reply.reply_to ? "message" : "reply",
      id: reply.id,
      thread_id: reply.thread_id,
      reply_to: reply.reply_to,
      subject: store.threadSubject(reply.thread_id),
      body: reply.body,
      url: threadPageUrl(baseUrl, reply.thread_id),
      ...(redirected ? { redirected_from: redirected } : {}),
    };
  };

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
    // Step 8: a polling session is live (New message can reach it) while its poll is held.
    const answered = await live.pollStarted(session, bridgeHost(body), body);
    const commands = () => store.pendingReplies(session).map(replyCommand);
    const now = commands();
    if (now.length > 0 || waitMs === 0) {
      answered();
      return json({ commands: now });
    }
    return new Promise<Response>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        req.signal.removeEventListener("abort", finish);
        answered();
        resolve(json({ commands: commands() }));
      };
      const timer = setTimeout(finish, waitMs);
      const unsubscribe = store.subscribe((line) => {
        if (line.kind === "message" && line.record.author.kind === "person" && store.pendingReplies(session).length > 0) finish();
      });
      req.signal.addEventListener("abort", finish);
    });
  };

  const bridgeHost = (body: Record<string, unknown>): string => (typeof body.host === "string" && body.host.trim() ? body.host.trim() : "agent");

  /**
   * `{ session, host, type: "delivered", id }`: the reply or message entered
   * the session as a turn. `{ session, host, type: "state", busy }` (step 8):
   * a turn started or ended, for the live sessions New message lists.
   */
  const bridgeEvent = async (req: Request): Promise<Response> => {
    const body = await readBody(req);
    const session = bridgeSession(body);
    const host = bridgeHost(body);
    if (body.type === "state") {
      live.stateChanged(session, host, body);
      return json({ ok: true });
    }
    if (body.type !== "delivered" || typeof body.id !== "string") {
      throw new InboxError("validation_error", 'type: "delivered" with the reply id, or "state" with busy.', { field: "type" });
    }
    const reply = store.recordDelivery(body.id, { host, session });
    return json({ ok: true, delivery: reply.delivery });
  };

  /** The agent sessions a `/mcp` POST's tool calls name (a batch included), as MCP presence. */
  const noteMcpPresence = async (req: Request): Promise<void> => {
    try {
      const body = (await req.json()) as unknown;
      for (const call of Array.isArray(body) ? body : [body]) {
        const args = (call as { method?: unknown; params?: { arguments?: { agent_session?: unknown } } } | null)?.params?.arguments;
        if ((call as { method?: unknown } | null)?.method !== "tools/call" || typeof args?.agent_session !== "string") continue;
        live.seenOverMcp(args.agent_session.trim());
      }
    } catch {
      // Not JSON: the MCP handler answers it.
    }
  };

  // ── New message (step 8): the live sessions and the window's two routes (packages/server/inbox-sessions.ts) ──
  const live = createInboxLiveSessions({
    store,
    serverSession,
    resolveRoot: async (path) => (await resolveInboxProjectRoot(path)).root,
  });

  let stopRequested = false;
  let server: ReturnType<typeof Bun.serve>;
  let attachmentRoutes: ReturnType<typeof createInboxAttachmentRoutes>;
  // Null while phones are off (the default): no door, no window routes, no listeners, no relay.
  let phones: ReturnType<typeof createInboxDevices> | null = null;
  let relay: ReturnType<typeof createInboxRelay> | null = null;
  // Over your tailnet (packages/server/inbox-tailscale.ts), made once the port is known.
  let tailscale: InboxTailscale;

  const readBody = async (req: Request): Promise<Record<string, unknown>> => {
    try {
      const value = await req.json();
      return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    } catch {
      throw new InboxError("validation_error", "body: expected a JSON object.");
    }
  };

  /** A route the tailnet never reaches: it would hand a tailnet peer this machine's agent surface, or widen the Inbox's exposure. */
  const localOnly = () =>
    json({ error: "This answers only on this computer, not over the tailnet.", code: "local_only" }, 403);

  const handle = async (req: Request, via: RequestVia): Promise<Response> => {
    // The tailnet listener checked its own Host (the served MagicDNS name)
    // and the owner's Tailscale login before handing the request here.
    if (via === "local") {
      const refused = hostGuard.check(req);
      if (refused) return refused;
    }
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

    // Phones (packages/server/inbox-devices.ts): the device door. The tailnet
    // reaches the door only, through its own listener, never this port.
    // Off, the door's paths fall through to the unknown-route 404 below.
    if (path === "/api/inbox/device" || path.startsWith(DOOR_PREFIX)) {
      if (via === "tailnet") return localOnly();
      if (phones) return phones.door(req, url);
    }

    if (path === "/mcp") {
      // MCP has no token: only agents on this computer, never the tailnet,
      // and never a non-loopback Host (PLANNOTATOR_ALLOWED_HOSTS cannot widen it).
      if (via === "tailnet") return localOnly();
      const host = req.headers.get("host");
      if (host !== null && !isLoopbackHostHeader(host, port)) {
        return json({ error: "/mcp answers only this machine.", code: "forbidden_host" }, 403);
      }
      if (origin !== null) {
        return json({ error: "Browser requests are not accepted on /mcp.", code: "origin_not_allowed" }, 403);
      }
      // A tool call naming an agent_session is presence: that session is
      // not "ended" while it talks to the Inbox, connection or not.
      if (req.method === "POST") void noteMcpPresence(req.clone());
      return mcp.fetch(req);
    }

    if (path.startsWith("/api/inbox/control/") || path.startsWith("/api/inbox/bridge/")) {
      // A tailnet peer can claim a loopback Host (serve passes it through, and
      // the tailnet HTTPS port is this port), so the listener decides.
      if (via === "tailnet") return localOnly();
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
      // `plannotator inbox --tailscale` while this Inbox runs: publish for this run.
      if (path === "/api/inbox/control/tailscale") {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        return json({ tailscale: tailscale.enableForRun() });
      }
      // `plannotator inbox` while this Inbox runs (an agent started it with
      // --background): connect the agents on this computer, as a start does.
      if (path === "/api/inbox/control/connect") {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        return json({ connect: await connectAgents() });
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

    // Through the tailnet every method but a read is state-changing.
    const writes = via === "tailnet" ? req.method !== "GET" && req.method !== "HEAD" : req.method === "POST";
    if (writes && path.startsWith("/api/")) {
      if (!isSameOriginOrNoOrigin(origin, req.headers.get("host") ?? "", req.headers.get("sec-fetch-site"))) {
        return json({ error: "Cross-origin requests are not accepted.", code: "cross_origin" }, 403);
      }
    }
    // The tailnet never widens the Inbox's exposure: pairing a phone and
    // Phones' tailnet and Wi-Fi switches answer only on this computer (the
    // window's own switch refuses `on` below).
    if (via === "tailnet" && req.method === "POST" && (path === "/api/inbox/pairing" || path === "/api/inbox/tailnet" || path === "/api/inbox/lan")) {
      return localOnly();
    }
    // What reached the pairing code, and step 1's checks of this computer, are this computer's own business too.
    if (via === "tailnet" && (path === "/api/inbox/pairing" || path === "/api/inbox/pairing/checks")) return localOnly();

    try {
      if (path === "/api/inbox/health" && req.method === "GET") return json(health());
      if (path === "/api/inbox/threads" && req.method === "GET") return json(listModel(projectFilterOf(url), archivedModeOf(url)));
      if (path === "/api/inbox/threads/archived" && req.method === "GET") return json(archivedModel(url));
      if (path === "/api/inbox/projects" && req.method === "GET") return json({ serverSession, cursor: store.cursor(), projects: projectFolders() });
      if (path === "/api/inbox/events" && req.method === "GET") return eventStream(req, url);
      if (path === "/api/inbox/restart") {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
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
      // The update control (packages/server/inbox-updates.ts). Updating changes
      // this computer, so none of it answers a page that came through the tailnet.
      if (path === "/api/inbox/update" || path.startsWith("/api/inbox/update/") || path === "/api/inbox/whats-new") {
        if (via === "tailnet") return localOnly();
        if (path === "/api/inbox/whats-new") {
          if (req.method !== "GET") return json({ error: "Use GET." }, 405);
          const notes = updates.whatsNew(url.searchParams.get("version") ?? "");
          return notes ? json(notes) : json({ error: "No release notes for that version.", code: "notes_not_found" }, 404);
        }
        if (path === "/api/inbox/update" && req.method === "GET") return json(updates.details());
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        if (path === "/api/inbox/update") {
          const result = updates.updateNow();
          if (result.outcome === "launched") return json({ ok: true, version: result.version, update: updates.current() });
          const refused: Record<string, string> = {
            locked: "An update is already running.",
            unmanaged: "This copy of Plannotator was not installed by the install script, so it can't update itself.",
            "dev-build": "This is a development build; there is nothing to update.",
            "no-release": "No newer release is known yet.",
            "up-to-date": "Plannotator is up to date.",
            "launch-failed": "The install script could not be started; see update.log.",
          };
          return json({ error: refused[result.outcome] ?? "The update could not start.", code: `update_${result.outcome.replace(/-/g, "_")}`, update: updates.current() }, 409);
        }
        if (path === "/api/inbox/update/snooze") {
          return updates.snooze() ? json({ ok: true, update: updates.current() }) : json({ error: "No update to put off.", code: "update_not_available" }, 409);
        }
        if (path === "/api/inbox/update/check") {
          const checked = await updates.checkNow();
          return json({ ...updates.details(), checked });
        }
        return json({ error: "Not found", code: "not_found" }, 404);
      }
      // The agents on this computer: paths in the person's home, so only on this computer.
      if (path === "/api/inbox/agents" || path.startsWith("/api/inbox/agents/")) {
        // The person's own agent files: only on this computer.
        if (via === "tailnet") return localOnly();
        if (path === "/api/inbox/agents" && req.method === "GET") return json(await agentsModel());
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        if (path === "/api/inbox/agents") return json(await saveAgent(body));
        if (path === "/api/inbox/agents/notes") return json(await answerNotes(body));
        if (path === "/api/inbox/agents/seen") {
          const file = readInboxAgents(dataDir);
          if (file.last_report && !file.last_report.seen) writeInboxAgents(dataDir, { ...file, last_report: { ...file.last_report, seen: true } });
          return json(await agentsModel());
        }
        return json({ error: "Not found", code: "not_found" }, 404);
      }
      if (path === "/api/inbox/settings") {
        if (req.method === "GET") return json(settingsModel(via));
        if (req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        const updateSwitches = body.update_check !== undefined || body.auto_update !== undefined;
        if (body.inbox_tool === undefined && body.notifications === undefined && body.sound === undefined && body.tailscale === undefined && body.theme === undefined && !updateSwitches) {
          throw new InboxError("validation_error", "body: inbox_tool, notifications, sound, tailscale, theme, update_check or auto_update is required.");
        }
        // Updating changes this computer: never from a page that came through the tailnet.
        if (updateSwitches && via === "tailnet") return localOnly();
        let tailscaleChange: { on: boolean; replaceExposed: boolean } | undefined;
        if (body.tailscale !== undefined) {
          const value = body.tailscale as { on?: unknown; replace_exposed?: unknown } | null;
          if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            typeof value.on !== "boolean" ||
            (value.replace_exposed !== undefined && typeof value.replace_exposed !== "boolean") ||
            Object.keys(value).some((key) => key !== "on" && key !== "replace_exposed")
          ) {
            throw new InboxError("validation_error", "tailscale: { on: boolean, replace_exposed?: boolean }.", { field: "tailscale" });
          }
          // Turning tailnet publishing on is a decision made on this computer.
          if (value.on && via === "tailnet") return localOnly();
          tailscaleChange = { on: value.on, replaceExposed: value.replace_exposed === true };
        }
        // Every part is checked before anything is written, and the tailnet
        // change (the one that can be refused: the env var, Tailscale itself)
        // goes first, so a refusal never leaves the others half saved.
        if (body.notifications !== undefined) saveNotifications(body.notifications, true);
        if (body.sound !== undefined) saveSound(body.sound, true);
        if (body.inbox_tool !== undefined) saveInboxTool(body.inbox_tool, true);
        if (updateSwitches) saveUpdateSwitches(body, true);
        if (body.theme !== undefined) saveTheme(body.theme, true);
        const tailnet = tailscaleChange === undefined ? tailscale.state() : tailscale.set(tailscaleChange.on, { via, replaceExposed: tailscaleChange.replaceExposed });
        const notifications = body.notifications === undefined ? notificationsState() : saveNotifications(body.notifications);
        const sound = body.sound === undefined ? soundState() : saveSound(body.sound);
        const inboxTool = body.inbox_tool === undefined ? inboxToolState() : saveInboxTool(body.inbox_tool);
        const updateState = updateSwitches ? saveUpdateSwitches(body) : updatesState();
        if (updateSwitches) updates.refresh();
        const theme = body.theme === undefined ? themeState() : saveTheme(body.theme);
        return json({ inbox_tool: inboxTool, notifications, sound, tailscale: tailnet, updates: updateState, theme });
      }
      // The one-time sound dialog: the page asks to show it, and only the first ask ever gets `show: true`.
      if (path === "/api/inbox/sound/dialog") {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        const show = claimSoundDialog(via);
        return json({ show, sound: soundState() });
      }

      const threadMatch = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)$/.exec(path);
      if (threadMatch && req.method === "GET") {
        // The window's thread: each message's seq (what is new since the last look) and a reply's sent annotations.
        const thread = store.windowThread(threadMatch[1]!);
        if (!thread) return json({ error: "No such thread.", code: "thread_not_found" }, 404);
        const decisionIds = thread.messages.flatMap((m) => (m.questions ?? []).map((q) => q.decision_id));
        const withRepo = { ...thread, project: { ...thread.project, repo: repos.get(thread.project.root) } };
        // `row` (additive): the thread's list row, also for an archived thread, which the window's list leaves out.
        return json({ serverSession, cursor: store.cursor(), thread: withRepo, decisions: threadDecisions(store, decisionIds), row: store.listRow(thread.thread_id) });
      }

      const seenMatch = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/seen$/.exec(path);
      if (seenMatch) {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        // `through_seq` (optional): the seq of the newest message the window showed; the look stops there.
        const through = body.through_seq;
        if (through !== undefined && through !== null && !(typeof through === "number" && Number.isSafeInteger(through) && through >= 0)) {
          throw new InboxError("validation_error", "through_seq: a message seq (a whole number, 0 or more).", { field: "through_seq" });
        }
        return json({ thread: store.markSeen(seenMatch[1]!, typeof through === "number" ? through : undefined) });
      }

      // Mark read and its Undo: the thread leaves the top for Quiet, its waiting questions closed (store.markRead).
      const readMatch = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/(read|unread)$/.exec(path);
      if (readMatch) {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        const read = readMatch[2] === "read";
        const row = store.markRead(readMatch[1]!, read);
        if (read) scheduleSetAside(readMatch[1]!);
        return json({ thread: row });
      }

      // Guided reviews (step 5): the snapshot a message carries (packages/server/inbox-guides.ts).
      const guide = await inboxGuideRoute(req, path, store, serverSession);
      if (guide) return guide;

      const messageMatch = /^\/api\/inbox\/messages\/([A-Za-z0-9_]+)\/(picks|reply|resolve)$/.exec(path);
      if (messageMatch) {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        const messageId = messageMatch[1]!;
        switch (messageMatch[2]) {
          case "picks": {
            const questions = store.savePicks(messageId, body.questions as never);
            return json({ message_id: messageId, questions, reply: null });
          }
          case "reply": {
            // The session that asked has ended and the person picked another
            // live session to take the reply: checked here as New message
            // checks its session (null: not live, 409 and nothing written).
            // An unknown message is the store's 404, never "not live".
            const asked = body.to === undefined ? undefined : store.message(messageId);
            const to = body.to === undefined || !asked ? undefined : live.replyTarget(asked.thread_id, body.to);
            let result: ReturnType<typeof store.sendReply>;
            try {
              result = store.sendReply(messageId, {
                ...(to === undefined ? {} : { to }),
                words: typeof body.words === "string" ? body.words : undefined,
                questions: (body.questions as never) ?? [],
                idempotency_key: body.idempotency_key as string,
                feedback: typeof body.feedback === "string" ? body.feedback : undefined,
                annotation_ids: body.annotation_ids as never,
                skip_unanswered: body.skip_unanswered === true,
              });
            } catch (error) {
              // A skip-only target whose questions closed meanwhile: a no-op, so
              // the rest of a multi-message Send still goes.
              if (error instanceof InboxError && error.code === "nothing_to_send") {
                return json({ message_id: messageId, questions: store.questionsOf(messageId), reply: null, replayed: false, nothing_to_send: true, decisions: [], decisions_refused: [] });
              }
              throw error;
            }
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
            // Unarchived: a Mark read's set-aside note an archive held back is due again.
            if (body.resolved === false) scheduleSetAside(thread.thread_id);
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
        staleTab: (body) => (checkServerSession(body, serverSession) === "mismatch" ? json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409) : null),
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

      // Step 8: the live sessions of a thread's project, and New message.
      const newMessage = await live.route(req, path);
      if (newMessage) return newMessage;

      // #1813: an image a message's body shows, read from its project
      // (packages/server/inbox-message-images.ts).
      const image = inboxMessageImageRoute(req, url, store);
      if (image) return image;

      // Step 2: attachments by id, annotations, the HTML asset route, delete
      // thread and delete project (packages/server/inbox-attachments.ts).
      const attached = await attachmentRoutes(req, url);
      if (attached) return attached;

      // Phones: pairing, the device list and revoke, the tailnet and Wi-Fi switches.
      const phoneRoute = phones ? await phones.windowRoute(req, url) : null;
      if (phoneRoute) return phoneRoute;

      if (path.startsWith("/api/")) return json({ error: "Not found", code: "not_found" }, 404);
      return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" } });
    } catch (error) {
      return errorResponse(error);
    }
  };

  /**
   * The window's own port: everything here came from this computer. A
   * request carrying what `tailscale serve` always adds (and a local client
   * never sends) came through a serve mapping pointed straight at this port,
   * such as a hand-made `tailscale serve --https=<port> http://127.0.0.1:<port>`.
   * Such a mapping hands the tailnet the whole Inbox, `/mcp` included (serve
   * passes a peer's own Host through), so the request is refused and Settings
   * offers the owner-only address instead.
   */
  const fetch = (req: Request): Promise<Response> => {
    if (SERVE_HEADERS.some((name) => req.headers.has(name))) {
      tailscale.noteServedRequest();
      return Promise.resolve(localOnly());
    }
    return handle(req, "local");
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
    ...(previous?.tailnet ? { tailnet: previous.tailnet } : {}),
    ...(previous?.lan ? { lan: previous.lan } : {}),
    // The mapping the last run made (its ports), so this start re-points or takes down its own.
    ...(previous?.tailscale ? { tailscale: previous.tailscale } : {}),
  };
  writeInboxRegistry(dataDir, registry);
  tailscale = createInboxTailscale({
    dataDir,
    port: () => port,
    registry: () => registry,
    dispatch: (req) => handle(req, "tailnet"),
    tailscale: options.tailscale,
    flag: options.publishTailnet === true,
    maxRequestBodySize: INBOX_MAX_REQUEST_BYTES,
    // A terminal closing a foreground Inbox while published: the clean stop (both tailnet mappings), then exit.
    onHangup: () => {
      stop();
      process.exit(129);
    },
  });
  tailscale.start();
  if (phonesOn) {
    const devices = createInboxDevices({
      dataDir,
      serverSession,
      port: () => port,
      registry: () => registry,
      readBody,
      dispatch: fetch,
      now: options.now,
      tailscale: options.tailscale,
      probes: options.pairingProbes,
      relay: { paired: async (device) => (relay ? relay.paired(device) : null), revoked: (device) => relay?.revoked(device) },
    });
    phones = devices;
    // The relay (packages/server/inbox-relay.ts): the mailbox socket while a phone is paired, the pushes, and the
    // carriage: store lines down as the event stream writes them, commands up through the door in-process.
    relay = createInboxRelay({ dataDir, store, devices: devices.devices, payload: eventPayload, apply: devices.asDevice });
    relay.start();
    devices.startTailnet();
    devices.startLan();
  }

  updates.start();
  // An Inbox whose data folder was removed (a test's temp dir, an uninstall
  // that could not reach it, a person deleting ~/.plannotator/inbox) is found
  // by no agent and keeps no store; it must not run on headless for days.
  // Two misses in a row; an unknown answer leaves the count as it is. A
  // timer: it cannot end an Inbox stuck in a synchronous loop, only one
  // whose event loop still turns.
  let dataMisses = 0;
  const dataCheck = setInterval(() => {
    if (stopped) return;
    const probe = probeInboxData(dataDir, serverSession);
    if (probe.state === "unknown") return;
    dataMisses = probe.state === "gone" ? dataMisses + 1 : 0;
    if (probe.state !== "gone" || dataMisses < 2) return;
    // Stop first: a write to a stderr that is gone must not keep it running.
    stop();
    try {
      process.stderr.write(`Plannotator Inbox: ${probe.reason}; stopped.\n`);
      if (tailnetStopFailedPort !== null) {
        process.stderr.write(`The tailnet address could not be taken down; run "tailscale serve --https=${tailnetStopFailedPort} off".\n`);
      }
    } catch {
      // Nowhere to say it.
    }
    options.onDataGone?.(probe.reason);
  }, options.dataCheckMs ?? INBOX_DATA_CHECK_MS);
  (dataCheck as { unref?: () => void }).unref?.();
  // Every known project's `origin`, after the server is listening; the cache
  // runs at most a few gits at once and queues the rest.
  setTimeout(() => {
    if (stopped) return;
    for (const project of store.listProjects()) void repos.refresh(project.root);
    // A set-aside note a stop interrupted (marked read, then the Inbox went away within the Undo window).
    for (const threadId of store.setAsideDue(setAsideDelayMs)) tellSetAside(threadId);
    for (const threadId of store.setAsideDue(0)) scheduleSetAside(threadId);
  }, 0);

  let stopped = false;
  /** The tailnet port whose take-down failed at the stop, for the data-gone message. */
  let tailnetStopFailedPort: number | null = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(dataCheck);
    for (const timer of setAsideTimers) clearTimeout(timer);
    setAsideTimers.clear();
    updates.stop();
    void mcp.close().catch(() => {});
    server.stop(true);
    // The tailnet mapping and the door listener, the Wi-Fi listener and its
    // Bonjour record, before a restart starts the new run.
    phones?.stopTailnet();
    phones?.stopLan();
    relay?.stop();
    // Over your tailnet: the mapping and the tailnet-only listener, before a restart starts the new run.
    tailnetStopFailedPort = tailscale.stop().failedPort;
  };

  return { port, url: baseUrl, token, serverSession, portChanged, store, registry, tailscale, connectAgents, stop };
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
