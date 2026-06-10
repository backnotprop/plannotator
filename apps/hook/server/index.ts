/**
 * Plannotator CLI for Claude Code, Droid, Codex, Gemini CLI, and Copilot CLI
 *
 * Supports twelve modes:
 *
 * 1. Plan Review (default, no args):
 *    - Spawned by Claude/Gemini/Codex hook entrypoints
 *    - Reads hook event from stdin, extracts plan content
 *    - Serves UI, returns approve/deny decision to stdout
 *
 * 2. Code Review (`plannotator review`, `plannotator review --git`):
 *    - Triggered by /review slash command
 *    - Runs git diff, opens review UI
 *    - Outputs feedback to stdout (captured by slash command)
 *
 * 3. Annotate (`plannotator annotate <file.md>`):
 *    - Triggered by /plannotator-annotate slash command
 *    - Opens any markdown file in the annotation UI
 *    - Outputs structured feedback to stdout
 *
 * 4. Archive (`plannotator archive`):
 *    - Opens read-only browser for saved plan decisions
 *    - Lists plans from ~/.plannotator/plans/ with status badges
 *    - Done button closes the browser
 *
 * 5. Sessions (`plannotator sessions`):
 *    - Lists active Plannotator server sessions
 *    - `--open [N]` reopens a session in the browser
 *    - `--clean` removes stale session files
 *
 * 6. Copilot Plan (`plannotator copilot-plan`):
 *    - Spawned by preToolUse hook (Copilot CLI)
 *    - Intercepts exit_plan_mode, reads plan.md from session state
 *    - Outputs permissionDecision JSON to stdout
 *
 * 7. Copilot Last (`plannotator copilot-last`):
 *    - Annotate the last assistant message from a Copilot CLI session
 *    - Parses events.jsonl from session state
 *
 * 8. Goal Setup (`plannotator setup-goal interview|facts <bundle.json>`):
 *    - Opens the bundled question or facts acceptance UI
 *    - Outputs structured JSON for setup-goal workflows
 *
 * 9. OpenCode Plan (`plannotator opencode-plan`):
 *    - Internal bridge mode used by the OpenCode plugin CLI fallback
 *    - Reads `{ plan, timeoutSeconds, sharingEnabled, agents }` from stdin
 *    - Outputs structured JSON for the plugin
 *
 * 10. OpenCode Review (`plannotator opencode-review`):
 *    - Internal structured review bridge used by the OpenCode plugin CLI fallback
 *
 * 11. OpenCode Last (`plannotator opencode-annotate-last`):
 *    - Internal structured last-message annotation bridge for OpenCode
 *
 * 12. Improve Context (`plannotator improve-context`):
 *    - Spawned by PreToolUse hook on EnterPlanMode
 *    - Reads improvement hook file from ~/.plannotator/hooks/
 *    - Returns additionalContext or silently passes through
 *
 * Global flags:
 *   --help             - Show top-level usage information
 *   --version, -v      - Print version and exit
 *   --browser <name>   - Override which browser to open (e.g. "Google Chrome")
 *
 * Environment variables:
 *   PLANNOTATOR_REMOTE - Set to "1"/"true" for remote, "0"/"false" for local
 *   PLANNOTATOR_PORT   - Fixed port to use (default: random locally, 19432 for remote)
 */

import { startPlannotatorServer, handleServerReady } from "@plannotator/server";
import {
  startReviewServer,
  handleReviewServerReady,
} from "@plannotator/server/review";
import {
  startAnnotateServer,
  handleAnnotateServerReady,
} from "@plannotator/server/annotate";
import {
  startGoalSetupServer,
  handleGoalSetupServerReady,
} from "@plannotator/server/goal-setup";
import {
  type DiffType,
  detectManagedVcs,
  prepareLocalReviewDiff,
  gitRuntime,
} from "@plannotator/server/vcs";
import {
  loadConfig,
  resolveDefaultDiffType,
  resolveUseJina,
} from "@plannotator/shared/config";
import { parseReviewArgs } from "@plannotator/shared/review-args";
import {
  normalizeGoalSetupBundle,
  type GoalSetupStage,
} from "@plannotator/shared/goal-setup";
import {
  stripAtPrefix,
  resolveAtReference,
} from "@plannotator/shared/at-reference";
import { htmlToMarkdown } from "@plannotator/shared/html-to-markdown";
import {
  urlToMarkdown,
  isConvertedSource,
} from "@plannotator/shared/url-to-markdown";
import {
  fetchRef,
  createWorktree,
  removeWorktree,
  ensureObjectAvailable,
} from "@plannotator/shared/worktree";
import {
  createWorktreePool,
  type WorktreePool,
} from "@plannotator/shared/worktree-pool";
import {
  parsePRUrl,
  checkPRAuth,
  fetchPR,
  getCliName,
  getCliInstallUrl,
  getMRLabel,
  getMRNumberLabel,
  getDisplayRepo,
} from "@plannotator/server/pr";
import { writeRemoteShareLink } from "@plannotator/server/share-url";
import {
  resolveMarkdownFile,
  resolveUserPath,
  hasMarkdownFiles,
} from "@plannotator/shared/resolve-file";
import { FILE_BROWSER_EXCLUDED } from "@plannotator/shared/reference-common";
import { statSync, rmSync, realpathSync, existsSync, readdirSync } from "fs";
import { parseRemoteUrl } from "@plannotator/shared/repo";
import {
  getReviewApprovedPrompt,
  getReviewDeniedSuffix,
  getPlanDeniedPrompt,
  getPlanToolName,
  buildPlanFileRule,
} from "@plannotator/shared/prompts";
import {
  registerSession,
  unregisterSession,
  listSessions,
} from "@plannotator/server/sessions";
import { openBrowser } from "@plannotator/server/browser";
import { detectProjectName } from "@plannotator/server/project";
import { hostnameOrFallback } from "@plannotator/shared/project";
import { readImprovementHook } from "@plannotator/shared/improvement-hooks";
import { composeImproveContext } from "@plannotator/shared/pfm-reminder";
import { AGENT_CONFIG, type Origin } from "@plannotator/shared/agents";
import {
  findDroidSessionLogsByAncestorWalk,
  findDroidSessionLogsForCwd,
  findSessionLogsByAncestorWalk,
  findSessionLogsForCwd,
  getRecentRenderedMessages,
  resolveDroidSessionLogForCwd,
  resolveSessionLogByAncestorPids,
  resolveSessionLogByCwdScan,
  type RenderedMessage,
} from "./session-log";
import { findCodexRolloutByThreadId, getLatestCodexPlan, getRecentCodexMessages } from "./codex-session";
import { findCopilotPlanContent, findCopilotSessionForCwd, getRecentCopilotMessages } from "./copilot-session";
import {
  formatInteractiveNoArgClarification,
  formatTopLevelHelp,
  formatVersion,
  isInteractiveNoArgInvocation,
  isTopLevelHelpInvocation,
  isVersionInvocation,
} from "./cli";
import { ensureClearContextSettingEnabled } from "./clearContextSetting";
import { formatClaudePlanHookOutput, normalizeClaudeHookEventName } from "./hookDecision";
import {
  logInjectorDecision,
  shouldFireInjector,
  spawnKeystrokeInjector,
} from "./keystrokeInjector";
import path from "path";
import { tmpdir } from "os";
import { buildLocalWorkspaceReview, type WorkspaceDiffType } from "@plannotator/server/review-workspace";

