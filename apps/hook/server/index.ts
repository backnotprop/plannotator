/**
 * Plannotator CLI for Claude Code & Copilot CLI
 *
 * Supports eight modes:
 *
 * 1. Plan Review (default, no args):
 *    - Spawned by ExitPlanMode hook (Claude Code)
 *    - Reads hook event from stdin, extracts plan content
 *    - Serves UI, returns approve/deny decision to stdout
 *
 * 2. Code Review (`plannotator review`):
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
 *   --browser <name>   - Override which browser to open (e.g. "Google Chrome")
 *
 * Environment variables:
 *   PLANNOTATOR_REMOTE - Set to "1" or "true" for remote mode (preferred)
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
import { type DiffType, getVcsContext, runVcsDiff } from "@plannotator/server/vcs";
import { parsePRUrl, checkPRAuth, fetchPR, getCliName, getCliInstallUrl, getMRLabel, getMRNumberLabel, getDisplayRepo } from "@plannotator/server/pr";
import { writeRemoteShareLink } from "@plannotator/server/share-url";
import { resolveMarkdownFile, hasMarkdownFiles } from "@plannotator/shared/resolve-file";
import { FILE_BROWSER_EXCLUDED } from "@plannotator/shared/reference-common";
import { statSync } from "fs";
import { registerSession, unregisterSession, listSessions } from "@plannotator/server/sessions";
import { openBrowser } from "@plannotator/server/browser";
import { detectProjectName } from "@plannotator/server/project";
import { planDenyFeedback } from "@plannotator/shared/feedback-templates";
import { readImprovementHook } from "@plannotator/shared/improvement-hooks";
import type { Origin } from "@plannotator/shared/agents";
import { findSessionLogsForCwd, resolveSessionLogByPpid, findSessionLogsByAncestorWalk, getLastRenderedMessage, type RenderedMessage } from "./session-log";
import { findCodexRolloutByThreadId, getLastCodexMessage } from "./codex-session";
import { findCopilotPlanContent, findCopilotSessionForCwd, getLastCopilotMessage } from "./copilot-session";
import {
  formatInteractiveNoArgClarification,
  formatTopLevelHelp,
  isInteractiveNoArgInvocation,
  isTopLevelHelpInvocation,
} from "./cli";
import path from "path";

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
// Priority: Codex > Copilot CLI > Claude Code (default fallback)
const detectedOrigin: Origin =
  process.env.CODEX_THREAD_ID ? "codex" :
  process.env.COPILOT_CLI ? "copilot-cli" :
  "claude-code";

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

  const urlArg = args[1];
  const isPRMode = urlArg?.startsWith("http://") || urlArg?.startsWith("https://");

  let rawPatch: string;
  let gitRef: string;
  let diffError: string | undefined;
  let gitContext: Awaited<ReturnType<typeof getVcsContext>> | undefined;
  let prMetadata: Awaited<ReturnType<typeof fetchPR>>["metadata"] | undefined;
  let initialDiffType: DiffType | undefined;

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
  } else {
    // --- Local Review Mode ---
    gitContext = await getVcsContext();
    initialDiffType = gitContext.vcsType === "p4" ? "p4-default" : "uncommitted";
    const diffResult = await runVcsDiff(initialDiffType, gitContext.defaultBranch);
    rawPatch = diffResult.patch;
    gitRef = diffResult.label;
    diffError = diffResult.error;
  }

  const reviewProject = (await detectProjectName()) ?? "_unknown";

  // Start review server (even if empty - user can switch diff types in local mode)
  const server = await startReviewServer({
    rawPatch,
    gitRef,
    error: diffError,
    origin: detectedOrigin,
    diffType: isPRMode ? undefined : (initialDiffType ?? "uncommitted"),
    gitContext,
    prMetadata,
    sharingEnabled,
    shareBaseUrl,
    htmlContent: reviewHtmlContent,
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
  if (result.approved) {
    console.log("Code review completed — no changes requested.");
  } else {
    console.log(result.feedback);
    if (!isPRMode) {
      console.log("\nThe reviewer has identified issues above. You must address all of them.");
    }
  }
  process.exit(0);

} else if (args[0] === "annotate") {
  // ============================================
  // ANNOTATE MODE
  // ============================================

  let filePath = args[1];
  if (!filePath) {
    console.error("Usage: plannotator annotate <file.md | folder/>");
    process.exit(1);
  }

  // Strip @ prefix if present (Claude Code file reference syntax)
  if (filePath.startsWith("@")) {
    filePath = filePath.slice(1);
  }

  // Use PLANNOTATOR_CWD if set (original working directory before script cd'd)
  const projectRoot = process.env.PLANNOTATOR_CWD || process.cwd();

  if (process.env.PLANNOTATOR_DEBUG) {
    console.error(`[DEBUG] Project root: ${projectRoot}`);
    console.error(`[DEBUG] File path arg: ${filePath}`);
  }

  // Check if the argument is a directory (folder annotation mode)
  const resolvedArg = path.resolve(projectRoot, filePath);
  let isFolder = false;
  try {
    isFolder = statSync(resolvedArg).isDirectory();
  } catch {
    // Not a directory, fall through to file resolution
  }

  let markdown: string;
  let absolutePath: string;
  let folderPath: string | undefined;
  let annotateMode: "annotate" | "annotate-folder" = "annotate";

  if (isFolder) {
    // Folder annotation mode
    if (!hasMarkdownFiles(resolvedArg, FILE_BROWSER_EXCLUDED)) {
      console.error(`No markdown files found in ${resolvedArg}`);
      process.exit(1);
    }
    folderPath = resolvedArg;
    absolutePath = resolvedArg;
    markdown = "";
    annotateMode = "annotate-folder";
    console.error(`Folder: ${resolvedArg}`);
  } else {
    // Single file annotation mode
    const resolved = resolveMarkdownFile(filePath, projectRoot);

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

  const annotateProject = (await detectProjectName()) ?? "_unknown";

  // Start the annotate server (reuses plan editor HTML)
  const server = await startAnnotateServer({
    markdown,
    filePath: absolutePath,
    origin: detectedOrigin,
    mode: annotateMode,
    folderPath,
    sharingEnabled,
    shareBaseUrl,
    pasteApiUrl,
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
    label: folderPath ? `annotate-${path.basename(folderPath)}` : `annotate-${path.basename(absolutePath)}`,
  });

  // Wait for user feedback
  const result = await server.waitForDecision();

  // Give browser time to receive response and update UI
  await Bun.sleep(1500);

  // Cleanup
  server.stop();

  // Output feedback (captured by slash command)
  console.log(result.feedback || "No feedback provided.");
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
    // 1. PPID session metadata: ~/.claude/sessions/<ppid>.json gives us the
    //    exact sessionId and original cwd. Deterministic, O(1), no scanning.
    // 2. CWD slug match: existing behavior — works when the shell CWD hasn't
    //    changed from the session's project directory.
    // 3. Ancestor walk: walk up the directory tree trying parent slugs. Handles
    //    the common case where the user `cd`'d deeper into a subdirectory.

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

    // 1. Try PPID-based session metadata (most reliable)
    const ppidLog = resolveSessionLogByPpid();
    tryLogCandidates("PPID session metadata", () => ppidLog ? [ppidLog] : []);

    // 2. Fall back to CWD slug match
    tryLogCandidates("CWD slug match", () => findSessionLogsForCwd(projectRoot));

    // 3. Fall back to ancestor directory walk
    tryLogCandidates("Ancestor walk", () => findSessionLogsByAncestorWalk(projectRoot));
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
    htmlContent: planHtmlContent,
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

  console.log(result.feedback || "No feedback provided.");
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
    const feedback = planDenyFeedback(
      result.feedback || "",
      "exit_plan_mode",
    );
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

  console.log(result.feedback || "No feedback provided.");
  process.exit(0);

} else if (args[0] === "improve-context") {
  // ============================================
  // IMPROVEMENT HOOK CONTEXT INJECTION MODE
  // ============================================
  //
  // Called by PreToolUse hook on EnterPlanMode.
  // Reads the improvement hook file and returns additionalContext.
  // No file = exit 0 silently (passthrough).

  // Must consume stdin (Claude Code hooks deliver event JSON on stdin)
  await Bun.stdin.text();

  const hook = readImprovementHook("enterplanmode-improve");
  if (!hook) process.exit(0);

  const context = [
    "[Plannotator Improvement Hook]",
    "The following corrective instructions were generated from analysis of previous plan denial patterns.",
    "Apply these guidelines when writing your plan:\n",
    hook.content,
  ].join("\n");

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

  let planContent = "";
  let permissionMode = "default";
  try {
    const event = JSON.parse(eventJson);
    planContent = event.tool_input?.plan || "";
    permissionMode = event.permission_mode || "default";
  } catch {
    console.error("Failed to parse hook event from stdin");
    process.exit(1);
  }

  if (!planContent) {
    console.error("No plan content in hook event");
    process.exit(1);
  }

  const planProject = (await detectProjectName()) ?? "_unknown";

  // Start the plan review server
  const server = await startPlannotatorServer({
    plan: planContent,
    origin: detectedOrigin,
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

  // Output JSON for PermissionRequest hook decision control
  if (result.approved) {
    // Build updatedPermissions to preserve the current permission mode
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
            message: planDenyFeedback(result.feedback || "", "ExitPlanMode"),
          },
        },
      })
    );
  }

  process.exit(0);
}
