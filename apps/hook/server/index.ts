/**
 * Plannotator CLI for Claude Code
 *
 * Supports two modes:
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

// Embed the built HTML at compile time
// @ts-ignore - Bun import attribute for text
import planHtml from "../dist/index.html" with { type: "text" };
const planHtmlContent = planHtml as unknown as string;

// @ts-ignore - Bun import attribute for text
import reviewHtml from "../dist/review.html" with { type: "text" };
const reviewHtmlContent = reviewHtml as unknown as string;

// Check for subcommand
const args = process.argv.slice(2);

if (args[0] === "review") {
  // ============================================
  // CODE REVIEW MODE
  // ============================================

  // Run git diff to get unstaged changes
  const proc = Bun.spawn(["git", "diff"], { stdout: "pipe", stderr: "pipe" });
  const rawPatch = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  if (stderr) {
    console.error(stderr.trim());
  }

  if (!rawPatch.trim()) {
    console.log("No changes to review.");
    process.exit(0);
  }

  // Start review server
  const server = await startReviewServer({
    rawPatch,
    gitRef: "working tree",
    origin: "claude-code",
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

} else {
  // ============================================
  // PLAN REVIEW MODE (default)
  // ============================================

  // Read hook event from stdin
  const eventJson = await Bun.stdin.text();

  let planContent = "";
  try {
    const event = JSON.parse(eventJson);
    planContent = event.tool_input?.plan || "";
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
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: "allow",
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
