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

import {
  startPlannotatorServer,
  handleServerReady,
} from "@plannotator/server";
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
import { type DiffType, prepareLocalReviewDiff, gitRuntime } from "@plannotator/server/vcs";
import { loadConfig, resolveDefaultDiffType, resolveUseJina } from "@plannotator/shared/config";
import { parseReviewArgs } from "@plannotator/shared/review-args";
import {
  evaluateTripwires,
  formatTripwiresMarkdown,
  buildAddTripwirePrompt,
  appendRuleToTripwiresJson,
  parseTripwiresConfigDetailed,
} from "@plannotator/shared/tripwires";
import {
  resolveMergedTripwires,
  globalTripwiresPath,
  readGlobalTripwiresFile,
  readTripwiresFile,
  repoRootFromCwd,
  writeGlobalTripwiresFile,
  writeRepoTripwiresFile,
} from "@plannotator/server/tripwires";
import {
  normalizeGoalSetupBundle,
  type GoalSetupStage,
} from "@plannotator/shared/goal-setup";
import { stripAtPrefix, resolveAtReference } from "@plannotator/shared/at-reference";
import { htmlToMarkdown } from "@plannotator/shared/html-to-markdown";
import { urlToMarkdown, isConvertedSource } from "@plannotator/shared/url-to-markdown";
import { fetchRef, createWorktree, removeWorktree, ensureObjectAvailable } from "@plannotator/shared/worktree";
import { createWorktreePool, type WorktreePool } from "@plannotator/shared/worktree-pool";
import { parsePRUrl, checkPRAuth, fetchPR, getCliName, getCliInstallUrl, getMRLabel, getMRNumberLabel, getDisplayRepo } from "@plannotator/server/pr";
import { writeRemoteShareLink } from "@plannotator/server/share-url";
import { resolveMarkdownFile, resolveUserPath, hasMarkdownFiles } from "@plannotator/shared/resolve-file";
import { FILE_BROWSER_EXCLUDED } from "@plannotator/shared/reference-common";
import { statSync, rmSync, realpathSync, existsSync } from "fs";
import { parseRemoteUrl } from "@plannotator/shared/repo";
import {
  getReviewApprovedPrompt,
  getReviewDeniedSuffix,
  getPlanDeniedPrompt,
  getPlanToolName,
  buildPlanFileRule,
} from "@plannotator/shared/prompts";
import { registerSession, unregisterSession, listSessions } from "@plannotator/server/sessions";
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
import path from "path";
import { tmpdir } from "os";

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
      console.log(JSON.stringify({ decision: "block", reason: result.feedback }));
    }
    return;
  }
  if (jsonFlag) {
    if (result.approved) {
      console.log(JSON.stringify({ decision: "approved" }));
    } else if (result.exit) {
      console.log(JSON.stringify({ decision: "dismissed" }));
    } else {
      console.log(JSON.stringify({ decision: "annotated", feedback: result.feedback || "" }));
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
  (originOverride && originOverride in AGENT_CONFIG) ? originOverride :
  process.env.CODEX_THREAD_ID ? "codex" :
  process.env.COPILOT_CLI ? "copilot-cli" :
  process.env.OPENCODE ? "opencode" :
  process.env.GEMINI_CLI ? "gemini-cli" :
  "claude-code";

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
    console.error(`Cleaned up stale sessions. ${sessions.length} active session(s) remain.`);
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
      console.error(`Session #${n} not found. ${sessions.length} active session(s).`);
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
    const age = Math.round((Date.now() - new Date(s.startedAt).getTime()) / 60000);
    const ageStr = age < 60 ? `${age}m` : `${Math.floor(age / 60)}h ${age % 60}m`;
    console.error(`  #${i + 1}  ${s.mode.padEnd(9)} ${s.project.padEnd(20)} ${s.url.padEnd(28)} ${ageStr} ago`);
  }
  console.error(`\nReopen with: plannotator sessions --open [N]`);
  process.exit(0);

} else if (args[0] === "setup-goal") {
  // ============================================
  // GOAL SETUP MODE
  // ============================================

  const stage = args[1] as GoalSetupStage | undefined;
  const bundlePath = args[2];

  if ((stage !== "interview" && stage !== "facts") || !bundlePath) {
    console.error(
      "Usage: plannotator setup-goal <interview|facts> <bundle.json | -> [--json]"
    );
    process.exit(1);
  }

  let bundle: Awaited<ReturnType<typeof loadGoalSetupBundle>>;
  try {
    bundle = await loadGoalSetupBundle(stage, bundlePath);
  } catch (err) {
    console.error(
      `Failed to load goal setup bundle: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }

  const goalProject = (await detectProjectName()) ?? "_unknown";

  const server = await startGoalSetupServer({
    bundle,
    origin: detectedOrigin,
    htmlContent: planHtmlContent,
    onReady: (url, isRemote, port) => {
      handleGoalSetupServerReady(url, isRemote, port);
    },
  });

  registerSession({
    pid: process.pid,
    port: server.port,
    url: server.url,
    mode: "goal-setup",
    project: goalProject,
    startedAt: new Date().toISOString(),
    label: `goal-setup-${bundle.stage}-${bundle.goalSlug || goalProject}`,
  });

  const result = await server.waitForDecision();
  await Bun.sleep(800);
  server.stop();

  if (result.exit) {
    console.log(JSON.stringify({ decision: "dismissed", stage: bundle.stage }));
  } else if (result.result) {
    const output = {
      decision: "submitted",
      stage: result.result.stage,
      result: result.result,
    };
    console.log(jsonFlag ? JSON.stringify(output) : JSON.stringify(output, null, 2));
  }
  process.exit(0);

} else if (args[0] === "tripwires") {
  // ============================================
  // TRIPWIRES MODE (list | validate | path)
  // ============================================
  //
  // Inspect the two-layer slop-free-zone config: a global per-project file
  // under <dataDir>/tripwires/<key>.json plus the repo-local
  // .plannotator/tripwires.json. All subcommands are read-only and fail-open.

  const sub = args[1];

  if (sub === "list") {
    // Resolve key + root (ensures the global file exists), then re-read each
    // layer separately so the report can group global vs. repo rules.
    const { key, root } = await resolveMergedTripwires(process.cwd());
    const globalPath = key ? globalTripwiresPath(key) : "(unknown)";
    const globalRules = parseTripwiresConfigDetailed(
      key ? readGlobalTripwiresFile(key) : null,
    ).config.rules;
    const repoPath = root ? `${root}/.plannotator/tripwires.json` : null;
    const repoRules = root
      ? parseTripwiresConfigDetailed(readTripwiresFile(root)).config.rules
      : [];

    console.log(
      formatTripwiresMarkdown({
        globalKey: key,
        globalPath,
        repoPath,
        globalRules,
        repoRules,
      }),
    );
    process.exit(0);
  }

  if (sub === "validate") {
    const { key, root } = await resolveMergedTripwires(process.cwd());
    const globalPath = key ? globalTripwiresPath(key) : "(unknown)";
    const repoPath = root ? `${root}/.plannotator/tripwires.json` : null;

    const globalResult = parseTripwiresConfigDetailed(
      key ? readGlobalTripwiresFile(key) : null,
    );
    const repoResult = parseTripwiresConfigDetailed(
      root ? readTripwiresFile(root) : null,
    );

    let hasError = false;
    const report = (label: string, path: string, result: ReturnType<typeof parseTripwiresConfigDetailed>) => {
      console.log(`${label} (${path})`);
      if (result.diagnostics.length === 0) {
        console.log(`  ${result.config.rules.length} rule(s), no problems`);
      } else {
        for (const d of result.diagnostics) {
          if (d.level === "error") hasError = true;
          const where = typeof d.ruleIndex === "number" ? ` [rule ${d.ruleIndex}]` : "";
          console.log(`  ${d.level}: ${d.message}${where}`);
        }
      }
    };

    report("Global", globalPath, globalResult);
    report("Repo", repoPath ?? ".plannotator/tripwires.json", repoResult);
    process.exit(hasError ? 1 : 0);
  }

  if (sub === "path") {
    const root = await repoRootFromCwd(process.cwd());
    const { key } = await resolveMergedTripwires(process.cwd());
    if (key) console.log(globalTripwiresPath(key));
    console.log(root ? `${root}/.plannotator/tripwires.json` : ".plannotator/tripwires.json");
    process.exit(0);
  }

  if (sub === "add") {
    // Two modes sharing one verb:
    //   structured flags (--glob ...) → write the rule directly
    //   free text                    → print the agent instruction (no write)
    const globs: string[] = [];
    const symbols: string[] = [];
    let note: string | undefined;
    let id: string | undefined;
    let toRepo = false;
    const descriptionParts: string[] = [];

    const rest = args.slice(2);
    for (let i = 0; i < rest.length; i++) {
      const token = rest[i];
      if (token === "--glob" || token === "-g") {
        if (rest[i + 1]) globs.push(rest[++i]);
      } else if (token === "--symbol" || token === "-s") {
        if (rest[i + 1]) symbols.push(rest[++i]);
      } else if (token === "--note") {
        if (rest[i + 1]) note = rest[++i];
      } else if (token === "--id") {
        if (rest[i + 1]) id = rest[++i];
      } else if (token === "--repo") {
        toRepo = true;
      } else {
        descriptionParts.push(token);
      }
    }

    if (globs.length > 0) {
      // Direct write. Explicit user action → errors are reported, not
      // swallowed (unlike review-time fail-open reads).
      const { root, key } = await resolveMergedTripwires(process.cwd());
      let targetPath: string;
      let raw: string | null;
      if (toRepo) {
        if (!root) {
          console.error("tripwires add --repo requires running inside a git repository.");
          process.exit(1);
        }
        targetPath = `${root}/.plannotator/tripwires.json`;
        raw = readTripwiresFile(root);
      } else {
        if (!key) {
          console.error("Could not derive a project key (not inside a git repository?). Run from the repo, or use --repo inside one.");
          process.exit(1);
        }
        targetPath = globalTripwiresPath(key);
        raw = readGlobalTripwiresFile(key);
      }

      const result = appendRuleToTripwiresJson(raw, { globs, symbols, note, id });
      if (!result.ok) {
        console.error(`Cannot add rule: ${result.error}`);
        process.exit(1);
      }
      try {
        if (toRepo) {
          writeRepoTripwiresFile(root!, result.json);
        } else {
          writeGlobalTripwiresFile(key!, result.json);
        }
      } catch (err) {
        console.error(`Failed to write ${targetPath}:`, err instanceof Error ? err.message : err);
        process.exit(1);
      }

      console.log(`Added tripwire "${result.rule.id}" to ${toRepo ? "repo" : "global"} config:`);
      console.log(`  ${targetPath}`);
      console.log("");
      console.log(JSON.stringify(result.rule, null, 2));
      console.log("");
      console.log("Run `plannotator tripwires list` to see all rules.");
      process.exit(0);
    }

    const description = descriptionParts.join(" ").trim();
    if (description) {
      const { root, key } = await resolveMergedTripwires(process.cwd());
      console.log(
        buildAddTripwirePrompt({
          description,
          globalPath: key ? globalTripwiresPath(key) : undefined,
          repoPath: root ? `${root}/.plannotator/tripwires.json` : undefined,
        }),
      );
      process.exit(0);
    }

    console.error("Usage: plannotator tripwires add <description...>");
    console.error("       plannotator tripwires add --glob <glob> [--glob ...] [--symbol <s> ...] [--note <text>] [--id <id>] [--repo]");
    process.exit(1);
  }

  console.error("Usage: plannotator tripwires <list|add|validate|path>");
  process.exit(1);

} else if (args[0] === "review") {
  // ============================================
  // CODE REVIEW MODE
  // ============================================

  const reviewArgs = parseReviewArgs(args.slice(1));
  const urlArg = reviewArgs.prUrl;
  const isPRMode = urlArg !== undefined;
  const useLocal = isPRMode && reviewArgs.useLocal;

  let rawPatch: string;
  let gitRef: string;
  let diffError: string | undefined;
  let gitContext: Awaited<ReturnType<typeof prepareLocalReviewDiff>>["gitContext"] | undefined;
  let prMetadata: Awaited<ReturnType<typeof fetchPR>>["metadata"] | undefined;
  let initialDiffType: DiffType | undefined;
  let agentCwd: string | undefined;
  let worktreePool: WorktreePool | undefined;
  let worktreeCleanup: (() => void | Promise<void>) | undefined;

  // Non-interactive tripwire flags short-circuit as soon as rawPatch is known —
  // BEFORE the --local PR checkout (worktree/clone) so a PR scan never pays for a
  // checkout it discards, and BEFORE detectProjectName/server startup. The scan
  // only needs rawPatch. Keyed off the launch repo (no agentCwd yet → cwd falls
  // through to gitContext?.cwd / process.cwd()), matching Pi and OpenCode.
  const maybeRunTripwireShortCircuit = async (): Promise<void> => {
    if (reviewArgs.tripwires) {
      const tripwireCwd = gitContext?.cwd ?? process.cwd();
      const { config, root, key } = await resolveMergedTripwires(tripwireCwd);
      const hits = evaluateTripwires(rawPatch, config, { cwd: root ?? undefined });
      const globalPath = key ? globalTripwiresPath(key) : "(unknown)";
      const globalRules = parseTripwiresConfigDetailed(
        key ? readGlobalTripwiresFile(key) : null,
      ).config.rules;
      const repoPath = root ? `${root}/.plannotator/tripwires.json` : null;
      const repoRules = root
        ? parseTripwiresConfigDetailed(readTripwiresFile(root)).config.rules
        : [];
      console.log(
        formatTripwiresMarkdown({ globalKey: key, globalPath, repoPath, globalRules, repoRules, hits }),
      );
      process.exit(0);
    }
    if (reviewArgs.addTripwire) {
      // The description is natural language; resolve real paths so the
      // emitted instruction points the agent at the exact files.
      const tripwireCwd = gitContext?.cwd ?? process.cwd();
      const { root, key } = await resolveMergedTripwires(tripwireCwd);
      console.log(
        buildAddTripwirePrompt({
          description: reviewArgs.addTripwire,
          globalPath: key ? globalTripwiresPath(key) : undefined,
          repoPath: root ? `${root}/.plannotator/tripwires.json` : undefined,
        }),
      );
      process.exit(0);
    }
  };

  if (isPRMode) {
    // --- PR Review Mode ---
    const prRef = parsePRUrl(urlArg);
    if (!prRef) {
      console.error(`Invalid PR/MR URL: ${urlArg}`);
      console.error("Supported formats:");
      console.error("  GitHub: https://github.com/owner/repo/pull/123");
      console.error("  GitLab: https://gitlab.com/group/project/-/merge_requests/42");
      process.exit(1);
    }

    const cliName = getCliName(prRef);
    const cliUrl = getCliInstallUrl(prRef);

    try {
      await checkPRAuth(prRef);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found") || msg.includes("ENOENT")) {
        console.error(`${cliName === "gh" ? "GitHub" : "GitLab"} CLI (${cliName}) is not installed.`);
        console.error(`Install it from ${cliUrl}`);
      } else {
        console.error(msg);
      }
      process.exit(1);
    }

    console.error(`Fetching ${getMRLabel(prRef)} ${getMRNumberLabel(prRef)} from ${getDisplayRepo(prRef)}...`);
    try {
      const pr = await fetchPR(prRef);
      rawPatch = pr.rawPatch;
      gitRef = `${getMRLabel(prRef)} ${getMRNumberLabel(prRef)}`;
      prMetadata = pr.metadata;
    } catch (err) {
      console.error(err instanceof Error ? err.message : "Failed to fetch PR");
      process.exit(1);
    }

    // Scan with the PR rawPatch and exit before any --local checkout work.
    await maybeRunTripwireShortCircuit();

    // --local: create a local checkout with the PR head for full file access
    if (useLocal && prMetadata) {
      // Hoisted so catch block can clean up partially-created directories
      let localPath: string | undefined;
      let sessionDir: string | undefined;
      try {
        const repoDir = process.cwd();
        const identifier = prMetadata.platform === "github"
          ? `${prMetadata.owner}-${prMetadata.repo}-${prMetadata.number}`
          : `${prMetadata.projectPath.replace(/\//g, "-")}-${prMetadata.iid}`;
        const suffix = Math.random().toString(36).slice(2, 8);
        // Resolve tmpdir to its real path — on macOS, tmpdir() returns /var/folders/...
        // but processes report /private/var/folders/... which breaks path stripping.
        sessionDir = path.join(realpathSync(tmpdir()), `plannotator-pr-${identifier}-${suffix}`);
        const prNumber = prMetadata.platform === "github" ? prMetadata.number : prMetadata.iid;
        localPath = path.join(sessionDir, "pool", `pr-${prNumber}`);
        const fetchRefStr = prMetadata.platform === "github"
          ? `refs/pull/${prMetadata.number}/head`
          : `refs/merge-requests/${prMetadata.iid}/head`;

        // Validate inputs from platform API to prevent git flag/path injection
        if (prMetadata.baseBranch.includes('..') || prMetadata.baseBranch.startsWith('-')) throw new Error(`Invalid base branch: ${prMetadata.baseBranch}`);
        if (!/^[0-9a-f]{40,64}$/i.test(prMetadata.baseSha)) throw new Error(`Invalid base SHA: ${prMetadata.baseSha}`);

        // Detect same-repo vs cross-repo (must match both owner/repo AND host)
        let isSameRepo = false;
        try {
          const remoteResult = await gitRuntime.runGit(["remote", "get-url", "origin"]);
          if (remoteResult.exitCode === 0) {
            const remoteUrl = remoteResult.stdout.trim();
            const currentRepo = parseRemoteUrl(remoteUrl);
            const prRepo = prMetadata.platform === "github"
              ? `${prMetadata.owner}/${prMetadata.repo}`
              : prMetadata.projectPath;
            const repoMatches = !!currentRepo && currentRepo.toLowerCase() === prRepo.toLowerCase();
            // Extract host from remote URL to avoid cross-instance false positives (GHE)
            const sshHost = remoteUrl.match(/^[^@]+@([^:]+):/)?.[1];
            const httpsHost = (() => { try { return new URL(remoteUrl).hostname; } catch { return null; } })();
            const remoteHost = (sshHost || httpsHost || "").toLowerCase();
            const prHost = prMetadata.host.toLowerCase();
            isSameRepo = repoMatches && remoteHost === prHost;
          }
        } catch { /* not in a git repo — cross-repo path */ }

        if (isSameRepo) {
          // ── Same-repo: fast worktree path ──
          console.error("Fetching PR branch and creating local worktree...");
          // Fetch base branch so origin/<baseBranch> is current for agent diffs.
          // Ensure baseSha is available (may fetch, which overwrites FETCH_HEAD).
          // Both MUST happen before the PR head fetch since FETCH_HEAD is what
          // createWorktree uses — the PR head fetch must be last.
          await fetchRef(gitRuntime, prMetadata.baseBranch, { cwd: repoDir });
          await ensureObjectAvailable(gitRuntime, prMetadata.baseSha, { cwd: repoDir });
          // Fetch PR head LAST — sets FETCH_HEAD to the PR tip for createWorktree.
          await fetchRef(gitRuntime, fetchRefStr, { cwd: repoDir });

          await createWorktree(gitRuntime, {
            ref: "FETCH_HEAD",
            path: localPath,
            detach: true,
            cwd: repoDir,
          });

          worktreeCleanup = async () => {
            if (worktreePool) await worktreePool.cleanup(gitRuntime);
            try { rmSync(sessionDir, { recursive: true, force: true }); } catch {}
          };
          process.once("exit", () => {
            // Best-effort sync cleanup: remove each pool worktree from git, then rm session dir
            try {
              for (const entry of worktreePool?.entries() ?? []) {
                Bun.spawnSync(["git", "worktree", "remove", "--force", entry.path], { cwd: repoDir });
              }
            } catch {}
            try { Bun.spawnSync(["rm", "-rf", sessionDir]); } catch {}
          });
        } else {
          // ── Cross-repo: shallow clone + fetch PR head ──
          const prRepo = prMetadata.platform === "github"
            ? `${prMetadata.owner}/${prMetadata.repo}`
            : prMetadata.projectPath;
          // Validate repo identifier to prevent flag injection via crafted URLs
          if (/^-/.test(prRepo)) throw new Error(`Invalid repository identifier: ${prRepo}`);
          const cli = prMetadata.platform === "github" ? "gh" : "glab";
          const host = prMetadata.host;
          // gh/glab repo clone doesn't accept --hostname; set GH_HOST/GITLAB_HOST env instead
          const isDefaultHost = host === "github.com" || host === "gitlab.com";
          const cloneEnv = isDefaultHost ? undefined : {
            ...process.env,
            ...(prMetadata.platform === "github" ? { GH_HOST: host } : { GITLAB_HOST: host }),
          };

          // Step 1: Fast skeleton clone (no checkout, depth 1 — minimal data transfer)
          console.error(`Cloning ${prRepo} (shallow)...`);
          const cloneResult = Bun.spawnSync(
            [cli, "repo", "clone", prRepo, localPath, "--", "--depth=1", "--no-checkout"],
            { stderr: "pipe", env: cloneEnv },
          );
          if (cloneResult.exitCode !== 0) {
            throw new Error(`${cli} repo clone failed: ${new TextDecoder().decode(cloneResult.stderr).trim()}`);
          }

          // Step 2: Fetch only the PR head ref (targeted, much faster than full fetch)
          console.error("Fetching PR branch...");
          const fetchResult = Bun.spawnSync(
            ["git", "fetch", "--depth=200", "origin", fetchRefStr],
            { cwd: localPath, stderr: "pipe" },
          );
          if (fetchResult.exitCode !== 0) throw new Error(`Failed to fetch PR head ref: ${new TextDecoder().decode(fetchResult.stderr).trim()}`);

          // Step 3: Checkout PR head (critical — if this fails, worktree is empty)
          const checkoutResult = Bun.spawnSync(["git", "checkout", "FETCH_HEAD"], { cwd: localPath, stderr: "pipe" });
          if (checkoutResult.exitCode !== 0) {
            throw new Error(`git checkout FETCH_HEAD failed: ${new TextDecoder().decode(checkoutResult.stderr).trim()}`);
          }

          // Best-effort: create base refs so `git diff main...HEAD` and `git diff origin/main...HEAD` work
          const baseFetch = Bun.spawnSync(["git", "fetch", "--depth=200", "origin", prMetadata.baseSha], { cwd: localPath, stderr: "pipe" });
          if (baseFetch.exitCode !== 0) console.error("Warning: failed to fetch baseSha, agent diffs may be inaccurate");
          Bun.spawnSync(["git", "branch", "--", prMetadata.baseBranch, prMetadata.baseSha], { cwd: localPath, stderr: "pipe" });
          Bun.spawnSync(["git", "update-ref", `refs/remotes/origin/${prMetadata.baseBranch}`, prMetadata.baseSha], { cwd: localPath, stderr: "pipe" });

          worktreeCleanup = () => { try { rmSync(sessionDir, { recursive: true, force: true }); } catch {} };
          process.once("exit", () => {
            try { Bun.spawnSync(["rm", "-rf", sessionDir]); } catch {}
          });
        }

        // --local only provides a sandbox path for agent processes.
        // Do NOT set gitContext — that would contaminate the diff pipeline.
        agentCwd = localPath;

        // Create worktree pool with the initial PR as the first entry
        worktreePool = createWorktreePool(
          { sessionDir, repoDir, isSameRepo },
          { path: localPath, prUrl: prMetadata.url, number: prNumber, ready: true },
        );

        console.error(`Local checkout ready at ${localPath}`);
      } catch (err) {
        console.error(`Warning: --local failed, falling back to remote diff`);
        console.error(err instanceof Error ? err.message : String(err));
        if (sessionDir) try { rmSync(sessionDir, { recursive: true, force: true }); } catch {}
        agentCwd = undefined;
        worktreePool = undefined;
        worktreeCleanup = undefined;
      }
    }
  } else {
    // --- Local Review Mode ---
    const config = loadConfig();
    const diffResult = await prepareLocalReviewDiff({
      vcsType: reviewArgs.vcsType,
      configuredDiffType: resolveDefaultDiffType(config),
      hideWhitespace: config.diffOptions?.hideWhitespace ?? false,
    });
    gitContext = diffResult.gitContext;
    initialDiffType = diffResult.diffType;
    rawPatch = diffResult.rawPatch;
    gitRef = diffResult.gitRef;
    diffError = diffResult.error;

    // Local mode: rawPatch is ready, scan and exit before server startup.
    await maybeRunTripwireShortCircuit();
  }

  const reviewProject = (await detectProjectName()) ?? "_unknown";

  // Start review server (even if empty - user can switch diff types in local mode)
  const server = await startReviewServer({
    rawPatch,
    gitRef,
    error: diffError,
    origin: detectedOrigin,
    diffType: gitContext ? (initialDiffType ?? "unstaged") : undefined,
    gitContext,
    prMetadata,
    agentCwd,
    worktreePool,
    sharingEnabled,
    shareBaseUrl,
    htmlContent: reviewHtmlContent,
    onCleanup: worktreeCleanup,
    onReady: async (url, isRemote, port) => {
      handleReviewServerReady(url, isRemote, port);

      if (isRemote && sharingEnabled && rawPatch) {
        await writeRemoteShareLink(rawPatch, shareBaseUrl, "review changes", "diff only").catch(() => {});
      }
    },
  });

  registerSession({
    pid: process.pid,
    port: server.port,
    url: server.url,
    mode: "review",
    project: reviewProject,
    startedAt: new Date().toISOString(),
    label: isPRMode ? `${getMRLabel(prMetadata!).toLowerCase()}-review-${getDisplayRepo(prMetadata!)}${getMRNumberLabel(prMetadata!)}` : `review-${reviewProject}`,
  });

  // Wait for user feedback
  const result = await server.waitForDecision();

  // Give browser time to receive response and update UI
  await Bun.sleep(1500);

  // Cleanup
  server.stop();

  // Output feedback (captured by slash command)
  if (result.exit) {
    console.log("Review session closed without feedback.");
  } else if (result.approved) {
    console.log(getReviewApprovedPrompt(detectedOrigin));
  } else {
    console.log(result.feedback);
    if (!isPRMode) {
      console.log(getReviewDeniedSuffix(detectedOrigin));
    }
  }
  process.exit(0);

} else if (args[0] === "annotate") {
  // ============================================
  // ANNOTATE MODE
  // ============================================

  const rawFilePath = args[1];
  if (!rawFilePath) {
    console.error("Usage: plannotator annotate <file.md | file.html | https://... | folder/>  [--no-jina] [--gate] [--json] [--hook]");
    process.exit(1);
  }

  // Primary resolution strips the `@` reference marker; rawFilePath is
  // preserved so each branch can fall back to the literal form below
  // (scoped-package-style names).
  let filePath = stripAtPrefix(rawFilePath);

  // Use PLANNOTATOR_CWD if set (original working directory before script cd'd)
  const projectRoot = process.env.PLANNOTATOR_CWD || process.cwd();

  if (process.env.PLANNOTATOR_DEBUG) {
    console.error(`[DEBUG] Project root: ${projectRoot}`);
    console.error(`[DEBUG] File path arg: ${filePath}`);
  }

  let markdown: string;
  let rawHtml: string | undefined;
  let absolutePath: string;
  let folderPath: string | undefined;
  let annotateMode: "annotate" | "annotate-folder" = "annotate";
  let sourceInfo: string | undefined;
  let sourceConverted = false;

  // --- URL annotation ---
  const isUrl = /^https?:\/\//i.test(filePath);

  if (isUrl) {
    const useJina = resolveUseJina(cliNoJina, loadConfig());
    console.error(`Fetching: ${filePath}${useJina ? " (via Jina Reader)" : " (via fetch+Turndown)"}`);
    try {
      const result = await urlToMarkdown(filePath, { useJina });
      markdown = result.markdown;
      sourceConverted = isConvertedSource(result.source);
      if (process.env.PLANNOTATOR_DEBUG) {
        console.error(`[DEBUG] Fetched via ${result.source} (${markdown.length} chars)`);
      }
    } catch (err) {
      console.error(`Failed to fetch URL: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    absolutePath = filePath; // Use URL as the "path" for display
    sourceInfo = filePath;   // Full URL for source attribution
  } else {
    // Folder check with literal-@ fallback for scoped-package-style names.
    const folderCandidate = resolveAtReference(rawFilePath, (c) => {
      try { return statSync(resolveUserPath(c, projectRoot)).isDirectory(); }
      catch { return false; }
    });

    if (folderCandidate !== null) {
      const resolvedArg = resolveUserPath(folderCandidate, projectRoot);
      // Folder annotation mode (markdown + HTML files)
      if (!hasMarkdownFiles(resolvedArg, FILE_BROWSER_EXCLUDED, /\.(mdx?|html?)$/i)) {
        console.error(`No markdown or HTML files found in ${resolvedArg}`);
        process.exit(1);
      }
      folderPath = resolvedArg;
      absolutePath = resolvedArg;
      markdown = "";
      annotateMode = "annotate-folder";
      console.error(`Folder: ${resolvedArg}`);
    } else {
      // HTML check with the same literal-@ fallback semantics.
      const htmlCandidate = resolveAtReference(rawFilePath, (c) => {
        const abs = resolveUserPath(c, projectRoot);
        return /\.html?$/i.test(abs) && existsSync(abs);
      });

      if (htmlCandidate !== null) {
        const resolvedArg = resolveUserPath(htmlCandidate, projectRoot);
        const htmlFile = Bun.file(resolvedArg);
        if (htmlFile.size > 10 * 1024 * 1024) {
          console.error(`File too large (${Math.round(htmlFile.size / 1024 / 1024)}MB, max 10MB): ${resolvedArg}`);
          process.exit(1);
        }
        const html = await htmlFile.text();
        if (renderHtmlFlag) {
          rawHtml = html;
          markdown = "";
        } else {
          markdown = htmlToMarkdown(html);
          sourceConverted = true;
        }
        absolutePath = resolvedArg;
        sourceInfo = path.basename(resolvedArg);
        console.error(`${renderHtmlFlag ? "Raw HTML" : "Converted"}: ${absolutePath}`);
      } else {
        // Single markdown file annotation mode
        // Strip-first with literal-@ fallback (scoped-package-style names).
        let resolved = resolveMarkdownFile(filePath, projectRoot);
        if (resolved.kind === "not_found" && rawFilePath !== filePath) {
          resolved = resolveMarkdownFile(rawFilePath, projectRoot);
        }

        if (resolved.kind === "ambiguous") {
          console.error(`Ambiguous filename "${resolved.input}" — found ${resolved.matches.length} matches:`);
          for (const match of resolved.matches) {
            console.error(`  ${match}`);
          }
          process.exit(1);
        }
        if (resolved.kind === "not_found") {
          console.error(`File not found: ${resolved.input}`);
          process.exit(1);
        }

        absolutePath = resolved.path;
        markdown = await Bun.file(absolutePath).text();
        console.error(`Resolved: ${absolutePath}`);
      }
    }
  }

  const annotateProject = (await detectProjectName()) ?? "_unknown";

  // Start the annotate server (reuses plan editor HTML)
  const server = await startAnnotateServer({
    markdown,
    filePath: absolutePath,
    origin: detectedOrigin,
    mode: annotateMode,
    folderPath,
    sourceInfo,
    sourceConverted,
    sharingEnabled,
    shareBaseUrl,
    pasteApiUrl,
    gate: gateFlag,
    rawHtml,
    renderHtml: renderHtmlFlag,
    htmlContent: planHtmlContent,
    onReady: async (url, isRemote, port) => {
      handleAnnotateServerReady(url, isRemote, port);

      if (isRemote && sharingEnabled && markdown) {
        await writeRemoteShareLink(markdown, shareBaseUrl, "annotate", "document only").catch(() => {});
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
    label: folderPath
      ? `annotate-${path.basename(folderPath)}`
      : `annotate-${isUrl ? hostnameOrFallback(absolutePath) : path.basename(absolutePath)}`,
  });

  // Wait for user feedback
  const result = await server.waitForDecision();

  // Give browser time to receive response and update UI
  await Bun.sleep(1500);

  // Cleanup
  server.stop();

  // Output feedback (captured by slash command)
  emitAnnotateOutcome(result);
  process.exit(0);

} else if (args[0] === "annotate-last" || args[0] === "last") {
  // ============================================
  // ANNOTATE LAST MESSAGE MODE
  // ============================================

  const projectRoot = process.env.PLANNOTATOR_CWD || process.cwd();
  const stdinIdx = args.indexOf("--stdin");
  const stdinFlag = stdinIdx !== -1;
  if (stdinFlag) args.splice(stdinIdx, 1);
  const codexThreadId = process.env.CODEX_THREAD_ID;
  const isCodex = !!codexThreadId;
  const isDroid = detectedOrigin === "droid";

  // Collect up to N recent assistant messages so the user can pick the right
  // one — defaults to the same selection as the legacy "last message"
  // behavior (index 0). Necessary because the newest transcript entry isn't
  // always the message the user intended to annotate (e.g., after /rewind).
  // 25 covers long conversations worth of rewinds without flooding the
  // picker; the list scrolls past this if more are shown.
  const RECENT_MESSAGES_LIMIT = 25;
  let lastMessage: RenderedMessage | null = null;
  let recentMessages: RenderedMessage[] = [];

  if (stdinFlag) {
    const text = (await Bun.stdin.text()).trim();
    if (text) {
      lastMessage = { messageId: "stdin", text, lineNumbers: [] };
    }
  } else if (codexThreadId) {
    // Codex path: find rollout by thread ID
    if (process.env.PLANNOTATOR_DEBUG) {
      console.error(`[DEBUG] Codex detected, thread ID: ${codexThreadId}`);
    }
    const rolloutPath = findCodexRolloutByThreadId(codexThreadId);
    if (rolloutPath) {
      if (process.env.PLANNOTATOR_DEBUG) {
        console.error(`[DEBUG] Rollout: ${rolloutPath}`);
      }
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
        console.error(`[DEBUG] ${label}: ${paths.length ? paths.join(", ") : "(none)"}`);
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
    tryLogCandidates("Ancestor PID session metadata", () => ancestorLog ? [ancestorLog] : []);

    // 2. Scan all session metadata files for one whose cwd matches
    const cwdScanLog = resolveSessionLogByCwdScan({ cwd: projectRoot });
    tryLogCandidates("Cwd-scan session metadata", () => cwdScanLog ? [cwdScanLog] : []);

    // 3. Fall back to CWD slug match (mtime-based)
    tryLogCandidates("CWD slug match (mtime)", () => findSessionLogsForCwd(projectRoot));

    // 4. Fall back to ancestor directory walk
    tryLogCandidates("Directory ancestor walk", () => findSessionLogsByAncestorWalk(projectRoot));
  }

  if (!lastMessage) {
    console.error(stdinFlag
      ? "No message content received on stdin."
      : "No rendered assistant message found in session logs.");
    process.exit(1);
  }

  if (process.env.PLANNOTATOR_DEBUG) {
    console.error(`[DEBUG] Found message ${lastMessage.messageId} (${lastMessage.text.length} chars)`);
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
  let userDiffType: DiffType | undefined;
  let gitContext: Awaited<ReturnType<typeof prepareLocalReviewDiff>>["gitContext"] | undefined;
  let prMetadata: Awaited<ReturnType<typeof fetchPR>>["metadata"] | undefined;

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
    const diffResult = await prepareLocalReviewDiff({
      cwd: process.env.PLANNOTATOR_CWD || process.cwd(),
      vcsType: reviewArgs.vcsType,
      configuredDiffType: resolveDefaultDiffType(config),
      hideWhitespace: config.diffOptions?.hideWhitespace ?? false,
    });
    gitContext = diffResult.gitContext;
    userDiffType = diffResult.diffType;
    rawPatch = diffResult.rawPatch;
    gitRef = diffResult.gitRef;
    diffError = diffResult.error;
  }

  // Non-interactive tripwire flags short-circuit BEFORE server startup. Emits
  // {decision:"annotated", feedback, isPRMode:true} — the bridge returns
  // feedback verbatim for isPRMode:true (no deny suffix), so no bridge change.
  if (reviewArgs.tripwires) {
    const tripwireCwd = gitContext?.cwd ?? process.env.PLANNOTATOR_CWD ?? process.cwd();
    const { config, root, key } = await resolveMergedTripwires(tripwireCwd);
    const hits = evaluateTripwires(rawPatch, config, { cwd: root ?? undefined });
    const globalPath = key ? globalTripwiresPath(key) : "(unknown)";
    const globalRules = parseTripwiresConfigDetailed(
      key ? readGlobalTripwiresFile(key) : null,
    ).config.rules;
    const repoPath = root ? `${root}/.plannotator/tripwires.json` : null;
    const repoRules = root
      ? parseTripwiresConfigDetailed(readTripwiresFile(root)).config.rules
      : [];
    const report = formatTripwiresMarkdown({ globalKey: key, globalPath, repoPath, globalRules, repoRules, hits });
    console.log(JSON.stringify({ decision: "annotated", feedback: report, isPRMode: true }));
    process.exit(0);
  }
  if (reviewArgs.addTripwire) {
    const tripwireCwd = gitContext?.cwd ?? process.env.PLANNOTATOR_CWD ?? process.cwd();
    const { root, key } = await resolveMergedTripwires(tripwireCwd);
    console.log(JSON.stringify({
      decision: "annotated",
      feedback: buildAddTripwirePrompt({
        description: reviewArgs.addTripwire,
        globalPath: key ? globalTripwiresPath(key) : undefined,
        repoPath: root ? `${root}/.plannotator/tripwires.json` : undefined,
      }),
      isPRMode: true,
    }));
    process.exit(0);
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
  let event: { toolName: string; toolArgs: string; cwd: string; timestamp: number; sessionId?: string };

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
        await writeRemoteShareLink(planContent, shareBaseUrl, "review the plan", "plan only").catch(() => {});
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
    console.log(JSON.stringify({
      permissionDecision: "allow",
    }));
  } else {
    const feedback = getPlanDeniedPrompt("copilot-cli", undefined, {
      toolName: getPlanToolName("copilot-cli"),
      planFileRule: "",
      feedback: result.feedback || "Plan changes requested",
    });
    console.log(JSON.stringify({
      permissionDecision: "deny",
      permissionDecisionReason: feedback,
    }));
  }

  process.exit(0);

} else if (args[0] === "copilot-last") {
  // ============================================
  // COPILOT CLI ANNOTATE LAST MESSAGE MODE
  // ============================================

  const projectRoot = process.env.PLANNOTATOR_CWD || process.cwd();

  if (process.env.PLANNOTATOR_DEBUG) {
    console.error(`[DEBUG] Copilot CLI detected, finding session for CWD: ${projectRoot}`);
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
        await writeRemoteShareLink(msg.text, shareBaseUrl, "annotate", "message only").catch(() => {});
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

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: context,
    },
  }));

  process.exit(0);

} else {
  // ============================================
  // PLAN REVIEW MODE (default)
  // ============================================

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
          await writeRemoteShareLink(latestPlan.text, shareBaseUrl, "review the plan", "plan only").catch(() => {});
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
        })
      );
    }

    process.exit(0);
  }

  let planContent = "";
  let permissionMode = "default";
  let isGemini = false;
  let planFilename = "";

  // Detect harness: Gemini sends plan_filename (file on disk), Claude Code sends plan (inline)
  planFilename = event.tool_input?.plan_filename || event.tool_input?.plan_path || "";
  isGemini = !!planFilename;

  if (isGemini) {
    // Reconstruct full plan path from transcript_path and session_id:
    // transcript_path = <projectTempDir>/chats/session-...json
    // plan lives at   = <projectTempDir>/<session_id>/plans/<plan_filename>
    const projectTempDir = path.dirname(path.dirname(event.transcript_path));
    const planFilePath = path.join(projectTempDir, event.session_id, "plans", planFilename);
    planContent = await Bun.file(planFilePath).text();
  } else {
    planContent = event.tool_input?.plan || "";
  }

  permissionMode = event.permission_mode || "default";

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
    sharingEnabled,
    shareBaseUrl,
    pasteApiUrl,
    htmlContent: planHtmlContent,
    onReady: async (url, isRemote, port) => {
      handleServerReady(url, isRemote, port);

      if (isRemote && sharingEnabled) {
        await writeRemoteShareLink(planContent, shareBaseUrl, "review the plan", "plan only").catch(() => {});
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
      console.log(result.feedback ? JSON.stringify({ systemMessage: result.feedback }) : "{}");
    } else {
      console.log(
        JSON.stringify({
          decision: "deny",
          reason: getPlanDeniedPrompt("gemini-cli", undefined, {
            toolName: getPlanToolName("gemini-cli"),
            planFileRule: buildPlanFileRule(getPlanToolName("gemini-cli"), planFilename),
            feedback: result.feedback || "Plan changes requested",
          }),
        })
      );
    }
  } else {
    // Claude Code: PermissionRequest hook decision
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
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: {
              behavior: "allow",
              ...(updatedPermissions.length > 0 && { updatedPermissions }),
            },
          },
        })
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
        })
      );
    }
  }

  process.exit(0);
}