// Embed the built HTML at compile time
// @ts-ignore - Bun import attribute for text
import planHtml from "../dist/index.html" with { type: "text" };
const planHtmlContent = planHtml as unknown as string;

// @ts-ignore - Bun import attribute for text
import reviewHtml from "../dist/review.html" with { type: "text" };
const reviewHtmlContent = reviewHtml as unknown as string;

// Check for subcommand
const args = process.argv.slice(2);

// Global flag: --browser <name>
const browserIdx = args.indexOf("--browser");
if (browserIdx !== -1 && args[browserIdx + 1]) {
  process.env.PLANNOTATOR_BROWSER = args[browserIdx + 1];
  args.splice(browserIdx, 2);
}

// Global flag: --no-jina (disables Jina Reader for URL annotation)
const noJinaIdx = args.indexOf("--no-jina");
const cliNoJina = noJinaIdx !== -1;
if (cliNoJina) args.splice(noJinaIdx, 1);

// Annotate review-gate flags: --gate adds an Approve button, --json
// switches stdout to structured decision output, --hook emits hook-native
// JSON that works directly with Claude Code and Codex PostToolUse/Stop
// hook protocols.
const gateIdx = args.indexOf("--gate");
let gateFlag = gateIdx !== -1;
if (gateFlag) args.splice(gateIdx, 1);
const jsonIdx = args.indexOf("--json");
const jsonFlag = jsonIdx !== -1;
if (jsonFlag) args.splice(jsonIdx, 1);
const hookIdx = args.indexOf("--hook");
const hookFlag = hookIdx !== -1;
if (hookFlag) args.splice(hookIdx, 1);
if (hookFlag) gateFlag = true;
const renderHtmlIdx = args.indexOf("--render-html");
const renderHtmlFlag = renderHtmlIdx !== -1;
if (renderHtmlFlag) args.splice(renderHtmlIdx, 1);

// Stdout matrix for annotate / annotate-last / copilot annotate-last.
//
// --hook (recommended for hooks):
//   Approve/Close → empty stdout (hook passes, agent proceeds).
//   Annotate → {"decision":"block","reason":"<feedback>"} (hook blocks).
//   Works with both Claude Code and Codex hook protocols.
//
// --json (structured decisions for wrapper scripts):
//   Emits {"decision":"approved|dismissed|annotated","feedback":"..."}.
//
// Plaintext (default):
//   Close → empty. Approve → "The user approved." Annotate → feedback.
//
// TODO: The plaintext --gate approval sentinel must stay as the exact string
// "The user approved." because slash command templates (plannotator-annotate.md,
// plannotator-last.md) instruct the agent to match it literally. Making this
// configurable requires updating those templates to accept dynamic values or
// switching gate mode to structured output only.
const APPROVED_PLAINTEXT_MARKER = "The user approved.";

function emitAnnotateOutcome(result: {
  feedback: string;
  exit?: boolean;
  approved?: boolean;
}): void {
  if (hookFlag) {
    if (result.approved || result.exit) return;
    if (result.feedback) {
      console.log(
        JSON.stringify({ decision: "block", reason: result.feedback }),
      );
    }
    return;
  }
  if (jsonFlag) {
    if (result.approved) {
      console.log(JSON.stringify({ decision: "approved" }));
    } else if (result.exit) {
      console.log(JSON.stringify({ decision: "dismissed" }));
    } else {
      console.log(
        JSON.stringify({
          decision: "annotated",
          feedback: result.feedback || "",
        }),
      );
    }
    return;
  }
  if (result.exit) return;
  if (result.approved) {
    console.log(APPROVED_PLAINTEXT_MARKER);
    return;
  }
  if (result.feedback) console.log(result.feedback);
}

async function loadGoalSetupBundle(
  stage: GoalSetupStage,
  bundlePath: string
) {
  const raw =
    bundlePath === "-"
      ? await Bun.stdin.text()
      : await Bun.file(path.resolve(bundlePath)).text();
  return normalizeGoalSetupBundle(JSON.parse(raw), stage);
}

if (isVersionInvocation(args)) {
  console.log(formatVersion());
  process.exit(0);
}

if (isTopLevelHelpInvocation(args)) {
  console.log(formatTopLevelHelp());
  process.exit(0);
}

if (isInteractiveNoArgInvocation(args, process.stdin.isTTY)) {
  console.log(formatInteractiveNoArgClarification());
  process.exit(0);
}

// Ensure session cleanup on exit
process.on("exit", () => unregisterSession());

// Check if URL sharing is enabled (default: true)
const sharingEnabled = process.env.PLANNOTATOR_SHARE !== "disabled";

// Custom share portal URL for self-hosting
const shareBaseUrl = process.env.PLANNOTATOR_SHARE_URL || undefined;

// Paste service URL for short URL sharing
const pasteApiUrl = process.env.PLANNOTATOR_PASTE_URL || undefined;

