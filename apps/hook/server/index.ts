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
import { writeRemoteShareLink } from "@plannotator/server/share-url";
import { resolveMarkdownFile } from "@plannotator/server/resolve-file";
import { registerSession, unregisterSession, listSessions } from "@plannotator/server/sessions";
import { openBrowser } from "@plannotator/server/browser";
import { detectProjectName } from "@plannotator/server/project";
import { planDenyFeedback, planApproveWithNotesFeedback } from "@plannotator/shared/feedback-templates";
import {
  extractSessionId,
  extractQuestions,
  stripPlanMetadata,
  generateSessionId,
  embedSessionId,
} from "@plannotator/shared/questions";
import {
  loadSession,
  createSession,
  recordIteration,
  getPreviousIterations,
  cleanupSessions,
} from "@plannotator/server/review-session";
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

  // Get git context (branches, available diff options)
  const gitContext = await getGitContext();

  // Run git diff HEAD (uncommitted changes - default)
  const { patch: rawPatch, label: gitRef, error: diffError } = await runGitDiff(
    "uncommitted",
    gitContext.defaultBranch
  );

  const reviewProject = (await detectProjectName()) ?? "_unknown";

  // Start review server (even if empty - user can switch diff types)
  const server = await startReviewServer({
    rawPatch,
    gitRef,
    error: diffError,
    origin: "claude-code",
    diffType: "uncommitted",
    gitContext,
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
    label: `review-${reviewProject}`,
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
    console.log("\nThe reviewer has identified issues above. You must address all of them.");
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

  // --- Session tracking for context persistence ---
  // Extract or create a session ID so we can accumulate context across deny/revise cycles
  let sessionId = extractSessionId(planContent);
  const isReturningSession = !!sessionId;

  if (!sessionId) {
    sessionId = generateSessionId();
  }

  // Extract any embedded clarification questions from the plan
  const embeddedQuestions = extractQuestions(planContent);

  // Strip metadata from the plan so the user sees clean markdown
  const cleanPlan = stripPlanMetadata(planContent);

  // Load previous iterations for context
  const previousIterations = isReturningSession
    ? getPreviousIterations(sessionId)
    : [];

  // Ensure session exists on disk
  if (!isReturningSession) {
    createSession(sessionId, planProject, "");
  }

  // Periodically clean up old sessions (non-blocking)
  cleanupSessions();

  // Start the plan review server (use clean plan without metadata comments)
  const server = await startPlannotatorServer({
    plan: cleanPlan,
    origin: "claude-code",
    permissionMode,
    sharingEnabled,
    shareBaseUrl,
    pasteApiUrl,
    htmlContent: planHtmlContent,
    sessionId,
    previousIterations,
    questions: embeddedQuestions,
    onReady: async (url, isRemote, port) => {
      handleServerReady(url, isRemote, port);

      if (isRemote && sharingEnabled) {
        await writeRemoteShareLink(cleanPlan, shareBaseUrl, "review the plan", "plan only").catch(() => {});
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

  // Record this iteration in the session store for context persistence
  recordIteration(sessionId, {
    plan: cleanPlan,
    feedback: result.feedback || "",
    questions: embeddedQuestions,
    answers: result.answers || [],
    decision: result.approved ? "approved" : "denied",
  });

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
            // Pass through user annotations as implementation notes when approving with feedback
            ...(result.feedback && {
              message: planApproveWithNotesFeedback(result.feedback, {
                clarificationQuestions: embeddedQuestions,
                clarificationAnswers: result.answers || [],
              }),
            }),
            // If no annotations but questions were answered, still include Q&A context
            ...(!result.feedback && embeddedQuestions.length > 0 && result.answers?.length && {
              message: planApproveWithNotesFeedback("", {
                clarificationQuestions: embeddedQuestions,
                clarificationAnswers: result.answers,
              }),
            }),
          },
        },
      })
    );
  } else {
    // Include session ID in deny feedback so the AI embeds it in the next plan submission
    const sessionHint = `\n\nIMPORTANT: Include this session marker at the top of your next plan so review context is preserved:\n<!-- plannotator:session ${sessionId} -->`;

    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: "deny",
            message: planDenyFeedback(
              (result.feedback || "") + sessionHint,
              "ExitPlanMode",
              {
                previousIterations,
                clarificationQuestions: embeddedQuestions,
                clarificationAnswers: result.answers || [],
              },
            ),
          },
        },
      })
    );
  }

  process.exit(0);
}
