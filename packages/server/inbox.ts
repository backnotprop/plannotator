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
 * route, no `/mcp` and no device door (`via: "tailnet"` below). The rules
 * that are about this computer ask `ownerOrLocal`: the owner over the tailnet
 * has what the computer has, another allowed login does not. A
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
  INBOX_CARD_AUTO_SHIP_COLUMNS,
  inboxCardAutoShip,
  inboxCardColumnOf,
  inboxCardRefsOf,
  inboxCardShipPrs,
  inboxCardMarkRef,
  isInboxCardDropUnseen,
  INBOX_CARD_MARKS_MAX,
  type InboxCardColumn,
  type InboxCardMark,
  type InboxCardRef,
  INBOX_SOUND_DEFAULT_VOLUME,
  INBOX_TEXT_SIZE_DEFAULT,
  INBOX_ROWS_OPTIONS,
  INBOX_TOUR_VERSION,
  type InboxTourChange,
  type InboxTourState,
  INBOX_CODEX_HOST,
  INBOX_QWEN_HOST,
  isQwenSessionId,
  INBOX_T3_HOST,
  isT3ThreadId,
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
  inboxRowsList,
  inboxRowsRead,
  type InboxRowsOption,
  type InboxHealth,
  type InboxLine,
  type InboxListRow,
  type InboxMessage,
  type InboxProject,
  type InboxProjectRepo,
  type InboxTag,
  inboxStepsProgress,
} from "@plannotator/core/inbox-types";
import { checkServerSession, createServerSessionNonce, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import {
  INBOX_REMINDER_HOSTS,
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
  resolveInboxAskAi,
  resolveInboxPhones,
  resolveInboxTool,
  saveConfig,
  configuredInboxTool,
  inboxToolWith,
  configuredInboxReminder,
  resolveInboxReminder,
  type InboxToolHost,
  type PlannotatorConfig,
  type ThemeConfig,
} from "@plannotator/shared/config";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { normalizeStableVersion, readUpdateState } from "@plannotator/shared/update-check";
import { scheduleDailyPing } from "@plannotator/shared/daily-ping";
import { isLoopbackHostHeader, isLoopbackForwardedFor } from "@plannotator/shared/loopback-host";
import { prepareAppHtml, prewarmAppHtml } from "@plannotator/shared/app-html";
import { openPackedApp, packedAppResponse, PACKED_ASSET_ROUTE_PREFIX } from "@plannotator/shared/packed-app";
import type { InboxSearchIndex, InboxSearchIndexOptions } from "@plannotator/shared/inbox/search";
import { createInboxSearchRoutes } from "./inbox-search";
import { inboxSkillsRoute } from "./inbox-skills";
import { isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";
import { isInboxPermissionSession } from "@plannotator/core/inbox-permission";
import { foldCheckoutFolderProjects } from "./inbox-checkout-folders";
import { combineSuggestions, type InboxAgentWork } from "./inbox-combine-suggestions";
import { createInboxTidy } from "./inbox-tidy";
import { createInboxListVersions } from "./inbox-list-delta";
import { debugRoute, INBOX_DEBUG_PATH, resolveInboxDebug } from "@plannotator/shared/inbox/debug-log";
import { perfPhase, retainPerfPhases, watchLoopStalls, withServerTiming } from "./inbox-perf";
import { InboxError, inboxDir } from "@plannotator/shared/inbox/schema";
import { inboxPromptsModel, parseInboxPromptsChange, saveInboxPromptsChange } from "./inbox-prompts";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { INBOX_TIDY_WITHDRAWN_HOST, inboxTidyBodyStepsOff, inboxTidyIsStepsOnly, inboxTidyStepsOnlyWakes } from "@plannotator/shared/inbox/tidy";
import { inboxArchivedRows, inboxListSections, inboxRowArchived } from "@plannotator/shared/inbox/list";
import { archiveProject, markProjectRead, unarchiveProject, unmarkProjectRead } from "@plannotator/shared/inbox/project-batch";
import {
  INBOX_ASK_BRIDGE_PREFIX,
  INBOX_ASK_WAITS_FIELD,
  INBOX_BRIDGE_EVENT_PATH,
  INBOX_BRIDGE_POLL_MAX_MS,
  INBOX_BRIDGE_POLL_PATH,
  inboxHandedAwayLine,
  inboxReaskItemsOf,
  INBOX_MAX_REQUEST_BYTES,
  INBOX_REMOVED_ACTION,
  INBOX_REMOVED_ACTION_TEXT,
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
import { createInboxMcpServer, INBOX_BOARD_OFF_TEXT, INBOX_STEPS_OFF_TEXT } from "./inbox-mcp";
import { inboxGuideRoute, readInboxReviewSnapshot } from "./inbox-guides";
import { parseDiffToFiles } from "@plannotator/core/diff-files";
import { createInboxRepoCache } from "./inbox-repos";
import { createRefCards, type RefRunner } from "./ref-cards";
import { createInboxProjectRoots, folderHoldsOtherWork, guessableProjects, isHomeOrRootFolder, nearestProjectHolding, type InboxGitRunner } from "./inbox-project-root";
import { handleFavicon } from "./shared-handlers";
import { createInboxAttachmentRoutes } from "./inbox-attachments";
import { createInboxImageCapture, inboxMessageImageRoute, type InboxImageCapture } from "./inbox-message-images";
import { createInboxAccountsFor } from "./inbox-accounts";
import { createInboxOpenInRoute, systemOpenInLauncher, type InboxOpenInLauncher } from "./inbox-open-in";
import { recordInboxAttachments, sweepStaleInboxSendTemps } from "@plannotator/shared/inbox/attachments";
import { inboxBodyForAgent, inboxUploadAttachments, removeInboxAttachmentFiles, removeInboxUploads } from "@plannotator/shared/inbox/uploads";
import { createInboxLiveSessions } from "./inbox-sessions";
import { createInboxCodexWake, type InboxCodexWake } from "./inbox-codex-wake";
import { createInboxVoice } from "./inbox-voice";
import { createInboxQwenWake, type InboxQwenWake } from "./inbox-qwen-wake";
import { createInboxT3Wake, type InboxT3Wake, type T3Connect } from "./inbox-t3-wake";
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
import { isWindowRequest } from "./inbox-cross-site";
import { createInboxLaunch } from "./inbox-launch";
import type { LaunchHost, LaunchHostContext } from "./inbox-launch-host";
import { createLoginEnv } from "./inbox-launch-env";
import { createInboxReplyDrafts } from "./inbox-reply-drafts";
import { createInboxAsk } from "./inbox-ask";
import { createInboxReviewDrawings, INBOX_REVIEW_DRAWINGS_PATH } from "./inbox-review-drawings";
import { pruneInboxReviewDrawings } from "@plannotator/shared/inbox/review-drawings";
import type { InboxAskTimes } from "./inbox-ask-live";
import { createInboxPins } from "./inbox-pins";
import { createInboxSnoozes } from "./inbox-snooze";
import { inboxRowAsOf, inboxRowSnoozed, inboxSplitSnoozed } from "@plannotator/core/inbox-snooze";
import { snoozeIntroDue, snoozeIntroFirstUse, type SnoozeIntroSaved } from "./inbox-snooze-intro";
import { revealLastShown, revealMayClaim, revealNext, type RevealId, type RevealState } from "@plannotator/shared/inbox/reveals";
import { createInboxEmbeds } from "./inbox-embeds";
import { createInboxFeedback, INBOX_FEEDBACK_PATH } from "./inbox-feedback";
import { forgeCardRefResolver, resolveInboxCardRefs } from "./inbox-card-refs";
import { createCardFavicons, type CardFaviconOptions } from "./inbox-card-favicons";
import { createCardMarks } from "./inbox-card-marks";
import { createInboxPulls, InboxPullsError, linkInboxPulls, pullCards, type InboxPullLinkStore, type InboxPullRepo } from "./inbox-pulls";
import { parseFileLevelComments, parsePRReviewAction, submitPRReview as submitForgeReview, type PRRef, type PRReviewFileComment, type PRRuntime } from "@plannotator/shared/pr-provider";
import { prCommandRuntime } from "./pr";
import { createInboxPullLinks } from "./inbox-pull-links";
import { createPullAvatars, type PullAvatarOptions } from "./inbox-pull-avatars";
import { INBOX_INITIATIVE_PEEK_THREADS, INBOX_PULL_OWNER_KEYS_MAX, inboxPullIsOpen, inboxPullRepoKey, inboxPullItems, inboxPullStacks, inboxReviewLandingChanges,
  inboxReviewRows, type InboxPullReason } from "@plannotator/core/inbox-types";
import { createInboxPullStates, createInboxReviewIndex } from "./inbox-reviews";
import { isInboxBoardSeq, readInboxBoardSeen, writeInboxBoardSeen } from "@plannotator/shared/inbox/board-seen";
import { createInboxTagsRoute } from "./inbox-tags";
import { createInboxStepsRoute, inboxStepsStale } from "./inbox-steps";
import { createInboxDebugLog } from "./inbox-debug-log";
import { createInboxDevices, DOOR_PREFIX } from "./inbox-devices";
import { createInboxMachines, type InboxMachines, type MachineFrame, type MachineLinkTimings } from "./inbox-machines";
import { replyIsStale } from "./inbox-outbox";
import type { PairingProbes } from "./inbox-pairing-checks";
import { createInboxRelay } from "./inbox-relay";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { createInboxTailscale, isDoorTailnetPort, type InboxTailscale } from "./inbox-tailscale";
import { createInboxUpdates, type InboxUpdatesOptions } from "./inbox-updates";
import { INBOX_WHATS_NEW_IMAGE_PATH, whatsNewImageRoute } from "./inbox-whats-new-images";
import { inboxCanonicalBaseUrl, inboxCanonicalRedirect } from "./inbox-canonical";
import { createInboxWindows, parseWindowId, parseWindowOrigin, parseWindowPermission } from "./inbox-windows";
import { handleInboxTourRequest } from "./inbox-tour";
import { createBunShapeRoutes } from "./shape-routes";
import { shapeCodeRoot } from "@plannotator/shared/shape/store";
import { shapeEventFrame } from "@plannotator/shared/shape/routes";
import { shapeAgentName } from "@plannotator/shared/shape/routes";
import { SHAPE_SWITCH_NOT_SAVED, setShapeSwitch, shapeSwitchOn } from "@plannotator/shared/shape/switch";
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
  type InboxStepsWire,
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
/** The cards read's list rows per initiative for its tagged threads: what the preview lists, plus the thread it is opened in (left out there). */
const INITIATIVE_THREAD_ROWS = INBOX_INITIATIVE_PEEK_THREADS + 1;
/**
 * A window's stream (`window=`) beats every 10 s with a named frame
 * (`event: heartbeat`), not the `: ping` comment the other streams get:
 * EventSource never shows a comment to the page, and the page needs to hear
 * the stream to tell a quiet Inbox from a dead connection
 * (packages/inbox/liveStream.ts treats 25 s of silence as dead).
 */
export const INBOX_WINDOW_HEARTBEAT_MS = 10_000;
const DEFAULT_HEALTH_TICK_MS = 60_000;
/** How often a running Inbox checks the daily ping (it sends at most once a UTC day). */
const DAILY_PING_CHECK_MS = 60 * 60 * 1000;
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
   * The window: the built app (`apps/hook/dist/inbox.html`, which the binary
   * embeds): one file, the page with its scripts packed behind it
   * (build/pack-inbox.ts), served as `/` and `/assets/<name>`. Absent (a source
   * run before `build:hook`, the server tests): `/` answers a one-line page
   * saying so.
   */
  htmlContent?: string;
  /**
   * Tests: where the Feedback dialog's send goes (inbox-feedback.ts). Default:
   * `PLANNOTATOR_FEEDBACK_URL`, else the feedback Worker's constant URL.
   */
  feedbackUrl?: string;
  /** Tests: the debug log on or off. Default: `PLANNOTATOR_INBOX_DEBUG=1` or the config's `inboxDebug`. */
  debug?: boolean;
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
  /** Tests: how long the tailnet door stays up for a machine unlinked while it could not be told. Default a week (`UNLINKED_REFUSAL_KEPT_MS`). */
  unlinkedRefusalKeptMs?: number;
  /** How "Reach from my tailnet" runs the `tailscale` CLI. Default: the CLI on PATH. */
  tailscale?: TailscaleRunner;
  /** Tests: more agents beside Claude Code (`createInboxLaunch`'s `hosts`), for a sandbox with no CLI to start. */
  launchHosts?: (context: LaunchHostContext) => LaunchHost[];
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
   * Ask AI (inbox-ask.ts). Default: `resolveInboxAskAi` (PLANNOTATOR_INBOX_ASK_AI,
   * else off). Off, its routes answer the unknown-route 404.
   */
  askAi?: boolean;
  /** Tests: Ask AI's waits (inbox-ask-live.ts). */
  askTimes?: InboxAskTimes;
  /** Tests: linked machines' clocks (packages/server/inbox-peer-link.ts): heartbeat silence, backoff. */
  machineLinkTimings?: MachineLinkTimings;
  /** Tests: how often a window's event stream sends `event: heartbeat` (default `INBOX_WINDOW_HEARTBEAT_MS`). */
  windowHeartbeatMs?: number;
  /** The Board, decided here instead of config.json `inboxBoard` (tests). Absent: config.json decides on every request. */
  board?: boolean;
  /** Thread steps, decided here instead of config.json `inboxSteps` (tests). Absent: config.json decides on every request. */
  steps?: boolean;
  /** Code review, decided here instead of config.json `inboxCodeReview` (tests). Absent: config.json decides on every request. */
  codeReview?: boolean;
  /** Shape, decided here instead of config.json `inboxShape` (tests). Absent: config.json decides on every request. */
  shape?: boolean;
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
  /** The person's home folder for Open in, by default this process's. */
  openInHome?: string;
  /** Tests: how a project root's `origin` is read (default `readInboxProjectRepo`, inbox-repos.ts). */
  readProjectRepo?: (root: string) => Promise<InboxProjectRepo | null>;
  /** Tests: run the hover cards' `gh` / `glab` through this instead of the real ones (ref-cards.ts). */
  refRunner?: RefRunner;
  /**
   * Tests: the `gh` / `glab` a review posted to the forge runs through (Pull requests' Post to GitHub/GitLab; the review
   * app's providers, `submitPRReview`). Default the Bun command runtime (pr.ts).
   */
  prRuntime?: PRRuntime;
  /** Tests: how a person's web link's favicon is fetched (inbox-card-favicons.ts): a scripted fetch and DNS, never the network. */
  cardFavicons?: CardFaviconOptions;
  /** Tests: how a PR author's picture is fetched (inbox-pull-avatars.ts): a scripted fetch and DNS, never the network. */
  pullAvatars?: Partial<PullAvatarOptions>;
  /** Tests: the git that decides a path's project (default `inboxGitRunner`, inbox-project-root.ts). */
  projectRootGit?: InboxGitRunner;
  /** Tests: the home folder no repository project is made at (default this user's, inbox-project-root.ts `isHomeOrRootFolder`). */
  projectRootHome?: string | null;
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
  /** Tests: voice dictation's endpoints, and where to look for a Codex CLI besides PATH (packages/server/inbox-voice.ts). */
  voice?: { chatgptUrl?: string; openaiUrl?: string; extraClis?: readonly string[] };
  /** Tests: where a read of `cswap list --json` looks, how long it waits, when a stuck run is killed, and how long an answer serves (packages/server/inbox-accounts.ts). */
  accounts?: { environment?: AgentEnvironment; timeoutMs?: number; hardLimitMs?: number; cacheMs?: number };
  /** The Qwen Code wake's clock and time limits (inbox-qwen-wake.ts): tests shorten them. */
  qwenWake?: { now?: () => number; sendTimeoutMs?: number; receiptTimeoutMs?: number; comebackMs?: number; socketParent?: string };
  /** The T3 Code wake (inbox-t3-wake.ts): tests pass a scripted T3, a clock and a log. */
  t3Wake?: { connect?: T3Connect; now?: () => number; log?: (line: string) => void; lookupTimeoutMs?: number };
}

/**
 * After a Mark read, the set-aside note waits out the window's 7 s Undo with
 * 3 s to spare (a slow click, a slow network), so an Undo never reaches an agent.
 */
export const INBOX_SET_ASIDE_DELAY_MS = 10_000;

/** A review posted to the forge from the Inbox: its main comment (GitHub refuses one over 65,536), and its comments. */
const PULL_REVIEW_BODY_MAX = 65_536;
const PULL_REVIEW_COMMENTS_MAX = 500;
const PULL_REVIEW_POSTED_MAX = 1_000;

/** The review's line comments as the review app builds them (`PRReviewFileComment`), or null when any is malformed. */
function pullReviewComments(value: unknown): PRReviewFileComment[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > PULL_REVIEW_COMMENTS_MAX) return null;
  const line = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n > 0 && n < 10_000_000;
  const side = (v: unknown) => v === "LEFT" || v === "RIGHT";
  const out: PRReviewFileComment[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const c = item as Record<string, unknown>;
    if (typeof c.path !== "string" || c.path.length === 0 || c.path.length > 1000 || !line(c.line) || !side(c.side) || typeof c.body !== "string" || c.body.length > PULL_REVIEW_BODY_MAX) return null;
    if (c.start_line !== undefined && !line(c.start_line)) return null;
    if (c.start_side !== undefined && !side(c.start_side)) return null;
    out.push({
      path: c.path,
      line: c.line as number,
      side: c.side as "LEFT" | "RIGHT",
      body: c.body,
      ...(c.start_line !== undefined ? { start_line: c.start_line as number } : {}),
      ...(c.start_side !== undefined ? { start_side: c.start_side as "LEFT" | "RIGHT" } : {}),
    });
  }
  return out;
}

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
  t3Wake: InboxT3Wake;
  /** Shape's watch of the boards: tests read how many windows it reads the store for. */
  shapeWatchers: () => number;
  stop: () => void;
}

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function json(body: unknown, status = 200): Response {
  return new Response(perfPhase("json", () => JSON.stringify(body)), { status, headers: JSON_HEADERS });
}