// Detect calling agent from environment variables set by agent runtimes.
// Priority:
//   PLANNOTATOR_ORIGIN (explicit override, validated against AGENT_CONFIG)
//   > Amp plugin wrappers (PLANNOTATOR_ORIGIN=amp)
//   > Droid command wrappers (PLANNOTATOR_ORIGIN=droid)
//   > Codex (CODEX_THREAD_ID)
//   > Copilot CLI (COPILOT_CLI)
//   > OpenCode (OPENCODE)
//   > Gemini CLI (GEMINI_CLI)
//   > Claude Code (default fallback)
//
// To add a new agent, also add an entry to AGENT_CONFIG in
// packages/shared/agents.ts (see header comment there).
const originOverride = process.env.PLANNOTATOR_ORIGIN as Origin | undefined;
const detectedOrigin: Origin =
  originOverride && originOverride in AGENT_CONFIG
    ? originOverride
    : process.env.CODEX_THREAD_ID
      ? "codex"
      : process.env.COPILOT_CLI
        ? "copilot-cli"
        : process.env.OPENCODE
          ? "opencode"
          : process.env.GEMINI_CLI
            ? "gemini-cli"
            : "claude-code";

type OpenCodeBridgeAgent = {
  name: string;
  description?: string;
  mode: string;
  hidden?: boolean;
};

type OpenCodeBridgeInput = {
  sharingEnabled?: unknown;
  shareBaseUrl?: unknown;
  pasteApiUrl?: unknown;
  agents?: unknown;
};

