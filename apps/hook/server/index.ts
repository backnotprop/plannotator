/**
 * Plannotator CLI for Claude Code
 *
 * Supports three modes:
 *
 * 1. Plan Review (default, no args):
 *    - Spawned by ExitPlanMode hook
 *    - Reads hook event from stdin, extracts plan content
 *    - Serves UI, returns approve/deny decision to stdout
 *
 * 2. Code Review (`plannotator review`):
 *    - Triggered by /plannotator-review slash command
 *    - Runs git diff, opens review UI
 *    - Outputs feedback to stdout (captured by slash command)
 *
 * 3. Markdown Annotation (`plannotator annotate <file.md>`):
 *    - Triggered by /plannotator-annotate slash command
 *    - Opens any markdown file for annotation
 *    - Outputs feedback to stdout for Claude to apply corrections
 *
 * Environment variables:
 *   PLANNOTATOR_REMOTE - Set to "1" or "true" for remote mode (preferred)
 *   PLANNOTATOR_PORT   - Fixed port to use (default: random locally, 19432 for remote)
 */

import path from "path";
import {
  startPlannotatorServer,
  handleServerReady,
} from "@plannotator/server";
import {
  startReviewServer,
  handleReviewServerReady,
} from "@plannotator/server/review";
import { startAnnotateServer } from "@plannotator/server/annotate";
import { getGitContext, runGitDiff } from "@plannotator/server/git";

// Embed the built HTML at compile time
// @ts-ignore - Bun import attribute for text
import planHtml from "../dist/index.html" with { type: "text" };
const planHtmlContent = planHtml as unknown as string;

// @ts-ignore - Bun import attribute for text
import reviewHtml from "../dist/review.html" with { type: "text" };
const reviewHtmlContent = reviewHtml as unknown as string;

// Check for subcommand
const args = process.argv.slice(2);

// Check if URL sharing is enabled (default: true)
const sharingEnabled = process.env.PLANNOTATOR_SHARE !== "disabled";

if (args[0] === "review") {
  // ============================================
  // CODE REVIEW MODE
  // ============================================

  // Get git context (branches, available diff options)
  const gitContext = await getGitContext();

  // Run git diff HEAD (uncommitted changes - default)
  const { patch: rawPatch, label: gitRef } = await runGitDiff(
    "uncommitted",
    gitContext.defaultBranch
  );

  // Start review server (even if empty - user can switch diff types)
  const server = await startReviewServer({
    rawPatch,
    gitRef,
    origin: "claude-code",
    diffType: "uncommitted",
    gitContext,
    sharingEnabled,
    htmlContent: reviewHtmlContent,
    onReady: handleReviewServerReady,
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

} else if (args[0] === "annotate") {
  // ============================================
  // MARKDOWN ANNOTATION MODE
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

  // Resolve path - use PLANNOTATOR_CWD if set (original working directory before script cd'd)
  const originalCwd = process.env.PLANNOTATOR_CWD || process.cwd();

  // Debug: log path resolution (visible in stderr, won't interfere with stdout JSON)
  if (process.env.PLANNOTATOR_DEBUG) {
    console.error(`[DEBUG] Original CWD: ${originalCwd}`);
    console.error(`[DEBUG] File path arg: ${filePath}`);
  }

  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(originalCwd, filePath);

  if (process.env.PLANNOTATOR_DEBUG) {
    console.error(`[DEBUG] Resolved path: ${absolutePath}`);
  }

  // Read file
  const file = Bun.file(absolutePath);
  if (!(await file.exists())) {
    console.error(`File not found: ${absolutePath}`);
    process.exit(1);
  }
  const markdown = await file.text();

  // Start annotation server (reuses plan UI)
  const server = await startAnnotateServer({
    markdown,
    filePath: absolutePath,
    origin: "claude-code",
    sharingEnabled,
    htmlContent: planHtmlContent,
    onReady: handleServerReady,
  });

  const result = await server.waitForDecision();

  // Give browser time to receive response and update UI
  await Bun.sleep(1500);

  // Cleanup
  server.stop();

  // Output feedback markdown (captured by slash command)
  console.log(result.feedback || "No annotations provided.");
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

  // Start the plan review server
  const server = await startPlannotatorServer({
    plan: planContent,
    origin: "claude-code",
    permissionMode,
    sharingEnabled,
    htmlContent: planHtmlContent,
    onReady: (url, isRemote, port) => {
      handleServerReady(url, isRemote, port);
    },
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
            message: result.feedback || "Plan changes requested",
          },
        },
      })
    );
  }

  process.exit(0);
}