const ERROR_STATUS: Record<string, number> = {
  validation_error: 422,
  project_unresolved: 503,
  owner_only: 403,
  // Ask AI: only the person's own window asks or reads (inbox-ask.ts).
  window_only: 403,
  // Ask AI: no agent owns the thread, so nobody can answer.
  ask_no_owner: 409,
  // Ask AI: the conversation's file. Refused so nothing replaces it (shared/inbox/ask.ts).
  ask_unreadable: 503,
  ask_damaged: 409,
  ask_full: 409,
  // Ask AI: the slot is taken, or this session's connection can't answer live (nothing new is saved).
  ask_busy: 409,
  ask_no_live_path: 409,
  // Ask AI: a client polling for a session no question asked for (it stops).
  ask_no_bridge: 404,
  message_not_found: 404,
  thread_not_found: 404,
  project_not_found: 404,
  already_combined: 409,
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
  // A reply held for this machine whose thread an agent wrote to after the person read it (linked machines, rule 11).
  thread_moved_on: 409,
  // Linking machines (inbox-machines.ts).
  machine_not_linked: 404,
  machine_unreachable: 502,
  machine_needs_update: 409,
  machine_mismatch: 409,
  link_to_self: 409,
  link_failed: 502,
  no_way_back: 409,
  offer_expired: 410,
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
  // Snoozes (packages/shared/inbox/snoozes.ts): a time gone by, and a file from a newer Plannotator.
  snooze_past: 409,
  snoozes_newer: 409,
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
  // A verdict on a review while the person has Code review off (Settings → Capabilities).
  code_review_off: 409,
  // New message (step 8).
  session_not_live: 409,
  // Launch (inbox-launch.ts): the project's folder is gone, the agent can't be started, or the feature is off.
  folder_missing: 422,
  // A new scratch folder could not be made (the root can't be written, or every name is taken).
  scratch_unavailable: 422,
  agent_unavailable: 409,
  launch_not_found: 404,
  launch_off: 404,
  open_unavailable: 409,
  // Trust folder: the agent's own config could not be changed; nothing was, and the message stays kept.
  trust_failed: 409,
  // Trust folder: the folder's warning is no longer the one the person read; nothing was saved.
  trust_warning_changed: 409,
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
  card_backlog_person_only: 409,
  card_dropped_by_person: 409,
  card_person_only: 403,
  // The Board's initiatives (approval "board-initiatives"): one name each.
  initiative_not_found: 404,
  initiative_exists: 409,
  initiative_person_only: 403,
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
 * The window is one built file: its styles are inline and its scripts are
 * packed behind the page and served by this server (`/assets/`, #2593), so the
 * policy allows inline code and code from this origin only. Nothing may frame
 * it, and it may only talk to this server.
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
  // Never remote mode's port, and never one the device door may take (8443 to 8450):
  // the window's tailnet mapping uses the Inbox's own port, so the two never meet.
  const forbidden = (port: number) => port === INBOX_FORBIDDEN_PORT || isDoorTailnetPort(port);
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

/** A snooze write: this machine's thread, or a linked machine's through the forward (`/api/inbox/m/<machine>/…`). */
const INBOX_SNOOZE_WRITE = /^\/api\/inbox\/(?:m\/[^/]+\/)?threads\/[^/]+\/snooze$/;

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

/**
 * HELD UNTIL THE NEXT BIG RELEASE (0.29): DELETE THIS FUNCTION THEN, NOT BEFORE. The owner decided (2026-11-04) to hold
 * Code review and Shape back from 0.28.49, and (2026-11-05) to keep holding them through 0.28.50. No version is read
 * here: the hold ends when this function is deleted. Their Settings → Capabilities switches show only to a person
 * who already has that feature on, or with PLANNOTATOR_INBOX_PREVIEW=1. Otherwise the settings read, the save's answer and the windows' `event:
 * capabilities` leave the key out, and Settings draws no row for an absent key. `told`: this request or event is the
 * switch's own save, so a person who turns a shown switch off hears it. The row may go at the next load.
 * In that release, write `[key]: { on }` at each caller again and drop the `changed` argument of `capabilityListeners`.
 */
function heldSwitch<K extends "code_review" | "shape">(key: K, on: boolean, told = false): { [P in K]?: { on: boolean } } {
  return on || told || process.env.PLANNOTATOR_INBOX_PREVIEW === "1" ? ({ [key]: { on } } as { [P in K]: { on: boolean } }) : {};
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
  const storeLoadStarted = performance.now();
  const store = InboxStore.open(dataDir, options.storeNow ? { now: options.storeNow } : {});
  // Read every project's log and replayed it (store.ts load): the debug log notes how long that took.
  const storeLoadMs = performance.now() - storeLoadStarted;
  // A send a crash interrupted leaves a temp blob; the next start removes it once it is stale.
  sweepStaleInboxSendTemps(store.dir);
  const serverSession = createServerSessionNonce();
  // The requests the phone's device door hands in, in-process, after it checked the device's token
  // (inbox-devices.ts `toWindow`): the person's own paired device, which answers a permission prompt as a window does.
  const fromDeviceDoor = new WeakSet<Request>();
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
  // Read once per start: Ask AI stays hidden until the owner has used it.
  const askOn = options.askAi ?? resolveInboxAskAi();
  const hostGuard = createRequestHostGuard({ localOnly: true });
  const previous = readInboxRegistry(dataDir);
  let port = 0;
  let baseUrl = "";
  let portChanged = false;
  const statusListeners = new Set<() => void>();
  /**
   * A reply draft was saved or deleted (inbox-reply-drafts.ts), or a compose draft saved, deleted or sent
   * (inbox-compose.ts, no thread: null): the windows' streams say `event: drafts`.
   */
  const draftListeners = new Set<(threadId: string | null) => void>();
  /** An Ask AI conversation changed (inbox-ask.ts): the owner's windows' streams say `event: ask`. */
  const askListeners = new Set<(threadId: string) => void>();
  /** The sidebar's pins changed (inbox-pins.ts): the windows' streams say `event: pins`. */
  const pinListeners = new Set<() => void>();
  /** A snooze changed or ran out (inbox-snooze.ts): the streams of windows and linked machines say `event: snoozes`. */
  const snoozeListeners = new Set<() => void>();
  /** How the list's rows look was saved (config.json `inboxRows`): the windows' streams say `event: rows`. */
  const rowsListeners = new Set<(rows: readonly InboxRowsOption[], rev: number) => void>();
  /** A capability switch was saved (Settings → Capabilities): the windows' streams say `event: capabilities`. `changed`: held until the next big release (heldSwitch). */
  const capabilityListeners = new Set<(changed?: "code_review" | "shape") => void>();
  // The Inbox windows open now and whether any can show a notification (inbox-windows.ts).
  const windows = createInboxWindows({ graceMs: options.windowGraceMs });
  /** Event streams open now (health's `event_streams`): Inbox tabs of one origin share one. */
  let openEventStreams = 0;
  const binaryPath = options.binaryPath !== undefined ? options.binaryPath : version !== "dev" ? process.execPath : null;
  // The sidebar's Update button (packages/server/inbox-updates.ts): the release
  // check, the binary on disk, Update now, Remind me tomorrow.
  let lastDailyPingCheck = 0;
  const updates = createInboxUpdates({
    dataDir,
    version,
    binaryPath,
    healthTickMs: options.healthTickMs ?? DEFAULT_HEALTH_TICK_MS,
    // The daily ping (packages/shared/daily-ping.ts): checked when the Inbox
    // starts, then at most once an hour on the update timer; in the background.
    onTick: () => {
      const at = Date.now();
      if (at - lastDailyPingCheck < DAILY_PING_CHECK_MS) return;
      lastDailyPingCheck = at;
      scheduleDailyPing({ version, dataDir, tool: "inbox" });
    },
    ...options.updates,
    onChange: () => {
      for (const listener of statusListeners) listener();
    },
  });

  // Each project's git `origin` (#1840), for the window's `#123` links:
  // resolved for every known project once the server listens (below) and
  // when a project is first seen, never while a request waits (inbox-repos.ts).
  const repos = createInboxRepoCache(options.readProjectRepo ? { read: options.readProjectRepo } : {});
  // Until the startup read of every project's origin has begun, an empty cache says nothing yet about Tidy's suggestions.
  let repoReadsBegun = false;

  // Hover cards for issue, PR and MR links (ref-cards.ts): nothing runs until a card is asked for.
  // github.com, gitlab.com and the hosts this computer's own gh / glab is signed in to; nothing else.
  const refCards = createRefCards(options.refRunner ? { run: options.refRunner } : {});
  // The Board's links, one resolver per source (inbox-card-refs.ts): GitHub and GitLab through the hover cards' lookup.
  const cardRefResolvers = [forgeCardRefResolver(refCards)];
  const cardFavicons = createCardFavicons(options.cardFavicons ?? {});
  // The Board's lane marks (inbox-card-marks.ts): GitHub batched per repository, GitLab through the hover cards.
  const cardMarks = createCardMarks({ refCards, ...(options.refRunner ? { run: options.refRunner } : {}) });
  // Pull requests (inbox-pulls.ts): read only while the page is open and Code review is on; the route refuses first otherwise.
  // The project roots whose origin the Pull requests list has waited for once.
  const pullRepoRead = new Set<string>();
  const pulls = createInboxPulls(options.refRunner ? { run: options.refRunner } : {});
  // The PR authors' pictures (inbox-pull-avatars.ts): only for logins the last list showed, served from this origin.
  const pullAvatars = createPullAvatars({ ...options.pullAvatars, dir: options.pullAvatars?.dir ?? join(inboxDir(dataDir), "pull-avatars") });
  /** Reviews posted to a forge while this Inbox runs (PR key, head, action, body): an identical one is refused. */
  const postedReviews = new Set<string>();
  // Which agent thread owns a PR, as the person chose it (Hand to an agent, Launch an agent): inbox/pull-links.json.
  const pullOwners = createInboxPullLinks(dataDir);
  // Reviews (inbox-reviews.ts): every thread with a review card, derived from the store's messages on read.
  const reviewIndex = createInboxReviewIndex(store);
  // A review thread's PR that left the list: one read of its state, so a closed PR, or one merged long ago, is recorded.
  const pullStates = createInboxPullStates({ run: options.refRunner, onLand: (record, forget) => pullOwners.land(record, forget) });
  const pullLinkStore: InboxPullLinkStore = {
    threadsOf: (id) => store.threadsOf(id),
    threadMessageIds: (id) => store.threadMessageIds(id),
    message: (id) => store.message(id),
    threadSubject: (id) => store.threadSubject(id),
    threadProject: (id) => {
      const root = store.message(id);
      return root && root.thread_id === id ? store.canonicalProjectId(root.project_id) : null;
    },
    // An agent that sent with a wake and polls no more is marked ended in the stack view (`live` is set up below).
    sessionLive: (session) => live.isSessionLive(session),
  };
  // Every project on a repository (two clones are two projects), and the repositories to ask the forge about.
  // A project's origin is read once before its first list (the cache is read-behind), so the first open after a
  // start is not empty; after that the cache's own refresh keeps it.
  const pullProjects = async (): Promise<{ projectsByRepo: Map<string, string[]>; wanted: InboxPullRepo[] }> => {
    const projectsByRepo = new Map<string, string[]>();
    const wanted: InboxPullRepo[] = [];
    const projectsNow = store.allProjects();
    const reposNow = await Promise.all(
      projectsNow.map(async (project) => {
        const repo = repos.get(project.root);
        if (repo || pullRepoRead.has(project.root)) return repo;
        pullRepoRead.add(project.root);
        return repos.refresh(project.root);
      }),
    );
    for (const [i, project] of projectsNow.entries()) {
      const repo = reposNow[i];
      if (!repo?.host) continue;
      const key = `${repo.host}/${repo.display}`.toLowerCase();
      const id = store.canonicalProjectId(project.id);
      const ids = projectsByRepo.get(key);
      if (ids) {
        if (!ids.includes(id)) ids.push(id);
        continue;
      }
      projectsByRepo.set(key, [id]);
      wanted.push({ host: repo.host.toLowerCase(), repo: repo.display, project_id: id });
    }
    return { projectsByRepo, wanted };
  };
  /**
   * Keys this Inbox has not read yet (it restarted since the window's list): read the list once, then look again. An
   * Others PR lands only when the background Others read does, so while one is still missing, wait for that read (its
   * own deadline) and list once more. A caller answers `pull_unknown` for any key still missing after.
   */
  const findPulls = async (keys: readonly string[], wanted: InboxPullRepo[]): Promise<void> => {
    if (keys.every((key) => pulls.find(key))) return;
    await pulls.list(wanted, { refresh: false });
    if (keys.every((key) => pulls.find(key))) return;
    await pulls.othersSettled();
    await pulls.list(wanted, { refresh: false });
  };

  // Where a path an agent named files its messages: its repository (a linked
  // worktree folds into its main repository's project) or the folder, cached
  // per folder (packages/server/inbox-project-root.ts). One cache for sends
  // and live sessions, so they always agree.
  const projectRoots = createInboxProjectRoots({
    ...(options.projectRootGit ? { git: options.projectRootGit } : {}),
    ...(options.projectRootHome !== undefined ? { home: options.projectRootHome } : {}),
  });
  // The projects a guess (git past its time limit) may file into (inbox-project-root.ts `guessableProjects`).
  const repositoryProjects = () => guessableProjects(store.allProjects(), projectRoots.home);
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
      const holder = nearestProjectHolding(repositoryProjects(), folder);
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
      const holder = nearestProjectHolding(repositoryProjects(), folder);
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
          (await qwenWake.wakes(host, session, meta)) ||
          (await t3Wake.wakes(host, session)),
        bridgePolls: (host, session) => BRIDGE_WAKING_HOSTS.has(host) && live.pollsNow(host, session),
        // The Board: the card tool is listed and served only while the person has it on.
        boardOn,
        // Thread steps: the steps tool and field are listed and served only while the person has them on.
        stepsOn,
        // Code review: submit_guide's `review` field is listed and served only while the person has it on.
        codeReviewOn,
        // A thread only a linked machine holds goes through the window's own forward (inbox-machines.ts).
        snoozeOnMachine: async (threadId, until) => (machines ? machines.snoozeThread(threadId, until) : null),
        snoozeMade: () => markSnoozeUsed(),
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
    // Additive (linked machines, inbox-machines.ts): this Inbox's stable id and the link protocol it speaks.
    inbox_id: machines.selfId,
    machine_links: 1,
  });

  /** Which list rows each window already holds, so a list read sends only the changed ones (#2593). */
  const listVersions = createInboxListVersions();

  const snoozesById = () => new Map(store.snoozes().map((snooze) => [snooze.thread_id, snooze]));
  /**
   * A row as the window and the phone read it (approval "inbox-snooze"): its
   * `snoozed`, and a return drawn by the clock now (core inbox-snooze.ts). Only
   * here, never in `store.listRow`, which agents read through.
   */
  const withSnooze = (row: InboxListRow, byThread = snoozesById(), now = new Date()): InboxListRow => {
    const snooze = byThread.get(row.thread_id);
    return snooze ? inboxRowAsOf({ ...row, snoozed: { until: snooze.until, at: snooze.at } }, now) : row;
  };

  /**
   * The sidebar's folders: every project, with its thread and unread counts,
   * and (additive) `listed`, the threads the window's list holds, and
   * `archived`, the rest. The window leaves out a project with nothing listed
   * (the project menu's automatic hiding); an older window ignores both.
   */
  const projectFolders = (rows?: readonly InboxListRow[]) => {
    const byThread = snoozesById();
    const counted = rows ?? store.listRows().map((row) => withSnooze(row, byThread));
    return store.listProjects().map((project) => {
      const mine = counted.filter((row) => row.project.id === project.id);
      const archived = mine.filter((row) => inboxRowArchived(row)).length;
      // The projects combined into this one: a link to one opens this project. Additive, and only when there are any.
      const combined = store.combinedInto(project.id).map(({ id, name, root }) => ({ id, name, root }));
      // A snoozed thread is listed (its project stays, for the band) and not unread (nothing shows until it is back).
      const unread = mine.filter((row) => row.unread && !inboxRowSnoozed(row)).length;
      return { ...project, ...(combined.length > 0 ? { combined } : {}), threads: mine.length, unread, listed: mine.length - archived, archived };
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
  /**
   * `merged` (`?machines=1`, the window only; the door refuses it to a linked
   * machine): every linked machine's rows join this Inbox's, each row with
   * its `machine`, plus the `machines` block. Without it, this Inbox's own.
   */
  const listModel = (projectFilter: string | null, archived: "include" | "exclude", merged = false, snoozedMode: "include" | "exclude" = "include") => {
    // One pass over the store feeds both the folders' counts and the sections.
    // `pinned_at` and `snoozed` (additive) on the window's and the phone's rows only: never on anything an agent reads.
    const pinnedAt = new Map(store.pins().map((pin) => [pin.thread_id, pin.pinned_at]));
    // Launched threads (only while launch is on): "Starting" / "Working", and a session blocked on a prompt in Stopped on you.
    // Resolved once per list: off, it is the identity and no row costs anything. Only this Inbox's own rows: a linked
    // machine's launches are that machine's to decorate.
    const decorate = launch.rowDecorator();
    // Snoozes, by this reader's clock now (core inbox-snooze.ts): a row past its time stands as a return, in every mode.
    // Applied after the launch decoration, so a launched row keeps its run word and section under a snooze.
    const now = new Date();
    const byThread = snoozesById();
    const own = store
      .listRows()
      .map((row) => withSnooze(decorate(pinnedAt.has(row.thread_id) ? { ...row, pinned_at: pinnedAt.get(row.thread_id)! } : row), byThread, now));
    // A linked machine never lists an id this store holds (archived and pinned included): its row is dropped, never merged.
    // The same clock over its rows: a machine asleep past a thread's `until` still gives that thread back.
    const rows: InboxListRow[] = merged
      ? [...own.map((row) => ({ ...row, machine: machines.selfId })), ...machines.rows().filter((row) => !store.message(row.thread_id)).map((row) => inboxRowAsOf(row, now))]
      : own;
    // Rows carry the head of a combined project; an id from before the combine (a phone, an API client) means that head.
    const shownProject = projectFilter ? store.canonicalProjectId(projectFilter) : null;
    const scoped = shownProject ? rows.filter((row) => row.project.id === shownProject) : rows;
    const byId = new Map(rows.map((row) => [row.thread_id, row]));
    const unarchived = archived === "exclude" ? scoped.filter((row) => !inboxRowArchived(row)) : scoped;
    const listed = snoozedMode === "exclude" ? inboxSplitSnoozed(unarchived, now) : null;
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
      projects: merged ? [...projectFolders(own).map((project) => ({ ...project, machine: machines.selfId })), ...machines.projects().filter((project) => typeof project.id !== "string" || !store.project(project.id))] : projectFolders(own),
      project: projectFilter,
      // `?archived=exclude` (the window): archived threads leave every section,
      // Quiet included, and Settings lists them (GET /api/inbox/threads/archived).
      // Without it they stay in Quiet, as an older window and the phone expect.
      // `?snoozed=exclude` (the window): snoozed threads leave every section for `snoozed`, soonest back first.
      // Without it they stay in their sections, each with its `snoozed` field, as an older window and the phone expect.
      sections: inboxListSections(listed ? listed.rows : unarchived),
      ...(listed ? { snoozed: listed.snoozed } : {}),
      /** This Inbox keeps snoozes: a linked machine offers Snooze on this machine's rows only when its list says so. Additive. */
      snoozes: true,
      /**
       * The sidebar's pinned threads (approval "inbox-pinned-threads"), in pin
       * order: every pinned thread whatever the project filter or `archived`
       * (an archived thread stays pinned). Additive: absent from an older Inbox.
       */
      pins: store
        .pins()
        .map((pin) => byId.get(pin.thread_id))
        .filter((row): row is InboxListRow => row !== undefined),
      ...(merged ? { self: machines.selfId, machines: machines.machinesView() } : {}),
    };
  };

  const projectFilterOf = (url: URL): string | null => {
    const value = url.searchParams.get("project");
    if (value === null || value === "") return null;
    if (!isInboxId("prj", value)) throw new InboxError("validation_error", "project: a prj_ id.", { field: "project" });
    // In the merged view a project may be another machine's.
    if (url.searchParams.get("machines") === "1" && machines.projectOwner(value)) return value;
    if (!store.project(value)) throw new InboxError("project_not_found", `No project ${value}.`);
    return value;
  };

  /**
   * The Board's cards (`GET /api/inbox/cards`): `?project=prj_…` and
   * `?column=in_progress,in_review` filter; every card otherwise, in the
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
    // them out), so the opened card names a done card's thread; a deleted thread is not linked at all.
    const threads: Record<string, ReturnType<typeof store.listRow>> = {};
    for (const card of cards) for (const id of card.threads) if (!(id in threads)) threads[id] = store.listRow(id);
    // `steps` (additive, approval "inbox-thread-steps", part 4): while the person's switch is on, each linked
    // thread's lists that hold steps, with each session's presence, for the lane card's mark and the opened
    // card's checklist. Switch off: absent, so the Board shows none.
    let steps: Record<string, InboxStepsWire[]> | undefined;
    if (stepsOn()) {
      steps = {};
      for (const id of Object.keys(threads)) {
        const lists = stepsRoute.threadSteps(id).filter((list) => list.steps.length > 0);
        if (lists.length > 0) steps[id] = lists;
      }
    }
    // `initiative_threads` (additive, approval "board-hashtags"): per live initiative, the latest-tagged threads
    // (`#Shape`) no card of it links, at most INITIATIVE_THREAD_ROWS, with their list rows in `threads`, and
    // `total`, how many such threads there are, for the preview's "+N more". From the store's in-memory tag
    // index, read from its newest end: a tag used in thousands of threads costs the same as one in a few.
    const linkedTo = new Map<string, Set<string>>();
    for (const card of cards) {
      if (!card.initiative || card.column === "dropped") continue;
      const linked = linkedTo.get(card.initiative) ?? new Set<string>();
      for (const id of card.threads) linked.add(id);
      linkedTo.set(card.initiative, linked);
    }
    const initiativeThreads = store.initiativeThreads({ limit: INITIATIVE_THREAD_ROWS, linked: (id) => linkedTo.get(id) });
    for (const read of Object.values(initiativeThreads)) for (const id of read.threads) if (!(id in threads)) threads[id] = store.listRow(id);
    // `initiatives` (additive, approval "board-initiatives"): every one, deleted ones too (an opened card's
    // history names them); the window offers only the live ones.
    return {
      serverSession,
      cursor: store.cursor(),
      cards,
      dropped_unseen: droppedUnseen,
      seen_seq: readInboxBoardSeen(store.dir),
      threads,
      ...(steps ? { steps } : {}),
      initiatives: store.initiatives(),
      initiative_threads: initiativeThreads,
    };
  };

  /**
   * The person's moves on a card (`POST /api/inbox/cards/:id`): `op` move
   * (`column`, any; a move to dropped may carry `reason`), icebox (a window
   * from before v2: Backlog, where the Icebox folded in), drop (`reason`
   * optional), restore (back to the column the card left for Dropped).
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
        return store.updateCard(id, { by, column: "backlog" });
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
      case "initiative":
        // The card's initiative (approval "board-initiatives"): an `ini_` id, or null for none.
        if (body.initiative === undefined) throw new InboxError("validation_error", "initiative: an ini_ id, or null for none.", { field: "initiative" });
        return store.setCardInitiative(id, body.initiative, by);
      default:
        throw new InboxError("validation_error", "op: move, icebox, drop, restore, edit, link, send or initiative.", { field: "op" });
    }
  };

  /** `?archived=include|exclude` on the list: where archived threads go. Default `include` (in Quiet). */
  const archivedModeOf = (url: URL): "include" | "exclude" => {
    const value = url.searchParams.get("archived");
    if (value === null || value === "" || value === "include") return "include";
    if (value === "exclude") return "exclude";
    throw new InboxError("validation_error", "archived: include or exclude.", { field: "archived" });
  };

  /** `?snoozed=include|exclude` on the list: where snoozed threads go. Default `include` (in their sections). */
  const snoozedModeOf = (url: URL): "include" | "exclude" => {
    const value = url.searchParams.get("snoozed");
    if (value === null || value === "" || value === "include") return "include";
    if (value === "exclude") return "exclude";
    throw new InboxError("validation_error", "snoozed: include or exclude.", { field: "snoozed" });
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
    const shownProject = projectFilter ? store.canonicalProjectId(projectFilter) : null;
    const scoped = shownProject ? archived.filter((row) => row.project.id === shownProject) : archived;
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
        const reminder = host && INBOX_REMINDER_HOSTS.includes(host)
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
      if (!(INBOX_TOOL_HOSTS as readonly string[]).includes(agent)) throw new InboxError("validation_error", "tool: only Claude Code, Pi, OpenCode and DeepSeek Harness have one.", { field: "tool" });
      const problem = setInboxTool(agent as InboxToolHost, body.tool, agentEnvironment);
      if (problem) problems.push(problem);
    }
    if (typeof body.reminder === "boolean") {
      if (!(INBOX_REMINDER_HOSTS as readonly string[]).includes(agent)) throw new InboxError("validation_error", "reminder: only Claude Code, Pi and OpenCode have one.", { field: "reminder" });
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

  /** The name on the person's comments (config.json `displayName`); null when never set. */
  const displayNameState = (): string | null => {
    const name = loadConfig().displayName;
    return typeof name === 'string' && name ? name : null;
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
   * How the list's rows look (config.json `inboxRows`, approval "inbox-customize-rows"): the options that are on.
   * Null until a window first saves it, so the first window adopts its browser's old cookies. Lenient on read (a name
   * this build does not know is dropped, so a downgrade or a typo never reads as "never saved"), strict on write (a
   * `422`). `inboxRowsRev` counts the saves: every answer and `event: rows` carries it, so a window takes a look only
   * when it is newer than the last it took, whatever order the answers and events arrive in.
   */
  const rowsState = (): { rows: InboxRowsOption[] | null; rev: number } => {
    const config = loadConfig();
    const rev = config.inboxRowsRev;
    return { rows: inboxRowsRead(config.inboxRows), rev: typeof rev === "number" && Number.isSafeInteger(rev) && rev > 0 ? rev : 0 };
  };

  const saveRows = (input: unknown, validateOnly = false): { rows: InboxRowsOption[]; rev: number } => {
    const rows = inboxRowsList(input);
    if (!rows) throw new InboxError("validation_error", `rows: a list of row options (${INBOX_ROWS_OPTIONS.join(", ")}).`, { field: "rows" });
    const rev = rowsState().rev + 1;
    if (validateOnly) return { rows, rev };
    saveConfig({ inboxRows: rows, inboxRowsRev: rev });
    const saved = rowsState();
    if (saved.rev !== rev || saved.rows?.join() !== rows.join()) throw new InboxError("config_not_saved", "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.");
    for (const listener of rowsListeners) listener(rows, rev);
    return { rows, rev };
  };
  const rowsWire = (state: { rows: InboxRowsOption[] | null; rev: number }) => ({ rows: state.rows, rows_rev: state.rev });

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

  /**
   * The one-time list options dialog (approval "inbox-list-options-intro"): `due` while it waits for a page on this
   * computer to claim it. Decided at the first release start that knows it, like the sound dialog: someone who used an
   * Inbox before gets it due; a fresh install is marked shown and never sees it (the tour shows today's list).
   */
  const listIntroState = () => {
    const saved = loadConfig().inboxListIntro;
    return { due: typeof saved?.dueAt === "string" && saved.dueAt !== "" && !saved.shownAt };
  };
  if (normalizeStableVersion(version) !== null && loadConfig().inboxListIntro === undefined) {
    const at = new Date().toISOString();
    saveConfig({ inboxListIntro: usedBefore ? { dueAt: at } : { shownAt: at } });
  }
  /**
   * The page that is about to show the dialog claims it: only the first claim ever gets `show: true`, so two tabs
   * never both show it. Only on this computer (a page through the tailnet leaves it for the next page opened here).
   * No await between the read and the write, so two claims cannot interleave.
   */
  const claimListIntro = (via: RequestVia): boolean => {
    if (via !== "local" || !listIntroState().due) return false;
    const at = new Date().toISOString();
    // A one-time announcement: it counts toward the reveals' 48 h spacing (shared/inbox/reveals.ts). A dev build never stamps
    // that clock.
    saveConfig({
      inboxListIntro: { ...loadConfig().inboxListIntro, shownAt: at },
      ...(normalizeStableVersion(version) !== null ? { inboxReveals: { ...loadConfig().inboxReveals, lastShownAt: at } } : {}),
    });
    // Not written (a read-only data dir): showing it anyway would show it on every load.
    return loadConfig().inboxListIntro?.shownAt === at;
  };

  /**
   * The one-time Snooze announcement (approval "inbox-snooze-announce"; the rules are inbox-snooze-intro.ts):
   * due on a release build for someone who first used the Inbox two days ago or more, never snoozed and never saw it.
   * Decided live, not at start: the two days pass while the Inbox runs. A dev build reads and writes nothing.
   */
  const snoozeIntroRelease = normalizeStableVersion(version) !== null;
  /** The saved state, with first use filled in from the event log when it is missing (an empty log at the backfill). */
  const snoozeIntroSaved = (): SnoozeIntroSaved | undefined => {
    const saved = loadConfig().inboxSnoozeIntro;
    if (!snoozeIntroRelease || !saved || saved.firstUseAt) return saved;
    const firstUseAt = snoozeIntroFirstUse(store.changesSince(0));
    if (!firstUseAt) return saved;
    saveConfig({ inboxSnoozeIntro: { ...saved, firstUseAt } });
    return { ...saved, firstUseAt };
  };
  // The backfill, once, at the first release start that knows the key (an upgrade): first use from the event log, and
  // a snooze running now is a snooze the person made.
  if (snoozeIntroRelease && loadConfig().inboxSnoozeIntro === undefined) {
    const firstUseAt = snoozeIntroFirstUse(store.changesSince(0));
    saveConfig({ inboxSnoozeIntro: { ...(firstUseAt ? { firstUseAt } : {}), ...(store.snoozes().length > 0 ? { snoozedAt: new Date().toISOString() } : {}) } });
  }
  /**
   * Whether it is due, and for this page: the owner's (this computer or their phone), never a tailnet guest's. Its own
   * rules, and the reveals' queue (shared/inbox/reveals.ts): the 48 h spacing, and the Board going first once Snooze waited
   * three days for its moment.
   */
  const snoozeIntroState = (owner: boolean) => ({
    due: owner && revealNow(owner) === "snooze",
  });
  /** The person snoozed something: the dialog never shows. Once; a dev build marks too (only showing is release-only). */
  const markSnoozeUsed = () => {
    const saved = loadConfig().inboxSnoozeIntro;
    if (saved?.snoozedAt) return;
    saveConfig({ inboxSnoozeIntro: { ...saved, snoozedAt: new Date().toISOString() } });
  };
  /**
   * The page about to show it claims it: only the first claim ever gets `show: true` (no await between the read and
   * the write, so two claims cannot interleave). A claim that could not be saved shows nothing.
   */
  const claimSnoozeIntro = (owner: boolean): boolean => {
    if (!snoozeIntroState(owner).due) return false;
    const at = new Date().toISOString();
    // One save: the stamp and the reveals' spacing clock.
    return saveConfig({ inboxSnoozeIntro: { ...loadConfig().inboxSnoozeIntro, shownAt: at }, inboxReveals: { ...loadConfig().inboxReveals, lastShownAt: at } });
  };

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
    const was = boardOn();
    saveConfig({ inboxBoard: on });
    if ((loadConfig().inboxBoard === true) !== on) throw new InboxError("config_not_saved", "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.");
    // Every window follows at once (its sidebar's Board row, its Settings switch), as the Checklist's.
    if (was !== boardOn()) for (const listener of capabilityListeners) listener();
    return { on: boardOn() };
  };
  /**
   * Thread steps (approval "inbox-thread-steps", 2026-11-03): on only when
   * the person turned it on (config.json `inboxSteps`). Off, agents get
   * nothing of it: no `steps` tool or field, no wake or compaction line, no
   * Tidy rule; the window shows no steps. Read on every request; the lists
   * kept are never deleted by it.
   */
  const stepsOn = () => options.steps ?? loadConfig().inboxSteps === true;
  /**
   * A Tidy wake that listed only steps, not yet delivered, once steps are off: withdrawn, so no turn goes out
   * (amendment 2: turning the switch off stops a Tidy that is already running). Recorded delivered by the Inbox
   * itself (`INBOX_TIDY_WITHDRAWN_HOST`): no connection, wake or next call hands it, and the run reads "nothing".
   * Every such wake when the switch turns off; and one at a time (`withdrawnTidy`) as a poll or an MCP next call is
   * about to hand it (a switch turned off in config.json by hand), so the off state scans nothing more per poll.
   */
  const withdraw = (note: InboxMessage) => {
    try {
      // Never `recordDelivery`: that would settle the person's earlier replies in the thread as read.
      store.recordTidyWithdrawn(note.id, INBOX_TIDY_WITHDRAWN_HOST);
    } catch {
      // Gone or no longer this session's: nothing to withdraw.
    }
  };
  const withdrawStepsOnlyTidies = () => {
    if (!stepsOn()) for (const note of inboxTidyStepsOnlyWakes(store)) withdraw(note);
  };
  /** Whether a pending item is a steps-only Tidy wake with steps off; if so, it is withdrawn now. */
  const withdrawnTidy = (item: InboxMessage): boolean => {
    if (!item.tidy?.wake || !inboxTidyIsStepsOnly(item.body) || stepsOn()) return false;
    withdraw(item);
    return true;
  };
  const saveSteps = (input: unknown, validateOnly = false) => {
    if (!input || typeof input !== "object" || Array.isArray(input) || typeof (input as { on?: unknown }).on !== "boolean" || Object.keys(input).some((key) => key !== "on")) {
      throw new InboxError("validation_error", "steps: { on: boolean }.", { field: "steps" });
    }
    const on = (input as { on: boolean }).on;
    if (validateOnly) return { on: stepsOn() };
    const was = stepsOn();
    saveConfig({ inboxSteps: on });
    if ((loadConfig().inboxSteps === true) !== on) throw new InboxError("config_not_saved", "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.");
    // Every window follows at once (its Settings switch, the thread's steps button).
    if (was !== stepsOn()) for (const listener of capabilityListeners) listener();
    if (was && !stepsOn()) withdrawStepsOnlyTidies();
    return { on: stepsOn() };
  };

  /**
   * Code review in the Inbox (approval "inbox-code-review-direction",
   * 2026-11-03): on only when the person turned it on (config.json
   * `inboxCodeReview`). Off or unset, agents get nothing of it (no
   * submit_guide `review` field, no skill in the catalog) and the window
   * shows nothing new. Read on every request.
   */
  const codeReviewOn = () => options.codeReview ?? loadConfig().inboxCodeReview === true;
  /**
   * Ask AI is on with PLANNOTATOR_INBOX_ASK_AI, or whenever Code review is on
   * (approval "shape-in-code-review", q-668227a8: Code review brings Ask, and
   * so Show me). Read on every request, as the switch is.
   */
  const askOnNow = () => askOn || codeReviewOn();
  const saveCodeReview = (input: unknown, validateOnly = false) => {
    if (!input || typeof input !== "object" || Array.isArray(input) || typeof (input as { on?: unknown }).on !== "boolean" || Object.keys(input).some((key) => key !== "on")) {
      throw new InboxError("validation_error", "code_review: { on: boolean }.", { field: "code_review" });
    }
    const on = (input as { on: boolean }).on;
    if (validateOnly) return { on: codeReviewOn() };
    const was = codeReviewOn();
    saveConfig({ inboxCodeReview: on });
    if ((loadConfig().inboxCodeReview === true) !== on) throw new InboxError("config_not_saved", "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.");
    // Every window follows at once (its Settings switch, the review cards, the "/" list).
    if (was !== codeReviewOn()) for (const listener of capabilityListeners) listener("code_review");
    return { on: codeReviewOn() };
  };

  /**
   * Shape (approval "shape-inbox-placement"): on only when the person turned
   * it on (config.json `inboxShape`). Off or unset: no `/api/shapes` route
   * answers (404, as if absent), the window shows no Pebble, row or search
   * group, and no agent text names it. Read on every request.
   */
  const shapeOn = () => options.shape ?? shapeSwitchOn();
  const saveShape = (input: unknown, validateOnly = false) => {
    if (!input || typeof input !== "object" || Array.isArray(input) || typeof (input as { on?: unknown }).on !== "boolean" || Object.keys(input).some((key) => key !== "on")) {
      throw new InboxError("validation_error", "shape: { on: boolean }.", { field: "shape" });
    }
    const on = (input as { on: boolean }).on;
    if (validateOnly) return { on: shapeOn() };
    const was = shapeOn();
    if (!setShapeSwitch(on)) throw new InboxError("config_not_saved", SHAPE_SWITCH_NOT_SAVED);
    if (was !== shapeOn()) for (const listener of capabilityListeners) listener("shape");
    return { on: shapeOn() };
  };

  /**
   * The reveals for returning users (approval "inbox-feature-reveal"; the queue is packages/shared/inbox/reveals.ts):
   * Snooze, then the Board. Read live, like Snooze: the days pass while the Inbox runs. A dev build decides nothing.
   * The Board can be revealed only while config.json `inboxBoard` is unset (nobody decided): `true` and `false` are
   * the person's (a `true` from 0.28.49's reveal, which turned it on at the claim, is theirs now and never touched), and
   * a test's `board` option decides it too.
   */
  const boardUndecided = () => INBOX_CARD_ACTION_ON && options.board === undefined && loadConfig().inboxBoard === undefined;
  /** The Checklist can be revealed only while config.json `inboxSteps` is unset, as the Board. */
  const stepsUndecided = () => options.steps === undefined && loadConfig().inboxSteps === undefined;
  const revealState = (now: Date): RevealState => {
    const snooze = snoozeIntroSaved();
    const config = loadConfig();
    const reveals = config.inboxReveals;
    // A list options or voice `shownAt` without `dueAt` is a fresh install's mark (never shown), not a show.
    const shown = (intro: { dueAt?: string; shownAt?: string } | undefined) => (intro?.dueAt ? intro.shownAt : undefined);
    return {
      release: snoozeIntroRelease,
      firstUseAt: snooze?.firstUseAt ?? null,
      // The spacing clock: the reveals' own stamp, and every announcement shown before this key existed (an upgrade).
      lastShownAt: revealLastShown([reveals?.lastShownAt, snooze?.shownAt, shown(config.inboxListIntro), shown(config.inboxVoiceIntro), config.inboxBoardIntro?.shownAt]),
      // Roots in the store. The onboarding tour's threads live in the window only (tour/content), never here.
      threads: store.threadIds().length,
      open: {
        snooze: snoozeIntroDue(snooze, now, snoozeIntroRelease),
        // Every undecided owner (the owner: "the board we just show every user"), also someone who saw the first-visit
        // dialog before the Board was a switch: the reveal offers it to them too (`claimReveal`).
        board: boardUndecided() && !reveals?.board?.shownAt,
        // The Checklist (approval "inbox-checklist-reveal"): never decided by the person and never revealed. The Board
        // need not be on.
        steps: stepsUndecided() && !reveals?.steps?.shownAt,
      },
      waitingSince: reveals?.waitingSince,
    };
  };
  /**
   * The reveal this page may arm, or null. The owner's pages only (this computer, their phone over the tailnet, an
   * allowed login on a tagged machine), never a guest's. The first time an entry is next is kept, for the patience.
   */
  const revealNow = (owner: boolean): RevealId | null => {
    if (!owner || !snoozeIntroRelease) return null;
    const now = new Date();
    const state = revealState(now);
    const next = revealNext(state, now);
    if (next && !state.waitingSince?.[next]) {
      const reveals = loadConfig().inboxReveals;
      saveConfig({ inboxReveals: { ...reveals, waitingSince: { ...reveals?.waitingSince, [next]: now.toISOString() } } });
    }
    return next;
  };
  /**
   * The page about to show a reveal claims it: a compare-and-set over the whole queue (no await between the read and
   * the write, so two claims cannot interleave). Only `next` can be claimed, and only while the spacing holds. A claim
   * turns nothing on (the owner, 2026-11-04: reveals are opt-in): the dialog offers the feature, and only its "Turn it
   * on" writes the switch (`POST /api/inbox/settings`). The Board's claim stamps its reveal and the spacing clock in one
   * save, never the first-visit dialog (the owner, 2026-11-04, review of #2598 finding 5): the offer has no Copy prompt,
   * so the first visit to a Board turned on (from the offer, or later in Settings after "Not now") shows the welcome
   * with Copy prompt; someone who saw it before (its `inboxBoardIntro.shownAt`) does not see it again. `show`: the page
   * draws the dialog. `key` (the page's own, kept with the stamp): the same page's retry after a lost answer gets
   * `show: true` again, without a write, while the feature is still undecided; any other key, window or device does not.
   */
  const claimReveal = (id: RevealId, owner: boolean, key: string | null = null): boolean => {
    if (id === "snooze") return claimSnoozeIntro(owner);
    if (id === "steps") return claimStepsReveal(owner, key);
    if (id !== "board" || !owner || !snoozeIntroRelease) return false;
    if (key && loadConfig().inboxReveals?.board?.key === key) return boardUndecided();
    const now = new Date();
    if (!revealMayClaim("board", revealState(now), now) || !boardUndecided()) return false;
    const at = now.toISOString();
    saveConfig({ inboxReveals: { ...loadConfig().inboxReveals, lastShownAt: at, board: { shownAt: at, ...(key ? { key } : {}) } } });
    // Not written (a read-only data dir): showing it anyway would show it on every load.
    return loadConfig().inboxReveals?.board?.shownAt === at;
  };
  /**
   * The Checklist's reveal (approval "inbox-checklist-reveal", 2026-11-04): the claim stamps the reveal and the spacing
   * clock in one save and turns nothing on, as the Board's. "Turn it on" in `ChecklistIntro` writes `inboxSteps`.
   */
  const claimStepsReveal = (owner: boolean, key: string | null): boolean => {
    if (!owner || !snoozeIntroRelease) return false;
    if (key && loadConfig().inboxReveals?.steps?.key === key) return stepsUndecided();
    const now = new Date();
    if (!revealMayClaim("steps", revealState(now), now) || !stepsUndecided()) return false;
    const at = now.toISOString();
    saveConfig({ inboxReveals: { ...loadConfig().inboxReveals, lastShownAt: at, steps: { shownAt: at, ...(key ? { key } : {}) } } });
    return loadConfig().inboxReveals?.steps?.shownAt === at;
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
   * Code, its mod). Changing it is for the owner only (`editable`): the text
   * goes to every agent session here.
   */
  const promptsState = (editable: boolean) => {
    const config = loadConfig();
    const env = agentEnvironment.env as NodeJS.ProcessEnv;
    const modOff = !claudeCodeModOn(agentEnvironment);
    const on = Object.fromEntries(
      INBOX_TOOL_HOSTS.map((host) => [host, !(host === "claude-code" && modOff) && resolveInboxReminder(config, env, host)]),
    ) as Record<InboxToolHost, boolean>;
    // OpenCode 1 cannot bring a reply back as a turn: its default is the no-wake line.
    const wakes = { "claude-code": true, pi: true, opencode: inboxPluginStatus("opencode", agentEnvironment)?.generation !== "1" };
    return inboxPromptsModel(config, on, editable, wakes);
  };

  /**
   * The person at this computer, or the login that owns it over the tailnet: what the rules about this
   * computer ask. A login config.json `inboxTailscaleAllow` added is neither, and an owner Tailscale never
   * named is no one. Only `via` lets the login header count: the window's port refuses a request carrying it.
   */
  const ownerOrLocal = (req: Request, via: RequestVia) => via === "local" || tailscale.isOwnerRequest(req.headers);
  const voiceOwnerOnly = () => new InboxError("owner_only", "Only this computer's owner can use voice from this Inbox.");
  /**
   * What Settings and the connect snippets read. `guest`: a tailnet login other than the owner's. `withStore`: the
   * Storage sizes too, a walk of every file, for a page older than GET /api/inbox/settings/storage (it reads
   * `settings.store` and breaks without it); a current page asks with `?store=0` and reads the sizes on their own.
   */
  const settingsModel = (via: RequestVia, guest: boolean, withStore: boolean) => ({
    serverSession,
    /** Over your tailnet: the switch, the address or why not, and who may open it. */
    tailscale: tailscale.state(),
    /** Whether this page reached the Inbox through the tailnet (the switch cannot be turned on from there). */
    via,
    /** A tailnet login other than the owner's: what is about this computer stays closed to this page. */
    guest,
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
    /** The one-time list options dialog: whether it waits to be claimed (POST /api/inbox/list-intro). */
    list_intro: listIntroState(),
    /** The one-time Snooze announcement: whether it waits to be claimed by this page (POST /api/inbox/snooze-intro). */
    snooze_intro: snoozeIntroState(!guest),
    /** The reveals for returning users (shared/inbox/reveals.ts): the one this page may arm, or null. Never for a guest. */
    reveal: { next: revealNow(!guest) },
    /** Settings → Voice: off unless turned on. Never a key: its source and, for a saved one, its last 4. */
    voice: voice.settings(via, guest),
    /** Settings → About: update notices and automatic updates. */
    updates: updatesState(),
    /** Settings → General: "Open Plannotator at plannotator.localhost" (#2184); not for a tailnet guest's page. */
    ...(guest ? {} : { cookie_host: cookieHostWire() }),
    /** Plannotator's appearance (config.json `theme`), shared with plan review; null when never chosen. */
    theme: themeState(),
    /** The name on this person's comments (config.json `displayName`), shared with plan and code review; null when never set. Not for a guest. */
    ...(guest ? {} : { display_name: displayNameState() }),
    /** The window's text size in px (config.json `inboxTextSize`), 14 unless chosen. */
    text_size: textSizeState(),
    /** How the list's rows look (config.json `inboxRows`): the options that are on, null until first saved; `rows_rev` counts the saves. */
    ...rowsWire(rowsState()),
    /** The guided review's diff layout (config.json `diffOptions.diffStyle`), shared with code review; null when never chosen. */
    diff_style: diffStyleState(),
    /** Experimental features, each off unless switched on (Settings → Capabilities → Experimental). */
    experimental: experimentalState(),
    /** The Board (config.json `inboxBoard`): off unless the person turned it on. */
    board: { on: boardOn() },
    /** Launch (config.json `inboxLaunch`): present only while it is on; Settings → Agents' full-permissions switch. */
    ...(launch.enabled() ? { launch: launch.settingsState() } : {}),
    /** Thread steps (config.json `inboxSteps`): off unless the person turned it on. */
    steps: { on: stepsOn() },
    /** Code review (config.json `inboxCodeReview`) and Shape (`inboxShape`): off unless the person turned them on. Held until the next big release: absent while off. */
    ...heldSwitch("code_review", codeReviewOn()),
    ...heldSwitch("shape", shapeOn()),
    /** The onboarding tour: started, finished or skipped, and whether the first real thread offers notifications once more. */
    tour: tourState(),
    /** Settings → Prompts: the Inbox reminder (editable by the owner) and the plan, review and annotate prompts. */
    prompts: promptsState(!guest),
    ...(withStore ? { store: perfPhase("disk", () => store.diskUsage()) } : {}),
    /** Settings → Storage's folder, so its line is drawn before the count. The sizes are their own read: GET /api/inbox/settings/storage. */
    store_dir: store.dir,
    /** Whether this Inbox serves phones; the window shows the Phones block only then. */
    phones: phonesOn,
    /** Ask AI (PLANNOTATOR_INBOX_ASK_AI, or Code review on): absent while it is off, and for a tailnet guest, who may not use it. */
    ...(askOnNow() && !guest ? { ask_ai: true } : {}),
    /** Whether `cswap` is on this computer, so the sidebar's Usage row is there before the first read. Looks on PATH, runs nothing. Never for a tailnet guest. */
    cswap: !guest && accounts.installed(),
  });

  /** Save the knob for the hosts named, keeping the others as they are. `validateOnly`: check the input and write nothing. */
  const saveInboxTool = (input: unknown, validateOnly = false) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new InboxError("validation_error", "inbox_tool: an object of host to boolean.", { field: "inbox_tool" });
    }
    const changes: Partial<Record<InboxToolHost, boolean>> = {};
    for (const [host, value] of Object.entries(input as Record<string, unknown>)) {
      if (!(INBOX_TOOL_HOSTS as readonly string[]).includes(host)) {
        throw new InboxError("validation_error", `inbox_tool.${host}: not a host (claude-code, pi, opencode, dsh).`, { field: `inbox_tool.${host}` });
      }
      if (typeof value !== "boolean") {
        throw new InboxError("validation_error", `inbox_tool.${host}: must be a boolean.`, { field: `inbox_tool.${host}` });
      }
      changes[host as InboxToolHost] = value;
    }
    if (validateOnly) return inboxToolState();
    // Every other entry is kept, a host this version does not know included.
    saveConfig({ inboxTool: inboxToolWith(loadConfig().inboxTool, changes) });
    const saved = loadConfig();
    for (const [host, value] of Object.entries(changes)) {
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
        // `thread_id` (additive): its message's thread, so a window re-reads its open thread only for that thread's records.
        return { seq: line.seq, kind: line.kind, id: line.id, thread_id: store.message(line.record.message_id)?.thread_id ?? null, question: store.questionWire(line.record) };
      case "annotation":
        return { seq: line.seq, kind: line.kind, id: line.id, annotation: line.record };
      case "card":
        // A Board card (approval "inbox-board"). A reader that does not know the kind skips it.
        return { seq: line.seq, kind: line.kind, id: line.id, card: store.cardWire(line.record) };
      case "steps":
        // A session's steps in a thread (approval "inbox-thread-steps"): silent, never a notification or unread.
        // `thread_id` so a window reads the open thread's steps again only for its own. A reader that does not know the kind skips it.
        return { seq: line.seq, kind: line.kind, id: line.id, thread_id: line.record.thread_id };
      case "initiative":
        // A Board initiative (approval "board-initiatives"): silent. A reader that does not know the kind skips it.
        return { seq: line.seq, kind: line.kind, id: line.id, initiative: line.record };
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
        // A compose draft has no thread: `{ compose: true }` (additive; a window that predates it skips the frame).
        const onDraft = (threadId: string | null) => send(`event: drafts\ndata: ${JSON.stringify(threadId === null ? { compose: true } : { thread_id: threadId })}\n\n`);
        if (windowId) draftListeners.add(onDraft);
        // An Ask AI conversation changed: the window reads it again. Only the owner's own window hears of it.
        const onAsk = (threadId: string) => send(`event: ask\ndata: ${JSON.stringify({ thread_id: threadId })}\n\n`);
        if (windowId && ask.allowed(req, via)) askListeners.add(onAsk);
        // The sidebar's pins changed (any window's, or a deletion): the list reads `pins` again. Windows only.
        const onPins = () => send(`event: pins\ndata: {}\n\n`);
        if (windowId) pinListeners.add(onPins);
        // A snooze changed or ran out: the list is read again. Windows, and a linked machine that asks (`snoozes=1`:
        // a snooze writes no record, so its copy of this machine's rows would not move). The phone's door hears nothing new.
        const onSnoozes = () => send(`event: snoozes\ndata: {}\n\n`);
        if (windowId || url.searchParams.get("snoozes") === "1") snoozeListeners.add(onSnoozes);
        // How the rows look was saved (any window's, a phone's too): every window takes it at once. Windows only.
        const onRows = (rows: readonly InboxRowsOption[], rev: number) => send(`event: rows\ndata: ${JSON.stringify({ rows, rev })}\n\n`);
        if (windowId) rowsListeners.add(onRows);
        // The steps switch was saved (any window's): every window reads its settings and the open thread's steps again. Windows only.
        // Shape's boards changed (a version, a note, a delivery, seen): `event: shapes` on this one stream, so a window
        // opens no second connection (sharedEvents.ts holds every tab to one). Only while Shape is on, and only for the
        // owner's window (here, or the owner over the tailnet): a tailnet guest, refused the routes, hears no board ids
        // and starts no polling. Off, nothing polls.
        const shapesFor = ownerOrLocal(req, via);
        let stopShapes: (() => void) | null = null;
        const syncShapes = () => {
          if (windowId && shapesFor && shapeOn() && !stopShapes) stopShapes = shapes.watch.subscribe((ids) => send(shapeEventFrame(ids)));
          else if (!shapeOn() && stopShapes) {
            stopShapes();
            stopShapes = null;
          }
        };
        syncShapes();
        const onCapabilities = (changed?: "code_review" | "shape") => {
          syncShapes();
          const frame = { board: { on: boardOn() }, steps: { on: stepsOn() }, ...heldSwitch("code_review", codeReviewOn(), changed === "code_review"), ...heldSwitch("shape", shapeOn(), changed === "shape") };
          send(`event: capabilities\ndata: ${JSON.stringify(frame)}\n\n`);
        };
        if (windowId) capabilityListeners.add(onCapabilities);
        if (windowId) sendReach();
        // A row's delivery moved with the live sessions (no store line): windows only, like `reach`.
        // `labels` (additive): a session's label changed; only the owner's windows hear it (they alone read labels).
        // A change of labels alone says nothing to a guest's window, so it gets no frame at all.
        const labelsHere = ownerOrLocal(req, via);
        const sendDeliveries = (labels: boolean, moved: boolean) => {
          if (!moved && !labelsHere) return;
          send(`event: deliveries\ndata: ${labels && labelsHere ? '{"labels":true}' : "{}"}\n\n`);
        };
        if (windowId) deliveryListeners.add(sendDeliveries);
        // Linked machines (`machines=1`, the window only; the door refuses it to a machine): their records, states and
        // the outbox, each in its own frame and never with an `id:`, so the local seq and Last-Event-ID stay this Inbox's.
        // A `machines` snapshot opens every stream: a resync, never a notification.
        const sendMachine = (frame: MachineFrame) => send(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);
        const stopMachines = url.searchParams.get("machines") === "1" ? machines.subscribe(sendMachine) : () => {};
        if (url.searchParams.get("machines") === "1") sendMachine({ event: "machines", data: { machines: machines.machinesView() } });
        // A window hears its heartbeat (a named frame, so the page sees it and can tell a dead connection from a
        // quiet Inbox); the phone's door, a linked machine and agents keep the comment line, as before.
        const heartbeat = windowId
          ? setInterval(() => send("event: heartbeat\ndata: {}\n\n"), options.windowHeartbeatMs ?? INBOX_WINDOW_HEARTBEAT_MS)
          : setInterval(() => send(": ping\n\n"), SSE_HEARTBEAT_MS);
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
          askListeners.delete(onAsk);
          pinListeners.delete(onPins);
          snoozeListeners.delete(onSnoozes);
          rowsListeners.delete(onRows);
          capabilityListeners.delete(onCapabilities);
          stopShapes?.();
          stopShapes = null;
          deliveryListeners.delete(sendDeliveries);
          stopMachines();
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
    const command = replyCommandOf(reply, sendNow, session);
    // A Tidy body is written when the run starts: with steps turned off since, it goes without its steps lines.
    if (command.tidy && !stepsOn()) return { ...command, body: inboxTidyBodyStepsOff(command.body) };
    // Thread steps (approval "inbox-thread-steps"): the session's own list in this thread, one wake line, only while
    // the person has steps on. Never on a Tidy, a 👍 or a hand-off notice: those are not about the thread's work.
    if (!stepsOn() || command.tidy || command.ack_of || command.handed_away) return command;
    const receiver = session ?? store.recipientOf(reply)?.session ?? null;
    const list = receiver ? store.stepsOf(reply.thread_id, receiver) : null;
    if (!list) return command;
    const { done, total, doing } = inboxStepsProgress(list.steps);
    return total > 0 ? { ...command, steps: { done, total, doing } } : command;
  };
  const replyCommandOf = (reply: InboxMessage, sendNow: boolean, session: string | null): InboxReplyCommand => {
    const tag = session && !store.isOwner(reply, session) ? (reply.tags?.find((t) => t.session === session) ?? null) : null;
    // Every wake's title, decided once: null on a plain reply in a thread with no name (an older connection says `a reply` too).
    const subject = store.agentTitle(reply, session);
    // The former owner of a handed-off thread: the notice alone (its body, so an older connection still says it).
    if (tag?.handed_away) {
      const to = hostAgentName(reply.to?.host);
      return {
        type: "reply",
        id: reply.id,
        thread_id: reply.thread_id,
        reply_to: reply.reply_to,
        subject,
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
        subject,
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
    return { ...ownerCommand(reply, sendNow, subject), ...handedFrom, ...(alsoTagged.length > 0 ? { also_tagged: alsoTagged } : {}) };
  };
  const ownerCommand = (reply: InboxMessage, sendNow: boolean, subject: string | null): InboxReplyCommand => {
    // Tidy: the note's body is the whole wake (inboxWakeText words it); never a reply to anything.
    if (reply.tidy) {
      return { type: "message", id: reply.id, thread_id: reply.thread_id, reply_to: null, subject: "Tidy", body: reply.body, url: threadPageUrl(baseUrl, reply.thread_id), tidy: true };
    }
    // A reply the person sent to another session because the one that asked
    // had ended: the wake says so, naming the agent that asked.
    const asked = store.redirectedFrom(reply);
    // Named from the host (`Claude Code`), never from the name the agent gave
    // itself: this line goes into another session's prompt.
    const redirected = asked ? hostAgentName(asked.host, "agent") : null;
    // More words in a thread the person started, handed to a session that has
    // seen nothing of it (the person moved them there): read the thread first.
    const continues = store.continuesThread(reply);
    return {
      type: reply.to && !reply.reply_to ? "message" : "reply",
      id: reply.id,
      thread_id: reply.thread_id,
      reply_to: reply.reply_to,
      subject,
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
    const commands = () =>
      store
        .pendingReplies(session, { tags })
        .filter((reply) => !withdrawnTidy(reply))
        .map((reply) => replyCommand(reply, sendNow, session));
    // Ask AI: said on every answer until the client connects, so an answer that no one read loses nothing.
    const askWaits = () => (ask.waits(session) ? { [INBOX_ASK_WAITS_FIELD]: true } : {});
    const now = commands();
    if (now.length > 0 || waitMs === 0 || ask.waits(session)) {
      answered();
      return json({ commands: now, ...askWaits() });
    }
    return new Promise<Response>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        stopAskWaits();
        req.signal.removeEventListener("abort", finish);
        answered();
        resolve(json({ commands: commands(), ...askWaits() }));
      };
      const timer = setTimeout(finish, waitMs);
      const unsubscribe = store.subscribe((line) => {
        if (line.kind === "message" && line.record.author.kind === "person" && store.pendingReplies(session, { tags }).length > 0) finish();
      });
      const stopAskWaits = ask.onWaits((waiting) => {
        if (waiting === session) finish();
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

  /**
   * A tool call answered here as a tool result, before the MCP server (which
   * has no such tool) would say "unknown tool", with nothing written:
   * `wait_for_reply`, gone from the Inbox while an older plugin, skill or
   * client may still call it, and `card` while the Board is off (a session
   * listed the tool while it was on; its tool list is fixed for the session).
   * Anything else, or a body that does not read, goes on to the MCP server
   * unchanged.
   */
  const refusedToolCall = (body: unknown): Response | null => {
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const call = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: { name?: unknown } };
    if (call.method !== "tools/call" || call.id === undefined) return null;
    const text =
      call.params?.name === INBOX_REMOVED_ACTION
        ? INBOX_REMOVED_ACTION_TEXT
        : call.params?.name === "card" && !boardOn()
          ? INBOX_BOARD_OFF_TEXT
          : call.params?.name === "steps" && !stepsOn()
            ? INBOX_STEPS_OFF_TEXT
            : null;
    return text ? json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text }], isError: true } }) : null;
  };

  /**
   * A send_message carrying `steps` while steps are off (a session that listed
   * the field while they were on): the message still goes, without the list,
   * instead of failing on a field the schema no longer has. Null when the
   * body needs no change.
   */
  const withoutOffSteps = (body: unknown): unknown | null => {
    if (stepsOn() || !body || typeof body !== "object" || Array.isArray(body)) return null;
    const call = body as { method?: unknown; params?: { name?: unknown; arguments?: Record<string, unknown> } };
    if (call.method !== "tools/call" || call.params?.name !== "send_message" || !call.params.arguments || !("steps" in call.params.arguments)) return null;
    const { steps: _dropped, ...rest } = call.params.arguments;
    return { ...call, params: { ...call.params, arguments: rest } };
  };

  /** The agent sessions a `/mcp` POST's tool calls name (a batch included), as MCP presence. */
  const noteMcpPresence = async (body: unknown): Promise<void> => {
    try {
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
        // message, compose and tags. A command its shell runs (host codex, CODEX_THREAD_ID) names no turn, so
        // it is presence, and marks a queued Tidy wake delivered, but it delivers no reply and is not made live.
        const meta = params?._meta;
        const thread = codexThreadOfCall(meta);
        if (thread && (!session || session === thread)) {
          if (!session) live.seenOverMcp(thread, { host: INBOX_CODEX_HOST });
          codexWake.noteToolCall(thread, codexTurnStartedAt(meta));
          if (await codexWake.wakes(INBOX_CODEX_HOST, thread, meta)) {
            await live.seenWakeOnly(thread, INBOX_CODEX_HOST, args?.project_path);
          }
        } else if (session && args?.agent_host === INBOX_T3_HOST && isT3ThreadId(session)) {
          // A T3 Code thread (inbox-t3-wake.ts; the shim names it from T3CODE_THREAD_ID): it is there, and while
          // a saved T3 grant reaches it, it is live for New message, compose and tags.
          t3Wake.noteToolCall(session);
          if (await t3Wake.wakes(INBOX_T3_HOST, session)) await live.seenWakeOnly(session, INBOX_T3_HOST, args?.project_path);
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
      // A shape it does not know: the MCP handler answers it.
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
    wakeOnlyStatus: (session) => codexWake.status(session) ?? qwenWake.status(session) ?? t3Wake.status(session),
    uncertainItemsOf: (session) => [...codexWake.uncertainItems(session), ...qwenWake.uncertainItems(session), ...t3Wake.uncertainItems(session)],
  });

  // Shape (approval "shape-inbox-placement"): the boards' routes and event feed, mounted only while Shape is on.
  // The drawing session's state, for the board's Ask footer: its own session, else the thread's owner.
  const shapes = createBunShapeRoutes({
    dataDir,
    sessionOf: (shape) => {
      const session = shape.session?.id ?? (shape.thread ? store.threadOwner(shape.thread)?.session ?? null : null);
      const connection = session ? live.connectionOf(session) : null;
      return { state: !connection ? "gone" : connection.busy ? "busy" : "live", agent: shapeAgentName(shape.session) };
    },
  });

  // The Codex wake: the person's items for a Codex thread go in as a new turn through `codex queue`,
  // once each (inbox-codex-wake.ts). Worded like any bridge command.
  const codexWake = createInboxCodexWake({
    store,
    environment: agentEnvironment,
    commandOf: (item, session) => replyCommand(item, false, session),
    // A steps-only Tidy wake with steps off is withdrawn, never handed (a switch turned off in config.json by hand).
    skip: (item) => withdrawnTidy(item),
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
    // A steps-only Tidy wake with steps off is withdrawn, never handed (a switch turned off in config.json by hand).
    skip: (item) => withdrawnTidy(item),
    ...options.qwenWake,
  });

  // The T3 Code wake: the person's items for a T3 thread go in as a T3 turn through T3's MCP API, under the
  // grant `plannotator t3 login` saved (inbox-t3-wake.ts).
  const t3Wake = createInboxT3Wake({
    store,
    dataDir,
    commandOf: (item, session) => replyCommand(item, false, session),
    // A steps-only Tidy wake with steps off is withdrawn, never handed (a switch turned off in config.json by hand).
    skip: (item) => withdrawnTidy(item),
    ...options.t3Wake,
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
    hostOf: live.hostOf,
    // A Codex reply whose `codex queue` ran out of time may not have gone: its row says it is saved, not queued.
    uncertain: (session, itemId) => codexWake.uncertain(session, itemId) || qwenWake.uncertain(session, itemId) || t3Wake.uncertain(session, itemId),
    autoSendAfterMs: live.autoSendAfterMs,
    waitOf: live.waitOf,
  });
  // A session's turn starting or ending, its connection going away, or an asker grace running out moves a
  // row's delivery without writing a store line. The sessions' delivery signature is compared on a short
  // timer, only while a window listens, and `event: deliveries` tells the windows to read the list again.
  // A poll that changed a session's label (issue #2450) says `labels` on the same frame: the rows' agents and the
  // open thread's authors read the list again.
  // `moved`: a row's delivery moved (every window hears it); `labels`: a label changed (the owner's windows only).
  const deliveryListeners = new Set<(labels: boolean, moved: boolean) => void>();
  let lastDeliverySignature = "";
  let lastLabelVersion = live.labelVersion();
  const deliveryWatch = setInterval(() => {
    // Launched threads: respawn a stopped session someone wrote to; read the CLI only while a window watches.
    launch.sweep(deliveryListeners.size > 0);
    if (deliveryListeners.size === 0) return;
    const signature = live.deliverySignature() + launch.signature();
    const moved = signature !== lastDeliverySignature;
    const labels = live.labelVersion() !== lastLabelVersion;
    if (!moved && !labels) return;
    lastDeliverySignature = signature;
    lastLabelVersion = live.labelVersion();
    for (const listener of deliveryListeners) listener(labels, moved);
  }, INBOX_DELIVERY_WATCH_MS);
  (deliveryWatch as { unref?: () => void }).unref?.();

  const tagsRoute = createInboxTagsRoute({ store, serverSession, live, json });
  const stepsRoute = createInboxStepsRoute({ store, serverSession, live, stepsOn, json });

  /** A tailnet login the allow list let in that is not this computer's owner: never starts, stops or deletes an agent (as Ask AI's own check below). */
  const isGuest = (req: Request, via: string) => via === "tailnet" && !tailscale.isOwnerRequest(req.headers);
  // Launch: compose starts Claude Code in a project, behind `inboxLaunch.enabled` (packages/server/inbox-launch.ts).
  // A start gets the person's login-shell env (read for that start only); a sandboxed test Inbox reads no shell and finds no CLI.
  const launch = createInboxLaunch({
    store,
    live,
    dataDir,
    serverSession,
    // The sandbox's own home: Trust folder writes to `<home>/.claude.json`, so a test never reaches the real one.
    homeDir: process.env.PLANNOTATOR_TEST_SANDBOX ? join(dataDir, "agents-home") : homedir(),
    platform: process.platform,
    loginEnv: process.env.PLANNOTATOR_TEST_SANDBOX
      ? async () => ({ HOME: join(dataDir, "agents-home"), PATH: "" })
      : createLoginEnv({
          run: (argv, o) => createAgentEnvironmentFor({ platform: process.platform, homeDir: homedir(), env: o.env }).run(argv, { timeoutMs: o.timeoutMs }),
          env: () => process.env,
          log: (line) => process.stderr.write(`${line}\n`),
        }),
    ownEnv: () => (process.env.PLANNOTATOR_TEST_SANDBOX ? { HOME: join(dataDir, "agents-home"), PATH: "" } : process.env),
    installDirs: process.env.PLANNOTATOR_TEST_SANDBOX ? [] : [join(homedir(), ".local", "bin"), join(homedir(), ".claude", "local")],
    displayFolder: (path) => displayPath(path, agentEnvironment) ?? path,
    readBody: (req) => readBody(req),
    json,
    onChange: () => {
      // A run line moved: a delivery move to every window, no label change.
      for (const listener of deliveryListeners) listener(false, true);
    },
    log: (line) => process.stderr.write(`${line}\n`),
    // The permission hook runs this Plannotator.
    selfCommand,
    hosts: options.launchHosts,
    isGuest,
  });
  // The login shell read ahead, off any request's path (launch on only).
  launch.warm();

  // Compose: a new thread the person starts with a live agent, drafts and uploads (packages/server/inbox-compose.ts).
  const compose = createInboxCompose({
    store,
    serverSession,
    live,
    resolveProject,
    readBody: (req) => readBody(req),
    json,
    boardOn,
    launch,
    isGuest,
    machine: () => machines.selfId,
    onDraftsChange: () => {
      for (const listener of draftListeners) listener(null);
    },
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
  // Ask AI: the conversation a thread keeps with its agent (packages/server/inbox-ask.ts).
  const ask = createInboxAsk({
    on: askOnNow,
    codeReviewOn,
    // Show me's review: its thread, title and the files of its diff (inbox-guides.ts reads the stored snapshot).
    reviewOf: (messageId) => {
      const message = store.message(messageId);
      if (!message) return null;
      if (!message.guide?.review || message.author.kind !== "agent") return "not_a_review";
      const snapshot = readInboxReviewSnapshot(store, messageId);
      if (!snapshot) return null;
      return { threadId: message.thread_id, title: message.guide.title, files: parseDiffToFiles(snapshot.review.rawPatch).map((file) => file.path) };
    },
    store,
    serverSession,
    readBody: (req) => readBody(req),
    json,
    isGuest: (req, via) => via === "tailnet" && !tailscale.isOwnerRequest(req.headers),
    onChange: (threadId) => {
      for (const listener of askListeners) listener(threadId);
    },
    token,
    hostOf: (session) => live.askHostOf(session),
    ...(options.askTimes ? { times: options.askTimes } : {}),
  });
  // Show me's drawings (packages/server/inbox-review-drawings.ts): the agent's pictures for a review, beside it.
  const reviewDrawings = createInboxReviewDrawings({
    store,
    serverSession,
    json,
    readBody: (req) => readBody(req),
    codeReviewOn,
    isGuest: (req, via) => via === "tailnet" && !tailscale.isOwnerRequest(req.headers),
    onAskChange: (threadId) => {
      for (const listener of askListeners) listener(threadId);
    },
  });
  // A deleted review takes its drawings along.
  store.onDeletion(() => pruneInboxReviewDrawings(store.dir, (messageId) => store.message(messageId) !== null));
  // Pins: threads pinned to the window's sidebar (packages/server/inbox-pins.ts). A deletion's prune tells the windows too.
  const pins = createInboxPins({ store, serverSession, readBody: (req) => readBody(req), json });
  // Snoozes: threads out of the list until a time (packages/server/inbox-snooze.ts).
  const snoozes = createInboxSnoozes({
    store,
    serverSession,
    readBody: (req) => readBody(req),
    json,
    tell: () => {
      for (const listener of snoozeListeners) listener();
    },
  });
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
  // The device door: always made (linked machines use it with Phones off); with Phones off it serves machines only,
  // and pairing a phone, the Wi-Fi listener, the relay and the phone routes do not exist.
  let phones: ReturnType<typeof createInboxDevices> | null = null;
  // Linked machines (inbox-machines.ts): made with the door, once the port is known.
  let machines: InboxMachines;
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

  /** Voice dictation (inbox-voice.ts): Settings → Voice, its one-time announcement and its routes. */
  const voice = createInboxVoice({
    dataDir,
    environment: agentEnvironment,
    version,
    serverSession,
    usedBefore,
    decidesIntro: normalizeStableVersion(version) !== null,
    computerName: () => phones?.machineDoor.computerName() ?? "this computer",
    // It goes last: the sound and list options dialogs first, whatever keeps them waiting.
    otherDialogDue: () => soundState().dialog_due || listIntroState().due,
    json,
    readBody,
    ...options.voice,
  });

  /** Settings → Accounts (inbox-accounts.ts): this computer's Claude accounts, read through `cswap`. */
  const accounts = createInboxAccountsFor(agentEnvironment, options.accounts);

  /** "Open in" for attachments: launches an app on this computer, so local only (never the tailnet, never the device door). */
  const openInRoute = createInboxOpenInRoute({
    store,
    serverSession,
    readBody,
    json,
    localOnly,
    launcher: options.openInLauncher ?? systemOpenInLauncher(),
    home: options.openInHome,
    codeReviewOn,
    shapeRoot: (id) => {
      const shape = shapeOn() ? shapes.store.get(id) : null;
      return shape ? shapeCodeRoot(shape.project) : null;
    },
    // The PR page read the pull list first, which read each project's origin.
    repoRoots: (repo) =>
      store
        .allProjects()
        .filter((project) => {
          const origin = repos.get(project.root);
          return origin?.host && inboxPullRepoKey(origin.host, origin.display) === repo;
        })
        .map((project) => project.root),
  });

  /**
   * Each project folder's agent messages (by the folder's own project id) for
   * Tidy's "started a folder above" suggestion: who sent each, and the folder
   * it was sent from (`base_path`). Built on the first read, then kept up by
   * the store's lines: only a NEW agent message adds to it (a mark-read or any
   * other rewrite of a message line does not), and a re-read from disk (a
   * deletion, `reloadCount`) builds it again. Read by group at lookup, so a
   * combine or an undo needs no rebuild.
   */
  let agentWorkIndex: { reloads: number; seen: Set<string>; byProject: Map<string, InboxAgentWork[]> } | null = null;
  const addAgentWork = (index: NonNullable<typeof agentWorkIndex>, message: InboxMessage) => {
    if (message.author.kind !== "agent" || index.seen.has(message.id)) return;
    index.seen.add(message.id);
    const work = index.byProject.get(message.project_id) ?? [];
    work.push({ session: message.author.session, folder: message.base_path ?? null });
    index.byProject.set(message.project_id, work);
  };
  const unsubscribeAgentWork = store.subscribe((line) => {
    if (agentWorkIndex && line.kind === "message") addAgentWork(agentWorkIndex, line.record);
  });
  const agentWorkOf = (projectId: string): InboxAgentWork[] => {
    if (agentWorkIndex?.reloads !== store.reloadCount()) {
      const index = { reloads: store.reloadCount(), seen: new Set<string>(), byProject: new Map<string, InboxAgentWork[]>() };
      for (const threadId of store.threadIds()) {
        for (const id of store.threadMessageIds(threadId)) {
          const message = store.message(id);
          if (message) addAgentWork(index, message);
        }
      }
      agentWorkIndex = index;
    }
    const index = agentWorkIndex;
    return store.projectGroup(projectId).flatMap((id) => index.byProject.get(id) ?? []);
  };

  // Tidy (packages/server/inbox-tidy.ts): the list header's and the Board's ⋮ menu.
  const tidy = createInboxTidy({
    store,
    serverSession,
    deliveryConnectionOf: (session) => live.deliveryConnectionOf(session),
    // The last idle transition, kept through a busy turn and the session's end (not the live idle_since).
    idleSince: (session) => live.lastIdleOf(session),
    mcpAgents: () => live.mcpAgents(),
    boardOn,
    // Thread steps (approval "inbox-thread-steps", part 5): a stale step in progress is a Tidy item only while the switch is on.
    stepsStale: () => {
      if (!stepsOn()) return null;
      const t = Date.now();
      return (record) => inboxStepsStale(record, live, t);
    },
    readBody,
    json,
    combineSuggestions: () => {
      // Runs on every list read, so it costs nothing without a duplicate: the repo cache as it stands (no git), and threads counted only for a pair.
      let threads: Map<string, number> | null = null;
      const threadsOf = (id: string) => {
        if (!threads) {
          threads = new Map();
          for (const row of store.listRows()) threads.set(row.project.id, (threads.get(row.project.id) ?? 0) + 1);
        }
        return threads.get(id) ?? 0;
      };
      return combineSuggestions({
        projects: store.listProjects(),
        everyProject: store.allProjects(),
        repoOf: (root) => repos.peek(root),
        threads: threadsOf,
        sameProject: (a, b) => store.sameProject(a, b),
        // A folder above a repository (read from disk, no git): not a repository, the home folder or `/`.
        plainFolder: (root) => !existsSync(join(root, ".git")) && !isHomeOrRootFolder(root, projectRoots.home),
        holdsOtherWork: folderHoldsOtherWork,
        agentWork: agentWorkOf,
      });
    },
    combineLoading: () => !repoReadsBegun || repos.reading(),
  });

  /** This computer, or the owner's own login over the tailnet: never a guest the allow list let in. */
  const isOwner = (req: Request, via: RequestVia): boolean => via === "local" || tailscale.isOwnerRequest(req.headers);
  /** The optional debug log (inbox-debug-log.ts): null, the default, changes nothing and writes nothing. */
  const debugLog = (options.debug ?? resolveInboxDebug(loadConfig(), process.env)) ? createInboxDebugLog(join(dataDir, "inbox")) : null;

  /**
   * The window: its page, with its scripts packed behind it (build/pack-inbox.ts, #2593) and answered under
   * `/assets/`, so the page loads its entry script up front and the rest (the guided and code review, the
   * diagram runtimes, the syntax grammars) on first use. An unpacked page (the not-built line) serves whole.
   */
  const windowApp = openPackedApp(options.htmlContent ?? NOT_BUILT_PAGE);
  const windowEntryScripts = [...windowApp.html.matchAll(/<script type="module"[^>]*\ssrc="(\/assets\/[^"]+)"/g)].map((m) => m[1]!);

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
      const answer = phones ? await phones.door(req, url) : null;
      if (answer) return answer;
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
      if (req.method === "POST") {
        const body = (await req.clone().json().catch(() => undefined)) as unknown;
        // A tool call naming an agent_session is presence: that session is
        // not "ended" while it talks to the Inbox, connection or not.
        void noteMcpPresence(body);
        const refused = refusedToolCall(body);
        if (refused) return refused;
        const stripped = withoutOffSteps(body);
        if (stripped) {
          const headers = new Headers(req.headers);
          headers.delete("content-length");
          return mcp.fetch(new Request(req.url, { method: "POST", headers, body: JSON.stringify(stripped) }));
        }
      }
      return mcp.fetch(req);
    }

    // A launched session's permission hook (Claude Code's: inbox-launch-claude-permission.ts): guarded like the bridge below
    // (this machine, no browser, the Inbox token), then the launch's own key. Never a window route.
    const isPermissionHook = /^\/api\/inbox\/launch\/[^/]+\/permission$/.test(path);
    // Ask AI's client (inbox-ask-live.ts). With the setting off, the unknown route, as if it did not exist.
    const askClient = askOnNow() && path.startsWith(INBOX_ASK_BRIDGE_PREFIX);
    // `plannotator review draw` / `drawings` (inbox-review-drawings.ts): a POST, or a read that carries the token. The window reads below.
    // Code review off: not a route at all, as before Show me.
    const drawingsClient = INBOX_REVIEW_DRAWINGS_PATH.test(path) && (req.method !== "GET" || req.headers.has("authorization")) && codeReviewOn();
    if (path.startsWith("/api/inbox/control/") || path.startsWith("/api/inbox/bridge/") || isPermissionHook || askClient || drawingsClient) {
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
      if (isPermissionHook) {
        try {
          return (await launch.permissionRoute(req, path)) ?? json({ error: "Not found", code: "not_found" }, 404);
        } catch (error) {
          return errorResponse(error);
        }
      }
      if (askClient) {
        try {
          return await ask.hostRoute(req, url);
        } catch (error) {
          return errorResponse(error);
        }
      }
      if (drawingsClient) {
        try {
          return (await reviewDrawings.cliRoute(req, path)) ?? json({ error: "Not found", code: "not_found" }, 404);
        } catch (error) {
          return errorResponse(error);
        }
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
      // `plannotator inbox link`: offer, link, unlink and list linked machines (inbox-machines.ts).
      if (path.startsWith("/api/inbox/control/machines")) {
        try {
          const answer = await machines.control(req, path);
          if (answer) return answer;
        } catch (error) {
          return errorResponse(error);
        }
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
    // The window's debug records (inbox-debug-log.ts): off, this falls through to the unknown-route 404.
    if (debugLog && path === INBOX_DEBUG_PATH) {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      if (!isOwner(req, via)) return json({ error: "Only this computer's owner can write the debug log.", code: "owner_only" }, 403);
      return debugLog.accept(req);
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
      // Ask AI's session and query routes. Off, and on any other server path, they do not exist here.
      if (path.startsWith("/api/ai/")) {
        const answer = await ask.aiRoute(req, path, via);
        if (answer) return answer;
      }
      if (path === "/api/inbox/health" && req.method === "GET") return json(health());
      if (path === "/api/inbox/threads" && req.method === "GET") {
        const projectFilter = projectFilterOf(url);
        const archivedMode = archivedModeOf(url);
        const merged = url.searchParams.get("machines") === "1";
        const snoozedMode = snoozedModeOf(url);
        const rows = perfPhase("rows", () => listModel(projectFilter, archivedMode, merged, snoozedMode));
        // `session_labels` (additive, issue #2450): each session's label by id, for the rows' agents and a message's
        // author. Display only, never stored; this computer's owner only, so a tailnet guest reads the list as before.
        const model = ownerOrLocal(req, via) ? { ...rows, session_labels: live.labels() } : rows;
        // `since` (the window, #2593): only the rows changed since the list it holds (inbox-list-delta.ts); the rest of
        // the model, the labels too, goes as it is now. Without it, as before.
        const since = url.searchParams.get("since");
        if (since === null) return json(model);
        return json(listVersions.answer(`${projectFilter ?? ""}|${archivedMode}|${merged ? 1 : 0}|${snoozedMode}`, model, since || null));
      }
      // Linked machines (inbox-machines.ts): the forward /api/inbox/m/<machine>/<route>, the machines and the outbox.
      if (path.startsWith("/api/inbox/m/") || path.startsWith("/api/inbox/machines") || path.startsWith("/api/inbox/outbox")) {
        const answer = await machines.route(req, url, via);
        if (answer) return answer;
      }
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
        // A snoozed thread's decisions wait with it (approval "inbox-snooze"): they come back with the thread.
        const snoozedNow = store.snoozedThreads();
        const open = store.openDecisions({ projectId: projectFilterOf(url) }).filter((decision) => !snoozedNow.has(decision.thread.id));
        const decisions = open.map((decision) => {
          // The thread's own folder: `thread.project` is the head of a combined project.
          const root = store.thread(decision.thread.id)?.project.root;
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
      // Pull requests (inbox-pulls.ts; approval "inbox-code-review-direction", items 4 and 5): the PRs of the
      // projects' repositories, read with this computer's gh / glab, and the agent thread each is tied to. Only
      // while Code review is on (refused before anything runs otherwise), only the owner's window (this computer's,
      // or the owner's over the tailnet), never on the device door (not on its allowlist), never another site.
      if (path === "/api/inbox/pulls" || path === "/api/inbox/pulls/diff" || path === "/api/inbox/pulls/avatar") {
        if (req.method !== "GET") return json({ error: "Use GET." }, 405);
        if (!ownerOrLocal(req, via)) return localOnly();
        if (!isSameOriginOrNoOrigin(origin, req.headers.get("host") ?? "", req.headers.get("sec-fetch-site"))) {
          return json({ error: "Cross-origin requests are not accepted.", code: "cross_origin" }, 403);
        }
        if (!codeReviewOn()) return json({ error: "Code review is off.", code: "code_review_off" }, 409);
        // A PR author's picture (the list's top-left spot): only a login the last list showed on that host, fetched by
        // the Inbox from the URL the forge gave (inbox-pull-avatars.ts); the window's CSP never loads a remote image.
        if (path === "/api/inbox/pulls/avatar") {
          const host = url.searchParams.get("host") ?? "";
          const login = url.searchParams.get("login") ?? "";
          if (host.length === 0 || host.length > 255) throw new InboxError("validation_error", "host: a forge host from the list.", { field: "host" });
          if (login.length === 0 || login.length > 100) throw new InboxError("validation_error", "login: an author's login from the list.", { field: "login" });
          if (!pullAvatars.known(host, login)) return json({ error: "No such author in the list.", code: "avatar_unknown" }, 404);
          const picture = await pullAvatars.get(host, login);
          if (!picture.ok) return json({ error: "No picture for this author.", code: "avatar_miss", miss: picture.miss }, 404);
          return new Response(picture.body, {
            headers: {
              "content-type": picture.type,
              "cache-control": "private, max-age=86400",
              "x-content-type-options": "nosniff",
              "content-security-policy": "sandbox; default-src 'none'",
              "cross-origin-resource-policy": "same-origin",
            },
          });
        }
        if (path === "/api/inbox/pulls/diff") {
          const key = url.searchParams.get("key") ?? "";
          const scope = url.searchParams.get("scope") ?? "layer";
          if (scope !== "layer" && scope !== "stack") throw new InboxError("validation_error", "scope: layer or stack.", { field: "scope" });
          if (key.length === 0 || key.length > 600) throw new InboxError("validation_error", "key: a pull request's key from the list.", { field: "key" });
          try {
            return json({ serverSession, ...(await pulls.diff(key, scope)) });
          } catch (cause) {
            if (cause instanceof InboxPullsError) return json({ error: cause.message, code: cause.code }, cause.code === "pull_unknown" ? 404 : cause.code === "pull_diff_fork" ? 409 : 502);
            throw cause;
          }
        }
        const { projectsByRepo, wanted } = await pullProjects();
        // `others=1`: the person has the Others view open, so Others is read as often as the list.
        const listed = await pulls.list(wanted, { refresh: url.searchParams.get("refresh") === "1", others: url.searchParams.get("others") === "1" });
        // Only this list's authors: a host it did not list (project removed, CLI signed out) keeps no login.
        pullAvatars.allowOnly(listed.hosts.map(({ host }) => ({ host, avatars: pulls.avatarUrls(host) })));
        const links = linkInboxPulls(listed.pulls, pullLinkStore, projectsByRepo, pullOwners.all());
        // The Board is optional: a card that links a PR is a quiet extra, only while the Board is on.
        const cards = boardOn() ? pullCards(listed.pulls, store.listCards()) : {};
        return json({ serverSession, ...listed, links, projects: Object.fromEntries(projectsByRepo), cards });
      }
      // Reviews (approval "inbox-reviews-page"; inbox-reviews.ts and core's inbox-reviews.ts): one row per thread with
      // a review card (the same thread the Inbox lists, never a copy), with the PRs it owns, plus the listed PRs no
      // review thread owns. The PR part is the pulls list's own read (same cache, same hosts). Same guards as the
      // pulls list: refused before anything runs (no git, gh or glab) while Code review is off.
      if (path === "/api/inbox/reviews") {
        if (req.method !== "GET") return json({ error: "Use GET." }, 405);
        if (!ownerOrLocal(req, via)) return localOnly();
        if (!isSameOriginOrNoOrigin(origin, req.headers.get("host") ?? "", req.headers.get("sec-fetch-site"))) {
          return json({ error: "Cross-origin requests are not accepted.", code: "cross_origin" }, 403);
        }
        if (!codeReviewOn()) return json({ error: "Code review is off.", code: "code_review_off" }, 409);
        const { projectsByRepo, wanted } = await pullProjects();
        const listed = await pulls.list(wanted, { refresh: url.searchParams.get("refresh") === "1" });
        const links = linkInboxPulls(listed.pulls, pullLinkStore, projectsByRepo, pullOwners.all());
        const stacks = inboxPullStacks(listed.pulls);
        const pullReasons = new Map<string, InboxPullReason>(inboxPullItems(stacks, (pull) => !!links[pull.key]).map((item) => [item.stack.id, item.reason]));
        const threads = reviewIndex.threads();
        const changes = inboxReviewLandingChanges({ threads, pulls: listed.pulls, links, landed: pullOwners.landings() });
        pullOwners.land(changes.record, changes.forget);
        pullStates.look({ threads, pulls: listed.pulls, hosts: listed.hosts, owners: pullOwners.all(), landed: pullOwners.landings() });
        const rows = inboxReviewRows({ threads, stacks, links, pulls: listed.pulls, pullReasons, landed: pullOwners.landings(), owners: pullOwners.all() });
        return json({ serverSession, fetched_at: listed.fetched_at, hosts: listed.hosts, rows, projects: Object.fromEntries(projectsByRepo) });
      }
      // Pull requests: the person hands a PR (or a stack's PRs) to an agent's thread, the one compose's Send (to a
      // live session, or to an agent it launches) just started for it. The Inbox keeps that choice
      // (inbox/pull-links.json); verdicts and Reply go there. Same guards as the list.
      if (path === "/api/inbox/pulls/owner") {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        if (!ownerOrLocal(req, via)) return localOnly();
        if (!isSameOriginOrNoOrigin(origin, req.headers.get("host") ?? "", req.headers.get("sec-fetch-site"))) {
          return json({ error: "Cross-origin requests are not accepted.", code: "cross_origin" }, 403);
        }
        if (!codeReviewOn()) return json({ error: "Code review is off.", code: "code_review_off" }, 409);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        const keys = Array.isArray(body.keys) ? body.keys : null;
        if (!keys || keys.length === 0 || keys.length > INBOX_PULL_OWNER_KEYS_MAX || !keys.every((k: unknown) => typeof k === "string" && k.length > 0 && k.length <= 600)) {
          throw new InboxError("validation_error", `keys: 1 to ${INBOX_PULL_OWNER_KEYS_MAX} pull request keys from the list.`, { field: "keys" });
        }
        // `validate_only` with `project_id`: may these PRs go to an agent in that project? Asked before the hand-off is
        // sent, so nothing reaches an agent that the Inbox would then refuse to keep as the PRs' owner.
        const validateOnly = body.validate_only === true;
        const threadId = typeof body.thread_id === "string" ? body.thread_id : "";
        const projectId = validateOnly
          ? typeof body.project_id === "string" && store.project(body.project_id)
            ? store.canonicalProjectId(body.project_id)
            : null
          : threadId
            ? pullLinkStore.threadProject(threadId)
            : null;
        if (!projectId) {
          throw validateOnly
            ? new InboxError("validation_error", "project_id: a project in the Inbox.", { field: "project_id" })
            : new InboxError("validation_error", "thread_id: a thread in the Inbox.", { field: "thread_id" });
        }
        const { projectsByRepo, wanted } = await pullProjects();
        // A key this Inbox has not read yet (it restarted since the window's list): read the list once, then look again;
        // still missing while Others is being read (an Others PR), wait for that read (its own deadline) and look again.
        await findPulls(keys as string[], wanted);
        let theirs = true;
        for (const key of keys as string[]) {
          const pull = pulls.find(key);
          if (pull && pull.mine) theirs = false;
          if (!pull) return json({ error: "That pull request is not in the list. Refresh the list and try again.", code: "pull_unknown" }, 404);
          if (!(projectsByRepo.get(`${pull.host}/${pull.repo}`.toLowerCase()) ?? []).includes(projectId)) {
            const field = validateOnly ? "project_id" : "thread_id";
            throw new InboxError("validation_error", `${field}: ${validateOnly ? "a project" : "a thread in a project"} of that pull request's repository.`, { field });
          }
        }
        if (validateOnly) return json({ serverSession, ok: true });
        if (body.ask !== undefined && body.ask !== "guide" && body.ask !== "custom") throw new InboxError("validation_error", "ask: guide or custom.", { field: "ask" });
        pullOwners.set(keys as string[], threadId, { ask: (body.ask as "guide" | "custom" | undefined) ?? null, theirs });
        return json({ serverSession, ok: true });
      }
      // Post to GitHub/GitLab (the owner's answer C on #2590: the person chooses at the end): the review the person
      // wrote in the Inbox goes on the pull request, as `plannotator review <PR url>` posts it (the review app's
      // providers). The Inbox's only write to a forge: as the person's own gh / glab account, so only the owner may
      // (on this computer, or the owner over the tailnet); every other gh / glab call the Inbox makes reads.
      if (path === "/api/inbox/pulls/review") {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        if (!ownerOrLocal(req, via)) return localOnly();
        if (!isSameOriginOrNoOrigin(origin, req.headers.get("host") ?? "", req.headers.get("sec-fetch-site"))) {
          return json({ error: "Cross-origin requests are not accepted.", code: "cross_origin" }, 403);
        }
        if (!codeReviewOn()) return json({ error: "Code review is off.", code: "code_review_off" }, 409);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        const key = typeof body.key === "string" && body.key.length > 0 && body.key.length <= 600 ? body.key : null;
        if (!key) throw new InboxError("validation_error", "key: a pull request key from the list.", { field: "key" });
        const action = parsePRReviewAction(body.action);
        if (!action) throw new InboxError("validation_error", "action: approve, comment or request_changes.", { field: "action" });
        const text = typeof body.body === "string" ? body.body : "";
        if (text.length > PULL_REVIEW_BODY_MAX) throw new InboxError("validation_error", `body: at most ${PULL_REVIEW_BODY_MAX} characters.`, { field: "body" });
        const fileComments = pullReviewComments(body.fileComments);
        if (!fileComments) throw new InboxError("validation_error", `fileComments: at most ${PULL_REVIEW_COMMENTS_MAX} comments, each { path, line, side, body }.`, { field: "fileComments" });
        const fileLevelComments = parseFileLevelComments(body.fileLevelComments).slice(0, PULL_REVIEW_COMMENTS_MAX);
        if (!pulls.find(key)) await findPulls([key], (await pullProjects()).wanted);
        const pull = pulls.find(key);
        if (!pull) return json({ error: "That pull request is not in the list. Refresh the list and try again.", code: "pull_unknown" }, 404);
        if (!inboxPullIsOpen(pull)) return json({ error: "That pull request is no longer open.", code: "pull_closed" }, 409);
        // Pinned to the commit the person read: a push since then is read again first, never reviewed blind.
        // Pinned to a commit the Inbox read for this PR: the list's head, or the head of the layer patch the person
        // read (the list can be a minute behind the forge). Anything else is a commit they never saw.
        const heads = [pull.head_sha, pulls.readHead(key)].filter((sha): sha is string => !!sha);
        if (heads.length === 0) return json({ error: "The forge did not say which commit this pull request is at. Refresh the list and try again.", code: "pull_head_unknown" }, 409);
        const headSha = typeof body.head_sha === "string" && heads.includes(body.head_sha) ? body.head_sha : null;
        if (!headSha) return json({ error: "This pull request has new commits since you read it.", code: "pull_moved" }, 409);
        const ref: PRRef | null =
          pull.platform === "github"
            ? (() => {
                const [owner, repo] = pull.repo.split("/");
                return owner && repo ? { platform: "github" as const, host: pull.host, owner, repo, number: pull.number } : null;
              })()
            : { platform: "gitlab" as const, host: pull.host, projectPath: pull.repo, iid: pull.number };
        if (!ref) return json({ error: "That pull request's repository can't be read here.", code: "pull_unknown" }, 404);
        // The same review twice (a second click, a replayed request): refused, never posted again. Kept while this
        // Inbox runs, for a review that fully went.
        const fingerprint = JSON.stringify([pull.key, headSha, action, text, fileComments, fileLevelComments]);
        if (postedReviews.has(fingerprint)) return json({ error: "This review is already on the pull request.", code: "already_posted" }, 409);
        try {
          const submission = await submitForgeReview(options.prRuntime ?? prCommandRuntime, ref, headSha, action, text, fileComments, fileLevelComments);
          if (submission.status === "complete") {
            postedReviews.add(fingerprint);
            while (postedReviews.size > PULL_REVIEW_POSTED_MAX) postedReviews.delete(postedReviews.values().next().value!);
          }
          // The list reads the forge again on its next look: the review moved the PR's state there.
          return json({ serverSession, ok: true, prUrl: pull.url, submission });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : "The review was not posted.";
          return json({ error: message, code: "pull_review_failed" }, 502);
        }
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
      // What's new and its images (inbox-whats-new-images.ts) only read release
      // notes, so they answer this computer and the owner over the tailnet; any
      // other tailnet login is refused (`owner_only`, as voice and Feedback do).
      // Fetching missing notes by a release's tag is limited to the versions
      // this Inbox knows (inbox-updates.ts fetchableVersion) and stays inside
      // the update-notes folder of the data directory.
      if (path === "/api/inbox/whats-new" || path === INBOX_WHATS_NEW_IMAGE_PATH) {
        if (!ownerOrLocal(req, via)) {
          throw new InboxError("owner_only", "Only this computer's owner can read What's new from this Inbox.");
        }
        // A stored image of a release's notes: read only, never fetched here.
        if (path === INBOX_WHATS_NEW_IMAGE_PATH) return whatsNewImageRoute(req, url, dataDir);
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
      // The update control (packages/server/inbox-updates.ts). Updating changes
      // this computer, so it answers the owner only.
      if (path === "/api/inbox/update" || path.startsWith("/api/inbox/update/")) {
        if (!ownerOrLocal(req, via)) return localOnly();
        if (path === "/api/inbox/update" && req.method === "GET") return json(updates.details());
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        if (path === "/api/inbox/update") {
          const result = await updates.updateNow();
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
      // The agents on this computer: paths in the person's home, and writes to their real agent files.
      if (path === "/api/inbox/agents" || path.startsWith("/api/inbox/agents/")) {
        // The person's own agent files: only theirs, never a tailnet guest's.
        if (!ownerOrLocal(req, via)) return localOnly();
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
      // Settings → Storage's sizes walk every file in the store, so only that panel asks for them, when it is shown.
      if (path === "/api/inbox/settings/storage") {
        if (req.method !== "GET") return json({ error: "Use GET." }, 405);
        return json(perfPhase("disk", () => store.diskUsage()));
      }
      if (path === "/api/inbox/settings") {
        if (req.method === "GET") return json(settingsModel(via, !ownerOrLocal(req, via), url.searchParams.get("store") !== "0"));
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
          body.rows === undefined &&
          body.diff_style === undefined &&
          body.experimental === undefined &&
          body.tour === undefined &&
          body.prompts === undefined &&
          body.board === undefined &&
          body.steps === undefined &&
          body.code_review === undefined &&
          body.shape === undefined &&
          body.cookie_host === undefined &&
          body.voice === undefined &&
          !updateSwitches
        ) {
          throw new InboxError("validation_error", "body: inbox_tool, notifications, sound, tailscale, theme, text_size, rows, diff_style, experimental, tour, prompts, board, steps, code_review, shape, voice, update_check, auto_update or cookie_host is required.");
        }
        const owner = ownerOrLocal(req, via);
        // The Board changes what agents on this computer are offered (the card tool): the owner's to change.
        if (body.board !== undefined && !owner) return localOnly();
        // Steps too (the steps tool, the wake and compaction lines): the owner's to change.
        if (body.steps !== undefined && !owner) return localOnly();
        // Code review too (submit_guide's `review` field, the review skills): the owner's to change.
        if (body.code_review !== undefined && !owner) return localOnly();
        // Shape too (the shape skill, the routes): the owner's to change.
        if (body.shape !== undefined && !owner) return localOnly();
        if (body.voice !== undefined && !owner) throw voiceOwnerOnly();
        // Updating changes this computer: the owner's to change.
        if (updateSwitches && !owner) return localOnly();
        // The reminder goes to every agent session on this computer: the owner's, like Settings → Agents.
        if (body.prompts !== undefined && !owner) return localOnly();
        // The address this computer's browser opens: the owner's to change.
        if (body.cookie_host !== undefined && !owner) return localOnly();
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
        if (body.rows !== undefined) saveRows(body.rows, true);
        if (body.diff_style !== undefined) saveDiffStyle(body.diff_style, true);
        if (body.experimental !== undefined) saveExperimental(body.experimental, true);
        if (body.tour !== undefined) saveTour(body.tour, true);
        if (body.board !== undefined) saveBoard(body.board, true);
        if (body.steps !== undefined) saveSteps(body.steps, true);
        if (body.code_review !== undefined) saveCodeReview(body.code_review, true);
        if (body.shape !== undefined) saveShape(body.shape, true);
        if (body.cookie_host !== undefined) saveCookieHostSwitch(body.cookie_host, true);
        if (body.voice !== undefined) voice.save(body.voice, true);
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
        const rows = rowsWire(body.rows === undefined ? rowsState() : saveRows(body.rows));
        const diffStyle = body.diff_style === undefined ? diffStyleState() : saveDiffStyle(body.diff_style);
        const experimental = body.experimental === undefined ? experimentalState() : saveExperimental(body.experimental);
        const tour = body.tour === undefined ? tourState() : saveTour(body.tour);
        const board = body.board === undefined ? { on: boardOn() } : saveBoard(body.board);
        const steps = body.steps === undefined ? { on: stepsOn() } : saveSteps(body.steps);
        const codeReview = body.code_review === undefined ? { on: codeReviewOn() } : saveCodeReview(body.code_review);
        const shape = body.shape === undefined ? { on: shapeOn() } : saveShape(body.shape);
        if (body.voice !== undefined) voice.save(body.voice);
        if (promptsChange) saveInboxPromptsChange(promptsChange);
        return json({ inbox_tool: inboxTool, notifications, sound, tailscale: tailnet, updates: updateState, theme, text_size: textSize, ...rows, diff_style: diffStyle, experimental, tour, board, steps, ...heldSwitch("code_review", codeReview.on, body.code_review !== undefined), ...heldSwitch("shape", shape.on, body.shape !== undefined), voice: voice.settings(via, !owner), prompts: promptsState(owner), ...(owner ? { cookie_host: cookieHost ?? cookieHostWire() } : {}) });
      }
      // Voice dictation (inbox-voice.ts). A read here can start a `codex`, so another site's is refused too.
      if (path.startsWith("/api/inbox/voice/")) {
        if (!isSameOriginOrNoOrigin(origin, req.headers.get("host") ?? "", req.headers.get("sec-fetch-site"))) {
          return json({ error: "Cross-origin requests are not accepted.", code: "cross_origin" }, 403);
        }
        if (!ownerOrLocal(req, via)) throw voiceOwnerOnly();
        const answer = await voice.route(req, url, via);
        if (answer) return answer;
      }
      // Settings → Accounts: the owner's logins and usage, and a read that goes to the Keychain and to Anthropic,
      // so another site gets no answer and no way to start one, and a tailnet guest gets neither. One check for this
      // computer's read and a linked machine's, which is not forwarded any other way. On the door for a machine only.
      const machineAccounts = /^\/api\/inbox\/accounts\/(ibx_[0-9A-HJKMNP-TV-Z]{26})$/.exec(path);
      if (path === "/api/inbox/accounts" || machineAccounts) {
        if (req.method !== "GET") return json({ error: "Use GET." }, 405);
        if (!isSameOriginOrNoOrigin(origin, req.headers.get("host") ?? "", req.headers.get("sec-fetch-site"))) {
          return json({ error: "Cross-origin requests are not accepted.", code: "cross_origin" }, 403);
        }
        if (!ownerOrLocal(req, via)) throw new InboxError("owner_only", "Only this computer's owner can see its accounts.");
        const fresh = url.searchParams.get("fresh") === "1";
        return json(machineAccounts ? await machines.accountsOf(machineAccounts[1]!, fresh, req.signal) : await accounts.read({ fresh }));
      }

      // The one-time sound dialog: the page asks to show it, and only the first ask ever gets `show: true`.
      if (path === "/api/inbox/sound/dialog") {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        const show = claimSoundDialog(via);
        return json({ show, sound: soundState() });
      }

      // The one-time list options dialog (approval "inbox-list-options-intro"): the first page on this computer to
      // ask gets `show: true`, once per machine; a page reached over the tailnet never claims it.
      if (path === "/api/inbox/list-intro") {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        return json({ show: claimListIntro(via), list_intro: listIntroState() });
      }

      // The one-time Snooze announcement (approval "inbox-snooze-announce"): the first page to ask gets `show: true`,
      // once per machine, on this computer or the owner's phone; a tailnet guest never.
      if (path === "/api/inbox/snooze-intro") {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        const owner = ownerOrLocal(req, via);
        return json({ show: claimSnoozeIntro(owner), snooze_intro: snoozeIntroState(owner) });
      }

      // The reveals for returning users (approval "inbox-feature-reveal"): one compare-and-set over the queue. Only the
      // reveal that is still next can be claimed; a guest never claims. A claim turns nothing on (opt-in, 2026-11-04).
      if (path === "/api/inbox/reveal") {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        const id = body.id;
        if (id !== "snooze" && id !== "board" && id !== "steps") throw new InboxError("validation_error", "id: snooze, board or steps.", { field: "id" });
        // The page's own key for this claim (a retry after a lost answer sends it again): optional, as an older page sends none.
        const key = body.key;
        if (key !== undefined && (typeof key !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(key))) throw new InboxError("validation_error", "key: 8 to 64 letters, digits, - or _.", { field: "key" });
        const owner = ownerOrLocal(req, via);
        const show = claimReveal(id, owner, key ?? null);
        return json({ show, reveal: { next: revealNow(owner) }, board: { on: boardOn() }, steps: { on: stepsOn() } });
      }

      // The Board's first-visit dialog (approval "inbox-board", intro amendment): the first page on this
      // computer or the owner's phone to open the Board claims it, once per machine (config.json
      // `inboxBoardIntro.shownAt`); a tailnet guest never claims it (the owner rule: never inhibit the owner
      // on their own tailnet).
      if (path === "/api/inbox/board/intro") {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        // Only once the Board is on: the dialog introduces a page the person can see.
        if (!ownerOrLocal(req, via) || !boardOn() || loadConfig().inboxBoardIntro?.shownAt) return json({ show: false });
        const at = new Date().toISOString();
        saveConfig({ inboxBoardIntro: { shownAt: at } });
        // Not written (a read-only data dir): showing it anyway would show it on every visit.
        return json({ show: loadConfig().inboxBoardIntro?.shownAt === at });
      }

      // Shape (packages/server/shape-routes.ts): off, every path is the unknown-route 404, as if absent. The person's
      // own window only: another site is refused (reads too: a board names files and folders), and a tailnet guest.
      if (path === "/api/shapes" || path.startsWith("/api/shapes/")) {
        if (!shapeOn()) return json({ error: "Not found", code: "not_found" }, 404);
        const crossSite = crossSiteCardRead(req);
        if (crossSite) return crossSite;
        if (!ownerOrLocal(req, via)) return localOnly();
        if (req.method === "POST") {
          const body = await req.clone().json().catch(() => null);
          if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        }
        const answered = await shapes.route(req, url);
        if (answered) return answered;
        return json({ error: "Not found", code: "not_found" }, 404);
      }

      // Search: a read route (and the recent searches the window writes on opening a result).
      const searched = await search.handle(req, url);
      if (searched) return searched;
      // The composers' skill picker and the SKILL.md a Send pastes in (inbox-skills.ts): read routes.
      const skills = inboxSkillsRoute(req, url, { codeReview: codeReviewOn(), shape: shapeOn() });
      if (skills) return skills;

      // Launch: Stop, Open in Terminal, Delete, Try again, Trust folder and its setting (404 while `inboxLaunch.enabled` is off).
      const launched = await launch.route(req, path, via, isOwner(req, via));
      if (launched) return launched;
      // Compose: live sessions in every project, a new thread, Send to another session, drafts and uploads.
      // The device door is never the owner here: it may not trust a folder, so it is offered none.
      const composed = await compose.route(req, url, isOwner(req, via) && !fromDeviceDoor.has(req), via);
      if (composed) return composed;
      // Reply drafts: the reply box's words per thread (approval "inbox-reply-drafts").
      const drafted = await replyDrafts.route(req, url);
      if (drafted) return drafted;
      // Ask AI: off, this answers nothing and the path is an unknown route.
      const asked = await ask.route(req, url, via);
      if (asked) return asked;
      // Show me's drawings, for the owner's window (inbox-review-drawings.ts; the CLI's door is above).
      const drawn = await reviewDrawings.windowRoute(req, path, via);
      if (drawn) return drawn;
      // Pins (approval "inbox-pinned-threads"): pin, unpin and the order of the sidebar's pinned threads.
      const pinned = await pins.route(req, url);
      if (pinned) return pinned;
      // Snooze and Unsnooze (approval "inbox-snooze").
      const snoozed = await snoozes.route(req, url);
      if (snoozed) return snoozed;
      // Live HTML embeds: keep a fence's page, and serve it under its own sandboxing policy.
      const embedded = await embeds.route(req, url);
      if (embedded) return embedded;
      // Feedback (the sidebar's Feedback dialog): sent on, never stored here. The owner's only: a
      // tailnet guest's words would go out as this computer's (its version, OS, IP and rate limit).
      if (path === INBOX_FEEDBACK_PATH && !ownerOrLocal(req, via)) {
        throw new InboxError("owner_only", "Only this computer's owner can send feedback from this Inbox.");
      }
      const fed = await feedback.route(req, path);
      if (fed) return fed;

      // The Board's cards (approval "inbox-board", step 1): the person's read and moves.
      if (path === "/api/inbox/cards") {
        // Cards carry the person's notes: another site's read is refused, as on the other read routes.
        if (req.method === "GET") return crossSiteCardRead(req) ?? json(cardsModel(url));
        if (req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
        // The person's New card (step 2): a title, notes and links, in Backlog (sent to no agent; a window
        // from before v2 says icebox, which folded into it); or sent to an agent: `thread_id` is the thread
        // the window just started for it with compose's Send (its body the notes), and the card lands in
        // that thread's project, sent, in Todo.
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        const asked = body.column === undefined || body.column === null ? "backlog" : body.column;
        if (asked !== "backlog" && asked !== "icebox" && asked !== "todo") throw new InboxError("validation_error", "column: backlog or todo (a New card).", { field: "column" });
        const column = asked === "icebox" ? "backlog" : asked;
        let projectId: unknown = body.project;
        if (body.thread_id !== undefined && body.thread_id !== null) {
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
          // A New card on a Board filtered to an initiative starts in it (approval "board-initiatives").
          initiative: body.initiative ?? undefined,
        });
        return json({ card: store.cardWire(made.card), replayed: made.replayed });
      }
      // The Board's initiatives (approval "board-initiatives"): the person makes one (`POST`, `name`).
      if (path === "/api/inbox/initiatives") {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        return json({ initiative: store.createInitiative({ name: body.name, by: { kind: "person" } }) });
      }
      // One initiative: `op` rename (`name`), delete (its cards read as in none; no card is written) or restore (the window's Undo).
      const initiativeAt = /^\/api\/inbox\/initiatives\/([^/]+)$/.exec(path);
      if (initiativeAt) {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const id = decodeURIComponent(initiativeAt[1]!);
        if (!isInboxId("ini", id)) throw new InboxError("validation_error", "An initiative id (ini_).", { field: "initiative" });
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        if (body.op === "rename") return json({ initiative: store.renameInitiative(id, body.name) });
        if (body.op === "delete") return json({ initiative: store.deleteInitiative(id) });
        // The window's Undo of a delete: the name taken since answers 409 initiative_exists.
        if (body.op === "restore") return json({ initiative: store.restoreInitiative(id) });
        throw new InboxError("validation_error", "op: rename, delete or restore.", { field: "op" });
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
      // cards on screen. Only the owner's window, only while the Board is on; never on the device
      // door (not on its allowlist). It writes only an automatic move to Done (Q3); it runs gh / glab, so
      // another site is refused first.
      if (path === "/api/inbox/cards/marks") {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        if (!ownerOrLocal(req, via)) return localOnly();
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
        // Auto-ship (approval "inbox-board-columns-v2", Q3): a card in Todo, In progress or In review has
        // its own PRs (linked through `pr`, inboxCardShipPrs) read with its mark, in the same queries; all
        // merged, one of them new since it was last in Done, moves it to Done (inboxCardAutoShip).
        const shipping: { id: string; refs: InboxCardRef[] }[] = [];
        for (const id of new Set(ids as string[])) {
          const card = store.card(id);
          const ref = card ? inboxCardMarkRef(card) : null;
          if (ref) wanted.push({ id, ref });
          if (card && INBOX_CARD_AUTO_SHIP_COLUMNS.includes(card.column)) {
            const own = new Set(inboxCardShipPrs(card));
            const prs = inboxCardRefsOf(card).filter((r) => r.kind === "pr" && own.has(r.url));
            if (prs.length > 0) shipping.push({ id, refs: prs });
          }
        }
        const resolved = await cardMarks.marks(
          [...wanted.map((w) => w.ref), ...shipping.flatMap((s) => s.refs)],
          { refresh: body.refresh === true },
        );
        const marks: Record<string, InboxCardMark> = {};
        for (const { id, ref } of wanted) {
          const mark = resolved.get(ref.url);
          if (mark) marks[id] = mark;
        }
        // Checked again against the card as it is now (it may have moved while gh ran); an unknown state does nothing.
        for (const { id } of shipping) {
          const card = store.card(id);
          const prs = card ? inboxCardAutoShip(card, (url) => resolved.get(url)?.state) : null;
          if (prs) store.autoShipCard(id, prs);
        }
        return json({ serverSession, marks });
      }
      // A web link's favicon on the opened card (inbox-card-favicons.ts): only a link the person added
      // (`by: "person"`), https, fetched here and served from this origin, since the window's CSP never
      // loads a remote image. An agent's link is refused before anything is fetched. Never on the device door.
      const faviconMatch = /^\/api\/inbox\/cards\/([A-Za-z0-9_]+)\/favicon$/.exec(path);
      if (faviconMatch) {
        if (req.method !== "GET") return json({ error: "Use GET." }, 405);
        // It makes this computer ask another host: never for a tailnet guest (as the marks), never with the Board off.
        if (!ownerOrLocal(req, via)) return localOnly();
        const refused = crossSiteCardRead(req);
        if (refused) return refused;
        if (!boardOn()) return json({ error: "The Board is off.", code: "board_off" }, 409);
        const card = store.card(faviconMatch[1]!);
        if (!card) throw new InboxError("card_not_found", `No card ${faviconMatch[1]}.`);
        const href = url.searchParams.get("url") ?? "";
        const ref = inboxCardRefsOf(card).find((r) => r.url === href && r.source === "web");
        if (!ref) return json({ error: "No such web link on this card.", code: "favicon_no_link" }, 404);
        if (ref.by !== "person") return json({ error: "Only a link you added shows its site's icon.", code: "favicon_not_yours" }, 404);
        let host: string;
        try {
          const parsed = new URL(ref.url);
          if (parsed.protocol !== "https:") return json({ error: "Only an https link shows its site's icon.", code: "favicon_not_https" }, 404);
          host = parsed.host;
        } catch {
          return json({ error: "No such web link on this card.", code: "favicon_no_link" }, 404);
        }
        const icon = await cardFavicons.get(host);
        if (!icon.ok) return json({ error: "No icon for this site.", code: "favicon_miss", miss: icon.miss }, 404);
        return new Response(icon.body, {
          headers: {
            "content-type": icon.type,
            "cache-control": "private, max-age=86400",
            "x-content-type-options": "nosniff",
            "content-security-policy": "sandbox; default-src 'none'",
            "cross-origin-resource-policy": "same-origin",
          },
        });
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
        const thread = perfPhase("thread", () => store.windowThread(threadMatch[1]!));
        if (!thread) return json({ error: "No such thread.", code: "thread_not_found" }, 404);
        // `pull_theirs`: the person handed this thread only teammates' PRs, so its reviews take no verdict.
        // `pull_keys` (Code review on): the PRs it owns, which its review may be posted to (Post to GitHub/GitLab).
        const pullKeys = codeReviewOn() ? pullOwners.keys(thread.thread_id) : [];
        const withRepo = {
          ...thread,
          project: { ...thread.project, repo: repos.get(thread.project.root) },
          ...(pullOwners.theirs(thread.thread_id) ? { pull_theirs: true as const } : {}),
          ...(pullKeys.length > 0 ? { pull_keys: pullKeys } : {}),
        };
        // `run` (additive, launch only): the launched thread's run line; null while the agent rests.
        // `attach_command` (with `run`): the host's attach command, there while the agent rests too.
        const run = await launch.runOf(thread.thread_id, isOwner(req, via));
        const row = store.listRow(thread.thread_id);
        // `row` (additive): the thread's list row, also for an archived thread, which the window's list leaves out.
        return json({ serverSession, cursor: store.cursor(), thread: withRepo, row: row ? withSnooze(launch.rowDecorator()(row)) : row, ...(run === undefined ? {} : { run, attach_command: launch.attachOf(thread.thread_id) }) });
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
      // `/unread` is Move back, which reopens them; Mark unread is `/mark-unread`, below.
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

      // Mark unread: the latest agent message is new again (New, bold); nothing is sent, and a Mark read stands (store.markUnread).
      const unreadMatch = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/mark-unread$/.exec(path);
      if (unreadMatch) {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        return json(store.markUnread(unreadMatch[1]!));
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

      // The project menu's Rename… and Reset name: `{ name: string | null }`
      // sets or clears the project's `display_name` (store.renameProject). The
      // same guards as every window write. Window only: not on the phone's
      // door, and never an agent's (no MCP action).
      const projectNameMatch = /^\/api\/inbox\/projects\/([A-Za-z0-9_]+)\/name$/.exec(path);
      if (projectNameMatch) {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        const projectId = projectNameMatch[1]!;
        if (!isInboxId("prj", projectId)) throw new InboxError("validation_error", "A project id (prj_).", { field: "project" });
        if (!("name" in body) || (body.name !== null && typeof body.name !== "string")) {
          throw new InboxError("validation_error", "name: the project's new name, or null to go back to its folder's name.", { field: "name" });
        }
        store.renameProject(projectId, body.name as string | null);
        return json({ project: projectFolders().find((p) => p.id === projectId) ?? null });
      }

      // Combine a project into another, or undo that (approval
      // "project-combine"): `{ into: prj_… | null }`. One new project line
      // (store.combineProject). The same guards as every window write. Answers
      // the project the person now sees, the Undo the window keeps needs no more.
      const projectCombineMatch = /^\/api\/inbox\/projects\/([A-Za-z0-9_]+)\/combine$/.exec(path);
      if (projectCombineMatch) {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        const projectId = projectCombineMatch[1]!;
        if (!isInboxId("prj", projectId)) throw new InboxError("validation_error", "A project id (prj_).", { field: "project" });
        if (!("into" in body) || (body.into !== null && !isInboxId("prj", body.into))) {
          throw new InboxError("validation_error", "into: the project to combine into, or null to undo a combine.", { field: "into" });
        }
        store.combineProject(projectId, body.into as string | null);
        const shown = store.canonicalProjectId(projectId);
        return json({ project: projectFolders().find((p) => p.id === shown) ?? null });
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
        const folder = () => projectFolders().find((p) => p.id === store.canonicalProjectId(projectId)) ?? null;
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
          answer = { project: folder(), batch, threads: rows([...batch.read, ...batch.looked]), ...incomplete(error) };
        } else if (action === "unread") {
          const ids = threadIdList(body.threads, "threads");
          const looked = body.looked === undefined ? [] : threadIdList(body.looked, "looked");
          const result = unmarkProjectRead(store, projectId, ids, looked);
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
      const guide = await inboxGuideRoute(req, path, store, serverSession, codeReviewOn);
      if (guide) return guide;

      // Undo a hand-off inside its window (approval "inbox-tag-handoff"): the reply goes as an Ask instead.
      const handoffUndo = /^\/api\/inbox\/messages\/([A-Za-z0-9_]+)\/handoff\/undo$/.exec(path);
      if (handoffUndo) {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        return json({ message: store.undoHandoff(handoffUndo[1]!) });
      }

      /**
       * Not a permission question, or the person's own call: a window's (the page's own Origin, this Host, and this
       * run's serverSession) or a paired device's through the device door (its token already checked).
       */
      const answeredFromWindow = (request: Request, body: Record<string, unknown>, target: InboxMessage | null | undefined): boolean => {
        if (target?.author.kind !== "agent" || !isInboxPermissionSession(target.author.session)) return true;
        return fromDeviceDoor.has(request) || isWindowRequest(request, body, serverSession);
      };

      const messageMatch = /^\/api\/inbox\/messages\/([A-Za-z0-9_]+)\/(picks|reply|reask|resolve)$/.exec(path);
      if (messageMatch) {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await readBody(req);
        if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        const messageId = messageMatch[1]!;
        // A launched session's permission prompt is answered from a window only: the page's own Origin and
        // this run's serverSession, never a bare local call (an agent's curl). A tightening, not a secret:
        // see "Permission prompts" in docs/agent-guides/inbox-launch.md.
        if ((messageMatch[2] === "picks" || messageMatch[2] === "reply") && !answeredFromWindow(req, body, store.message(messageId))) {
          return json({ error: "A permission prompt is answered in the Inbox window.", code: "window_only" }, 403);
        }
        switch (messageMatch[2]) {
          case "picks": {
            // `unsent_only` (decision mode): a pick that raced the Send of its reply never reopens what went.
            if (body.unsent_only !== undefined && typeof body.unsent_only !== "boolean") {
              throw new InboxError("validation_error", "unsent_only: a boolean.", { field: "unsent_only" });
            }
            // `confirm_full`: the person confirmed Full permissions on a launched session's permission question.
            if (body.confirm_full !== undefined && typeof body.confirm_full !== "boolean") {
              throw new InboxError("validation_error", "confirm_full: a boolean.", { field: "confirm_full" });
            }
            const questions = store.savePicks(messageId, body.questions as never, { unsentOnly: body.unsent_only === true, confirmFull: body.confirm_full === true });
            return json({ message_id: messageId, questions, reply: null });
          }
          case "reply": {
            // Rule 11 (linked machines): a reply held on another machine says the newest seq of the thread the person
            // saw; when an agent wrote to the thread after it, the late words are refused, never put on the new question.
            // A replay answers what it wrote.
            if (body.seen_through_seq !== undefined) {
              if (typeof body.seen_through_seq !== "number" || !Number.isSafeInteger(body.seen_through_seq) || body.seen_through_seq < 0) {
                throw new InboxError("validation_error", "seen_through_seq: a whole number.", { field: "seen_through_seq" });
              }
              const key = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
              const target = store.message(messageId);
              const thread = target ? store.thread(target.thread_id) : null;
              if (thread && !(key && store.replyByKey(messageId, key)) && replyIsStale(thread.messages, body.seen_through_seq, (id) => store.messageCursor(id))) {
                throw new InboxError("thread_moved_on", "The agent wrote again after you read this thread; your reply was not sent. Read it again, then reply.");
              }
            }
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
                ...(isGuest(req, via) ? { by_guest: true } : {}),
                ...(attachments.length > 0 ? { attachments } : {}),
                ...(to === undefined ? {} : { to }),
                ...(tags && tags.length > 0 ? { tags } : {}),
                ...(handoff ? { handoff } : {}),
                words: typeof body.words === "string" ? body.words : undefined,
                questions: (body.questions as never) ?? [],
                idempotency_key: body.idempotency_key as string,
                feedback: typeof body.feedback === "string" ? body.feedback : undefined,
                annotation_ids: body.annotation_ids as never,
                viewing: body.viewing,
                // A verdict on a review (Approve / Send feedback in the review's header): only while Code review is on.
                ...(body.review_verdict !== undefined && body.review_verdict !== null
                  ? codeReviewOn()
                    ? { review_verdict: body.review_verdict }
                    : (() => {
                        throw new InboxError("code_review_off", "Code review is off in this Inbox (Settings → Capabilities); nothing was sent.");
                      })()
                  : {}),
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
            // The Send that carried the reply box's draft: its words go (a replay too, since the first one sent them)
            // while it is the draft those words were saved as (`updated_at`), with the files this Send carried (a file
            // it did not carry stays, as a draft of files only); or it goes whole while it holds exactly those words
            // and only files this Send carried. Another window's newer, different draft stays.
            if (typeof body.clear_draft === "string") {
              const threadId = store.message(messageId)?.thread_id;
              const words = typeof body.words === "string" ? body.words : undefined;
              const sentUploads = uploads.filter((id): id is string => typeof id === "string");
              if (threadId && store.clearSentReplyDraft(threadId, body.clear_draft, words, sentUploads)) for (const listener of draftListeners) listener(threadId);
            }
            // A hand-off waits out its Undo window, then goes to both sessions.
            if (!result.replayed && result.reply.handoff) scheduleHandoffSettle();
            if (result.replayed) removeInboxAttachmentFiles(store.dir, attachments);
            // Sent: the uploads are the reply's attachments now, so no reply draft names them any more (one that kept
            // a paste this Send did not carry, or another thread's): each draft that changed is told to its windows.
            else if (attachments.length > 0) {
              const sentIds = uploads.filter((id): id is string => typeof id === "string");
              removeInboxUploads(store.dir, sentIds);
              for (const threadId of store.dropSentUploadsFromReplyDrafts(sentIds)) for (const listener of draftListeners) listener(threadId);
            }
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
              ...(isGuest(req, via) ? { by_guest: true } : {}),
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
            // The person's Archive (the window, a phone, a linked machine's forward): it ends a snooze.
            const thread = store.resolveThread(messageId, body.resolved !== false, "person");
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
        const page = windowApp.html;
        // A page load (or a refresh) asks for a new release when the answer is
        // over a minute old: fire-and-forget, the button follows on the event stream.
        if (req.method === "GET") updates.nudge();
        if (via === "tailnet") return tailnetWindowPage(req, page);
        return new Response(req.method === "HEAD" ? null : page, {
          headers: { ...WINDOW_PAGE_HEADERS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      // The window's scripts, by exact name from the pack (404 for any other), compressed over the tailnet as the page is.
      if (path.startsWith(PACKED_ASSET_ROUTE_PREFIX)) return packedAppResponse(windowApp, req, path, via === "tailnet");
      if (path === "/favicon.png" && req.method === "GET") return handleFavicon();

      // Step 8: the live sessions of a thread's project, and New message.
      // Session labels (issue #2450) ride these two for this computer's owner only: a tailnet guest reads them as before.
      const newMessage = await live.route(req, path, ownerOrLocal(req, via), isGuest(req, via));
      if (newMessage) return newMessage;
      // Tags (approval "inbox-tag-agents"): who the person can tag with `@` (packages/server/inbox-tags.ts).
      const taggable = tagsRoute.route(req, path, ownerOrLocal(req, via));
      if (taggable) return taggable;
      // Thread steps (approval "inbox-thread-steps"): a thread's lists with each session's presence (packages/server/inbox-steps.ts).
      const steps = stepsRoute.route(req, path);
      if (steps) return steps;

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

  // Snooze, by any route the person has (the window and the phone here, a linked machine's thread through the
  // forward, a phone app or a linked machine through the door, which hands its write to this same path): once it went
  // through, the one-time Snooze announcement never shows (approval "inbox-snooze-announce"). snoozes.json cannot say
  // so: it deletes itself with the last snooze. A tailnet guest's snooze is not the owner's.
  const handleMarkingSnoozes = async (req: Request, via: RequestVia): Promise<Response> => {
    const ask = req.method === "POST" && INBOX_SNOOZE_WRITE.test(new URL(req.url, "http://127.0.0.1").pathname) && ownerOrLocal(req, via) ? req.clone() : null;
    const response = await handle(req, via);
    if (ask && response.ok) {
      const body = (await ask.json().catch(() => null)) as { until?: unknown } | null;
      if (typeof body?.until === "string") markSnoozeUsed();
    }
    return response;
  };
  // With the debug log on only (inbox-perf.ts): Server-Timing on every API answer, slow requests and a stalled loop
  // noted. Off, the handler is not wrapped and perfPhase does nothing but a compare.
  // The store's load time and the loop watch start with the first request the log keeps, so the log stays empty until then.
  let stopLoopWatch: (() => void) | null = null;
  const releasePerfPhases = debugLog ? retainPerfPhases() : null;
  const isLoggedApiPath = (req: Request): boolean => {
    try {
      const pathname = new URL(req.url, "http://127.0.0.1").pathname;
      return pathname.startsWith("/api/inbox/") && pathname !== INBOX_DEBUG_PATH;
    } catch {
      return false;
    }
  };
  const logged = debugLog
    ? debugLog.wrap(async (req: Request, via: RequestVia) => {
        if (!stopLoopWatch && isLoggedApiPath(req)) {
          stopLoopWatch = watchLoopStalls((ms) => debugLog.note("loop_stall", { ms }));
          let messages = 0;
          const threadIds = store.threadIds();
          for (const id of threadIds) messages += store.threadMessageIds(id).length;
          debugLog.note("store_load", { ms: Math.round(storeLoadMs), threads: threadIds.length, messages });
        }
        return handleMarkingSnoozes(req, via);
      }, isOwner)
    : handleMarkingSnoozes;
  const served = debugLog ? withServerTiming(logged, debugRoute, (slow) => debugLog.note("slow_req", { ...slow })) : handleMarkingSnoozes;

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
    return served(req, "local");
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
    dispatch: async (req) => markPlannotatorResponse(await served(req, "tailnet")),
    // Compress the page, and the entry script it asks for next, for the tailnet before the first phone asks (#2032).
    onListen: () => {
      prewarmAppHtml(windowApp.html, "br");
      for (const entry of windowEntryScripts) windowApp.answer(entry, "GET", "br", true).catch(() => {});
    },
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
  {
    const devices = createInboxDevices({
      dataDir,
      serverSession,
      port: () => port,
      registry: () => registry,
      readBody,
      // Only the door calls this, after the device's token: its requests may answer a permission prompt.
      dispatch: (req) => {
        fromDeviceDoor.add(req);
        return fetch(req);
      },
      now: options.now,
      refusalKeptMs: options.unlinkedRefusalKeptMs,
      tailscale: options.tailscale,
      probes: options.pairingProbes,
      relay: { paired: async (device) => (relay ? relay.paired(device) : null), revoked: (device) => relay?.revoked(device) },
      phones: phonesOn,
      machines: () => machines ?? null,
    });
    phones = devices;
    machines = createInboxMachines({
      dataDir,
      serverSession,
      computerName: devices.machineDoor.computerName,
      door: devices.machineDoor,
      readBody,
      json,
      holds: (kind, id) =>
        kind === "projects" ? store.project(id) !== null : kind === "attachments" ? store.attachment(id) !== null : kind === "annotations" ? store.annotation(id) !== null : store.message(id) !== null,
      isGuest: (req, via) => via === "tailnet" && !tailscale.isOwnerRequest(req.headers),
      timings: options.machineLinkTimings,
    });
    if (phonesOn) {
      // The relay (packages/server/inbox-relay.ts): the mailbox socket while a phone is paired, the pushes, and the
      // carriage: store lines down as the event stream writes them, commands up through the door in-process.
      relay = createInboxRelay({ dataDir, store, devices: devices.devices, payload: eventPayload, apply: devices.asDevice });
      relay.start();
    }
    // With Phones off, only while a machine is linked.
    devices.startTailnet();
    if (phonesOn) devices.startLan();
    machines.start();
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
    for (const project of store.allProjects()) void repos.refresh(project.root);
    repoReadsBegun = true;
    // Once: an earlier Inbox's folder project for a checkouts folder goes into its repository's project, by
    // Combine projects' own write (inbox-checkout-folders.ts). One debug line per fold.
    void foldCheckoutFolderProjects({
      store,
      ...(options.projectRootGit ? { git: options.projectRootGit } : {}),
      // The same home the sends' resolver keeps apart (projectRootHome in tests).
      home: projectRoots.home,
      log: (fold) => debugLog?.note("project_folded", fold),
    }).catch(() => {});
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
    stopLoopWatch?.();
    releasePerfPhases?.();
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
    snoozes.stop();
    clearInterval(restartWatch);
    clearInterval(deliveryWatch);
    clearInterval(autoSendWatch);
    unsubscribeWaits();
    launch.stop();
    unsubscribeAgentWork();
    codexWake.stop();
    qwenWake.stop();
    t3Wake.stop();
    voice.stop();
    // An answer in progress is saved. Open clients lose the connection (the force below cuts their
    // `closing` short); one that polls the next Inbox gets a 404, and stops.
    ask.stop();
    void mcp.close().catch(() => {});
    server.stop(true);
    // The tailnet mapping and the door listener, the Wi-Fi listener and its
    // Bonjour record, before a restart starts the new run.
    machines?.stop();
    phones?.stopTailnet();
    phones?.stopLan();
    relay?.stop();
    // Over your tailnet: the mapping and the tailnet-only listener, before a restart starts the new run.
    tailnetStopFailedPort = tailscale.stop().failedPort;
  };

  return { port, url: baseUrl, token, serverSession, portChanged, store, registry, tailscale, connectAgents, search: search.index, imageCapture, codexWake, qwenWake, t3Wake, shapeWatchers: () => shapes.watch.watching(), stop };
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