function parseOpenCodeBridgeInput<T extends object>(
  mode: string,
  inputJson: string,
): T & OpenCodeBridgeInput {
  try {
    return JSON.parse(inputJson) as T & OpenCodeBridgeInput;
  } catch (error) {
    console.error(`Failed to parse ${mode} input: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function getBridgeSharingEnabled(input: OpenCodeBridgeInput): boolean {
  return typeof input.sharingEnabled === "boolean" ? input.sharingEnabled : sharingEnabled;
}

function getBridgeShareBaseUrl(input: OpenCodeBridgeInput): string | undefined {
  return typeof input.shareBaseUrl === "string" && input.shareBaseUrl ? input.shareBaseUrl : shareBaseUrl;
}

function getBridgePasteApiUrl(input: OpenCodeBridgeInput): string | undefined {
  return typeof input.pasteApiUrl === "string" && input.pasteApiUrl ? input.pasteApiUrl : pasteApiUrl;
}

function normalizeOpenCodeBridgeAgents(value: unknown): OpenCodeBridgeAgent[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const agents = value
    .map((agent): OpenCodeBridgeAgent | null => {
      if (!agent || typeof agent !== "object") return null;
      const record = agent as Record<string, unknown>;
      if (typeof record.name !== "string" || !record.name) return null;
      return {
        name: record.name,
        ...(typeof record.description === "string" && { description: record.description }),
        mode: typeof record.mode === "string" ? record.mode : "primary",
        ...(typeof record.hidden === "boolean" && { hidden: record.hidden }),
      };
    })
    .filter((agent): agent is OpenCodeBridgeAgent => agent !== null);

  return agents.length > 0 ? agents : undefined;
}

function makeOpenCodeBridgeClient(agents: unknown) {
  const data = normalizeOpenCodeBridgeAgents(agents);
  if (!data) return undefined;

  return {
    app: {
      agents: async () => ({ data }),
    },
  };
}

function emitOpenCodeAnnotateOutcome(result: {
  feedback: string;
  exit?: boolean;
  approved?: boolean;
  selectedMessageId?: string;
  feedbackScope?: "message" | "messages";
}): void {
  if (result.approved) {
    console.log(JSON.stringify({ decision: "approved" }));
    return;
  }
  if (result.exit) {
    console.log(JSON.stringify({ decision: "dismissed" }));
    return;
  }
  console.log(JSON.stringify({
    decision: "annotated",
    feedback: result.feedback || "",
    ...(result.selectedMessageId && { selectedMessageId: result.selectedMessageId }),
    ...(result.feedbackScope && { feedbackScope: result.feedbackScope }),
  }));
}

if (args[0] === "sessions") {
  // ============================================
  // SESSION DISCOVERY MODE
  // ============================================

  if (args.includes("--clean")) {
    // Force cleanup: list sessions (which auto-removes stale entries)
    const sessions = listSessions();
    console.error(
      `Cleaned up stale sessions. ${sessions.length} active session(s) remain.`,
    );
    process.exit(0);
  }

  const sessions = listSessions();

  if (sessions.length === 0) {
    console.error("No active Plannotator sessions.");
    process.exit(0);
  }

  const openIdx = args.indexOf("--open");
  if (openIdx !== -1) {
    // Open a session in the browser
    const nArg = args[openIdx + 1];
    const n = nArg ? parseInt(nArg, 10) : 1;
    const session = sessions[n - 1];
    if (!session) {
      console.error(
        `Session #${n} not found. ${sessions.length} active session(s).`,
      );
      process.exit(1);
    }
    await openBrowser(session.url);
    console.error(`Opened ${session.mode} session in browser: ${session.url}`);
    process.exit(0);
  }

  // List sessions as a table
  console.error("Active Plannotator sessions:\n");
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const age = Math.round(
      (Date.now() - new Date(s.startedAt).getTime()) / 60000,
    );
    const ageStr =
      age < 60 ? `${age}m` : `${Math.floor(age / 60)}h ${age % 60}m`;
    console.error(
      `  #${i + 1}  ${s.mode.padEnd(9)} ${s.project.padEnd(20)} ${s.url.padEnd(28)} ${ageStr} ago`,
    );
  }
  console.error(`\nReopen with: plannotator sessions --open [N]`);
  process.exit(0);
      recentMessages = getRecentCodexMessages(rolloutPath, RECENT_MESSAGES_LIMIT, { beforeActiveTurn: true })
        .map((m) => ({ messageId: m.messageId, text: m.text, lineNumbers: [], timestamp: m.timestamp }));
      lastMessage = recentMessages[0] ?? null;
    }
  } else if (isDroid) {
    // Droid/Factory path: resolve the current repo's session log from
    // ~/.factory/sessions/<cwd-slug>/*.jsonl. Factory does not expose the same
    // per-process session metadata files as Claude Code, so the best available
    // selector is "newest current-session candidate for this cwd", with an
    // ancestor walk fallback for users who `cd` into a subdirectory after
    // session start.
    if (process.env.PLANNOTATOR_DEBUG) {
      console.error(`[DEBUG] Droid detected, project root: ${projectRoot}`);
    }

    const cwdLogs = findDroidSessionLogsForCwd(projectRoot);
    const ancestorLogs = cwdLogs.length === 0
      ? findDroidSessionLogsByAncestorWalk(projectRoot)
      : [];

    if (process.env.PLANNOTATOR_DEBUG) {
      console.error(`[DEBUG] Droid CWD session logs (mtime): ${cwdLogs.length ? cwdLogs.join(", ") : "(none)"}`);
      if (cwdLogs.length === 0) {
        console.error(`[DEBUG] Droid ancestor walk: ${ancestorLogs.length ? ancestorLogs.join(", ") : "(none)"}`);
      }
    }

    const droidLog = resolveDroidSessionLogForCwd(projectRoot);
    if (process.env.PLANNOTATOR_DEBUG) {
      console.error(`[DEBUG] Droid selected log: ${droidLog ?? "(none)"}`);
    }
    if (droidLog) {
      recentMessages = getRecentRenderedMessages(droidLog, RECENT_MESSAGES_LIMIT);
      lastMessage = recentMessages[0] ?? null;
    }
  } else {
    // Claude Code path: resolve session log
    //
    // Strategy (most precise → least precise):
    // 1. Ancestor-PID session metadata: walk up the process tree checking
    //    ~/.claude/sessions/<pid>.json at each hop. When invoked from a slash
    //    command's `!` bang, the direct parent is a bash subshell — Claude's
    //    session file is a few hops up. Deterministic when it matches.
    // 2. Cwd-scan of session metadata: read every ~/.claude/sessions/*.json,
    //    filter by cwd, pick the most recent startedAt. Better than mtime
    //    guessing because it uses session-level metadata.
    // 3. CWD slug match (mtime-based): legacy behavior — picks the most
    //    recently modified jsonl in the project dir. Fragile when multiple
    //    sessions exist for the same project.
    // 4. Ancestor directory walk: handles the case where the user `cd`'d
    //    deeper into a subdirectory after session start.

    if (process.env.PLANNOTATOR_DEBUG) {
      console.error(`[DEBUG] Project root: ${projectRoot}`);
      console.error(`[DEBUG] PPID: ${process.ppid}`);
    }

    /** Try each log path, return the first that yields a message. */
    function tryLogCandidates(label: string, getPaths: () => string[]): void {
      if (lastMessage) return;
      const paths = getPaths();
      if (process.env.PLANNOTATOR_DEBUG) {
        console.error(
          `[DEBUG] ${label}: ${paths.length ? paths.join(", ") : "(none)"}`,
        );
      }
      for (const logPath of paths) {
        const recent = getRecentRenderedMessages(logPath, RECENT_MESSAGES_LIMIT);
        if (recent.length > 0) {
          recentMessages = recent;
          lastMessage = recent[0];
          return;
        }
      }
    }

    // 1. Walk ancestor PIDs for a matching session metadata file
    const ancestorLog = resolveSessionLogByAncestorPids();
    tryLogCandidates("Ancestor PID session metadata", () =>
      ancestorLog ? [ancestorLog] : [],
    );

    // 2. Scan all session metadata files for one whose cwd matches
    const cwdScanLog = resolveSessionLogByCwdScan({ cwd: projectRoot });
    tryLogCandidates("Cwd-scan session metadata", () =>
      cwdScanLog ? [cwdScanLog] : [],
    );

    // 3. Fall back to CWD slug match (mtime-based)
    tryLogCandidates("CWD slug match (mtime)", () =>
      findSessionLogsForCwd(projectRoot),
    );

    // 4. Fall back to ancestor directory walk
    tryLogCandidates("Directory ancestor walk", () =>
      findSessionLogsByAncestorWalk(projectRoot),
    );
  }

  if (!lastMessage) {
    console.error(stdinFlag
      ? "No message content received on stdin."
      : "No rendered assistant message found in session logs.");
    process.exit(1);
  }

  if (process.env.PLANNOTATOR_DEBUG) {
    console.error(
      `[DEBUG] Found message ${lastMessage.messageId} (${lastMessage.text.length} chars)`,
    );
  }

  const annotatedMessage = lastMessage;
  const annotateProject = (await detectProjectName()) ?? "_unknown";

  // Only ship the picker list when there's a choice to make. The client uses
  // its presence (length > 1) as the signal to render the picker UI.
  const pickerMessages = recentMessages.length > 1
    ? recentMessages.map((m) => ({ messageId: m.messageId, text: m.text, timestamp: m.timestamp }))
    : undefined;

  const server = await startAnnotateServer({
    markdown: annotatedMessage.text,
    filePath: "last-message",
    origin: detectedOrigin,
    mode: "annotate-last",
    sharingEnabled,
    shareBaseUrl,
    pasteApiUrl,
    gate: gateFlag,
    htmlContent: planHtmlContent,
    recentMessages: pickerMessages,
    onReady: async (url, isRemote, port) => {
      handleAnnotateServerReady(url, isRemote, port);

      if (isRemote && sharingEnabled) {
        await writeRemoteShareLink(annotatedMessage.text, shareBaseUrl, "annotate", "message only").catch(() => {});
      }
    },
  });

  registerSession({
    pid: process.pid,
    port: server.port,
    url: server.url,
    mode: "annotate",
    project: annotateProject,
    startedAt: new Date().toISOString(),
    label: `annotate-last`,
  });

  const result = await server.waitForDecision();

  await Bun.sleep(1500);

  server.stop();

  emitAnnotateOutcome(result);
  process.exit(0);
} else if (args[0] === "archive") {
  // ============================================
  // ARCHIVE BROWSER MODE
  // ============================================

  const archiveProject = (await detectProjectName()) ?? "_unknown";

  const server = await startPlannotatorServer({
    plan: "",
    origin: detectedOrigin,
    mode: "archive",
    sharingEnabled,
    shareBaseUrl,
    htmlContent: planHtmlContent,
    onReady: (url, isRemote, port) => {
      handleServerReady(url, isRemote, port);
    },
  });

  registerSession({
    pid: process.pid,
    port: server.port,
    url: server.url,
    mode: "archive",
    project: archiveProject,
    startedAt: new Date().toISOString(),
    label: `archive-${archiveProject}`,
  });

  await server.waitForDone!();

  await Bun.sleep(500);
  server.stop();
  process.exit(0);

} else if (args[0] === "opencode-plan") {
  // ============================================
  // OPENCODE PLUGIN PLAN REVIEW MODE
  // ============================================
  //
  // Internal CLI bridge used when the OpenCode plugin is running in a host
  // that cannot import Bun-only server modules directly.

  const inputJson = await Bun.stdin.text();
  const input = parseOpenCodeBridgeInput<{ plan?: unknown; timeoutSeconds?: unknown }>(
    "opencode-plan",
    inputJson,
  );

  const planContent = typeof input.plan === "string" ? input.plan : "";
  if (!planContent.trim()) {
    console.error("No plan content in opencode-plan input");
    process.exit(1);
  }

  const timeoutSeconds = input.timeoutSeconds === null
    ? null
    : typeof input.timeoutSeconds === "number" && Number.isFinite(input.timeoutSeconds) && input.timeoutSeconds > 0
      ? input.timeoutSeconds
      : null;

  const planProject = (await detectProjectName()) ?? "_unknown";
  const bridgeSharingEnabled = getBridgeSharingEnabled(input);
  const bridgeShareBaseUrl = getBridgeShareBaseUrl(input);
  const bridgePasteApiUrl = getBridgePasteApiUrl(input);
  const server = await startPlannotatorServer({
    plan: planContent,
    origin: "opencode",
    sharingEnabled: bridgeSharingEnabled,
    shareBaseUrl: bridgeShareBaseUrl,
    pasteApiUrl: bridgePasteApiUrl,
    htmlContent: planHtmlContent,
    opencodeClient: makeOpenCodeBridgeClient(input.agents),
    onReady: async (url, isRemote, port) => {
      await handleServerReady(url, isRemote, port);

      if (isRemote && bridgeSharingEnabled) {
        await writeRemoteShareLink(planContent, bridgeShareBaseUrl, "review the plan", "plan only").catch(() => {});
      }
    },
  });

  registerSession({
    pid: process.pid,
    port: server.port,
    url: server.url,
    mode: "plan",
    project: planProject,
    startedAt: new Date().toISOString(),
    label: `plan-${planProject}`,
  });

  const result = timeoutSeconds === null
    ? await server.waitForDecision()
    : await new Promise<Awaited<ReturnType<typeof server.waitForDecision>>>((resolve) => {
        const timeoutId = setTimeout(
          () =>
            resolve({
              approved: false,
              feedback: `[Plannotator] No response within ${timeoutSeconds} seconds. Port released automatically. Please call submit_plan again.`,
            }),
          timeoutSeconds * 1000,
        );

        server.waitForDecision().then((decision) => {
          clearTimeout(timeoutId);
          resolve(decision);
        });
      });

  await Bun.sleep(1500);
  server.stop();

  console.log(JSON.stringify({
    approved: result.approved,
    ...(result.feedback && { feedback: result.feedback }),
    ...(result.savedPath && { savedPath: result.savedPath }),
    ...(result.agentSwitch && { agentSwitch: result.agentSwitch }),
  }));
  process.exit(0);

} else if (args[0] === "opencode-review") {
  // ============================================
  // OPENCODE PLUGIN CODE REVIEW MODE
  // ============================================
  //
  // Internal structured CLI bridge used when the OpenCode plugin is running
  // in a host that cannot import Bun-only server modules directly.

  const inputJson = await Bun.stdin.text();
  const input = parseOpenCodeBridgeInput<{ arguments?: unknown }>(
    "opencode-review",
    inputJson,
  );
  const reviewArgs = parseReviewArgs(typeof input.arguments === "string" ? input.arguments : "");
  const urlArg = reviewArgs.prUrl;
  const isPRMode = urlArg !== undefined;

  let rawPatch: string;
  let gitRef: string;
  let diffError: string | undefined;
  let userDiffType: DiffType | WorkspaceDiffType | undefined;
  let gitContext: Awaited<ReturnType<typeof prepareLocalReviewDiff>>["gitContext"] | undefined;
  let prMetadata: Awaited<ReturnType<typeof fetchPR>>["metadata"] | undefined;
  let workspace: Awaited<ReturnType<typeof buildLocalWorkspaceReview>> | undefined;
  let agentCwd: string | undefined;

  if (isPRMode) {
    const prRef = parsePRUrl(urlArg);
    if (!prRef) {
      console.error(`Invalid PR/MR URL: ${urlArg}`);
      process.exit(1);
    }

    console.error(`Fetching ${getMRLabel(prRef)} ${getMRNumberLabel(prRef)} from ${getDisplayRepo(prRef)}...`);

    try {
      await checkPRAuth(prRef);
    } catch (err) {
      const cliName = getCliName(prRef);
      console.error(err instanceof Error ? err.message : `${cliName} auth check failed`);
      process.exit(1);
    }

    try {
      const pr = await fetchPR(prRef);
      rawPatch = pr.rawPatch;
      gitRef = `${getMRLabel(prRef)} ${getMRNumberLabel(prRef)}`;
      prMetadata = pr.metadata;
    } catch (err) {
      console.error(err instanceof Error ? err.message : `Failed to fetch ${getMRLabel(prRef)} ${getMRNumberLabel(prRef)}`);
      process.exit(1);
    }
  } else {
    console.error("Opening code review UI...");

    const config = loadConfig();
    const cwd = process.env.PLANNOTATOR_CWD || process.cwd();
    const managedVcs = await detectManagedVcs(cwd, reviewArgs.vcsType);
    const forcedVcs = !!reviewArgs.vcsType && reviewArgs.vcsType !== "auto";

    if (managedVcs || forcedVcs) {
      const diffResult = await prepareLocalReviewDiff({
        cwd,
        vcsType: reviewArgs.vcsType,
        configuredDiffType: resolveDefaultDiffType(config),
        hideWhitespace: config.diffOptions?.hideWhitespace ?? false,
      });
      gitContext = diffResult.gitContext;
      userDiffType = diffResult.diffType;
      rawPatch = diffResult.rawPatch;
      gitRef = diffResult.gitRef;
      diffError = diffResult.error;
    } else {
      workspace = await buildLocalWorkspaceReview(cwd, {
        configuredDiffType: resolveDefaultDiffType(config),
        hideWhitespace: config.diffOptions?.hideWhitespace ?? false,
      });
      if (workspace.repos.length === 0) {
        console.error("Not in a VCS repo and no nested Git/JJ repositories were found.");
        process.exit(1);
      }
      rawPatch = workspace.rawPatch;
      gitRef = workspace.gitRef;
      diffError = workspace.error;
      userDiffType = workspace.diffType;
      agentCwd = workspace.root;
    }
  }

  const bridgeSharingEnabled = getBridgeSharingEnabled(input);
  const bridgeShareBaseUrl = getBridgeShareBaseUrl(input);
  const reviewProject = (await detectProjectName()) ?? "_unknown";

  const server = await startReviewServer({
    rawPatch,
    gitRef,
    error: diffError,
    origin: "opencode",
    diffType: isPRMode ? undefined : userDiffType,
    gitContext,
    prMetadata,
    workspace,
    agentCwd,
    sharingEnabled: bridgeSharingEnabled,
    shareBaseUrl: bridgeShareBaseUrl,
    htmlContent: reviewHtmlContent,
    opencodeClient: makeOpenCodeBridgeClient(input.agents),
    onReady: (url, isRemote, port) => {
      handleReviewServerReady(url, isRemote, port);
    },
  });

  registerSession({
    pid: process.pid,
    port: server.port,
    url: server.url,
    mode: "review",
    project: reviewProject,
    startedAt: new Date().toISOString(),
    label: isPRMode && prMetadata
      ? `${getMRLabel(prMetadata).toLowerCase()}-review-${getDisplayRepo(prMetadata)}${getMRNumberLabel(prMetadata)}`
      : `review-${reviewProject}`,
  });

  const result = await server.waitForDecision();
  await Bun.sleep(1500);
  server.stop();

  console.log(JSON.stringify({
    decision: result.exit
      ? "dismissed"
      : result.approved
        ? "approved"
        : "annotated",
    approved: result.approved,
    isPRMode,
    ...(result.feedback && { feedback: result.feedback }),
    ...(result.agentSwitch && { agentSwitch: result.agentSwitch }),
  }));
  process.exit(0);

} else if (args[0] === "opencode-annotate-last") {
  // ============================================
  // OPENCODE PLUGIN ANNOTATE LAST MESSAGE MODE
  // ============================================

  const inputJson = await Bun.stdin.text();
  const input = parseOpenCodeBridgeInput<{
    gate?: unknown;
    recentMessages?: unknown;
  }>("opencode-annotate-last", inputJson);

  const recentMessages = Array.isArray(input.recentMessages)
    ? input.recentMessages
        .map((message): { messageId: string; text: string; timestamp?: string } | null => {
          if (!message || typeof message !== "object") return null;
          const record = message as Record<string, unknown>;
          if (typeof record.text !== "string" || !record.text.trim()) return null;
          return {
            messageId: typeof record.messageId === "string" && record.messageId
              ? record.messageId
              : crypto.randomUUID(),
            text: record.text,
            ...(typeof record.timestamp === "string" && { timestamp: record.timestamp }),
          };
        })
        .filter((message): message is { messageId: string; text: string; timestamp?: string } => message !== null)
    : [];

  const lastMessage = recentMessages[0] ?? null;
  if (!lastMessage) {
    console.error("No assistant message found in opencode-annotate-last input.");
    process.exit(1);
  }

  console.error("Opening annotation UI for last message...");

  const bridgeSharingEnabled = getBridgeSharingEnabled(input);
  const bridgeShareBaseUrl = getBridgeShareBaseUrl(input);
  const bridgePasteApiUrl = getBridgePasteApiUrl(input);
  const annotateProject = (await detectProjectName()) ?? "_unknown";
  const pickerMessages = recentMessages.length > 1 ? recentMessages : undefined;

  const server = await startAnnotateServer({
    markdown: lastMessage.text,
    filePath: "last-message",
    origin: "opencode",
    mode: "annotate-last",
    recentMessages: pickerMessages,
    sharingEnabled: bridgeSharingEnabled,
    shareBaseUrl: bridgeShareBaseUrl,
    pasteApiUrl: bridgePasteApiUrl,
    gate: input.gate === true,
    htmlContent: planHtmlContent,
    onReady: (url, isRemote, port) => {
      handleAnnotateServerReady(url, isRemote, port);
    },
  });

  registerSession({
    pid: process.pid,
    port: server.port,
    url: server.url,
    mode: "annotate",
    project: annotateProject,
    startedAt: new Date().toISOString(),
    label: "annotate-last",
  });

  const result = await server.waitForDecision();
  await Bun.sleep(1500);
  server.stop();

  emitOpenCodeAnnotateOutcome(result);
  process.exit(0);

} else if (args[0] === "copilot-plan") {
  // ============================================
  // COPILOT CLI PLAN INTERCEPTION MODE
  // ============================================
  //
  // Called by preToolUse hook on EVERY tool call in Copilot CLI.
  // Must filter quickly and only activate for exit_plan_mode.
  // No output = allow the tool call to proceed.

  const eventJson = await Bun.stdin.text();
  let event: {
    toolName: string;
    toolArgs: string;
    cwd: string;
    timestamp: number;
    sessionId?: string;
  };

  try {
    event = JSON.parse(eventJson);
  } catch {
    // Can't parse input — allow the tool call
    process.exit(0);
  }

  // FILTER: Only intercept exit_plan_mode
  if (event.toolName !== "exit_plan_mode") {
    process.exit(0); // No output = allow
  }

  // Find plan.md content (sessionId primary, newest plan.md fallback)
  const planContent = findCopilotPlanContent(event.sessionId);

  if (!planContent) {
    // No plan.md found — allow exit_plan_mode to proceed normally
    process.exit(0);
  }

  const planProject = (await detectProjectName()) ?? "_unknown";

  const server = await startPlannotatorServer({
    plan: planContent,
    origin: "copilot-cli",
    sharingEnabled,
    shareBaseUrl,
    pasteApiUrl,
    htmlContent: planHtmlContent,
    onReady: async (url, isRemote, port) => {
      handleServerReady(url, isRemote, port);

      if (isRemote && sharingEnabled) {
        await writeRemoteShareLink(
          planContent,
          shareBaseUrl,
          "review the plan",
          "plan only",
        ).catch(() => {});
      }
    },
  });

  registerSession({
    pid: process.pid,
    port: server.port,
    url: server.url,
    mode: "plan",
    project: planProject,
    startedAt: new Date().toISOString(),
    label: `plan-${planProject}`,
  });

  const result = await server.waitForDecision();
  await Bun.sleep(1500);
  server.stop();

  // Output Copilot CLI permission decision format
  if (result.approved) {
    console.log(
      JSON.stringify({
        permissionDecision: "allow",
      }),
    );
  } else {
    const feedback = getPlanDeniedPrompt("copilot-cli", undefined, {
      toolName: getPlanToolName("copilot-cli"),
      planFileRule: "",
      feedback: result.feedback || "Plan changes requested",
    });
    console.log(
      JSON.stringify({
        permissionDecision: "deny",
        permissionDecisionReason: feedback,
      }),
    );
  }

  process.exit(0);
} else if (args[0] === "copilot-last") {
  // ============================================
  // COPILOT CLI ANNOTATE LAST MESSAGE MODE
  // ============================================

  const projectRoot = process.env.PLANNOTATOR_CWD || process.cwd();

  if (process.env.PLANNOTATOR_DEBUG) {
    console.error(
      `[DEBUG] Copilot CLI detected, finding session for CWD: ${projectRoot}`,
    );
  }

  const sessionDir = findCopilotSessionForCwd(projectRoot);

  if (!sessionDir) {
    console.error("No Copilot CLI session found.");
    process.exit(1);
  }

  if (process.env.PLANNOTATOR_DEBUG) {
    console.error(`[DEBUG] Session dir: ${sessionDir}`);
  }

  const recent = getRecentCopilotMessages(sessionDir, 25);
  const msg = recent[0] ?? null;
  if (!msg) {
    console.error("No assistant message found in Copilot CLI session.");
    process.exit(1);
  }

  if (process.env.PLANNOTATOR_DEBUG) {
    console.error(`[DEBUG] Found message (${msg.text.length} chars)`);
  }

  const annotateProject = (await detectProjectName()) ?? "_unknown";
  const pickerMessages = recent.length > 1 ? recent : undefined;

  const server = await startAnnotateServer({
    markdown: msg.text,
    filePath: "last-message",
    origin: "copilot-cli",
    mode: "annotate-last",
    recentMessages: pickerMessages,
    sharingEnabled,
    shareBaseUrl,
    gate: gateFlag,
    htmlContent: planHtmlContent,
    onReady: async (url, isRemote, port) => {
      handleAnnotateServerReady(url, isRemote, port);

      if (isRemote && sharingEnabled) {
        await writeRemoteShareLink(
          msg.text,
          shareBaseUrl,
          "annotate",
          "message only",
        ).catch(() => {});
      }
    },
  });

  registerSession({
    pid: process.pid,
    port: server.port,
    url: server.url,
    mode: "annotate",
    project: annotateProject,
    startedAt: new Date().toISOString(),
    label: `annotate-last`,
  });

  const result = await server.waitForDecision();
  await Bun.sleep(1500);
  server.stop();

  emitAnnotateOutcome(result);
  process.exit(0);
} else if (args[0] === "improve-context") {
  // ============================================
  // IMPROVEMENT HOOK CONTEXT INJECTION MODE
  // ============================================
  //
  // Called by PreToolUse hook on EnterPlanMode.
  // Composes any enabled context sources (compound improvement hook,
  // PFM reminder) into a single additionalContext payload.
  // Nothing enabled = exit 0 silently (passthrough).

  await Bun.stdin.text();

  const hook = readImprovementHook("enterplanmode-improve");
  const pfmEnabled = loadConfig().pfmReminder === true;

  const context = composeImproveContext({
    pfmEnabled,
    improvementHookContent: hook?.content ?? null,
  });

  if (context === null) process.exit(0);

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: context,
      },
    }),
  );

  process.exit(0);
} else {
  // ============================================
  // PLAN REVIEW MODE (default)
  // ============================================

  /**
   * Read the most recently modified .md file from CC's plansDirectory.
   *
   * CC's ExitPlanMode tool has no `plan` parameter — it writes the plan to
   * disk and reads it back internally. The PermissionRequest hook therefore
   * never receives plan content inline; the only reliable source is the file
   * CC wrote. This is the intended path for CC, not a fallback shim.
   */
  async function readLatestCCPlanFile(): Promise<string> {
    try {
      const settingsPath = path.join(
        process.env.HOME ?? "",
        ".claude",
        "settings.json",
      );
      if (!existsSync(settingsPath)) return "";
      const settings: Record<string, any> = JSON.parse(
        await Bun.file(settingsPath).text(),
      );
      const plansDir: string = settings.plansDirectory ?? "claude-code-plans";
      const resolved = path.isAbsolute(plansDir)
        ? plansDir
        : path.join(process.cwd(), plansDir);
      if (!existsSync(resolved)) return "";
      const newest = readdirSync(resolved)
        .filter((f) => f.endsWith(".md"))
        .map((f) => {
          // Tolerate broken symlinks / races: a single unreadable entry
          // must not blank out the whole resolution. mtime -1 sorts last.
          try {
            return { f, mtime: statSync(path.join(resolved, f)).mtimeMs };
          } catch {
            return { f, mtime: -1 };
          }
        })
        .filter((e) => e.mtime >= 0)
        .sort((a, b) => b.mtime - a.mtime)[0];
      return newest ? await Bun.file(path.join(resolved, newest.f)).text() : "";
    } catch {
      return "";
    }
  }

  // Read hook event from stdin
  const eventJson = await Bun.stdin.text();
  if (!eventJson.trim()) {
    process.exit(0);
  }

  let event: Record<string, any>;
  try {
    event = JSON.parse(eventJson);
  } catch (e: any) {
    console.error(`Failed to parse hook event from stdin: ${e?.message || e}`);
    process.exit(1);
  }

  if (event.hook_event_name === "Stop") {
    const rolloutPath =
      (typeof event.transcript_path === "string" && event.transcript_path) ||
      (process.env.CODEX_THREAD_ID
        ? findCodexRolloutByThreadId(process.env.CODEX_THREAD_ID)
        : null);

    if (!rolloutPath || !existsSync(rolloutPath)) {
      process.exit(0);
    }

    const latestPlan = getLatestCodexPlan(rolloutPath, {
      turnId: typeof event.turn_id === "string" ? event.turn_id : undefined,
      stopHookActive: !!event.stop_hook_active,
    });

    if (!latestPlan?.text) {
      process.exit(0);
    }

    const planProject = (await detectProjectName()) ?? "_unknown";
    const server = await startPlannotatorServer({
      plan: latestPlan.text,
      origin: "codex",
      sharingEnabled,
      shareBaseUrl,
      pasteApiUrl,
      htmlContent: planHtmlContent,
      onReady: async (url, isRemote, port) => {
        handleServerReady(url, isRemote, port);

        if (isRemote && sharingEnabled) {
          await writeRemoteShareLink(
            latestPlan.text,
            shareBaseUrl,
            "review the plan",
            "plan only",
          ).catch(() => {});
        }
      },
    });

    registerSession({
      pid: process.pid,
      port: server.port,
      url: server.url,
      mode: "plan",
      project: planProject,
      startedAt: new Date().toISOString(),
      label: `plan-${planProject}`,
    });

    const result = await server.waitForDecision();
    await Bun.sleep(1500);
    server.stop();

    if (result.approved) {
      console.log("{}");
    } else {
      console.log(
        JSON.stringify({
          decision: "block",
          reason: getPlanDeniedPrompt("codex", undefined, {
            toolName: getPlanToolName("codex"),
            planFileRule: "",
            feedback: result.feedback || "Plan changes requested",
          }),
        }),
      );
    }

    process.exit(0);
  }

  let planContent = "";
  let permissionMode = "default";
  let isGemini = false;
  let planFilename = "";

  // Detect harness: Gemini sends plan_filename (file on disk), CC reads from plansDirectory
  planFilename =
    event.tool_input?.plan_filename || event.tool_input?.plan_path || "";
  isGemini = !!planFilename;

  if (isGemini) {
    // Reconstruct full plan path from transcript_path and session_id:
    // transcript_path = <projectTempDir>/chats/session-...json
    // plan lives at   = <projectTempDir>/<session_id>/plans/<plan_filename>
    const projectTempDir = path.dirname(path.dirname(event.transcript_path));
    const planFilePath = path.join(
      projectTempDir,
      event.session_id,
      "plans",
      planFilename,
    );
    planContent = await Bun.file(planFilePath).text();
  } else {
    // CC does not inline plan content in the PermissionRequest hook payload —
    // ExitPlanMode has no `plan` parameter. Fall back to the most recently
    // modified .md file in plansDirectory (relative to cwd, matching CC's
    // own resolution of the plansDirectory setting).
    planContent = event.tool_input?.plan || (await readLatestCCPlanFile());
  }

  permissionMode = event.permission_mode || "default";
  const toolName: string =
    typeof event.tool_name === "string"
      ? event.tool_name
      : typeof event.toolName === "string"
        ? event.toolName
        : "";

  if (!planContent) {
    console.error("No plan content in hook event");
    process.exit(1);
  }

  const planProject = (await detectProjectName()) ?? "_unknown";

  // Start the plan review server
  const server = await startPlannotatorServer({
    plan: planContent,
    origin: isGemini ? "gemini-cli" : detectedOrigin,
    permissionMode,
    toolName,
    sharingEnabled,
    shareBaseUrl,
    pasteApiUrl,
    htmlContent: planHtmlContent,
    onReady: async (url, isRemote, port) => {
      handleServerReady(url, isRemote, port);

      if (isRemote && sharingEnabled) {
        await writeRemoteShareLink(
          planContent,
          shareBaseUrl,
          "review the plan",
          "plan only",
        ).catch(() => {});
      }
    },
  });

  registerSession({
    pid: process.pid,
    port: server.port,
    url: server.url,
    mode: "plan",
    project: planProject,
    startedAt: new Date().toISOString(),
    label: `plan-${planProject}`,
  });

  // Wait for user decision (blocks until approve/deny)
  const result = await server.waitForDecision();

  // Give browser time to receive response and update UI
  await Bun.sleep(1500);

  // Cleanup
  server.stop();

  // Output decision in the appropriate format for the harness
  if (isGemini) {
    if (result.approved) {
      console.log(
        result.feedback
          ? JSON.stringify({ systemMessage: result.feedback })
          : "{}",
      );
    } else {
      console.log(
        JSON.stringify({
          decision: "deny",
          reason: getPlanDeniedPrompt("gemini-cli", undefined, {
            toolName: getPlanToolName("gemini-cli"),
            planFileRule: buildPlanFileRule(
              getPlanToolName("gemini-cli"),
              planFilename,
            ),
            feedback: result.feedback || "Plan changes requested",
          }),
        }),
      );
    }
  } else {
    const hookEventName = normalizeClaudeHookEventName(event.hook_event_name);
    const nativeClearEnabled =
      result.approved &&
      toolName === "ExitPlanMode" &&
      (result.deferToNativeForClear || result.permissionMode === "deferNative")
    ) {
      // Step aside: emit nothing so CC shows its own native plan dialog
      // (which offers clear-context + bypass). behavior:"defer" is NOT valid
      // here — it belongs on HookPermissionDecision (PreToolUse), not on
      // PermissionRequestHookSpecificOutput.decision.
      const nativeClearEnabled = await ensureClearContextSettingEnabled();
      if (nativeClearEnabled) {
        const fire = shouldFireInjector(result);
        logInjectorDecision(result, fire);
        if (fire) {
          spawnKeystrokeInjector();
        }
        process.exit(0);
      }
      result.clearContextNudge = true;
      result.permissionMode = "bypassPermissions";
    }

    if (result.approved) {
      const updatedPermissions = [];
      if (result.permissionMode) {
        updatedPermissions.push({
          type: "setMode",
          mode: result.permissionMode,
          destination: "session",
        });
      }

      console.log(
        JSON.stringify({
          ...(result.clearContextNudge && {
            systemMessage:
              "Plannotator requested bypass mode. Hooks cannot clear context. Run /clear before continuing if you want a fresh implementation session.",
          }),
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: {
              behavior: "allow",
              ...(updatedPermissions.length > 0 && { updatedPermissions }),
            },
          },
        }),
      );
    } else {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: {
              behavior: "deny",
              message: getPlanDeniedPrompt(detectedOrigin, undefined, {
                toolName: getPlanToolName(detectedOrigin),
                planFileRule: "",
                feedback: result.feedback || "Plan changes requested",
              }),
            },
          },
        }),
      );
    }
  }

  process.exit(0);
}
