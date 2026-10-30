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

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  INBOX_APP_ID,
  INBOX_CARD_COLUMNS,
  inboxCardColumnOf,
  inboxCardRefsOf,
  inboxCardMarkRef,
  isInboxCardDropUnseen,
  INBOX_CARD_MARKS_MAX,
  type InboxCardColumn,
  type InboxCardMark,
  type InboxCardRef,
  INBOX_SOUND_DEFAULT_VOLUME,
  INBOX_TEXT_SIZE_DEFAULT,
  INBOX_TOUR_VERSION,
  type InboxTourChange,
  type InboxTourState,
  INBOX_CODEX_HOST,
  INBOX_QWEN_HOST,
  isQwenSessionId,
  INBOX_MCP_WAKING_HOSTS,
  INBOX_WAKING_HOSTS,
  INBOX_HOST_NAMES,
  codexThreadOfCall,
  codexTurnStartedAt,
  isCodexThreadId,
  isInboxId,
  isInboxSoundVolume,
  isInboxTextSize,
  type InboxTextSize,
  type InboxHealth,
  type InboxLine,
  type InboxListRow,
  type InboxMessage,
  type InboxProject,
  type InboxProjectRepo,
  type InboxTag,
} from "@plannotator/core/inbox-types";
import { checkServerSession, createServerSessionNonce, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import {
  INBOX_TOOL_HOSTS,
  cookieHostState,
  loadConfig,
  saveCookieHost,
  parseAutoUpdateEnv,
  parseExperimentalEnv,
  resolveExperimental,
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
import { isLoopbackHostHeader, isLoopbackForwardedFor } from "@plannotator/shared/loopback-host";
import { prepareAppHtml, prewarmAppHtml } from "@plannotator/shared/app-html";
import type { InboxSearchIndex, InboxSearchIndexOptions } from "@plannotator/shared/inbox/search";
import { createInboxSearchRoutes } from "./inbox-search";
import { inboxSkillsRoute } from "./inbox-skills";
import { isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";
import { createInboxTidy } from "./inbox-tidy";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { inboxPromptsModel, parseInboxPromptsChange, saveInboxPromptsChange } from "./inbox-prompts";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxArchivedRows, inboxListSections, inboxRowArchived } from "@plannotator/shared/inbox/list";
import { archiveProject, markProjectRead, unarchiveProject, unmarkProjectRead } from "@plannotator/shared/inbox/project-batch";
import {
  INBOX_BRIDGE_EVENT_PATH,
  INBOX_BRIDGE_POLL_MAX_MS,
  INBOX_BRIDGE_POLL_PATH,
  inboxHandedAwayLine,
  inboxReaskItemsOf,
  INBOX_MAX_REQUEST_BYTES,
  INBOX_SEND_NOW_POLL_FIELD,
  INBOX_TAGS_POLL_FIELD,
  type InboxReplyCommand,
} from "@plannotator/shared/inbox/connection";
import {
  createInboxToken,
  inboxRegistryPath,
  isOwnDataDir,
  probeInboxData,
  readInboxRegistry,
  writeInboxRegistry,
  type InboxRegistryEntry,
} from "@plannotator/shared/inbox/registry";
import { openBrowser } from "./browser";
import { isAddressInUseError } from "./remote";
import { createRequestHostGuard } from "./request-host-guard";
import { markPlannotatorResponse, withPlannotatorServerHeader } from "./plannotator-server-marker";
import { createInboxMcpServer, INBOX_BOARD_OFF_TEXT } from "./inbox-mcp";
import { inboxGuideRoute } from "./inbox-guides";
import { createInboxRepoCache } from "./inbox-repos";
import { createRefCards, type RefRunner } from "./ref-cards";
import { createInboxProjectRoots, nearestProjectHolding, type InboxGitRunner } from "./inbox-project-root";
import { handleFavicon } from "./shared-handlers";
import { createInboxAttachmentRoutes } from "./inbox-attachments";
import { createInboxImageCapture, inboxMessageImageRoute, type InboxImageCapture } from "./inbox-message-images";
import { createInboxOpenInRoute, systemOpenInLauncher, type InboxOpenInLauncher } from "./inbox-open-in";
import { recordInboxAttachments, sweepStaleInboxSendTemps } from "@plannotator/shared/inbox/attachments";
import { inboxBodyForAgent, inboxUploadAttachments, removeInboxAttachmentFiles, removeInboxUploads } from "@plannotator/shared/inbox/uploads";
import { createInboxLiveSessions } from "./inbox-sessions";
import { createInboxCodexWake, type InboxCodexWake } from "./inbox-codex-wake";
import { createInboxQwenWake, type InboxQwenWake } from "./inbox-qwen-wake";
import {
  claudePluginBehindInbox,
  claudeRestartCommand,
  claudeSessionOutdated,
  CLAUDE_PLUGIN_UPDATE_COMMAND,
  createClaudePluginInstallReader,
  createOpenCodeSpecReader,
  createPiPinReader,
  openCodeSessionOutdated,
  piSessionOutdated,
} from "./inbox-restart";
import { createInboxCompose, INBOX_UPLOAD_SWEEP_MS } from "./inbox-compose";
import { createInboxReplyDrafts } from "./inbox-reply-drafts";
import { createInboxPins } from "./inbox-pins";
import { createInboxEmbeds } from "./inbox-embeds";
import { createInboxFeedback, INBOX_FEEDBACK_PATH } from "./inbox-feedback";
import { forgeCardRefResolver, resolveInboxCardRefs } from "./inbox-card-refs";
import { createCardMarks } from "./inbox-card-marks";
import { isInboxBoardSeq, readInboxBoardSeen, writeInboxBoardSeen } from "@plannotator/shared/inbox/board-seen";
import { createInboxTagsRoute } from "./inbox-tags";
import { createInboxDevices, DOOR_PREFIX } from "./inbox-devices";
import type { PairingProbes } from "./inbox-pairing-checks";
import { createInboxRelay } from "./inbox-relay";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { createInboxTailscale, PHONES_TAILNET_HTTPS_PORT, type InboxTailscale } from "./inbox-tailscale";
import { createInboxUpdates, type InboxUpdatesOptions } from "./inbox-updates";
import { INBOX_WHATS_NEW_IMAGE_PATH, whatsNewImageRoute } from "./inbox-whats-new-images";
import { inboxCanonicalBaseUrl, inboxCanonicalRedirect } from "./inbox-canonical";
import { createInboxWindows, parseWindowId, parseWindowOrigin, parseWindowPermission } from "./inbox-windows";
import { handleInboxTourRequest } from "./inbox-tour";
import {
  agentSpec,
  claudeCodeModOn,
  connectInboxAgents,
  createAgentEnvironment,
  createAgentEnvironmentFor,
  displayPath,
  inboxAgentReach,
  inboxConnectDisabled,
  inboxPluginStatus,
  readInboxAgents,
  setInboxAgentReach,
  setInboxTool,
  writeInboxAgents,
  type AgentEnvironment,
} from "./inbox-agents";
import { addInboxNote, INBOX_NOTE_BLOCK, inboxNotesDisabled, markNotesAsked, noteCandidateIds, notesAsked, noteStatus, refreshInboxNotes, removeInboxNote } from "./inbox-agent-notes";
import {
  displayInboxSubject,
  INBOX_AGENT_IDS,
  INBOX_AGENT_LABELS,
  INBOX_AUTO_SEND_AFTER_MS,
  INBOX_CARD_ACTION_ON,
  INBOX_NOTE_AGENT_IDS,
  type InboxAgentId,
  type InboxConnectReport,
  type InboxNoteAgentId,
} from "@plannotator/core/inbox-types";

/** The hosts whose own connection polls the bridge and wakes its session with the reply: the waking hosts but Codex, which the Inbox wakes itself. */
const BRIDGE_WAKING_HOSTS: ReadonlySet<string> = new Set(INBOX_WAKING_HOSTS.filter((host) => !INBOX_MCP_WAKING_HOSTS.includes(host)));

/** Where a request came in: the window's loopback port, or the tailnet-only listener `tailscale serve` points at. */
type RequestVia = "local" | "tailnet";

/** Headers `tailscale serve` sets on every proxied request (the identity headers for a user's device). */
const SERVE_IDENTITY_HEADERS = ["tailscale-headers-info", "tailscale-user-login"] as const;

const LOOPBACK = "127.0.0.1";
/** A palette id as packages/ui/themes names them (`plannotator`, `tokyo-night`). */
const THEME_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Remote mode's fixed port: the Inbox never takes it. */
export const INBOX_FORBIDDEN_PORT = 19432;
const SSE_HEARTBEAT_MS = 15_000;
const DEFAULT_HEALTH_TICK_MS = 60_000;
/** How often the sidebar's "Reload Claude Code N" is checked against the live sessions (a session restarted or went away). */
const INBOX_RESTART_WATCH_MS = 5_000;
/** How often the live sessions' delivery signature is compared while a window listens (`event: deliveries`). */
const INBOX_DELIVERY_WATCH_MS = 1_000;
/**
 * How often the Inbox looks for replies that waited `INBOX_AUTO_SEND_AFTER_MS`
 * on a busy session (approval "inbox-busy-agent-reply"): a few seconds late at
 * most, and every poll of a busy session looks too.
 */
export const INBOX_AUTO_SEND_SWEEP_MS = 5_000;
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
  /** How long a streamed attachment answer may go unread before its file handle closes (inbox-byte-range.ts). Default `STREAM_IDLE_CLOSE_MS`; tests shorten it. */
  streamIdleMs?: number;
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
  updates?: Pick<
    InboxUpdatesOptions,
    "fetchReleasePage" | "fetchRelease" | "fetchReleaseTag" | "fetchImage" | "whatsNewWaitMs" | "launchInstaller" | "isManaged" | "listSessions" | "now" | "probeVersion"
  >;
  /**
   * The window: the built single-file app (`apps/hook/dist/inbox.html`, which
   * the binary embeds). Absent (a source run before `build:hook`, the server
   * tests): `/` answers a one-line page saying so.
   */
  htmlContent?: string;
  /**
   * Tests: where the Feedback dialog's send goes (inbox-feedback.ts). Default:
   * `PLANNOTATOR_FEEDBACK_URL`, else the feedback Worker's constant URL.
   */
  feedbackUrl?: string;
  /** Tests: how long a window's record outlives its last event stream (default `WINDOW_GRACE_MS`). */
  windowGraceMs?: number;
  /** Tests: the clock (epoch ms) send_message's "not read since" line reads (packages/server/inbox-session-reads.ts). Default: the wall clock. */
  mcpNow?: () => number;
  /** Tests: the store's clock (what it stamps on messages, cards and deliveries), so a test can write what reads as hours old. Default: the wall clock. */
  storeNow?: () => Date;
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
  /** The Board, decided here instead of config.json `inboxBoard` (tests). Absent: config.json decides on every request. */
  board?: boolean;
  /**
   * `plannotator inbox --tailscale`: publish over the tailnet for this run
   * whatever PLANNOTATOR_INBOX_TAILSCALE / config.json `inboxTailscale` say
   * (packages/server/inbox-tailscale.ts). Default false.
   */
  publishTailnet?: boolean;
  /**
   * How "Open in" launches an attachment's app (packages/server/inbox-open-in.ts).
   * Default: this host's launcher. Tests pass a recording one, so no real app starts.
   */
  openInLauncher?: InboxOpenInLauncher;
  /** Tests: how a project root's `origin` is read (default `readInboxProjectRepo`, inbox-repos.ts). */
  readProjectRepo?: (root: string) => Promise<InboxProjectRepo | null>;
  /** Tests: run the hover cards' `gh` / `glab` through this instead of the real ones (ref-cards.ts). */
  refRunner?: RefRunner;
  /** Tests: the git that decides a path's project (default `inboxGitRunner`, inbox-project-root.ts). */
  projectRootGit?: InboxGitRunner;
  /**
   * How long after a Mark read the asking agents are told what it closed (the
   * window's Undo lasts 7 s). Default `INBOX_SET_ASIDE_DELAY_MS`. Tests shorten it.
   */
  setAsideDelayMs?: number;
  /**
   * How long a reply (a message, a Re-ask note; never a 👍 note) waits on a busy session before
   * it goes into the running turn by itself, where that session's connection
   * can take it mid-turn. Default `INBOX_AUTO_SEND_AFTER_MS` (5 minutes).
   * Tests shorten it.
   */
  autoSendAfterMs?: number;
  /** Tests: how often the Inbox looks for replies due to go in by itself. Default `INBOX_AUTO_SEND_SWEEP_MS`. */
  autoSendSweepMs?: number;
  /**
   * Where the agents the Inbox connects itself to live (home, environment,
   * PATH, running their CLIs; inbox-agents.ts). Default: this process's.
   * Tests give temp folders and fake CLIs.
   */
  agentEnvironment?: AgentEnvironment;
  /** Tests: how the search index slices its build (packages/shared/inbox/search.ts). Default: 5 ms slices that yield. */
  searchIndex?: InboxSearchIndexOptions;
  /**
   * The Codex wake (packages/server/inbox-codex-wake.ts): where to look for a
   * Codex CLI besides `agentEnvironment`'s PATH (default: the ChatGPT app's,
   * never under the test sandbox), and how often to look for replies to queue.
   */
  codexWake?: { extraClis?: readonly string[]; now?: () => number; queueTimeoutMs?: number };
  /** The Qwen Code wake's clock and time limits (inbox-qwen-wake.ts): tests shorten them. */
  qwenWake?: { now?: () => number; sendTimeoutMs?: number; receiptTimeoutMs?: number; comebackMs?: number; socketParent?: string };
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
  /** The search index (built on the first search): tests and the benchmark read its build stats. */
  search: InboxSearchIndex;
  /** The background capture of images messages show (inbox-message-images.ts): tests wait on its `idle`. */
  imageCapture: InboxImageCapture;
  /** The Codex wake (inbox-codex-wake.ts): tests run its sweep. */
  codexWake: InboxCodexWake;
  /** The Qwen Code wake (inbox-qwen-wake.ts): tests run its sweep. */
  qwenWake: InboxQwenWake;
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
  project_unresolved: 503,
  owner_only: 403,
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
  // Re-ask: every question of that session is answered, picked or closed already.
  nothing_to_reask: 409,
  // Tidy: none of the sessions asked has anything to tidy now (asked a moment ago, or nothing left).
  nothing_to_tidy: 409,
  thread_resolved: 409,
  // 👍 Looks good: refused on a person's message, on an older agent message, and while a question is open.
  ack_not_allowed: 422,
  ack_stale: 409,
  ack_after_reply: 409,
  question_open: 409,
  idempotency_key_reused: 409,
  // Action items (approval "inbox-next-actions"): a Done already sent (no Undo), an action item no longer open, an agent's `done` that names no open action item.
  action_already_sent: 409,
  action_closed: 409,
  invalid_done: 422,
  // The project menu: a batch_id already answered another project or action.
  batch_id_reused: 409,
  config_not_saved: 500,
  // pins.json from a newer Plannotator: kept as it is (packages/shared/inbox/pins.ts).
  pins_newer: 409,
  // Attachments and annotations (step 2).
  attachment_not_found: 404,
  attachment_missing: 404,
  attachment_changed_type: 409,
  attachment_not_text: 415,
  attachment_not_image: 415,
  attachment_not_video: 415,
  attachment_not_html: 415,
  // "Open in" (packages/server/inbox-open-in.ts): an app the per-kind policy refuses, or one not installed.
  open_not_allowed: 422,
  app_not_available: 422,
  attachment_too_large: 413,
  // A page an attached HTML page links to, shown read-only in its pane (inbox-attachments.ts `linked-page`).
  linked_page_not_html: 415,
  linked_page_refused: 403,
  linked_page_outside: 403,
  linked_page_missing: 404,
  linked_page_too_large: 413,
  annotation_not_allowed: 422,
  annotation_not_found: 404,
  annotation_closed: 409,
  // A comment on a guided review's diff, on a message that carries none.
  guide_not_found: 404,
  // New message (step 8).
  session_not_live: 409,
  // Send now: the session's connection does not poll now, or cannot deliver into a running turn.
  send_now_unavailable: 409,
  // Tags: a live session whose Plannotator is too old to word a tag truthfully.
  tag_needs_update: 409,
  // Tags: the session is known, but as another agent than the tag says.
  tag_host_mismatch: 409,
  // Add or Hand off (approval "inbox-tag-handoff"): a session that is not woken, the thread's own owner, a hand-off already sent.
  mode_needs_live: 409,
  already_owner: 409,
  handoff_settled: 409,
  // Compose: a new thread the person starts (packages/server/inbox-compose.ts).
  already_delivered: 409,
  not_addressed: 422,
  // A thread name another open thread of the project already has.
  thread_name_taken: 409,
  draft_conflict: 409,
  upload_refused: 422,
  upload_too_large: 413,
  markup_too_large: 413,
  upload_not_found: 404,
  // The Board's cards (approval "inbox-board"): who may move a card.
  card_not_found: 404,
  card_no_project: 404,
  card_other_project: 422,
  card_icebox_person_only: 403,
  card_iceboxed: 409,
  card_dropped_by_person: 409,
  card_person_only: 403,
  // Over your tailnet (packages/server/inbox-tailscale.ts).
  tailscale_env_decides: 409,
  // Settings → Capabilities → Experimental, while PLANNOTATOR_EXPERIMENTAL decides.
  experimental_env_decides: 409,
  // Settings → General → "Open Plannotator at plannotator.localhost" (#2184): locked by the env var or another urlHost.
  cookie_host_env_decides: 409,
  cookie_host_url_host_in_use: 409,
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

/** The window page's security headers, on every answer for `/`. */
const WINDOW_PAGE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": WINDOW_CSP,
} as const;

/** One tag per page body, computed once (the page is ~22 MB; it changes only with the binary). */
let windowPageTag: { page: string; etag: string } | null = null;
function windowPageEtag(page: string): string {
  if (windowPageTag?.page !== page) windowPageTag = { page, etag: `W/"${Bun.hash(page).toString(36)}"` };
  return windowPageTag.etag;
}

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  const bare = etag.replace(/^W\//, "");
  return header.split(",").some((tag) => {
    const t = tag.trim();
    return t === "*" || t.replace(/^W\//, "") === bare;
  });
}

/**
 * `/` through the tailnet listener (#2032): the page compressed as remote-mode
 * and `--tailscale` sessions serve theirs (#1617, `packages/shared/app-html.ts`),
 * brotli in practice since serve is HTTPS. The window's own loopback port keeps
 * the uncompressed `no-store` answer: on loopback the transfer is free and the
 * one-time compression pass only delays the first load.
 *
 * Cache: `private, no-cache` with a weak ETag, not `no-store`. The page is the
 * same bytes until a restart to update swaps the binary, and a phone on cellular
 * opens it many times a day, so a revalidation that answers 304 saves the ~5 MB
 * body; `no-cache` still asks every time, so a new build is never missed. The tag
 * is weak because the br, gzip and identity bodies are one page (one tag fits all
 * three under `Vary: Accept-Encoding`). The data routes stay `no-store`.
 * The listener's checks (owner login, served Host, Sec-Fetch-Site) ran before this.
 */
async function tailnetWindowPage(req: Request, page: string): Promise<Response> {
  const etag = windowPageEtag(page);
  const cacheHeaders = { "Cache-Control": "private, no-cache", ETag: etag, Vary: "Accept-Encoding" };
  if (etagMatches(req.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: { ...WINDOW_PAGE_HEADERS, ...cacheHeaders } });
  }
  const prepared = await prepareAppHtml(page, req.headers.get("accept-encoding"), true);
  const headers = { ...prepared.headers, ...WINDOW_PAGE_HEADERS, ...cacheHeaders, "Content-Type": "text/html; charset=utf-8" };
  // A Buffer is a valid fetch body; the lib types lag.
  return new Response(req.method === "HEAD" ? null : (prepared.body as BodyInit), { headers });
}

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

/** The project root for a path an agent named (the rules: packages/server/inbox-project-root.ts). */
export { resolveInboxProjectRoot } from "./inbox-project-root";

function startOnLoopback(fetch: Parameters<typeof Bun.serve>[0]["fetch"], preferred: number | null): { server: ReturnType<typeof Bun.serve>; portChanged: boolean } {
  const serve = (port: number) =>
    Bun.serve(withPlannotatorServerHeader({ hostname: LOOPBACK, port, idleTimeout: 0, maxRequestBodySize: INBOX_MAX_REQUEST_BYTES, fetch }) as Parameters<typeof Bun.serve>[0]);
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
  const store = InboxStore.open(dataDir, options.storeNow ? { now: options.storeNow } : {});
  // A send a crash interrupted leaves a temp blob; the next start removes it once it is stale.
  sweepStaleInboxSendTemps(store.dir);
  const serverSession = createServerSessionNonce();
  // Search (packages/server/inbox-search.ts): the index is built on the first search, not here.
  const search = createInboxSearchRoutes({ store, serverSession, index: options.searchIndex });
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
  // 👍 Looks good: once the same Undo window has passed with it standing, the ack is sent to the agent (a note, delivered like a reply).
  const settleAcks = () => {
    try {
      store.settleAcks(setAsideDelayMs);
    } catch (error) {
      process.stderr.write(`Inbox: an acknowledgment was not settled: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };
  const scheduleAckSettle = () => {
    const timer = setTimeout(() => {
      setAsideTimers.delete(timer);
      settleAcks();
    }, setAsideDelayMs + 50);
    (timer as { unref?: () => void }).unref?.();
    setAsideTimers.add(timer);
  };
  // A hand-off (approval "inbox-tag-handoff", A2): held for the same Undo window, then handed to the new owner and the former one.
  const settleHandoffs = () => {
    try {
      store.settleHandoffs(setAsideDelayMs);
    } catch (error) {
      process.stderr.write(`Inbox: a hand-off was not settled: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };
  const scheduleHandoffSettle = () => {
    const timer = setTimeout(() => {
      setAsideTimers.delete(timer);
      settleHandoffs();
    }, setAsideDelayMs + 50);
    (timer as { unref?: () => void }).unref?.();
    setAsideTimers.add(timer);
  };
  // Action items (approval "inbox-next-actions"): the person's Done or Can't do it goes to the agent once the same Undo window has passed.
  const settleActions = () => {
    try {
      store.settleActions(setAsideDelayMs);
    } catch (error) {
      process.stderr.write(`Inbox: an action item's Done was not sent: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };
  const scheduleActionSettle = () => {
    const timer = setTimeout(() => {
      setAsideTimers.delete(timer);
      settleActions();
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
  /** A reply draft was saved or deleted (inbox-reply-drafts.ts): the windows' streams say `event: drafts`. */
  const draftListeners = new Set<(threadId: string) => void>();
  /** The sidebar's pins changed (inbox-pins.ts): the windows' streams say `event: pins`. */
  const pinListeners = new Set<() => void>();
  // The Inbox windows open now and whether any can show a notification (inbox-windows.ts).
  const windows = createInboxWindows({ graceMs: options.windowGraceMs });
  /** Event streams open now (health's `event_streams`): Inbox tabs of one origin share one. */
  let openEventStreams = 0;
  const binaryPath = options.binaryPath !== undefined ? options.binaryPath : version !== "dev" ? process.execPath : null;
  // The sidebar's Update button (packages/server/inbox-updates.ts): the release
  // check, the binary on disk, Update now, Remind me tomorrow.
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

  // Hover cards for issue, PR and MR links (ref-cards.ts): nothing runs until a card is asked for.
  // github.com, gitlab.com and the hosts this computer's own gh / glab is signed in to; nothing else.
  const refCards = createRefCards(options.refRunner ? { run: options.refRunner } : {});
  // The Board's links, one resolver per source (inbox-card-refs.ts): GitHub and GitLab through the hover cards' lookup.
  const cardRefResolvers = [forgeCardRefResolver(refCards)];
  // The Board's lane marks (inbox-card-marks.ts): GitHub batched per repository, GitLab through the hover cards.
  const cardMarks = createCardMarks({ refCards, ...(options.refRunner ? { run: options.refRunner } : {}) });

  // Where a path an agent named files its messages: its repository (a linked
  // worktree folds into its main repository's project) or the folder, cached
  // per folder (packages/server/inbox-project-root.ts). One cache for sends
  // and live sessions, so they always agree.
  const projectRoots = createInboxProjectRoots(options.projectRootGit ? { git: options.projectRootGit } : {});
  // Images messages show that have no captured file yet: copied in the background after a read of their thread (inbox-message-images.ts).
  const imageCapture = createInboxImageCapture(store);
  const projectLocks = new Map<string, Promise<InboxProject>>();
  const resolveProject = async (path: string): Promise<InboxProject> => {
    const { root, name, folder, settled } = await projectRoots.resolve(path);
    const existing = store.projectByRoot(root);
    if (existing) return existing;
    if (!settled) {
      // git ran past its time limit, so `root` is a guess. A project the
      // store would keep forever is never made from it: the nearest existing
      // REPOSITORY project holding the folder (its root has a `.git`; read
      // from disk, no git), else the agent is told to try again. A folder
      // project (`~`, a notes folder) never takes a guess: a new worktree or
      // repository under it would be filed there for good.
      const repositories = store.listProjects().filter((project) => existsSync(join(project.root, ".git")));
      const holder = nearestProjectHolding(repositories, folder);
      if (holder) return holder;
      throw new InboxError(
        "project_unresolved",
        `Could not tell which project ${folder} belongs to: git did not answer in time. Nothing was sent or saved; try the same call again.`,
        { field: "project_path" },
      );
    }
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

  /**
   * The projects a path names, never making one (the agents' search writes
   * nothing): resolveProject's lookup without its creation, plus the project
   * an Inbox from before worktrees folded kept for the worktree itself.
   */
  const findProjects = async (path: string): Promise<{ projects: InboxProject[]; unresolved: boolean }> => {
    const { root, folder, settled, worktree } = await projectRoots.resolve(path);
    const projects: InboxProject[] = [];
    const existing = store.projectByRoot(root);
    if (existing) projects.push(existing);
    else if (!settled) {
      const repositories = store.listProjects().filter((project) => existsSync(join(project.root, ".git")));
      const holder = nearestProjectHolding(repositories, folder);
      if (holder) projects.push(holder);
    }
    const earlier = worktree ? store.projectByRoot(worktree) : null;
    if (earlier && !projects.some((project) => project.id === earlier.id)) projects.push(earlier);
    return { projects, unresolved: !settled && projects.length === 0 };
  };

  const mcp = createMcpHandler(
    () =>
      createInboxMcpServer({
        store,
        baseUrl: () => baseUrl,
        resolveProject,
        projectRootOf: (path) => projectRoots.resolve(path),
        recordAttachments: (paths, project, base) =>
          recordInboxAttachments(store.dir, paths, { base, at: new Date().toISOString() }),
        // An open wait_for_reply keeps its session present (never "ended").
        presence: {
          seen: (session) => live.seenOverMcp(session),
          hold: (session, threadId) => {
            const release = live.holdOverMcp(session, threadId);
            return () => {
              release();
              // A Codex thread's wait ended: what it left (a wait cut short) is queued as a turn now.
              if (codexWake.status(session) !== null) void codexWake.sweep();
              if (qwenWake.status(session) !== null) void qwenWake.sweep();
            };
          },
        },
        // The agents' read-only search reads the window's own ⌘K index, and finds projects without making one.
        searchIndex: search.index,
        findProjects,
        // A Claude Code, Pi or OpenCode session whose bridge polls now is woken by the reply, whoever sent for it
        // (the stdio shim run inside that session sends as it: PLANNOTATOR_SESSION_TAG, PI_SESSION_ID). A Codex
        // thread's messages wake it when this Inbox can run `codex queue` (inbox-codex-wake.ts); a running Qwen
        // Code session's, when this Inbox is its trusted sender (inbox-qwen-wake.ts).
        sessionWakes: async (host, session, meta) =>
          (typeof host === "string" && typeof session === "string" && BRIDGE_WAKING_HOSTS.has(host) && live.pollsNow(host, session)) ||
          (await codexWake.wakes(host, session, meta)) ||
          qwenWake.wakes(host, session, meta),
        // The Board: the card tool is listed and served only while the person has it on.
        boardOn,
        ...(options.mcpNow ? { now: options.mcpNow } : {}),
      }),
    { legacy: "stateless", maxRequestBodySize: INBOX_MAX_REQUEST_BYTES },
  );

  const health = (): InboxHealth => ({
    ok: true,
    app: INBOX_APP_ID,
    version,
    serverSession,
    pid: process.pid,
    update: updates.current(),
    notify_reach: windows.reach(notificationsState().enabled),
    // Additive: event streams open now (windows' and the phone door's). Inbox tabs of one origin share one.
    event_streams: openEventStreams,
    // Additive: read_thread honours the peek mark (the session's thread list after a compaction or resume).
    peek: true,
  });

  /**
   * The sidebar's folders: every project, with its thread and unread counts,
   * and (additive) `listed`, the threads the window's list holds, and
   * `archived`, the rest. The window leaves out a project with nothing listed
   * (the project menu's automatic hiding); an older window ignores both.
   */
  const projectFolders = (rows: readonly InboxListRow[] = store.listRows()) => {
    return store.listProjects().map((project) => {
      const mine = rows.filter((row) => row.project.id === project.id);
      const archived = mine.filter((row) => inboxRowArchived(row)).length;
      return { ...project, threads: mine.length, unread: mine.filter((row) => row.unread).length, listed: mine.length - archived, archived };
    });
  };

  /**
   * The project menu's batches remember their answer by `batch_id` (the
   * last 50, in memory), so a retried request answers what the first one did
   * and its Undo still names the threads it touched.
   */
  const batches = new Map<string, { route: string; answer: unknown }>();
  const BATCH_MEMORY = 50;
  const batchIdOf = (body: Record<string, unknown>): string | null => {
    const id = body.batch_id;
    if (id === undefined || id === null) return null;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new InboxError("validation_error", "batch_id: 1 to 128 letters, digits, _ or -.", { field: "batch_id" });
    }
    return id;
  };
  const rememberBatch = (id: string | null, route: string, answer: unknown) => {
    if (id === null) return;
    batches.set(id, { route, answer });
    while (batches.size > BATCH_MEMORY) batches.delete(batches.keys().next().value!);
  };
  /** Thread ids a body names: a list of msg_ ids (an Undo). */
  const threadIdList = (value: unknown, field: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 10_000 || !value.every((id) => isInboxId("msg", id))) {
      throw new InboxError("validation_error", `${field}: a list of thread ids (msg_).`, { field });
    }
    return value as string[];
  };

  /**
   * The list model: one row per thread, placed in the approved sections, with
   * the project as a label and an optional filter (`?project=prj_...`), which
   * keeps the sections and drops other projects' rows.
   */
  const listModel = (projectFilter: string | null, archived: "include" | "exclude") => {
    // One pass over the store feeds both the folders' counts and the sections.
    // `pinned_at` (additive) on the window's and the phone's rows only: never on anything an agent reads.
    const pinnedAt = new Map(store.pins().map((pin) => [pin.thread_id, pin.pinned_at]));
    const rows = store.listRows().map((row) => (pinnedAt.has(row.thread_id) ? { ...row, pinned_at: pinnedAt.get(row.thread_id)! } : row));
    const scoped = projectFilter ? rows.filter((row) => row.project.id === projectFilter) : rows;
    const byId = new Map(rows.map((row) => [row.thread_id, row]));
    return {
      serverSession,
      version,
      cursor: store.cursor(),
      update: updates.current(),
      /** This Inbox started on a newer version than the last one: the sidebar's "What's new in X" link. */
      updated: updates.updated(),
      /** Claude Code sessions a restart would bring up to date (inbox-restart.ts): the sidebar's "Reload Claude Code N". Additive. */
      restart_claude_code: live.restartCount(),
      /** Every runtime's sessions a reload brings up to date (Claude Code, Pi, Oh My Pi, OpenCode 2): "Reload agents N". Additive. */
      restart_agents: live.restartAgents(),
      /** Checking for updates has failed for hours: the sidebar's quiet "Can't check for updates". Additive. */
      update_check_failing: updates.checkFailing(),
      notice: portChanged ? "The Inbox moved to a new port: allow notifications again on this page." : null,
      projects: projectFolders(rows),
      project: projectFilter,
      // `?archived=exclude` (the window): archived threads leave every section,
      // Quiet included, and Settings lists them (GET /api/inbox/threads/archived).
      // Without it they stay in Quiet, as an older window and the phone expect.
      sections: inboxListSections(archived === "exclude" ? scoped.filter((row) => !inboxRowArchived(row)) : scoped),
      /**
       * The sidebar's pinned threads (approval "inbox-pinned-threads"), in pin
       * order: every pinned thread whatever the project filter or `archived`
       * (an archived thread stays pinned). Additive: absent from an older Inbox.
       */
      pins: store
        .pins()
        .map((pin) => byId.get(pin.thread_id))
        .filter((row): row is InboxListRow => row !== undefined),
    };
  };

  const projectFilterOf = (url: URL): string | null => {
    const value = url.searchParams.get("project");
    if (value === null || value === "") return null;
    if (!isInboxId("prj", value)) throw new InboxError("validation_error", "project: a prj_ id.", { field: "project" });
    if (!store.project(value)) throw new InboxError("project_not_found", `No project ${value}.`);
    return value;
  };

  /**
   * The Board's cards (`GET /api/inbox/cards`): `?project=prj_…` and
   * `?column=building,your_review` filter; every card otherwise, in the
   * Board's column order, the latest move first.
   */
  const cardsModel = (url: URL) => {
    const project = projectFilterOf(url);
    const raw = url.searchParams.get("column");
    let columns: Set<InboxCardColumn> | null = null;
    if (raw !== null && raw !== "") {
      columns = new Set();
      for (const value of raw.split(",")) {
        const column = inboxCardColumnOf(value);
        if (column === null) throw new InboxError("validation_error", `column: one or more of ${INBOX_CARD_COLUMNS.join(", ")}, comma-separated.`, { field: "column" });
        columns.add(column);
      }
    }
    const cards = store.listCards({ projectIds: project ? new Set([project]) : null, columns }).map((card) => store.cardWire(card));
    // An agent's drops the person has not seen, in the project (or everywhere): the Board's "N dropped by an agent".
    const droppedUnseen = store.listCards({ projectIds: project ? new Set([project]) : null, columns: new Set(["dropped"]) }).filter(isInboxCardDropUnseen).length;
    // `seen_seq` (additive): the person's last look at the Board (a store seq); a card an agent wrote to in a later line is unread (isInboxCardUnread).
    // `threads` (additive): each linked thread's list row, archived ones included (the window's list leaves
    // them out), so the opened card names a shipped card's thread; a deleted thread is not linked at all.
    const threads: Record<string, ReturnType<typeof store.listRow>> = {};
    for (const card of cards) for (const id of card.threads) if (!(id in threads)) threads[id] = store.listRow(id);
    return { serverSession, cursor: store.cursor(), cards, dropped_unseen: droppedUnseen, seen_seq: readInboxBoardSeen(store.dir), threads };
  };

  /**
   * The person's moves on a card (`POST /api/inbox/cards/:id`): `op` move
   * (`column`, any; a move to dropped may carry `reason`), icebox (the pause
   * only the person makes), drop (`reason` optional), restore (back to the
   * column the card left for the Icebox or Dropped).
   */
  const personCardMove = (id: string, body: Record<string, unknown>) => {
    if (!isInboxId("crd", id)) throw new InboxError("validation_error", "A card id (crd_).", { field: "card" });
    const by = { kind: "person" } as const;
    const reason = body.reason === undefined || body.reason === null || body.reason === "" ? undefined : body.reason;
    switch (body.op) {
      case "move":
        if (body.column === undefined) throw new InboxError("validation_error", "column: where the card goes.", { field: "column" });
        return store.updateCard(id, { by, column: body.column, reason: body.column === "dropped" ? reason : undefined });
      case "icebox":
        return store.updateCard(id, { by, column: "icebox" });
      case "drop":
        return store.updateCard(id, { by, column: "dropped", reason });
      case "restore":
        return store.updateCard(id, { by, restore: true });
      case "edit":
        // The opened card: the title and the notes (either; notes "" or null clears them).
        return store.updateCard(id, { by, title: body.title === undefined ? undefined : body.title, notes: body.notes === undefined ? undefined : body.notes ?? "" });
      case "link":
        // A thread or a reference (issue, PR) the person links from the opened card.
        return store.updateCard(id, { by, threads: body.thread_id ? [body.thread_id] : [], refs: body.ref ? [body.ref] : [] });
      case "send":
        // Sent to an agent: `thread_id` is the thread the window just started for it (compose's Send).
        return store.sendCard(id, { thread_id: body.thread_id });
      default:
        throw new InboxError("validation_error", "op: move, icebox, drop, restore, edit, link or send.", { field: "op" });
    }
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
  // The notes the person installed, brought up to this version while untouched (an update reaches
  // them when the Inbox restarts onto it); an edited, damaged, read-only or busy file is left alone.
  try {
    refreshInboxNotes(dataDir, agentEnvironment);
  } catch {
    // Never holds up a start.
  }
  let connecting: Promise<InboxConnectReport> | null = null;
  // The Inbox's stop ends a run still going: its agent CLIs are killed, never left running.
  const connectStop = new AbortController();
  const connectAgents = (): Promise<InboxConnectReport> => {
    connecting ??= connectInboxAgents({ dataDir, selfCommand, environment: agentEnvironment, signal: connectStop.signal }).finally(() => {
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
        // chosen_off: config.json turns it off by name (the person's choice, e.g. Settings' switch), not the host default.
        // Claude Code's tool comes from its plugin's mod: with the mod off (PLANNOTATOR_CLAUDE_MOD / claudeCodeMod) there is none.
        const modOff = id === "claude-code" && !claudeCodeModOn(agentEnvironment);
        const tool = host
          ? {
              on: !modOff && resolveInboxTool(config, env, host),
              locked: toolEnv !== undefined,
              chosen_off: toolEnv === undefined && configuredInboxTool(config, host) === false,
              ...(modOff ? { mod_off: true } : {}),
            }
          : null;
        // No tool (the inboxTool switch, or Claude Code's mod off): no reminder.
        const reminder = host
          ? { on: !modOff && resolveInboxReminder(config, env, host), locked: toolEnv !== undefined, needs_tool: modOff || !resolveInboxTool(config, env, host) }
          : null;
        // With PLANNOTATOR_INBOX_NOTES=0 only a note already written is listed, so it can still be turned off.
        const status = (INBOX_NOTE_AGENT_IDS as readonly string[]).includes(id) ? noteStatus(id as InboxNoteAgentId, dataDir, agentEnvironment) : null;
        const note = status && (!notesOff || status.state === "added" || status.state === "edited") ? status : null;
        // Codex through MCP: whether this Inbox can wake it (a Codex CLI with `codex queue`; inbox-codex-wake.ts).
        // Probed only for a connected one, so reading the agents runs no CLI otherwise. Qwen Code: whether
        // Plannotator holds its trusted-sender token (inbox-qwen-trust.ts), read from disk, no CLI.
        const wakes =
          INBOX_MCP_WAKING_HOSTS.includes(id) && reach.kind === "mcp" && reach.on ? { wakes: id === INBOX_QWEN_HOST ? qwenWake.canWake() : (await codexWake.cli()) !== null } : {};
        return { id, label: INBOX_AGENT_LABELS[id], detected, reach, tool, reminder, note, plugin: inboxPluginStatus(id, agentEnvironment), ...wakes };
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
      // The open sessions that poll now, per host, and which need a restart or an update (inbox-restart.ts).
      sessions: live.hostSessions((host) => {
        if (host !== "claude-code") return { installed: host === "pi" && version !== "dev" ? version : null, update_command: null };
        const install = claudePluginInstall.read();
        return {
          installed: install?.version ?? null,
          update_command: claudePluginBehindInbox(install, version) ? CLAUDE_PLUGIN_UPDATE_COMMAND : null,
        };
      }),
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
      if (!(INBOX_NOTE_AGENT_IDS as readonly string[]).includes(agent)) throw new InboxError("validation_error", "note: this agent has no Inbox note workflow.", { field: "note" });
      if (agent === "cursor") throw new InboxError("validation_error", "note: Cursor's note is copied by hand into Customize → Rules; Show note in Settings → Agents.", { field: "note" });
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
      throw new InboxError("validation_error", `add: a list of agents (${INBOX_NOTE_AGENT_IDS.join(", ")}).`, { field: "add" });
    }
    if (body.asked !== undefined && !isNoteList(body.asked)) {
      throw new InboxError("validation_error", `asked: a list of agents (${INBOX_NOTE_AGENT_IDS.join(", ")}).`, { field: "asked" });
    }
    if (body.seen !== undefined && typeof body.seen !== "boolean") throw new InboxError("validation_error", "seen: a boolean.", { field: "seen" });
    const adding = [...new Set(add as InboxNoteAgentId[])];
    if (inboxNotesDisabled(agentEnvironment.env) && adding.length > 0) throw new InboxError("notes_disabled", "PLANNOTATOR_INBOX_NOTES=0 is set: notes are off.");
    const options = { dataDir, selfCommand, environment: agentEnvironment };
    // Read before adding: an agent whose note is added is no longer a candidate.
    const shown = (body.asked as InboxNoteAgentId[] | undefined) ?? (await noteCandidateIds(options));
    const results = adding.map((agent) =>
      // Never a note, written or to copy, for an agent that is not on this computer.
      !agentSpec(agent).detect(agentEnvironment)
        ? ({ ok: false, agent, reason: `${INBOX_AGENT_LABELS[agent]} was not found on this computer`, path: null } as const)
        : agent === "cursor"
          ? // Cursor keeps its rules in the app: nothing is written, the window shows the note to copy.
            ({ ok: true, agent, action: "manual", path: null } as const)
          : addInboxNote(agent, dataDir, agentEnvironment),
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
      throw new InboxError("config_not_saved", "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.");
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
      throw new InboxError("config_not_saved", "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.");
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
      throw new InboxError("config_not_saved", "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.");
    }
    return saved;
  };

  /**
   * The window's text size (config.json `inboxTextSize`): the body size in px
   * the Inbox's type ramp scales from, 12 to 15; 14 (the window as it has
   * always been drawn) while unset or unreadable.
   */
  const textSizeState = (): InboxTextSize => {
    const value = loadConfig().inboxTextSize;
    return isInboxTextSize(value) ? value : INBOX_TEXT_SIZE_DEFAULT;
  };

  const saveTextSize = (input: unknown, validateOnly = false): InboxTextSize => {
    if (!isInboxTextSize(input)) throw new InboxError("validation_error", "text_size: 12, 13, 14 or 15.", { field: "text_size" });
    if (validateOnly) return textSizeState();
    saveConfig({ inboxTextSize: input });
    if (loadConfig().inboxTextSize !== input) throw new InboxError("config_not_saved", "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.");
    return input;
  };

  /**
   * The onboarding tour (config.json `inboxTour`, approval
   * "inbox-onboarding-tour"): when it was started, finished or skipped, and
   * whether the first real thread offers notifications once more. Kept per
   * machine, so a port change keeps it.
   */
  const tourState = (): InboxTourState => {
    const value = loadConfig().inboxTour;
    const stamp = (v: unknown) => (typeof v === "string" && v ? v : null);
    return {
      version: typeof value?.version === "number" ? value.version : INBOX_TOUR_VERSION,
      seen_at: stamp(value?.seen_at),
      finished_at: stamp(value?.finished_at),
      skipped_at: stamp(value?.skipped_at),
      notify_again: value?.notify_again === true,
    };
  };

  const saveTour = (input: unknown, validateOnly = false): InboxTourState => {
    const keys = ["seen", "finished", "skipped", "notify_again"];
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).length === 0 ||
      Object.entries(input).some(([key, value]) => !keys.includes(key) || typeof value !== "boolean")
    ) {
      throw new InboxError("validation_error", "tour: { seen?, finished?, skipped?, notify_again? }, each a boolean.", { field: "tour" });
    }
    if (validateOnly) return tourState();
    const change = input as InboxTourChange;
    const now = new Date().toISOString();
    const current = tourState();
    const next: InboxTourState = {
      version: INBOX_TOUR_VERSION,
      seen_at: change.seen ? now : current.seen_at,
      finished_at: change.finished ? now : current.finished_at,
      skipped_at: change.skipped ? now : current.skipped_at,
      notify_again: change.notify_again ?? current.notify_again,
    };
    saveConfig({ inboxTour: next });
    const saved = tourState();
    if (saved.seen_at !== next.seen_at || saved.finished_at !== next.finished_at || saved.skipped_at !== next.skipped_at || saved.notify_again !== next.notify_again) {
      throw new InboxError("config_not_saved", "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.");
    }
    return saved;
  };

  /**
   * The diff layout guided reviews draw (config.json `diffOptions.diffStyle`),
   * the same setting code review reads and writes, so a choice in either holds
   * in the other: `split` or `unified`, null while never chosen.
   */
  const diffStyleState = (): "split" | "unified" | null => {
    const value = loadConfig().diffOptions?.diffStyle;
    return value === "split" || value === "unified" ? value : null;
  };

  const saveDiffStyle = (input: unknown, validateOnly = false): "split" | "unified" | null => {
    if (input !== "split" && input !== "unified") throw new InboxError("validation_error", "diff_style: split or unified.", { field: "diff_style" });
    if (validateOnly) return diffStyleState();
    // saveConfig merges diffOptions per field, so code review's other diff options stay.
    saveConfig({ diffOptions: { diffStyle: input } });
    if (diffStyleState() !== input) throw new InboxError("config_not_saved", "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.");
    return input;
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
      throw new InboxError("config_not_saved", "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.");
    }
    return updatesState();
  };

  /**
   * "Open Plannotator at plannotator.localhost" (#2184): config.json `urlHost:
   * "plannotator.localhost"`, shared with plan review, code review and
   * annotate. `env` is PLANNOTATOR_URL_HOST when set and `url_host` another
   * config.json `urlHost`: either locks the switch. Applies from the next start.
   */
  const cookieHostWire = () => {
    const state = cookieHostState();
    return { on: state.on, env: state.env ?? null, url_host: state.urlHost ?? null };
  };

  /** Save the cookie switch. `validateOnly`: check the input and write nothing. */
  const saveCookieHostSwitch = (input: unknown, validateOnly = false) => {
    if (typeof input !== "boolean") throw new InboxError("validation_error", "cookie_host: must be a boolean.", { field: "cookie_host" });
    if (validateOnly) return cookieHostWire();
    const { outcome } = saveCookieHost(input);
    if (outcome === "env") throw new InboxError("cookie_host_env_decides", "PLANNOTATOR_URL_HOST decides this setting.", { cookie_host: cookieHostWire() });
    if (outcome === "url_host") throw new InboxError("cookie_host_url_host_in_use", "config.json already sets urlHost; it is not replaced.", { cookie_host: cookieHostWire() });
    if (outcome === "failed") throw new InboxError("config_not_saved", "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.");
    return cookieHostWire();
  };

  /**
   * Experimental features (config.json `experimental`, PLANNOTATOR_EXPERIMENTAL
   * wins): each switch, and whether the env var decides it. Read on every
   * request, so a switch applies at once.
   */
  const decisionModeOn = () => resolveExperimental(loadConfig(), "decision-mode");
  /**
   * The Board (approval "inbox-board", 2026-10-26): on only when the person
   * turned it on (config.json `inboxBoard`), and only in a build that has the
   * card action at all (INBOX_CARD_ACTION_ON). Read on every request, never
   * cached: turning it off takes effect at the next request, with no timer
   * and no lock. Cards are never deleted by it.
   */
  const boardOn = () => INBOX_CARD_ACTION_ON && (options.board ?? loadConfig().inboxBoard === true);
  const saveBoard = (input: unknown, validateOnly = false) => {
    if (!input || typeof input !== "object" || Array.isArray(input) || typeof (input as { on?: unknown }).on !== "boolean" || Object.keys(input).some((key) => key !== "on")) {
      throw new InboxError("validation_error", "board: { on: boolean }.", { field: "board" });
    }
    const on = (input as { on: boolean }).on;
    if (validateOnly) return { on: boardOn() };
    saveConfig({ inboxBoard: on });
    if ((loadConfig().inboxBoard === true) !== on) throw new InboxError("config_not_saved", "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.");
    return { on: boardOn() };
  };
  const experimentalState = () => ({
    decision_mode: { on: decisionModeOn(), env: parseExperimentalEnv("decision-mode") ?? null },
  });

  /** Save `experimental: { decision_mode }`. `validateOnly`: check and write nothing. */
  const saveExperimental = (input: unknown, validateOnly = false) => {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      typeof (input as { decision_mode?: unknown }).decision_mode !== "boolean" ||
      Object.keys(input).some((key) => key !== "decision_mode")
    ) {
      throw new InboxError("validation_error", "experimental: { decision_mode: boolean }.", { field: "experimental" });
    }
    const on = (input as { decision_mode: boolean }).decision_mode;
    // The env var decides (like PLANNOTATOR_INBOX_TAILSCALE): saving to config.json would change nothing.
    const env = parseExperimentalEnv("decision-mode");
    if (env !== undefined) {
      throw new InboxError("experimental_env_decides", `PLANNOTATOR_EXPERIMENTAL is set in this Inbox's environment, so decision mode stays ${env ? "on" : "off"}.`, { field: "experimental" });
    }
    if (validateOnly) return experimentalState();
    saveConfig({ experimental: { decisionMode: on } });
    if (loadConfig().experimental?.decisionMode !== on) throw new InboxError("config_not_saved", "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.");
    return experimentalState();
  };

  /**
   * Settings → Prompts: the Inbox reminder (config.json `prompts.inbox`) and
   * the plan, review and annotate prompts. `on` per agent is what Settings →
   * Agents shows: the reminder switch, with the Inbox tool (and, for Claude
   * Code, its mod). Changing it is for this computer only: the text goes to
   * every agent session here.
   */
  const promptsState = (via: RequestVia) => {
    const config = loadConfig();
    const env = agentEnvironment.env as NodeJS.ProcessEnv;
    const modOff = !claudeCodeModOn(agentEnvironment);
    const on = Object.fromEntries(
      INBOX_TOOL_HOSTS.map((host) => [host, !(host === "claude-code" && modOff) && resolveInboxReminder(config, env, host)]),
    ) as Record<InboxToolHost, boolean>;
    // OpenCode 1 cannot bring a reply back as a turn: its default is the no-wake line.
    const wakes = { "claude-code": true, pi: true, opencode: inboxPluginStatus("opencode", agentEnvironment)?.generation !== "1" };
    return inboxPromptsModel(config, on, via === "local", wakes);
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
    /** Whether a notification can reach the person now: the windows open and how many may notify. */
    notify_reach: windows.reach(notificationsState().enabled),
    /** The question sound: the Settings row, and whether the one-time dialog was shown. */
    sound: soundState(),
    /** Settings → About: update notices and automatic updates. */
    updates: updatesState(),
    /** Settings → General: "Open Plannotator at plannotator.localhost" (#2184); only for a page on this computer. */
    ...(via === "local" ? { cookie_host: cookieHostWire() } : {}),
    /** Plannotator's appearance (config.json `theme`), shared with plan review; null when never chosen. */
    theme: themeState(),
    /** The window's text size in px (config.json `inboxTextSize`), 14 unless chosen. */
    text_size: textSizeState(),
    /** The guided review's diff layout (config.json `diffOptions.diffStyle`), shared with code review; null when never chosen. */
    diff_style: diffStyleState(),
    /** Experimental features, each off unless switched on (Settings → Capabilities → Experimental). */
    experimental: experimentalState(),
    /** The Board (config.json `inboxBoard`): off unless the person turned it on. */
    board: { on: boardOn() },
    /** The onboarding tour: started, finished or skipped, and whether the first real thread offers notifications once more. */
    tour: tourState(),
    /** Settings → Prompts: the Inbox reminder (editable on this computer) and the plan, review and annotate prompts. */
    prompts: promptsState(via),
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
        throw new InboxError("config_not_saved", "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.");
      }
    }
    return inboxToolState();
  };

  // A message line as served: its subject as shown (one line, no leaked tool-call text), never as stored.
  const shownSubject = (record: InboxMessage): InboxMessage =>
    record.subject ? { ...record, subject: displayInboxSubject(record.subject) } : record;

  const eventPayload = (line: InboxLine) => {
    switch (line.kind) {
      case "project":
        // The display name (the folder's real name), as every other read gives it.
        return { seq: line.seq, kind: line.kind, id: line.id, project: { ...line.record, name: store.project(line.id)?.name ?? line.record.name } };
      case "message":
        // `first` (additive): this line is the message's first, not a later rewrite (a look, a resolve, an Unarchive).
        return { seq: line.seq, kind: line.kind, id: line.id, first: store.messageCursor(line.id) === line.seq, message: shownSubject(line.record) };
      case "question":
        // The store's one question state: a question an agent asked after the archive line is live (notifications, the sound).
        return { seq: line.seq, kind: line.kind, id: line.id, question: store.questionWire(line.record) };
      case "annotation":
        return { seq: line.seq, kind: line.kind, id: line.id, annotation: line.record };
      case "card":
        // A Board card (approval "inbox-board"). A reader that does not know the kind skips it.
        return { seq: line.seq, kind: line.kind, id: line.id, card: store.cardWire(line.record) };
    }
  };

  const eventStream = (req: Request, url: URL, via: RequestVia): Response => {
    // A reconnect: EventSource sends the last id it saw, while its URL still
    // carries the cursor it first opened with. The last id wins, so a tab that
    // slept or lost its connection catches up from where it was (and raises
    // what it missed) instead of replaying everything since it loaded.
    // Only a usable id counts (a non-negative whole number): an empty or
    // malformed header falls back to the URL's cursor, never to a full replay
    // or to none.
    const seqOf = (raw: string | null): number | null => {
      if (raw === null || !/^\d+$/.test(raw.trim())) return null;
      const value = Number(raw.trim());
      return Number.isSafeInteger(value) ? value : null;
    };
    const cursor = seqOf(req.headers.get("last-event-id")) ?? seqOf(url.searchParams.get("cursor"));
    // `once=1` (additive): the hello and the replay after the cursor, then the response ends. A tab that
    // listens to another tab's stream (packages/inbox/sharedEvents.ts) fetches what it missed (it slept,
    // or the new leader started past it) without holding a connection open. Not counted as a stream.
    if (url.searchParams.get("once") === "1") {
      let text = `event: hello\ndata: ${JSON.stringify({ serverSession, cursor: store.cursor() })}\n\n`;
      if (cursor !== null) for (const line of store.changesSince(cursor)) text += `id: ${line.seq}\nevent: record\ndata: ${JSON.stringify(eventPayload(line))}\n\n`;
      return new Response(text, {
        headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
      });
    }
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
        openEventStreams += 1;
        let counted = true;
        const sendLine = (line: InboxLine) => send(`id: ${line.seq}\nevent: record\ndata: ${JSON.stringify(eventPayload(line))}\n\n`);
        send(`retry: 2000\nevent: hello\ndata: ${JSON.stringify({ serverSession, cursor: store.cursor() })}\n\n`);
        if (cursor !== null) for (const line of store.changesSince(cursor)) sendLine(line);
        const unsubscribe = store.subscribe(sendLine);
        // `updated` (additive): the "What's new in X" link appears or goes once its notes are fetched or cannot be.
        // `restart_claude_code` (additive): the sidebar's "Reload Claude Code N" follows the sessions as they restart.
        const onStatus = () =>
          send(
            `event: status\ndata: ${JSON.stringify({ update: updates.current(), updated: updates.updated(), restart_claude_code: live.restartCount(), restart_agents: live.restartAgents(), update_check_failing: updates.checkFailing() })}\n\n`,
          );
        statusListeners.add(onStatus);
        // An Inbox window (not the phone's door): counted while its stream is open, with what it reported.
        const windowId = parseWindowId(url.searchParams.get("window"));
        const leave = windowId
          ? windows.connect(windowId, {
              permission: parseWindowPermission(url.searchParams.get("permission")),
              origin: parseWindowOrigin(url.searchParams.get("origin")),
              via,
            })
          : () => {};
        // Whether a notification can reach the person: every window's Settings shows it live.
        // Windows only: the phone's door (contract 7.9) gets hello, record, status and the heartbeat.
        const sendReach = () => send(`event: reach\ndata: ${JSON.stringify(windows.reach(notificationsState().enabled))}\n\n`);
        const stopReach = windowId ? windows.subscribe(sendReach) : () => {};
        // A reply draft changed (any window's, or this one's): the list reads the rows' `unsent` again. Windows only.
        const onDraft = (threadId: string) => send(`event: drafts\ndata: ${JSON.stringify({ thread_id: threadId })}\n\n`);
        if (windowId) draftListeners.add(onDraft);
        // The sidebar's pins changed (any window's, or a deletion): the list reads `pins` again. Windows only.
        const onPins = () => send(`event: pins\ndata: {}\n\n`);
        if (windowId) pinListeners.add(onPins);
        if (windowId) sendReach();
        // A row's delivery moved with the live sessions (no store line): windows only, like `reach`.
        const sendDeliveries = () => send(`event: deliveries\ndata: {}\n\n`);
        if (windowId) deliveryListeners.add(sendDeliveries);
        const heartbeat = setInterval(() => send(": ping\n\n"), SSE_HEARTBEAT_MS);
        cleanup = () => {
          if (counted) {
            counted = false;
            openEventStreams -= 1;
          }
          clearInterval(heartbeat);
          unsubscribe();
          statusListeners.delete(onStatus);
          stopReach();
          draftListeners.delete(onDraft);
          pinListeners.delete(onPins);
          deliveryListeners.delete(sendDeliveries);
          leave();
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
  /** The session a person's message without `to` goes to: the author of the message it answers. */
  const recipientOf = (reply: InboxMessage): string | null => {
    const parent = reply.reply_to ? store.message(reply.reply_to) : null;
    return parent?.author.kind === "agent" ? parent.author.session : null;
  };
  /**
   * An agent named from a known host only (`Claude Code`), never from a name
   * or a host string it chose itself: these go into another session's
   * prompt. Anything else is "another agent" (`fallback`).
   */
  const hostAgentName = (host: string | null | undefined, fallback = "another agent"): string =>
    host && Object.hasOwn(INBOX_HOST_NAMES, host) ? INBOX_HOST_NAMES[host]! : fallback;
  /**
   * The reply route's `tags`, with each one's mode from the reply box's line
   * (approval "inbox-tag-handoff", A2): none is an Ask (today's tag), `add`
   * joins the session to the thread, `handoff` hands it the thread (at most
   * one). Each is resolved by `tagTargets` first (its refusals unchanged);
   * Add and Hand off reach a live, woken session only. A hand-off to the
   * session that owns the thread already is refused (`already_owner`).
   */
  const tagModes = (
    messageId: string,
    value: unknown,
  ): { tags: InboxTag[]; handoff?: NonNullable<Parameters<typeof store.sendReply>[1]["handoff"]> } => {
    const resolved = live.tagTargets(value);
    const list = value as Record<string, unknown>[];
    const modeOf = (session: string) => {
      const mode = list.find((item) => item && item.session === session)?.mode;
      if (mode === undefined || mode === null || mode === "ask") return "ask";
      if (mode === "add" || mode === "handoff") return mode;
      throw new InboxError("validation_error", "tags: mode is ask, add or handoff.", { field: "tags" });
    };
    const handoffs = resolved.filter((tag) => modeOf(tag.session) === "handoff");
    if (handoffs.length > 1) throw new InboxError("validation_error", "tags: a reply hands the thread to one session at most.", { field: "tags" });
    for (const tag of resolved) {
      if (modeOf(tag.session) !== "ask" && (!tag.wakes || !tag.host)) {
        throw new InboxError(
          "mode_needs_live",
          "Add and Hand off reach a live session only: a session you picked reads the Inbox through MCP. Nothing was sent. Send it as an Ask instead.",
          { sessions: [tag.session] },
        );
      }
    }
    const tags = resolved.filter((tag) => modeOf(tag.session) !== "handoff").map((tag) => (modeOf(tag.session) === "add" ? { ...tag, joined: true } : tag));
    const target = handoffs[0];
    if (!target) return { tags };
    const message = store.message(messageId);
    if (!message) throw new InboxError("message_not_found", `No message ${messageId}.`);
    const owner = store.threadOwner(message.thread_id);
    if (owner?.session === target.session) throw new InboxError("already_owner", "That session owns this thread already: nothing was sent.");
    return {
      tags,
      handoff: {
        to: { host: target.host!, session: target.session },
        label: target.label ?? null,
        // The former owner reads by its agent and this thread's project in the person's lines ("Claude Code (plannotator)").
        from: owner
          ? {
              host: owner.host,
              session: owner.session,
              wakes: live.wakesTagged(owner.session),
              label: `${hostAgentName(owner.host, "An agent")} (${store.project(message.project_id)?.name ?? "this project"})`,
            }
          : null,
      },
    };
  };
  /**
   * `sendNow`: the polling connection said it can deliver into a running turn;
   * only then does a Send now reply carry `now`. `session`: the polling
   * session, when the reply may tag it (approval "inbox-tag-agents"): a
   * session the reply tags gets the tagged wake, and the owner of a reply
   * that tags others is told who else it went to.
   */
  const replyCommand = (reply: InboxMessage, sendNow = false, session: string | null = null): InboxReplyCommand => {
    const tag = session && !store.isOwner(reply, session) ? (reply.tags?.find((t) => t.session === session) ?? null) : null;
    // The former owner of a handed-off thread: the notice alone (its body, so an older connection still says it).
    if (tag?.handed_away) {
      const to = hostAgentName(reply.to?.host);
      return {
        type: "reply",
        id: reply.id,
        thread_id: reply.thread_id,
        reply_to: reply.reply_to,
        subject: store.threadSubject(reply.thread_id),
        body: inboxHandedAwayLine(to),
        url: threadPageUrl(baseUrl, reply.thread_id),
        handed_away: { to },
      };
    }
    if (tag) {
      return {
        type: reply.to && !reply.reply_to ? "message" : "reply",
        id: reply.id,
        thread_id: reply.thread_id,
        reply_to: reply.reply_to,
        subject: store.threadSubject(reply.thread_id),
        body: inboxBodyForAgent(reply),
        url: threadPageUrl(baseUrl, reply.thread_id),
        tagged: { owner: hostAgentName(store.recipientOf(reply)?.host) },
        // Added to the thread ("Add instead"): it works alongside the owner.
        ...(tag.joined ? { added: true } : {}),
        ...(tag.deliver_now_at && sendNow ? { now: true } : {}),
      };
    }
    const alsoTagged = (reply.tags ?? []).filter((t) => !t.handed_away).map((t) => hostAgentName(t.host));
    // Handed this thread ("Hand off instead"): the wake says it is this session's now.
    const handedFrom = reply.handoff && !reply.handoff.undone_at && reply.to ? { handoff: { from: hostAgentName(reply.handoff.from?.host) } } : {};
    return { ...ownerCommand(reply, sendNow), ...handedFrom, ...(alsoTagged.length > 0 ? { also_tagged: alsoTagged } : {}) };
  };
  const ownerCommand = (reply: InboxMessage, sendNow: boolean): InboxReplyCommand => {
    // Tidy: the note's body is the whole wake (inboxWakeText words it); never a reply to anything.
    if (reply.tidy) {
      return { type: "message", id: reply.id, thread_id: reply.thread_id, reply_to: null, subject: "Tidy", body: reply.body, url: threadPageUrl(baseUrl, reply.thread_id), tidy: true };
    }
    // A reply the person sent to another session because the one that asked
    // had ended: the wake says so, naming the agent that asked.
    const asked = reply.to && reply.reply_to ? store.message(reply.reply_to) : null;
    // Named from the host (`Claude Code`), never from the name the agent gave
    // itself: this line goes into another session's prompt.
    const redirected =
      asked && asked.author.kind === "agent" && asked.author.session !== reply.to!.session ? hostAgentName(asked.author.host, "agent") : null;
    // More words in a thread the person started, handed to a session that has
    // seen nothing of it (the person moved them there): read the thread first.
    const root = store.message(reply.thread_id);
    const continues =
      !!reply.to &&
      reply.thread_id !== reply.id &&
      !!root?.started_by_person &&
      root.delivery?.session !== reply.to.session &&
      // The root goes to this session too (not taken yet, maybe in the same poll): it opens the thread.
      root.to?.session !== reply.to.session &&
      !store.thread(reply.thread_id)?.messages.some((m) => m.author.kind === "agent" && m.author.session === reply.to!.session);
    return {
      type: reply.to && !reply.reply_to ? "message" : "reply",
      id: reply.id,
      thread_id: reply.thread_id,
      reply_to: reply.reply_to,
      subject: store.threadSubject(reply.thread_id),
      body: inboxBodyForAgent(reply),
      url: threadPageUrl(baseUrl, reply.thread_id),
      ...(redirected ? { redirected_from: redirected } : {}),
      // A thread the person started: the wake says so (INBOX_NEW_THREAD_INSTRUCTION).
      ...(reply.started_by_person && reply.thread_id === reply.id ? { new_thread: true } : {}),
      ...(continues && !redirected ? { continues_thread: true } : {}),
      // Send now: the connection delivers it at once, into the running turn when one runs.
      ...(reply.deliver_now_at && sendNow ? { now: true } : {}),
      // A thread the person started with no name yet, handed to a session that may name it: the wake asks it to.
      ...(!reply.ack_of && store.canNameThread(reply.thread_id, reply.to?.session ?? recipientOf(reply)) ? { name_thread: true } : {}),
      // The person's 👍 Looks good (amended 2026-10-16): the wake is the one ack line.
      ...(reply.ack_of ? { ack_of: reply.ack_of } : {}),
      // The person's Re-ask (approval "inbox-reask"): the wake takes INBOX_REASK_INSTRUCTION.
      ...((reply.reask?.length ?? 0) > 0 ? { reask: true } : {}),
      // What the note lists (#2059): the wake names action items only when it lists some.
      ...(inboxReaskItemsOf(reply.reask) ? { reask_items: inboxReaskItemsOf(reply.reask) } : {}),
      // A note that lists one question or action item: the wake says it in the singular.
      ...(reply.reask?.length === 1 ? { reask_one: true } : {}),
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
    const sendNow = body[INBOX_SEND_NOW_POLL_FIELD] === true;
    // Tags: what this session was only tagged in goes to a connection that words it truthfully.
    const tags = body[INBOX_TAGS_POLL_FIELD] === true;
    // A busy session that can take an item mid-turn: what has waited long enough goes in now.
    const steer = live.deliveryConnectionOf(session);
    if (sendNow && steer?.busy === true && steer.send_now) autoSendFor(session, tags);
    const commands = () => store.pendingReplies(session, { tags }).map((reply) => replyCommand(reply, sendNow, session));
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
        if (line.kind === "message" && line.record.author.kind === "person" && store.pendingReplies(session, { tags }).length > 0) finish();
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
    // Send now could not go into the running turn: the reply reads as queued again and waits for idle.
    if (body.type === "send_now_failed" && typeof body.id === "string") {
      store.clearDeliverNow(body.id, session);
      return json({ ok: true });
    }
    if (body.type !== "delivered" || typeof body.id !== "string") {
      throw new InboxError("validation_error", 'type: "delivered" with the reply id, or "state" with busy.', { field: "type" });
    }
    // An item the Inbox marked to go in by itself: whether it went into the running turn, or waited for the
    // turn to end (the session was seen idle after the mark: its own Ask question held the turn).
    const marked = store.message(body.id);
    const markedAt = marked
      ? marked.tags?.find((tag) => tag.session === session && tag.deliver_now_by === "auto")?.deliver_now_at ??
        (marked.deliver_now_by === "auto" ? marked.deliver_now_at : null)
      : null;
    const intoTurn = markedAt ? live.deliveredIntoTurn(session, markedAt) : undefined;
    const reply = store.recordDelivery(body.id, { host, session, ...(intoTurn !== undefined ? { intoTurn } : {}) });
    return json({ ok: true, delivery: reply.delivery });
  };

  /** The agent sessions a `/mcp` POST's tool calls name (a batch included), as MCP presence. */
  /**
   * A `card` call while the Board is off (a session listed the tool while it
   * was on; its tool list is fixed for the session): answered here with the
   * tool result `board_off`, before the MCP server (which no longer has the
   * tool) would say "unknown tool". Anything else, or a body that does not
   * read, goes on to the MCP server unchanged.
   */
  const boardOffCardCall = async (req: Request): Promise<Response | null> => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return null;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const call = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: { name?: unknown } };
    if (call.method !== "tools/call" || call.params?.name !== "card" || call.id === undefined) return null;
    return json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: INBOX_BOARD_OFF_TEXT }], isError: true } });
  };

  const noteMcpPresence = async (req: Request): Promise<void> => {
    try {
      const body = (await req.json()) as unknown;
      for (const call of Array.isArray(body) ? body : [body]) {
        if ((call as { method?: unknown } | null)?.method !== "tools/call") continue;
        const params = (call as { params?: { arguments?: Record<string, unknown>; _meta?: unknown } }).params;
        const args = params?.arguments;
        const session = typeof args?.agent_session === "string" ? args.agent_session.trim() : null;
        // Who it is, when the call says: an MCP agent the person can tag (inbox-tags.ts).
        if (session) live.seenOverMcp(session, { host: args?.agent_host, name: args?.agent_name });
        // A Codex thread (inbox-codex-wake.ts). Codex names its thread on every call (`_meta.threadId`), so a
        // tool without a session (search, get_guide_brief) counts too: it is there, and it read what was queued
        // before this turn started. While this Inbox can wake it (not a `codex exec` run), it is live for New
        // message, compose and tags. A command its shell runs (host codex, CODEX_THREAD_ID) is presence only.
        const meta = params?._meta;
        const thread = codexThreadOfCall(meta);
        if (thread && (!session || session === thread)) {
          if (!session) live.seenOverMcp(thread, { host: INBOX_CODEX_HOST });
          codexWake.noteToolCall(thread, codexTurnStartedAt(meta));
          if (await codexWake.wakes(INBOX_CODEX_HOST, thread, meta)) {
            await live.seenWakeOnly(thread, INBOX_CODEX_HOST, args?.project_path);
          }
        } else if (session && args?.agent_host === INBOX_CODEX_HOST && isCodexThreadId(session)) {
          codexWake.noteToolCall(session, null);
        } else if (session && args?.agent_host === INBOX_QWEN_HOST && isQwenSessionId(session)) {
          // A Qwen Code session (inbox-qwen-wake.ts; the shim names it from Qwen's registry): it is there, and
          // what Qwen queued for it before now has reached it. While this Inbox can wake it, it is live for New
          // message, compose and tags, until its record goes.
          qwenWake.noteToolCall(session);
          if (await qwenWake.wakes(INBOX_QWEN_HOST, session, meta)) await live.seenWakeOnly(session, INBOX_QWEN_HOST, args?.project_path);
        }
      }
    } catch {
      // Not JSON: the MCP handler answers it.
    }
  };

  // ── New message (step 8): the live sessions and the window's two routes (packages/server/inbox-sessions.ts) ──
  // Which polling sessions run an older plugin than a restart loads (inbox-restart.ts).
  const claudePluginInstall = createClaudePluginInstallReader(agentEnvironment);
  // Pi's settings pin an exact extension version: `pi update --extensions` skips it.
  const piPinned = createPiPinReader(agentEnvironment);
  // OpenCode 2's configured spec: `opencode2 plugin update` takes it as its target (only Plannotator), and a pinned one never moves.
  const openCodeSpec = createOpenCodeSpecReader(agentEnvironment);
  const live = createInboxLiveSessions({
    store,
    serverSession,
    resolveRoot: async (path) => (await projectRoots.resolve(path)).root,
    outdatedOf: (host, plugin, folder) => {
      if (host === "claude-code") {
        return claudeSessionOutdated({
          loaded: plugin,
          records: claudePluginInstall.records(),
          folder,
          cliVersion: version,
          pluginsDir: claudePluginInstall.pluginsDir(),
          changedAt: claudePluginInstall.changedAt,
        });
      }
      if (host === "pi") return piSessionOutdated(plugin, version, { pinned: piPinned() });
      return host === "opencode" ? openCodeSessionOutdated(plugin, version, { spec: openCodeSpec() }) : null;
    },
    displayFolder: (path) => displayPath(path, agentEnvironment) ?? path,
    restartCommandOf: (host, folder, session) => (host === "claude-code" ? claudeRestartCommand(folder, session) : null),
    autoSendAfterMs: options.autoSendAfterMs ?? INBOX_AUTO_SEND_AFTER_MS,
    // A Codex thread has no connection that polls: it is there until Codex says its thread is gone.
    // A Qwen Code session too, until its registry record goes (inbox-qwen-wake.ts).
    wakeOnlyStatus: (session) => codexWake.status(session) ?? qwenWake.status(session),
    uncertainItemsOf: (session) => [...codexWake.uncertainItems(session), ...qwenWake.uncertainItems(session)],
  });

  // The Codex wake: the person's items for a Codex thread go in as a new turn through `codex queue`,
  // once each (inbox-codex-wake.ts). Worded like any bridge command.
  const codexWake = createInboxCodexWake({
    store,
    environment: agentEnvironment,
    commandOf: (item, session) => replyCommand(item, false, session),
    // A thread blocked in wait_for_reply gets the reply from that call, not as another turn as well.
    waitingOverMcp: (session, threadId) => live.waitingOverMcp(session, threadId),
    ...(options.codexWake?.extraClis ? { extraClis: options.codexWake.extraClis } : {}),
    ...(options.codexWake?.now ? { now: options.codexWake.now } : {}),
    ...(options.codexWake?.queueTimeoutMs ? { queueTimeoutMs: options.codexWake.queueTimeoutMs } : {}),
  });

  // The Qwen Code wake: the person's items for a running Qwen session go in over Qwen's cross-session
  // messaging, once each, as Plannotator's trusted sender (inbox-qwen-wake.ts, inbox-qwen-trust.ts).
  const qwenWake = createInboxQwenWake({
    store,
    environment: agentEnvironment,
    dataDir,
    commandOf: (item, session) => replyCommand(item, false, session),
    waitingOverMcp: (session, threadId) => live.waitingOverMcp(session, threadId),
    ...options.qwenWake,
  });

  // A reply that waited 5 minutes on a busy session goes into its running turn by itself, as if the person
  // pressed Send now (owner approval "inbox-busy-agent-reply", 2026-10-21). Only where that session's
  // connection can take it mid-turn (`send_now`). The wait is the live sessions' clock, started the first
  // time that session was seen busy and able to take it while the item waited (never the item's
  // `created_at`); a restart or the session going away starts it again. The store marks it once
  // (`deliver_now_by: "auto"`); the mark is a store line, which answers the session's held poll with `now: true`.
  const autoSendFor = (session: string, tags: boolean) => {
    try {
      store.autoSendDue(session, { afterMs: live.autoSendAfterMs, tags, clockOf: (id) => live.waitClockOf(session, id) });
    } catch (error) {
      process.stderr.write(`Inbox: a reply did not go in by itself: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };
  const autoSendSweep = () => {
    live.trackWaits();
    for (const { session, tags } of live.steerableSessions()) autoSendFor(session, tags);
  };
  // A person's item written while its session is already busy starts its clock at once, not at the next sweep.
  let waitsQueued = false;
  const unsubscribeWaits = store.subscribe((line) => {
    if (line.kind !== "message" || line.record.author.kind !== "person" || waitsQueued) return;
    waitsQueued = true;
    queueMicrotask(() => {
      waitsQueued = false;
      live.trackWaits();
    });
  });
  const autoSendWatch = setInterval(autoSendSweep, options.autoSendSweepMs ?? INBOX_AUTO_SEND_SWEEP_MS);
  (autoSendWatch as { unref?: () => void }).unref?.();
  // The sidebar's "Reload Claude Code N" is pushed as it changes (a session restarts, goes away, or an update lands).
  let lastRestartCount = "";
  const restartWatch = setInterval(() => {
    const count = JSON.stringify(live.restartAgents());
    if (count === lastRestartCount) return;
    lastRestartCount = count;
    for (const listener of statusListeners) listener();
  }, INBOX_RESTART_WATCH_MS);
  (restartWatch as { unref?: () => void }).unref?.();

  // The list rows' delivery (approval "inbox-row-delivery"): the store reads the live sessions for it.
  store.setDeliveryPresence({
    connection: live.deliveryConnectionOf,
    askerLive: live.askerLive,
    // A Codex reply whose `codex queue` ran out of time may not have gone: its row says it is saved, not queued.
    uncertain: (session, itemId) => codexWake.uncertain(session, itemId) || qwenWake.uncertain(session, itemId),
    autoSendAfterMs: live.autoSendAfterMs,
    waitOf: live.waitOf,
  });
  // A session's turn starting or ending, its connection going away, or an asker grace running out moves a
  // row's delivery without writing a store line. The sessions' delivery signature is compared on a short
  // timer, only while a window listens, and `event: deliveries` tells the windows to read the list again.
  const deliveryListeners = new Set<() => void>();
  let lastDeliverySignature = "";
  const deliveryWatch = setInterval(() => {
    if (deliveryListeners.size === 0) return;
    const signature = live.deliverySignature();
    if (signature === lastDeliverySignature) return;
    lastDeliverySignature = signature;
    for (const listener of deliveryListeners) listener();
  }, INBOX_DELIVERY_WATCH_MS);
  (deliveryWatch as { unref?: () => void }).unref?.();

  const tagsRoute = createInboxTagsRoute({ store, serverSession, live, json });

  // Compose: a new thread the person starts with a live agent, drafts and uploads (packages/server/inbox-compose.ts).
  const compose = createInboxCompose({
    store,
    serverSession,
    live,
    resolveProject,
    readBody: (req) => readBody(req),
    json,
    boardOn,
  });
  compose.sweep();
  // Reply drafts: the words typed in a thread's reply box, kept per thread (packages/server/inbox-reply-drafts.ts).
  const replyDrafts = createInboxReplyDrafts({
    store,
    serverSession,
    readBody: (req) => readBody(req),
    json,
    onChange: (threadId) => {
      for (const listener of draftListeners) listener(threadId);
    },
  });
  // Pins: threads pinned to the window's sidebar (packages/server/inbox-pins.ts). A deletion's prune tells the windows too.
  const pins = createInboxPins({ store, serverSession, readBody: (req) => readBody(req), json });
  // Live HTML embeds (approval "inbox-inline-html"): the documents the window frames for a message's ```html fences (inbox-embeds.ts).
  const embeds = createInboxEmbeds({ readBody: (req) => readBody(req), json });
  // The sidebar's Feedback dialog: forwards what the person typed to the feedback Worker (inbox-feedback.ts).
  const feedback = createInboxFeedback({ version, json, ...(options.feedbackUrl ? { url: () => options.feedbackUrl! } : {}) });
  const stopPinEvents = store.onPinsChange(() => {
    for (const listener of pinListeners) listener();
  });
  const uploadSweep = setInterval(() => compose.sweep(), INBOX_UPLOAD_SWEEP_MS);
  (uploadSweep as { unref?: () => void }).unref?.();

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

  /** "Open in" for attachments: launches an app on this computer, so local only (never the tailnet, never the device door). */
  const openInRoute = createInboxOpenInRoute({
    store,
    serverSession,
    readBody,
    json,
    localOnly,
    launcher: options.openInLauncher ?? systemOpenInLauncher(),
  });

  // Tidy (packages/server/inbox-tidy.ts): the list header's and the Board's ⋮ menu.
  const tidy = createInboxTidy({
    store,
    serverSession,
    deliveryConnectionOf: (session) => live.deliveryConnectionOf(session),
    // The last idle transition, kept through a busy turn and the session's end (not the live idle_since).
    idleSince: (session) => live.lastIdleOf(session),
    mcpAgents: () => live.mcpAgents(),
    boardOn,
    readBody,
    json,
  });

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
    /** The Board's reads carry the person's notes: another site's read is refused, as on the other read routes. */
    const crossSiteCardRead = (request: Request): Response | null =>
      isSameOriginOrNoOrigin(origin, request.headers.get("host") ?? "", request.headers.get("sec-fetch-site"))
        ? null
        : json({ error: "Cross-origin requests are not accepted.", code: "cross_origin" }, 403);

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
      // The Board off: `card` is not listed, and a session that listed it while it was on gets
      // board_off (a tool result, as any refusal) instead of "unknown tool". Nothing is written.
      if (req.method === "POST" && !boardOn()) {
        const refused = await boardOffCardCall(req.clone());
        if (refused) return refused;
      }
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
        // `plannotator inbox stop` names its data dir: a copied data dir's record names this
        // Inbox too, and its stop must not end this one. No body (an older CLI) stops, as before.
        const request = (await req.json().catch(() => null)) as { data_dir?: unknown } | null;
        if (typeof request?.data_dir === "string" && !isOwnDataDir(dataDir, request.data_dir)) {
          return json({ error: "This Inbox runs on another data dir.", code: "not_ours" }, 409);
        }
        // Read before the stop: `plannotator inbox restart` passes a run published only by
        // `--tailscale` on to the next start, as the window's Restart does (additive).
        const tailscaleRunOnly = tailscale.runOnly();
        if (!stopRequested) {
          stopRequested = true;
          setTimeout(() => {
            stop();
            options.onStopRequested?.();
          }, 50);
        }
        return json({ ok: true, stopping: true, tailscale_run_only: tailscaleRunOnly });
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

    // The onboarding tour's fixture and assets (inbox-tour.ts): read only, served from the binary on demand.
    const tourAnswer = await handleInboxTourRequest(req, path);
    if (tourAnswer) return tourAnswer;

    try {
      if (path === "/api/inbox/health" && req.method === "GET") return json(health());
      if (path === "/api/inbox/threads" && req.method === "GET") return json(listModel(projectFilterOf(url), archivedModeOf(url)));
      if (path === "/api/inbox/threads/archived" && req.method === "GET") return json(archivedModel(url));
      // Decision mode (experimental, approval "inbox-decision-mode"): a read-only projection of every
      // decision waiting on the person. Off (the default), the route does not exist.
      if (path === "/api/inbox/decisions") {
        if (!decisionModeOn()) return json({ error: "Not found", code: "not_found" }, 404);
        if (req.method !== "GET") return json({ error: "Use GET." }, 405);
        // Another site's page must not read (or time) what waits on the person.
        if (!isSameOriginOrNoOrigin(origin, req.headers.get("host") ?? "", req.headers.get("sec-fetch-site"))) {
          return json({ error: "Cross-origin requests are not accepted.", code: "cross_origin" }, 403);
        }
        // Each decision's project carries its repo (as a thread does), so refs on its card link there.
        const decisions = store.openDecisions({ projectId: projectFilterOf(url) }).map((decision) => {
          const root = store.project(decision.thread.project.id)?.root;
          return { ...decision, thread: { ...decision.thread, project: { ...decision.thread.project, repo: root ? repos.get(root) : null } } };
        });
        return json({ serverSession, cursor: store.cursor(), decisions });
      }
      if (path === "/api/inbox/projects" && req.method === "GET") return json({ serverSession, cursor: store.cursor(), projects: projectFolders() });
      // Tidy: who it would ask (GET) and asking them (POST).
      const tidied = await tidy.route(req, url);
      if (tidied) return tidied;
      // A hover card's data for an issue, PR or MR link (ref-cards.ts). Read only, the window's own
      // read guard; the owner over the tailnet gets it too. Never on the device door (not in its
      // allowlist), so nothing of it reaches a phone or the relay.
      if (path === "/api/inbox/ref") {
        if (req.method !== "GET") return json({ error: "Use GET." }, 405);
        if (!isSameOriginOrNoOrigin(origin, req.headers.get("host") ?? "", req.headers.get("sec-fetch-site"))) {
          return json({ error: "Cross-origin requests are not accepted.", code: "cross_origin" }, 403);
        }
        const href = url.searchParams.get("url") ?? "";
        if (href.length > 2048) throw new InboxError("validation_error", "url: at most 2048 characters.", { field: "url" });
        const result = await refCards.get(href);
        if (!result) throw new InboxError("validation_error", "url: an https link to an issue, pull request or merge request.", { field: "url" });
        return json({ serverSession, ...result });
      }
      if (path === "/api/inbox/events" && req.method === "GET") {
      // Another site's page must not hold (or time) a stream of everything the Inbox holds:
      // refused like the other read routes. The phone's door and agents send no fetch metadata.
      if (!isSameOriginOrNoOrigin(origin, req.headers.get("host") ?? "", req.headers.get("sec-fetch-site"))) {
        return json({ error: "Cross-origin requests are not accepted.", code: "cross_origin" }, 403);
      }
      return eventStream(req, url, via);
    }
      // A window's report: its browser's notification permission for its own origin changed (inbox-windows.ts).
      if (path === "/api/inbox/window") {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        const windowId = parseWindowId(body.window);
        if (!windowId) throw new InboxError("validation_error", "window: 8 to 64 letters, digits, - or _.", { field: "window" });
        // The tab closed (its pagehide beacon, or the tab that holds the shared stream saw it go): it stops counting.
        if (body.gone === true) {
          windows.leave(windowId);
          return json({ notify_reach: windows.reach(notificationsState().enabled) });
        }
        const permission = parseWindowPermission(body.permission);
        if (!permission) throw new InboxError("validation_error", "permission: granted, default, denied or unsupported.", { field: "permission" });
        // `served_by` (additive): the tab whose event stream this tab listens to (tabs share one stream).
        const servedBy = body.served_by === undefined || body.served_by === null ? null : parseWindowId(body.served_by);
        if (body.served_by !== undefined && body.served_by !== null && !servedBy) {
          throw new InboxError("validation_error", "served_by: 8 to 64 letters, digits, - or _.", { field: "served_by" });
        }
        windows.report(windowId, { permission, origin: parseWindowOrigin(body.origin), via, servedBy });
        return json({ notify_reach: windows.reach(notificationsState().enabled) });
      }
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
      // this computer, so none of it answers a page that came through the tailnet;
      // nor does the What's new page, nor its images (inbox-whats-new-images.ts).
      if (
        path === "/api/inbox/update" ||
        path.startsWith("/api/inbox/update/") ||
        path === "/api/inbox/whats-new" ||
        path === INBOX_WHATS_NEW_IMAGE_PATH
      ) {
        if (via === "tailnet") return localOnly();
        // A stored image of a release's notes: read only, never fetched here.
        if (path === INBOX_WHATS_NEW_IMAGE_PATH) return whatsNewImageRoute(req, url, dataDir);
        if (path === "/api/inbox/whats-new") {
          if (req.method !== "GET") return json({ error: "Use GET." }, 405);
          // Notes this machine never saved (a version installed outside the
          // Inbox) are fetched by the release's tag, waited for at most 3 s;
          // past that the page is told to ask again (503 notes_loading).
          const answer = await updates.whatsNew(url.searchParams.get("version") ?? "");
          if (answer.kind === "notes") return json(answer.notes);
          if (answer.kind === "loading") {
            const res = json({ error: "Fetching the release notes…", code: "notes_loading", retry_after_ms: 1000 }, 503);
            res.headers.set("Retry-After", "1");
            return res;
          }
          return json({ error: "No release notes for that version.", code: "notes_not_found" }, 404);
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
        if (
          body.inbox_tool === undefined &&
          body.notifications === undefined &&
          body.sound === undefined &&
          body.tailscale === undefined &&
          body.theme === undefined &&
          body.text_size === undefined &&
          body.diff_style === undefined &&
          body.experimental === undefined &&
          body.tour === undefined &&
          body.prompts === undefined &&
          body.board === undefined &&
          body.cookie_host === undefined &&
          !updateSwitches
        ) {
          throw new InboxError("validation_error", "body: inbox_tool, notifications, sound, tailscale, theme, text_size, diff_style, experimental, tour, prompts, board, update_check, auto_update or cookie_host is required.");
        }
        // The Board changes what agents on this computer are offered (the card tool): changed only here.
        if (body.board !== undefined && via === "tailnet") return localOnly();
        // Updating changes this computer: never from a page that came through the tailnet.
        if (updateSwitches && via === "tailnet") return localOnly();
        // The reminder goes to every agent session on this computer: changed only here, like Settings → Agents.
        if (body.prompts !== undefined && via === "tailnet") return localOnly();
        // The address this computer's browser opens: never from a page that came through the tailnet.
        if (body.cookie_host !== undefined && via === "tailnet") return localOnly();
        const promptsChange = body.prompts === undefined ? undefined : parseInboxPromptsChange(body.prompts);
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
        if (body.text_size !== undefined) saveTextSize(body.text_size, true);
        if (body.diff_style !== undefined) saveDiffStyle(body.diff_style, true);
        if (body.experimental !== undefined) saveExperimental(body.experimental, true);
        if (body.tour !== undefined) saveTour(body.tour, true);
        if (body.board !== undefined) saveBoard(body.board, true);
        if (body.cookie_host !== undefined) saveCookieHostSwitch(body.cookie_host, true);
        const tailnet = tailscaleChange === undefined ? tailscale.state() : tailscale.set(tailscaleChange.on, { via, replaceExposed: tailscaleChange.replaceExposed });
        // After the tailnet change, so a tailnet refusal saves nothing; the cookie switch can be
        // refused too (the env var, another urlHost), so it comes before the other saves.
        const cookieHost = body.cookie_host === undefined ? undefined : saveCookieHostSwitch(body.cookie_host);
        const notifications = body.notifications === undefined ? notificationsState() : saveNotifications(body.notifications);
        const sound = body.sound === undefined ? soundState() : saveSound(body.sound);
        const inboxTool = body.inbox_tool === undefined ? inboxToolState() : saveInboxTool(body.inbox_tool);
        const updateState = updateSwitches ? saveUpdateSwitches(body) : updatesState();
        if (updateSwitches) updates.refresh();
        const theme = body.theme === undefined ? themeState() : saveTheme(body.theme);
        const textSize = body.text_size === undefined ? textSizeState() : saveTextSize(body.text_size);
        const diffStyle = body.diff_style === undefined ? diffStyleState() : saveDiffStyle(body.diff_style);
        const experimental = body.experimental === undefined ? experimentalState() : saveExperimental(body.experimental);
        const tour = body.tour === undefined ? tourState() : saveTour(body.tour);
        const board = body.board === undefined ? { on: boardOn() } : saveBoard(body.board);
        if (promptsChange) saveInboxPromptsChange(promptsChange);
        return json({ inbox_tool: inboxTool, notifications, sound, tailscale: tailnet, updates: updateState, theme, text_size: textSize, diff_style: diffStyle, experimental, tour, board, prompts: promptsState(via), ...(via === "local" ? { cookie_host: cookieHost ?? cookieHostWire() } : {}) });
      }
      // The one-time sound dialog: the page asks to show it, and only the first ask ever gets `show: true`.
      if (path === "/api/inbox/sound/dialog") {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        const show = claimSoundDialog(via);
        return json({ show, sound: soundState() });
      }

      // The Board's first-visit dialog (approval "inbox-board", intro amendment): the first page on this
      // computer to open the Board claims it, once per machine (config.json `inboxBoardIntro.shownAt`);
      // a page reached over the tailnet never claims it.
      if (path === "/api/inbox/board/intro") {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        // Only once the Board is on: the dialog introduces a page the person can see.
        if (via !== "local" || !boardOn() || loadConfig().inboxBoardIntro?.shownAt) return json({ show: false });
        const at = new Date().toISOString();
        saveConfig({ inboxBoardIntro: { shownAt: at } });
        // Not written (a read-only data dir): showing it anyway would show it on every visit.
        return json({ show: loadConfig().inboxBoardIntro?.shownAt === at });
      }

      // Search: a read route (and the recent searches the window writes on opening a result).
      const searched = await search.handle(req, url);
      if (searched) return searched;
      // The composers' skill picker and the SKILL.md a Send pastes in (inbox-skills.ts): read routes.
      const skills = inboxSkillsRoute(req, url);
      if (skills) return skills;

      // Compose: live sessions in every project, a new thread, Send to another session, drafts and uploads.
      const composed = await compose.route(req, url);
      if (composed) return composed;
      // Reply drafts: the reply box's words per thread (approval "inbox-reply-drafts").
      const drafted = await replyDrafts.route(req, url);
      if (drafted) return drafted;
      // Pins (approval "inbox-pinned-threads"): pin, unpin and the order of the sidebar's pinned threads.
      const pinned = await pins.route(req, url);
      if (pinned) return pinned;
      // Live HTML embeds: keep a fence's page, and serve it under its own sandboxing policy.
      const embedded = await embeds.route(req, url);
      if (embedded) return embedded;
      // Feedback (the sidebar's Feedback dialog): sent on, never stored here. The owner's only: a
      // tailnet guest's words would go out as this computer's (its version, OS, IP and rate limit).
      if (path === INBOX_FEEDBACK_PATH && via === "tailnet" && !tailscale.isOwnerRequest(req.headers)) {
        throw new InboxError("owner_only", "Only this computer's owner can send feedback from this Inbox.");
      }
      const fed = await feedback.route(req, path);
      if (fed) return fed;

      // The Board's cards (approval "inbox-board", step 1): the person's read and moves.
      if (path === "/api/inbox/cards") {
        // Cards carry the person's notes: another site's read is refused, as on the other read routes.
        if (req.method === "GET") return crossSiteCardRead(req) ?? json(cardsModel(url));
        if (req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
        // The person's New card (step 2): a title, notes and links, in Backlog (sent to no agent) or the
        // Icebox; or sent to an agent: `thread_id` is the thread the window just started for it with
        // compose's Send (its body the notes), and the card lands in that thread's project, sent.
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        const column = body.column === undefined || body.column === null ? "backlog" : body.column;
        if (column !== "backlog" && column !== "icebox") throw new InboxError("validation_error", "column: backlog or icebox (a New card).", { field: "column" });
        let projectId: unknown = body.project;
        if (body.thread_id !== undefined && body.thread_id !== null) {
          if (column !== "backlog") throw new InboxError("validation_error", "thread_id: a card sent to an agent starts in Backlog.", { field: "thread_id" });
          const message = typeof body.thread_id === "string" ? store.message(body.thread_id) : null;
          if (!message) throw new InboxError("thread_not_found", `No thread ${String(body.thread_id)}.`);
          projectId = message.project_id;
        }
        if (!isInboxId("prj", projectId)) throw new InboxError("validation_error", "project: a prj_ id.", { field: "project" });
        if (!store.project(projectId)) throw new InboxError("project_not_found", `No project ${projectId}.`);
        const refs = body.refs === undefined || body.refs === null ? [] : body.refs;
        if (!Array.isArray(refs)) throw new InboxError("validation_error", "refs: a list of issue or PR links.", { field: "refs" });
        // One store op: the send is checked before the card is written, so a refused thread leaves no card.
        const made = store.createCard({
          project_id: projectId,
          by: { kind: "person" },
          title: body.title,
          column,
          notes: body.notes,
          refs,
          idempotency_key: body.idempotency_key,
          send_thread_id: body.thread_id ?? undefined,
        });
        return json({ card: store.cardWire(made.card), replayed: made.replayed });
      }
      // The person opened the Board: the look runs through the store's cursor when that Board was read (never back, never ahead).
      if (path === "/api/inbox/cards/seen") {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        if (!isInboxBoardSeq(body.through_seq)) throw new InboxError("validation_error", "through_seq: the cursor of the Board read the person saw (a whole number).", { field: "through_seq" });
        return json({ seen_seq: writeInboxBoardSeen(store.dir, body.through_seq, store.cursor()) });
      }
      // The person looked at Dropped: an agent's drops there are seen (in `project`, or everywhere).
      if (path === "/api/inbox/cards/dropped/seen") {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        let projectIds: Set<string> | null = null;
        if (body.project !== undefined && body.project !== null) {
          if (!isInboxId("prj", body.project)) throw new InboxError("validation_error", "project: a prj_ id.", { field: "project" });
          if (!store.project(body.project)) throw new InboxError("project_not_found", `No project ${body.project}.`);
          projectIds = new Set([body.project]);
        }
        // The drops the window showed the person: a drop that landed after the page drew is not seen.
        const ids = body.cards;
        if (!Array.isArray(ids) || ids.length > 1000 || ids.some((id) => !isInboxId("crd", id))) {
          throw new InboxError("validation_error", "cards: the crd_ ids of the drops the person was shown (at most 1000).", { field: "cards" });
        }
        return json({ cards: store.markCardDropsSeen(projectIds, new Set(ids as string[])).map((card) => store.cardWire(card)) });
      }
      // The lane cards' marks (inbox-card-marks.ts): the state of each card's one marked link, for the
      // cards on screen. Only this computer's window, only while the Board is on; never on the device
      // door (not on its allowlist). Read only; it runs gh / glab, so another site is refused first.
      if (path === "/api/inbox/cards/marks") {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        if (via === "tailnet") return localOnly();
        const refused = crossSiteCardRead(req);
        if (refused) return refused;
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        if (!boardOn()) return json({ error: "The Board is off.", code: "board_off" }, 409);
        const ids = body.cards;
        if (!Array.isArray(ids) || ids.length > INBOX_CARD_MARKS_MAX || ids.some((id) => !isInboxId("crd", id))) {
          throw new InboxError("validation_error", `cards: the crd_ ids of the cards on screen (at most ${INBOX_CARD_MARKS_MAX}).`, { field: "cards" });
        }
        const wanted: { id: string; ref: InboxCardRef }[] = [];
        for (const id of new Set(ids as string[])) {
          const card = store.card(id);
          const ref = card ? inboxCardMarkRef(card) : null;
          if (ref) wanted.push({ id, ref });
        }
        const resolved = await cardMarks.marks(
          wanted.map((w) => w.ref),
          { refresh: body.refresh === true },
        );
        const marks: Record<string, InboxCardMark> = {};
        for (const { id, ref } of wanted) {
          const mark = resolved.get(ref.url);
          if (mark) marks[id] = mark;
        }
        return json({ serverSession, marks });
      }
      // The opened card's links, resolved now (read only; each source's resolver, inbox-card-refs.ts).
      // Never on the device door, like /api/inbox/ref.
      const refsMatch = /^\/api\/inbox\/cards\/([A-Za-z0-9_]+)\/refs$/.exec(path);
      if (refsMatch) {
        if (req.method !== "GET") return json({ error: "Use GET." }, 405);
        const refused = crossSiteCardRead(req);
        if (refused) return refused;
        const card = store.card(refsMatch[1]!);
        if (!card) throw new InboxError("card_not_found", `No card ${refsMatch[1]}.`);
        return json({ serverSession, refs: await resolveInboxCardRefs(inboxCardRefsOf(card), cardRefResolvers) });
      }
      const cardMatch = /^\/api\/inbox\/cards\/([A-Za-z0-9_]+)$/.exec(path);
      if (cardMatch && req.method === "GET") {
        const refused = crossSiteCardRead(req);
        if (refused) return refused;
        // The opened card: the card and its history, newest first, and (additive) its own
        // project's repo, so `#123` and `owner/repo#123` in its text link as in a thread.
        const card = store.card(cardMatch[1]!);
        if (!card) throw new InboxError("card_not_found", `No card ${cardMatch[1]}.`);
        const root = store.project(card.project_id)?.root;
        return json({ serverSession, card: store.cardWire(card), history: store.cardHistory(card.id), repo: root ? repos.get(root) : null });
      }
      if (cardMatch) {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        return json({ card: store.cardWire(personCardMove(cardMatch[1]!, body)) });
      }

      const threadMatch = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)$/.exec(path);
      if (threadMatch && req.method === "GET") {
        // The window's thread: each message's seq (what is new since the last look) and a reply's sent annotations.
        // Images the messages show with no captured file yet: copied in the background; the read never waits (approval "inbox-image-viewer").
        if (store.thread(threadMatch[1]!)) imageCapture.schedule(threadMatch[1]!);
        const thread = store.windowThread(threadMatch[1]!);
        if (!thread) return json({ error: "No such thread.", code: "thread_not_found" }, 404);
        const withRepo = { ...thread, project: { ...thread.project, repo: repos.get(thread.project.root) } };
        // `row` (additive): the thread's list row, also for an archived thread, which the window's list leaves out.
        return json({ serverSession, cursor: store.cursor(), thread: withRepo, row: store.listRow(thread.thread_id) });
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

      // 👍 Looks good (design record "inbox-acknowledge"): silent, nothing sent and no
      // session woken; an ack on the agent's latest message and a Mark read.
      // `{ ack: false }` takes it back (the toast's Undo, the pressed button).
      const ackMatch = /^\/api\/inbox\/messages\/([A-Za-z0-9_]+)\/ack$/.exec(path);
      if (ackMatch) {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        if (body.ack !== undefined && typeof body.ack !== "boolean") throw new InboxError("validation_error", "ack: must be a boolean.", { field: "ack" });
        const on = body.ack !== false;
        const result = store.ackMessage(ackMatch[1]!, on);
        if (on) scheduleAckSettle();
        return json(result);
      }

      // An action item: the person's Done (with an optional note) or Can't do it
      // (with a reason). `staged: true` (the window; approval
      // "inbox-action-items-in-reply") puts it in the reply draft, sent with the
      // person's Send; without it (approval "inbox-next-actions") it is sent once
      // the Undo window passes. `{ outcome: null }` takes it back. `note_only`
      // (a note typed under the marked row) never marks an item taken back.
      const actionMatch = /^\/api\/inbox\/messages\/([A-Za-z0-9_]+)\/actions\/(a-[0-9a-f]{8}(?:-\d{1,3})?)$/.exec(path);
      if (actionMatch) {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        const questions = store.markAction(actionMatch[1]!, actionMatch[2]!, { outcome: body.outcome, note: body.note, staged: body.staged, note_only: body.note_only });
        // A staged mark waits for the person's Send: no timer.
        if (body.outcome !== null && body.staged !== true) scheduleActionSettle();
        return json({ questions });
      }

      // The project menu (design record "inbox-project-menu"): Mark all as
      // read and Archive all on one project, and their Undo. Loops over the
      // single actions (packages/shared/inbox/project-batch.ts); the same
      // guards as every window write. On the phone's door too (contract
      // 7.43 to 7.45), whose idempotency log replays a batch's answer.
      const projectBatchMatch = /^\/api\/inbox\/projects\/([A-Za-z0-9_]+)\/(read|unread|resolve)$/.exec(path);
      if (projectBatchMatch) {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        const projectId = projectBatchMatch[1]!;
        if (!isInboxId("prj", projectId)) throw new InboxError("validation_error", "A project id (prj_).", { field: "project" });
        if (!store.project(projectId)) throw new InboxError("project_not_found", `No project ${projectId}.`);
        const action = projectBatchMatch[2]!;
        const batchId = batchIdOf(body);
        const route = `${action}:${projectId}:${action === "resolve" ? String(body.resolved !== false) : ""}`;
        if (batchId !== null) {
          const seen = batches.get(batchId);
          if (seen && seen.route !== route) throw new InboxError("batch_id_reused", "This batch_id answered another request.");
          if (seen) return json({ ...(seen.answer as object), replayed: true });
        }
        const rows = (ids: readonly string[]) => ids.map((id) => store.listRow(id)).filter((row): row is InboxListRow => row !== null);
        const folder = () => projectFolders().find((p) => p.id === projectId) ?? null;
        let answer: Record<string, unknown>;
        // A batch that stopped partway (a write failed): the threads it changed get their notes, and the
        // answer names them with `error`, so the window offers Undo for what did apply and says the rest
        // did not change. The cause goes to stderr, never the page.
        const incomplete = (error: string | undefined) => {
          if (error === undefined) return {};
          process.stderr.write(`Inbox: the project menu's batch on ${projectId} stopped partway: ${error}\n`);
          return { error: { code: "batch_incomplete", message: "Stopped partway; the other threads did not change." } };
        };
        if (action === "read") {
          const { error, ...batch } = markProjectRead(store, projectId);
          for (const id of batch.read) scheduleSetAside(id);
          answer = { project: folder(), batch, threads: rows(batch.read), ...incomplete(error) };
        } else if (action === "unread") {
          const ids = threadIdList(body.threads, "threads");
          const result = unmarkProjectRead(store, projectId, ids);
          answer = { project: folder(), threads: rows(result.done), skipped: result.skipped };
        } else {
          if (body.resolved !== undefined && typeof body.resolved !== "boolean") throw new InboxError("validation_error", "resolved: must be a boolean.", { field: "resolved" });
          if (body.resolved !== false) {
            const { error, ...batch } = archiveProject(store, projectId);
            // A came-back thread sent back by Mark read: its set-aside note, as for the single action.
            for (const id of batch.read) scheduleSetAside(id);
            answer = { project: folder(), batch, threads: rows([...batch.resolved, ...batch.read]), ...incomplete(error) };
          } else {
            const named = body.threads;
            if (!named || typeof named !== "object" || Array.isArray(named)) {
              throw new InboxError("validation_error", "threads: { resolved: [ids], read: [ids] } from the batch to undo.", { field: "threads" });
            }
            const { resolved, read } = named as Record<string, unknown>;
            const undo = { resolved: threadIdList(resolved, "threads.resolved"), read: threadIdList(read, "threads.read") };
            const result = unarchiveProject(store, projectId, undo);
            // Unarchived: a Mark read's set-aside note an archive held back is due again (as for the single Unarchive).
            for (const id of undo.resolved) if (result.done.includes(id)) scheduleSetAside(id);
            // An action item's Done an archive held back is sent once the thread is open again.
            if (result.done.length > 0) {
              settleActions();
              if (store.actionsPending() > 0) scheduleActionSettle();
            }
            answer = { project: folder(), threads: rows(result.done), skipped: result.skipped };
          }
        }
        rememberBatch(batchId, route, answer);
        return json({ ...answer, replayed: false });
      }

      // Guided reviews (step 5): the snapshot a message carries (packages/server/inbox-guides.ts).
      const guide = await inboxGuideRoute(req, path, store, serverSession);
      if (guide) return guide;

      // Undo a hand-off inside its window (approval "inbox-tag-handoff"): the reply goes as an Ask instead.
      const handoffUndo = /^\/api\/inbox\/messages\/([A-Za-z0-9_]+)\/handoff\/undo$/.exec(path);
      if (handoffUndo) {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        return json({ message: store.undoHandoff(handoffUndo[1]!) });
      }

      const messageMatch = /^\/api\/inbox\/messages\/([A-Za-z0-9_]+)\/(picks|reply|reask|resolve)$/.exec(path);
      if (messageMatch) {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        const messageId = messageMatch[1]!;
        switch (messageMatch[2]) {
          case "picks": {
            // `unsent_only` (decision mode): a pick that raced the Send of its reply never reopens what went.
            if (body.unsent_only !== undefined && typeof body.unsent_only !== "boolean") {
              throw new InboxError("validation_error", "unsent_only: a boolean.", { field: "unsent_only" });
            }
            const questions = store.savePicks(messageId, body.questions as never, { unsentOnly: body.unsent_only === true });
            return json({ message_id: messageId, questions, reply: null });
          }
          case "reply": {
            // The session that asked has ended and the person picked another
            // live session to take the reply: checked here as New message
            // checks its session (null: not live, 409 and nothing written).
            // An unknown message is the store's 404, never "not live".
            const asked = body.to === undefined ? undefined : store.message(messageId);
            const to = body.to === undefined || !asked ? undefined : live.replyTarget(asked.thread_id, body.to);
            // The sessions the person tagged with `@` (approval "inbox-tag-agents"): each one live
            // with a connection that understands tags, or an MCP agent the Inbox knows; any other
            // is refused before anything is written. A replay answers what it wrote, as it was.
            const tagKey = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
            const tagged =
              body.tags === undefined || body.tags === null || (tagKey && store.replyByKey(messageId, tagKey)) ? undefined : tagModes(messageId, body.tags);
            const tags = tagged?.tags;
            const handoff = tagged?.handoff;
            // Files the person pasted into the reply box: their uploads become
            // attachments on the reply, exactly as compose's become a thread's.
            // A replay answers the reply it wrote before anything is copied
            // (its uploads are gone by then); the rest checks the message first.
            const uploads = body.uploads === undefined || body.uploads === null ? [] : body.uploads;
            if (!Array.isArray(uploads)) throw new InboxError("validation_error", "uploads: a list of upload ids.", { field: "uploads" });
            const replayKey = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
            const fresh = uploads.length > 0 && !store.replyByKey(messageId, replayKey);
            if (fresh && !store.message(messageId)) throw new InboxError("message_not_found", `No message ${messageId}.`);
            const attachments = fresh ? inboxUploadAttachments(store.dir, uploads, new Date().toISOString()) : [];
            let result: ReturnType<typeof store.sendReply>;
            try {
              result = store.sendReply(messageId, {
                ...(attachments.length > 0 ? { attachments } : {}),
                ...(to === undefined ? {} : { to }),
                ...(tags && tags.length > 0 ? { tags } : {}),
                ...(handoff ? { handoff } : {}),
                words: typeof body.words === "string" ? body.words : undefined,
                questions: (body.questions as never) ?? [],
                idempotency_key: body.idempotency_key as string,
                feedback: typeof body.feedback === "string" ? body.feedback : undefined,
                annotation_ids: body.annotation_ids as never,
                // The questions the person chose to skip ("Skip them"): only these. The old
                // `skip_unanswered` flag is ignored (approval "inbox-explicit-skip", 2026-10-21).
                skip: body.skip,
                actions: body.actions,
              });
            } catch (error) {
              removeInboxAttachmentFiles(store.dir, attachments);
              // A skip-only Send whose questions closed meanwhile: a no-op, so
              // the rest of a Send to several sessions still goes.
              if (error instanceof InboxError && error.code === "nothing_to_send") {
                return json({ message_id: messageId, questions: store.questionsOf(messageId), reply: null, replayed: false, nothing_to_send: true });
              }
              throw error;
            }
            // The Send that carried the reply box's words: its draft goes (a replay too, since the first one sent them),
            // while it is the draft those words were saved as (`updated_at`) or holds exactly those words, so another
            // window's newer, different draft stays.
            if (typeof body.clear_draft === "string") {
              const threadId = store.message(messageId)?.thread_id;
              const words = typeof body.words === "string" ? body.words : undefined;
              if (threadId && store.clearSentReplyDraft(threadId, body.clear_draft, words)) for (const listener of draftListeners) listener(threadId);
            }
            // A hand-off waits out its Undo window, then goes to both sessions.
            if (!result.replayed && result.reply.handoff) scheduleHandoffSettle();
            if (result.replayed) removeInboxAttachmentFiles(store.dir, attachments);
            // Sent: the uploads are the reply's attachments now.
            else if (attachments.length > 0) removeInboxUploads(store.dir, uploads.filter((id): id is string => typeof id === "string"));
            return json({
              message_id: messageId,
              questions: store.questionsOf(messageId),
              reply: result.reply,
              replayed: result.replayed,
            });
          }
          case "reask": {
            // Re-ask (approval "inbox-reask"): a note asking the session that
            // wrote this message for its open questions again, in one message.
            // `to`: another live session, because the one that asked has ended
            // (checked as a reply's is; null: not live, 409, nothing written).
            const asked = body.to === undefined ? undefined : store.message(messageId);
            const to = body.to === undefined || !asked ? undefined : live.replyTarget(asked.thread_id, body.to);
            const result = store.sendReask(messageId, {
              idempotency_key: body.idempotency_key as string,
              ...(to === undefined ? {} : { to }),
            });
            return json({
              message_id: messageId,
              questions: store.questionsOf(messageId),
              reply: result.reply,
              replayed: result.replayed,
            });
          }
          case "resolve": {
            if (body.resolved !== undefined && typeof body.resolved !== "boolean") {
              throw new InboxError("validation_error", "resolved: must be a boolean.");
            }
            const thread = store.resolveThread(messageId, body.resolved !== false);
            // Unarchived: a Mark read's set-aside note an archive held back is due again.
            if (body.resolved === false) {
              scheduleSetAside(thread.thread_id);
              // An action item's Done an archive held back (archived inside its Undo window) is sent now, or when its window passes.
              settleActions();
              if (store.actionsPending() > 0) scheduleActionSettle();
            }
            return json({ thread });
          }
        }
      }

      if (path === "/" && (req.method === "GET" || req.method === "HEAD")) {
        // One origin: notification permission is per origin (inbox-canonical.ts).
        const canonical = inboxCanonicalRedirect(req, url, baseUrl, via);
        if (canonical) return canonical;
        const page = options.htmlContent ?? NOT_BUILT_PAGE;
        // A page load (or a refresh) asks for a new release when the answer is
        // over a minute old: fire-and-forget, the button follows on the event stream.
        if (req.method === "GET") updates.nudge();
        if (via === "tailnet") return tailnetWindowPage(req, page);
        return new Response(req.method === "HEAD" ? null : page, {
          headers: { ...WINDOW_PAGE_HEADERS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      if (path === "/favicon.png" && req.method === "GET") return handleFavicon();

      // Step 8: the live sessions of a thread's project, and New message.
      const newMessage = await live.route(req, path);
      if (newMessage) return newMessage;
      // Tags (approval "inbox-tag-agents"): who the person can tag with `@` (packages/server/inbox-tags.ts).
      const taggable = tagsRoute.route(req, path);
      if (taggable) return taggable;

      // #1813: an image a message's body shows, read from wherever it is on this
      // computer outside the home folder's hidden folders (packages/server/inbox-message-images.ts).
      const image = await inboxMessageImageRoute(req, url, store);
      if (image) return image;

      // "Open in": an attachment in its own app, by id only (packages/server/inbox-open-in.ts).
      const opened = await openInRoute(req, path, via);
      if (opened) return opened;

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
   *
   * Note on X-Forwarded-For (#1867): a local reverse proxy (e.g. nginx, Caddy,
   * portless) also adds X-Forwarded-For with loopback IP(s). That is NOT tailscale
   * serve exposure. Tailscale serve forwards the peer's tailnet/remote IP. We only
   * treat X-Forwarded-For as tailnet exposure if it contains a non-loopback address.
   */
  const fetch = (req: Request): Promise<Response> => {
    const hasTailscaleHeader = SERVE_IDENTITY_HEADERS.some((name) => req.headers.has(name));
    const forwardedFor = req.headers.get("x-forwarded-for");
    const hasExternalForwardedFor = forwardedFor !== null && !isLoopbackForwardedFor(forwardedFor);

    if (hasTailscaleHeader || hasExternalForwardedFor) {
      tailscale.noteServedRequest();
      return Promise.resolve(localOnly());
    }
    return handle(req, "local");
  };

  attachmentRoutes = createInboxAttachmentRoutes({ store, serverSession, readBody, streamIdleMs: options.streamIdleMs, scheduleImageCapture: imageCapture.schedule });
  const started = startOnLoopback(fetch, previous?.port ?? null);
  server = started.server;
  portChanged = started.portChanged;
  port = server.port as number;
  baseUrl = inboxCanonicalBaseUrl(port);

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
    dispatch: async (req) => markPlannotatorResponse(await handle(req, "tailnet")),
    // Compress the page for the tailnet before the first phone asks (#2032).
    onListen: () => prewarmAppHtml(options.htmlContent ?? NOT_BUILT_PAGE, "br"),
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
    // An ack a stop interrupted inside its Undo window.
    settleAcks();
    if (store.acksPending() > 0) scheduleAckSettle();
    // An action item's Done a stop interrupted inside its Undo window.
    settleActions();
    if (store.actionsPending() > 0) scheduleActionSettle();
    // A hand-off a stop interrupted inside its Undo window.
    settleHandoffs();
    if (store.handoffsPending() > 0) scheduleHandoffSettle();
  }, 0);

  let stopped = false;
  /** The tailnet port whose take-down failed at the stop, for the data-gone message. */
  let tailnetStopFailedPort: number | null = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(dataCheck);
    windows.stop();
    for (const timer of setAsideTimers) clearTimeout(timer);
    setAsideTimers.clear();
    connectStop.abort();
    updates.stop();
    search.dispose();
    // No capture writes after stop (a restart to update starts the next binary on this store).
    imageCapture.stop();
    clearInterval(uploadSweep);
    stopPinEvents();
    clearInterval(restartWatch);
    clearInterval(deliveryWatch);
    clearInterval(autoSendWatch);
    unsubscribeWaits();
    codexWake.stop();
    qwenWake.stop();
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

  return { port, url: baseUrl, token, serverSession, portChanged, store, registry, tailscale, connectAgents, search: search.index, imageCapture, codexWake, qwenWake, stop };
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
