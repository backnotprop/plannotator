/**
 * Plannotator CLI for Claude Code
 *
 * Supports four modes:
 *
 * 1. Plan Review (default, no args):
 *    - Spawned by ExitPlanMode hook
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
 * 4. Sessions (`plannotator sessions`):
 *    - Lists active Plannotator server sessions
 *    - `--open [N]` reopens a session in the browser
 *    - `--clean` removes stale session files
 *
 * Global flags:
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
import { getGitContext, runGitDiff } from "@plannotator/server/git";
import { parsePRUrl, checkGhAuth, fetchPR } from "@plannotator/server/pr";
import { writeRemoteShareLink } from "@plannotator/server/share-url";
import { resolveMarkdownFile } from "@plannotator/server/resolve-file";
import { registerSession, unregisterSession, listSessions } from "@plannotator/server/sessions";
import { openBrowser } from "@plannotator/server/browser";
import { detectProjectName } from "@plannotator/server/project";
import { planDenyFeedback } from "@plannotator/shared/feedback-templates";
import { findSessionLogsForCwd, getLastRenderedMessage, type RenderedMessage } from "./session-log";
import { findCodexRolloutByThreadId, getLastCodexMessage } from "./codex-session";
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

// Ensure session cleanup on exit
process.on("exit", () => unregisterSession());

// Check if URL sharing is enabled (default: true)
const sharingEnabled = process.env.PLANNOTATOR_SHARE !== "disabled";

// Custom share portal URL for self-hosting
const shareBaseUrl = process.env.PLANNOTATOR_SHARE_URL || undefined;

// Paste service URL for short URL sharing
const pasteApiUrl = process.env.PLANNOTATOR_PASTE_URL || undefined;

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
  let gitContext: Awaited<ReturnType<typeof getGitContext>> | undefined;
  let prMetadata: Awaited<ReturnType<typeof fetchPR>>["metadata"] | undefined;

  if (isPRMode) {
    // --- PR Review Mode ---
    const prRef = parsePRUrl(urlArg);
    if (!prRef) {
      console.error(`Invalid PR URL: ${urlArg}`);
      console.error("Supported formats: https://github.com/owner/repo/pull/123");
      process.exit(1);
    }

    try {
      await checkGhAuth();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found") || msg.includes("ENOENT")) {
        console.error("GitHub CLI (gh) is not installed.");
        console.error("Install it from https://cli.github.com");
      } else {
        console.error(msg);
      }
      process.exit(1);
    }

    console.error(`Fetching PR #${prRef.number} from ${prRef.owner}/${prRef.repo}...`);
    try {
      const pr = await fetchPR(prRef);
      rawPatch = pr.rawPatch;
      gitRef = `PR #${prRef.number}`;
      prMetadata = pr.metadata;
    } catch (err) {
      console.error(err instanceof Error ? err.message : "Failed to fetch PR");
      process.exit(1);
    }
  } else {
    // --- Local Review Mode ---
    gitContext = await getGitContext();
    const diffResult = await runGitDiff("uncommitted", gitContext.defaultBranch);
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
    origin: "claude-code",
    diffType: isPRMode ? undefined : "uncommitted",
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
    label: isPRMode ? `pr-review-${prMetadata!.owner}/${prMetadata!.repo}#${prMetadata!.number}` : `review-${reviewProject}`,
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
    console.error("Usage: plannotator annotate <file.md>");
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

  // Smart file resolution: exact path, case-insensitive relative, or bare filename search
  const resolved = await resolveMarkdownFile(filePath, projectRoot);

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

  const absolutePath = resolved.path;
  console.error(`Resolved: ${absolutePath}`);
  const markdown = await Bun.file(absolutePath).text();

  const annotateProject = (await detectProjectName()) ?? "_unknown";

  // Start the annotate server (reuses plan editor HTML)
  const server = await startAnnotateServer({
    markdown,
    filePath: absolutePath,
    origin: "claude-code",
    sharingEnabled,
    shareBaseUrl,
    htmlContent: planHtmlContent,
    onReady: async (url, isRemote, port) => {
      handleAnnotateServerReady(url, isRemote, port);

      if (isRemote && sharingEnabled) {
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
    label: `annotate-${path.basename(absolutePath)}`,
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
    // Claude Code path: find session logs by CWD
    const candidates = findSessionLogsForCwd(projectRoot);

    if (process.env.PLANNOTATOR_DEBUG) {
      console.error(`[DEBUG] Project root: ${projectRoot}`);
      console.error(`[DEBUG] Candidates: ${candidates.join(", ")}`);
    }

    for (const logPath of candidates) {
      if (process.env.PLANNOTATOR_DEBUG) {
        console.error(`[DEBUG] Trying: ${logPath}`);
      }
      lastMessage = getLastRenderedMessage(logPath);
      if (lastMessage) break;
    }
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
    origin: isCodex ? "codex" : "claude-code",
    mode: "annotate-last",
    sharingEnabled,
    shareBaseUrl,
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
    origin: "claude-code",
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
