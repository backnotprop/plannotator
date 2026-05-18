/**
 * Plannotator CLI for Claude Code, Codex, Gemini CLI, and Copilot CLI
 *
 * Supports eight modes:
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
 * 8. Improve Context (`plannotator improve-context`):
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
import { parseAnnotateArgs } from "@plannotator/shared/annotate-args";
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
  createPluginErrorResponse,
  createPluginSuccessResponse,
  getPluginCapabilities,
  type PluginAnnotateRequest,
  type PluginArchiveRequest,
  type PluginBaseRequest,
  type PluginClientOrigin,
  type PluginPlanRequest,
  type PluginReviewRequest,
  type PluginSessionInfo,
} from "@plannotator/shared/plugin-protocol";
import {
  findSessionLogsByAncestorWalk,
  findSessionLogsForCwd,
  getLastRenderedMessage,
  resolveSessionLogByAncestorPids,
  resolveSessionLogByCwdScan,
  type RenderedMessage,
} from "./session-log";
import { findCodexRolloutByThreadId, getLastCodexMessage, getLatestCodexPlan } from "./codex-session";
import { findCopilotPlanContent, findCopilotSessionForCwd, getLastCopilotMessage } from "./copilot-session";
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

let planHtmlContentPromise: Promise<string> | undefined;
let reviewHtmlContentPromise: Promise<string> | undefined;
let htmlAssetsPromise: Promise<typeof import("./html-assets")> | undefined;

function getHtmlAssets() {
  htmlAssetsPromise ??= import("./html-assets");
  return htmlAssetsPromise;
}

function getPlanHtmlContent(): Promise<string> {
  planHtmlContentPromise ??= getHtmlAssets().then((mod) => mod.planHtmlContent);
  return planHtmlContentPromise;
}

function getReviewHtmlContent(): Promise<string> {
  reviewHtmlContentPromise ??= getHtmlAssets().then((mod) => mod.reviewHtmlContent);
  return reviewHtmlContentPromise;
}

async function loadGoalSetupBundle(
  stage: GoalSetupStage,
  bundlePath: string,
) {
  const raw =
    bundlePath === "-"
      ? await Bun.stdin.text()
      : await Bun.file(path.resolve(bundlePath)).text();
  return normalizeGoalSetupBundle(JSON.parse(raw), stage);
}

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

// Annotate review-gate flags (#570): --gate adds an Approve button,
// --json switches stdout to structured decision output, --hook emits
// hook-native JSON that works directly with Claude Code and Codex
// PostToolUse/Stop hook protocols.
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

// Stdout matrix for annotate / annotate-last / copilot annotate-last (#570).
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

function registerProcessCleanup(cleanup: () => void): () => void {
  let cleaned = false;
  const run = () => {
    if (cleaned) return;
    cleaned = true;
    cleanup();
  };
  const onSigint = () => {
    run();
    process.exit(130);
  };
  const onSigterm = () => {
    run();
    process.exit(143);
  };

  process.once("exit", run);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  return () => {
    process.removeListener("exit", run);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    run();
  };
}

function cleanupWorktreeSession(
  repoDir: string,
  sessionDir: string,
  worktreePool: WorktreePool | undefined,
  fallbackWorktreePath: string,
): void {
  try {
    const entries = [...(worktreePool?.entries() ?? [])];
    if (entries.length > 0) {
      for (const entry of entries) {
        Bun.spawnSync(["git", "worktree", "remove", "--force", entry.path], { cwd: repoDir });
      }
    } else {
      Bun.spawnSync(["git", "worktree", "remove", "--force", fallbackWorktreePath], { cwd: repoDir });
    }
  } catch {}
  try { rmSync(sessionDir, { recursive: true, force: true }); } catch {}
}

function emitPluginError(code: string, message: string, exitCode = 1): never {
  console.log(JSON.stringify(createPluginErrorResponse(code, message)));
  process.exit(exitCode);
}

async function readPluginRequest<T extends PluginBaseRequest>(): Promise<Partial<T>> {
  try {
    const raw = await Bun.stdin.text();
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    emitPluginError(
      "invalid-json",
      err instanceof Error ? err.message : "Invalid JSON request",
    );
  }
}

function getPluginOrigin(request: Partial<PluginBaseRequest>): PluginClientOrigin {
  const originIndex = args.indexOf("--origin");
  const originArg = originIndex >= 0 ? args[originIndex + 1] : undefined;
  const origin = request.origin || originArg || detectedOrigin;
  if (origin !== "opencode" && origin !== "pi") {
    emitPluginError(
      "invalid-origin",
      `Plugin origin must be "opencode" or "pi"; got ${String(origin || "")}`,
    );
  }
  return origin;
}

function applyPluginCwd(request: Partial<PluginBaseRequest>): void {
  if (!request.cwd) return;
  try {
    process.chdir(request.cwd);
  } catch (err) {
    emitPluginError(
      "invalid-cwd",
      err instanceof Error ? err.message : `Invalid cwd: ${request.cwd}`,
    );
  }
}

function pluginSessionInfo(
  mode: PluginSessionInfo["mode"],
  server: { url: string; port: number; isRemote: boolean },
): PluginSessionInfo {
  return {
    mode,
    url: server.url,
    port: server.port,
    isRemote: server.isRemote,
  };
}

function emitPluginSessionReady(session: PluginSessionInfo): void {
  console.error(`PLANNOTATOR_SESSION_READY ${JSON.stringify(session)}`);
}

async function runPluginPlanCommand(): Promise<void> {
  const request = await readPluginRequest<PluginPlanRequest>();
  const origin = getPluginOrigin(request);
  applyPluginCwd(request);

  let planContent = typeof request.plan === "string" ? request.plan : "";
  if (!planContent && request.planFilePath) {
    try {
      const planPath = path.isAbsolute(request.planFilePath)
        ? request.planFilePath
        : path.resolve(process.cwd(), request.planFilePath);
      planContent = await Bun.file(planPath).text();
    } catch (err) {
      emitPluginError(
        "plan-read-failed",
        err instanceof Error ? err.message : `Could not read plan file: ${request.planFilePath}`,
      );
    }
  }

  if (!planContent.trim()) {
    emitPluginError(
      "missing-plan",
      "Plugin plan requests must include a non-empty plan or planFilePath.",
    );
  }

  const effectiveSharingEnabled = request.sharingEnabled ?? sharingEnabled;
  const effectiveShareBaseUrl = request.shareBaseUrl ?? shareBaseUrl;
  const effectivePasteApiUrl = request.pasteApiUrl ?? pasteApiUrl;
  const planProject = (await detectProjectName()) ?? "_unknown";

  const server = await startPlannotatorServer({
    plan: planContent,
    origin,
    permissionMode: request.permissionMode,
    sharingEnabled: effectiveSharingEnabled,
    shareBaseUrl: effectiveShareBaseUrl,
    pasteApiUrl: effectivePasteApiUrl,
    htmlContent: await getPlanHtmlContent(),
    opencodeClient: request.availableAgents
      ? { app: { agents: async () => ({ data: request.availableAgents }) } }
      : undefined,
    onReady: async (url, isRemote, port) => {
      handleServerReady(url, isRemote, port);

      if (isRemote && effectiveSharingEnabled) {
        await writeRemoteShareLink(planContent, effectiveShareBaseUrl, "review the plan", "plan only").catch(() => {});
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
    label: `plugin-plan-${origin}-${planProject}`,
  });

  const session = pluginSessionInfo("plan", server);
  emitPluginSessionReady(session);
  const result = await server.waitForDecision();
  await Bun.sleep(1500);
  server.stop();

  console.log(JSON.stringify(createPluginSuccessResponse(result, session)));
}

async function runPluginArchiveCommand(): Promise<void> {
  const request = await readPluginRequest<PluginArchiveRequest>();
  const origin = getPluginOrigin(request);
  applyPluginCwd(request);

  const effectiveSharingEnabled = request.sharingEnabled ?? sharingEnabled;
  const effectiveShareBaseUrl = request.shareBaseUrl ?? shareBaseUrl;
  const effectivePasteApiUrl = request.pasteApiUrl ?? pasteApiUrl;
  const archiveProject = (await detectProjectName()) ?? "_unknown";

  const server = await startPlannotatorServer({
    plan: "",
    origin,
    mode: "archive",
    customPlanPath: request.customPlanPath,
    sharingEnabled: effectiveSharingEnabled,
    shareBaseUrl: effectiveShareBaseUrl,
    pasteApiUrl: effectivePasteApiUrl,
    htmlContent: await getPlanHtmlContent(),
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
    label: `plugin-archive-${origin}-${archiveProject}`,
  });

  const session = pluginSessionInfo("archive", server);
  emitPluginSessionReady(session);
  if (server.waitForDone) await server.waitForDone();
  await Bun.sleep(500);
  server.stop();

  console.log(JSON.stringify(createPluginSuccessResponse({ opened: true }, session)));
}

async function runPluginAnnotateCommand(defaultMode: "annotate" | "annotate-last" = "annotate"): Promise<void> {
  const request = await readPluginRequest<PluginAnnotateRequest>();
  const origin = getPluginOrigin(request);
  applyPluginCwd(request);

  const directMarkdown = typeof request.markdown === "string";
  const hasRawArgs = typeof request.args === "string";
  const parsedArgs = hasRawArgs ? parseAnnotateArgs(request.args ?? "") : undefined;
  const structuredFilePath = typeof request.filePath === "string" ? request.filePath : "";
  const directFilePath = structuredFilePath.trim().length > 0;
  const gate = request.gate ?? parsedArgs?.gate ?? false;
  const renderHtml = request.renderHtml ?? (typeof request.rawHtml === "string" ? true : parsedArgs?.renderHtml ?? false);

  let markdown = directMarkdown ? request.markdown! : "";
  let rawHtml = request.rawHtml;
  let absolutePath = directFilePath ? structuredFilePath : "";
  let folderPath = request.folderPath;
  let annotateMode: "annotate" | "annotate-folder" | "annotate-last" = request.mode ?? defaultMode;
  let sourceInfo = request.sourceInfo;
  let sourceConverted = request.sourceConverted ?? false;

  if (folderPath) {
    const resolvedFolder = path.isAbsolute(folderPath) ? folderPath : resolveUserPath(folderPath, process.cwd());
    folderPath = resolvedFolder;
    absolutePath = resolvedFolder;
    markdown = directMarkdown ? markdown : "";
    annotateMode = "annotate-folder";
  } else if (!directMarkdown && typeof rawHtml !== "string") {
    const rawFilePath = parsedArgs?.rawFilePath || structuredFilePath;
    if (!rawFilePath) {
      emitPluginError(
        "missing-annotate-target",
        "Plugin annotate requests must include args, markdown, filePath, folderPath, or rawHtml.",
      );
    }

    const filePath = parsedArgs?.filePath || structuredFilePath;
    const projectRoot = process.cwd();
    const isUrl = /^https?:\/\//i.test(filePath);

    if (isUrl) {
      const useJina = resolveUseJina(cliNoJina, loadConfig());
      console.error(`Fetching: ${filePath}${useJina ? " (via Jina Reader)" : " (via fetch+Turndown)"}`);
      try {
        const result = await urlToMarkdown(filePath, { useJina });
        markdown = result.markdown;
        sourceConverted = isConvertedSource(result.source);
      } catch (err) {
        emitPluginError("url-fetch-failed", `Failed to fetch URL: ${err instanceof Error ? err.message : String(err)}`);
      }
      absolutePath = filePath;
      sourceInfo = filePath;
    } else {
      const folderCandidate = resolveAtReference(rawFilePath, (candidate) => {
        try { return statSync(resolveUserPath(candidate, projectRoot)).isDirectory(); }
        catch { return false; }
      });

      if (folderCandidate !== null) {
        const resolvedArg = resolveUserPath(folderCandidate, projectRoot);
        if (!hasMarkdownFiles(resolvedArg, FILE_BROWSER_EXCLUDED, /\.(mdx?|html?)$/i)) {
          emitPluginError("empty-folder", `No markdown or HTML files found in ${resolvedArg}`);
        }
        folderPath = resolvedArg;
        absolutePath = resolvedArg;
        markdown = "";
        annotateMode = "annotate-folder";
        console.error(`Folder: ${resolvedArg}`);
      } else {
        const htmlCandidate = resolveAtReference(rawFilePath, (candidate) => {
          const abs = resolveUserPath(candidate, projectRoot);
          return /\.html?$/i.test(abs) && existsSync(abs);
        });

        if (htmlCandidate !== null) {
          const resolvedArg = resolveUserPath(htmlCandidate, projectRoot);
          const htmlFile = Bun.file(resolvedArg);
          if (htmlFile.size > 10 * 1024 * 1024) {
            emitPluginError("file-too-large", `File too large (${Math.round(htmlFile.size / 1024 / 1024)}MB, max 10MB): ${resolvedArg}`);
          }
          const html = await htmlFile.text();
          if (renderHtml) {
            rawHtml = html;
            markdown = "";
          } else {
            markdown = htmlToMarkdown(html);
            sourceConverted = true;
          }
          absolutePath = resolvedArg;
          sourceInfo = path.basename(resolvedArg);
          console.error(`${renderHtml ? "Raw HTML" : "Converted"}: ${absolutePath}`);
        } else {
          let resolved = resolveMarkdownFile(filePath, projectRoot);
          if (resolved.kind === "not_found" && rawFilePath !== filePath) {
            resolved = resolveMarkdownFile(rawFilePath, projectRoot);
          }
          if (resolved.kind === "ambiguous") {
            emitPluginError(
              "ambiguous-file",
              `Ambiguous filename "${resolved.input}" — found ${resolved.matches.length} matches:\n${resolved.matches.map((match) => `  ${match}`).join("\n")}`,
            );
          }
          if (resolved.kind === "not_found") {
            emitPluginError("file-not-found", `File not found: ${resolved.input}`);
          }
          absolutePath = resolved.path;
          markdown = await Bun.file(absolutePath).text();
          console.error(`Resolved: ${absolutePath}`);
        }
      }
    }
  }

  if (!absolutePath) absolutePath = annotateMode === "annotate-last" ? "last-message" : "document";

  const effectiveSharingEnabled = request.sharingEnabled ?? sharingEnabled;
  const effectiveShareBaseUrl = request.shareBaseUrl ?? shareBaseUrl;
  const effectivePasteApiUrl = request.pasteApiUrl ?? pasteApiUrl;
  const annotateProject = (await detectProjectName()) ?? "_unknown";

  const server = await startAnnotateServer({
    markdown,
    filePath: absolutePath,
    origin,
    mode: annotateMode,
    folderPath,
    sourceInfo,
    sourceConverted,
    sharingEnabled: effectiveSharingEnabled,
    shareBaseUrl: effectiveShareBaseUrl,
    pasteApiUrl: effectivePasteApiUrl,
    gate,
    rawHtml,
    renderHtml,
    htmlContent: await getPlanHtmlContent(),
    onReady: async (url, isRemote, port) => {
      handleAnnotateServerReady(url, isRemote, port);

      if (isRemote && effectiveSharingEnabled && markdown) {
        await writeRemoteShareLink(markdown, effectiveShareBaseUrl, "annotate", "document only").catch(() => {});
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
      ? `plugin-annotate-${origin}-${path.basename(folderPath)}`
      : `plugin-annotate-${origin}-${annotateMode === "annotate-last" ? "last" : path.basename(absolutePath)}`,
  });

  const session = pluginSessionInfo("annotate", server);
  emitPluginSessionReady(session);
  const result = await server.waitForDecision();
  await Bun.sleep(1500);
  server.stop();

  console.log(JSON.stringify(createPluginSuccessResponse({
    ...result,
    filePath: absolutePath,
    mode: annotateMode,
  }, session)));
}

async function runPluginReviewCommand(): Promise<void> {
  const request = await readPluginRequest<PluginReviewRequest>();
  const origin = getPluginOrigin(request);
  applyPluginCwd(request);

  const reviewArgs = parseReviewArgs(request.args ?? "");
  const urlArg = request.prUrl ?? reviewArgs.prUrl;
  const isPRMode = urlArg !== undefined;
  const useLocal = isPRMode && (request.useLocal ?? reviewArgs.useLocal);

  let rawPatch: string;
  let gitRef: string;
  let diffError: string | undefined;
  let gitContext: Awaited<ReturnType<typeof prepareLocalReviewDiff>>["gitContext"] | undefined;
  let prMetadata: Awaited<ReturnType<typeof fetchPR>>["metadata"] | undefined;
  let initialDiffType: DiffType | undefined;
  let initialBase: string | undefined;
  let agentCwd: string | undefined;
  let worktreePool: WorktreePool | undefined;
  let worktreeCleanup: (() => void | Promise<void>) | undefined;

  if (isPRMode) {
    const prRef = parsePRUrl(urlArg);
    if (!prRef) {
      emitPluginError(
        "invalid-pr-url",
        `Invalid PR/MR URL: ${urlArg}\nSupported formats:\n  GitHub: https://github.com/owner/repo/pull/123\n  GitLab: https://gitlab.com/group/project/-/merge_requests/42`,
      );
    }

    const cliName = getCliName(prRef);
    const cliUrl = getCliInstallUrl(prRef);

    try {
      await checkPRAuth(prRef);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found") || msg.includes("ENOENT")) {
        emitPluginError(
          "pr-auth-failed",
          `${cliName === "gh" ? "GitHub" : "GitLab"} CLI (${cliName}) is not installed. Install it from ${cliUrl}`,
        );
      }
      emitPluginError("pr-auth-failed", msg);
    }

    console.error(`Fetching ${getMRLabel(prRef)} ${getMRNumberLabel(prRef)} from ${getDisplayRepo(prRef)}...`);
    try {
      const pr = await fetchPR(prRef);
      rawPatch = pr.rawPatch;
      gitRef = `${getMRLabel(prRef)} ${getMRNumberLabel(prRef)}`;
      prMetadata = pr.metadata;
    } catch (err) {
      emitPluginError("pr-fetch-failed", err instanceof Error ? err.message : `Failed to fetch ${getMRLabel(prRef)} ${getMRNumberLabel(prRef)}`);
    }

    if (useLocal && prMetadata) {
      let localPath: string | undefined;
      let sessionDir: string | undefined;
      try {
        const repoDir = process.cwd();
        const identifier = prMetadata.platform === "github"
          ? `${prMetadata.owner}-${prMetadata.repo}-${prMetadata.number}`
          : `${prMetadata.projectPath.replace(/\//g, "-")}-${prMetadata.iid}`;
        const suffix = Math.random().toString(36).slice(2, 8);
        sessionDir = path.join(realpathSync(tmpdir()), `plannotator-pr-${identifier}-${suffix}`);
        const prNumber = prMetadata.platform === "github" ? prMetadata.number : prMetadata.iid;
        localPath = path.join(sessionDir, "pool", `pr-${prNumber}`);
        const fetchRefStr = prMetadata.platform === "github"
          ? `refs/pull/${prMetadata.number}/head`
          : `refs/merge-requests/${prMetadata.iid}/head`;

        if (prMetadata.baseBranch.includes("..") || prMetadata.baseBranch.startsWith("-")) throw new Error(`Invalid base branch: ${prMetadata.baseBranch}`);
        if (!/^[0-9a-f]{40,64}$/i.test(prMetadata.baseSha)) throw new Error(`Invalid base SHA: ${prMetadata.baseSha}`);

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
            const sshHost = remoteUrl.match(/^[^@]+@([^:]+):/)?.[1];
            const httpsHost = (() => { try { return new URL(remoteUrl).hostname; } catch { return null; } })();
            const remoteHost = (sshHost || httpsHost || "").toLowerCase();
            const prHost = prMetadata.host.toLowerCase();
            isSameRepo = repoMatches && remoteHost === prHost;
          }
        } catch {}

        if (isSameRepo) {
          console.error("Fetching PR branch and creating local worktree...");
          await fetchRef(gitRuntime, prMetadata.baseBranch, { cwd: repoDir });
          await ensureObjectAvailable(gitRuntime, prMetadata.baseSha, { cwd: repoDir });
          await fetchRef(gitRuntime, fetchRefStr, { cwd: repoDir });

          await createWorktree(gitRuntime, {
            ref: "FETCH_HEAD",
            path: localPath,
            detach: true,
            cwd: repoDir,
          });

          // worktreePool is assigned after registration; read it at cleanup
          // time so early exits still fall back to removing localPath.
          worktreeCleanup = registerProcessCleanup(() => cleanupWorktreeSession(
            repoDir,
            sessionDir,
            worktreePool,
            localPath,
          ));
        } else {
          const prRepo = prMetadata.platform === "github"
            ? `${prMetadata.owner}/${prMetadata.repo}`
            : prMetadata.projectPath;
          if (/^-/.test(prRepo)) throw new Error(`Invalid repository identifier: ${prRepo}`);
          const cli = prMetadata.platform === "github" ? "gh" : "glab";
          const host = prMetadata.host;
          const isDefaultHost = host === "github.com" || host === "gitlab.com";
          const cloneEnv = isDefaultHost ? undefined : {
            ...process.env,
            ...(prMetadata.platform === "github" ? { GH_HOST: host } : { GITLAB_HOST: host }),
          };

          console.error(`Cloning ${prRepo} (shallow)...`);
          const cloneResult = Bun.spawnSync(
            [cli, "repo", "clone", prRepo, localPath, "--", "--depth=1", "--no-checkout"],
            { stderr: "pipe", env: cloneEnv },
          );
          if (cloneResult.exitCode !== 0) {
            throw new Error(`${cli} repo clone failed: ${new TextDecoder().decode(cloneResult.stderr).trim()}`);
          }

          console.error("Fetching PR branch...");
          const fetchResult = Bun.spawnSync(
            ["git", "fetch", "--depth=200", "origin", fetchRefStr],
            { cwd: localPath, stderr: "pipe" },
          );
          if (fetchResult.exitCode !== 0) throw new Error(`Failed to fetch PR head ref: ${new TextDecoder().decode(fetchResult.stderr).trim()}`);

          const checkoutResult = Bun.spawnSync(["git", "checkout", "FETCH_HEAD"], { cwd: localPath, stderr: "pipe" });
          if (checkoutResult.exitCode !== 0) {
            throw new Error(`git checkout FETCH_HEAD failed: ${new TextDecoder().decode(checkoutResult.stderr).trim()}`);
          }

          const baseFetch = Bun.spawnSync(["git", "fetch", "--depth=200", "origin", prMetadata.baseSha], { cwd: localPath, stderr: "pipe" });
          if (baseFetch.exitCode !== 0) console.error("Warning: failed to fetch baseSha, agent diffs may be inaccurate");
          Bun.spawnSync(["git", "branch", "--", prMetadata.baseBranch, prMetadata.baseSha], { cwd: localPath, stderr: "pipe" });
          Bun.spawnSync(["git", "update-ref", `refs/remotes/origin/${prMetadata.baseBranch}`, prMetadata.baseSha], { cwd: localPath, stderr: "pipe" });

          worktreeCleanup = registerProcessCleanup(() => {
            try { rmSync(sessionDir, { recursive: true, force: true }); } catch {}
          });
        }

        agentCwd = localPath;
        worktreePool = createWorktreePool(
          { sessionDir, repoDir, isSameRepo },
          { path: localPath, prUrl: prMetadata.url, number: prNumber, ready: true },
        );

        console.error(`Local checkout ready at ${localPath}`);
      } catch (err) {
        console.error("Warning: --local failed, falling back to remote diff");
        console.error(err instanceof Error ? err.message : String(err));
        if (worktreeCleanup) {
          worktreeCleanup();
        } else if (sessionDir) {
          try { rmSync(sessionDir, { recursive: true, force: true }); } catch {}
        }
        agentCwd = undefined;
        worktreePool = undefined;
        worktreeCleanup = undefined;
      }
    }
  } else {
    const config = loadConfig();
    const diffResult = await prepareLocalReviewDiff({
      vcsType: request.vcsType ?? reviewArgs.vcsType,
      requestedDiffType: request.diffType as DiffType | undefined,
      requestedBase: request.defaultBranch,
      configuredDiffType: resolveDefaultDiffType(config),
      hideWhitespace: config.diffOptions?.hideWhitespace ?? false,
    });
    gitContext = diffResult.gitContext;
    initialDiffType = diffResult.diffType;
    initialBase = diffResult.base;
    rawPatch = diffResult.rawPatch;
    gitRef = diffResult.gitRef;
    diffError = diffResult.error;
  }

  const effectiveSharingEnabled = request.sharingEnabled ?? sharingEnabled;
  const effectiveShareBaseUrl = request.shareBaseUrl ?? shareBaseUrl;
  const reviewProject = (await detectProjectName()) ?? "_unknown";

  const server = await startReviewServer({
    rawPatch,
    gitRef,
    error: diffError,
    origin,
    diffType: gitContext ? (initialDiffType ?? "unstaged") : undefined,
    gitContext,
    initialBase,
    prMetadata,
    agentCwd,
    worktreePool,
    sharingEnabled: effectiveSharingEnabled,
    shareBaseUrl: effectiveShareBaseUrl,
    htmlContent: await getReviewHtmlContent(),
    opencodeClient: request.availableAgents
      ? { app: { agents: async () => ({ data: request.availableAgents }) } }
      : undefined,
    onCleanup: worktreeCleanup,
    onReady: async (url, isRemote, port) => {
      handleReviewServerReady(url, isRemote, port);

      if (isRemote && effectiveSharingEnabled && rawPatch) {
        await writeRemoteShareLink(rawPatch, effectiveShareBaseUrl, "review changes", "diff only").catch(() => {});
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
    label: isPRMode && prMetadata
      ? `plugin-${getMRLabel(prMetadata).toLowerCase()}-review-${getDisplayRepo(prMetadata)}${getMRNumberLabel(prMetadata)}`
      : `plugin-review-${origin}-${reviewProject}`,
  });

  const session = pluginSessionInfo("review", server);
  emitPluginSessionReady(session);
  const result = await server.waitForDecision();
  await Bun.sleep(1500);
  server.stop();

  console.log(JSON.stringify(createPluginSuccessResponse(result, session)));
}

if (args[0] === "plugin") {
  const command = args[1];
  if (command === "capabilities") {
    console.log(JSON.stringify(getPluginCapabilities()));
    process.exit(0);
  }

  if (command === "plan") {
    await runPluginPlanCommand();
    process.exit(0);
  }

  if (command === "review") {
    await runPluginReviewCommand();
    process.exit(0);
  }

  if (command === "annotate" || command === "annotate-last") {
    await runPluginAnnotateCommand(command === "annotate-last" ? "annotate-last" : "annotate");
    process.exit(0);
  }

  if (command === "archive") {
    await runPluginArchiveCommand();
    process.exit(0);
  }

  console.log(
    JSON.stringify(
      createPluginErrorResponse(
        "unknown-plugin-command",
        command ? `Unknown plugin command: ${command}` : "Missing plugin command",
      ),
    ),
  );
  process.exit(1);
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

          worktreeCleanup = registerProcessCleanup(() => cleanupWorktreeSession(
            repoDir,
            sessionDir,
            worktreePool,
            localPath,
          ));
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

          worktreeCleanup = registerProcessCleanup(() => {
            try { rmSync(sessionDir, { recursive: true, force: true }); } catch {}
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
        if (worktreeCleanup) {
          worktreeCleanup();
        } else if (sessionDir) {
          try { rmSync(sessionDir, { recursive: true, force: true }); } catch {}
        }
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
    htmlContent: await getReviewHtmlContent(),
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
    htmlContent: await getPlanHtmlContent(),
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
  const codexThreadId = process.env.CODEX_THREAD_ID;
  const isCodex = !!codexThreadId;

  let lastMessage: RenderedMessage | null = null;

  if (codexThreadId) {
    // Codex path: find rollout by thread ID
    if (process.env.PLANNOTATOR_DEBUG) {
      console.error(`[DEBUG] Codex detected, thread ID: ${codexThreadId}`);
    }
    const rolloutPath = findCodexRolloutByThreadId(codexThreadId);
    if (rolloutPath) {
      if (process.env.PLANNOTATOR_DEBUG) {
        console.error(`[DEBUG] Rollout: ${rolloutPath}`);
      }
      const msg = getLastCodexMessage(rolloutPath);
      if (msg) {
        lastMessage = { messageId: codexThreadId, text: msg.text, lineNumbers: [] };
      }
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
        lastMessage = getLastRenderedMessage(logPath);
        if (lastMessage) return;
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
    console.error("No rendered assistant message found in session logs.");
    process.exit(1);
  }

  if (process.env.PLANNOTATOR_DEBUG) {
    console.error(`[DEBUG] Found message ${lastMessage.messageId} (${lastMessage.text.length} chars)`);
  }

  const annotateProject = (await detectProjectName()) ?? "_unknown";

  const server = await startAnnotateServer({
    markdown: lastMessage.text,
    filePath: "last-message",
    origin: detectedOrigin,
    mode: "annotate-last",
    sharingEnabled,
    shareBaseUrl,
    pasteApiUrl,
    gate: gateFlag,
    htmlContent: await getPlanHtmlContent(),
    onReady: async (url, isRemote, port) => {
      handleAnnotateServerReady(url, isRemote, port);

      if (isRemote && sharingEnabled) {
        await writeRemoteShareLink(lastMessage.text, shareBaseUrl, "annotate", "message only").catch(() => {});
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
    htmlContent: await getPlanHtmlContent(),
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
    htmlContent: await getPlanHtmlContent(),
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
    htmlContent: await getPlanHtmlContent(),
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

  const msg = getLastCopilotMessage(sessionDir);
  if (!msg) {
    console.error("No assistant message found in Copilot CLI session.");
    process.exit(1);
  }

  if (process.env.PLANNOTATOR_DEBUG) {
    console.error(`[DEBUG] Found message (${msg.text.length} chars)`);
  }

  const annotateProject = (await detectProjectName()) ?? "_unknown";

  const server = await startAnnotateServer({
    markdown: msg.text,
    filePath: "last-message",
    origin: "copilot-cli",
    mode: "annotate-last",
    sharingEnabled,
    shareBaseUrl,
    gate: gateFlag,
    htmlContent: await getPlanHtmlContent(),
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
      htmlContent: await getPlanHtmlContent(),
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
    htmlContent: await getPlanHtmlContent(),
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
