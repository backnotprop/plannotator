/**
 * Plannotator Ephemeral Server for Claude Code
 *
 * Spawned by ExitPlanMode hook to serve Plannotator UI and handle approve/deny decisions.
 * Supports both local and remote sessions (SSH, devcontainer).
 *
 * Environment variables:
 *   PLANNOTATOR_REMOTE - Set to "1" or "true" for remote mode (preferred)
 *   PLANNOTATOR_PORT   - Fixed port to use (default: random locally, 19432 for remote)
 *   PLANNOTATOR_ORIGIN - Origin identifier (default: "claude-code")
 *
 * Reads hook event from stdin, extracts plan content, serves UI, returns decision.
 */

import {
  startPlannotatorServer,
  handleServerReady,
} from "@plannotator/server";

// Embed the built HTML at compile time
// @ts-ignore - Bun import attribute for text
import indexHtml from "../dist/index.html" with { type: "text" };
const htmlContent = indexHtml as unknown as string;

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

// Start the shared server
const origin = process.env.PLANNOTATOR_ORIGIN || "claude-code";

const server = await startPlannotatorServer({
  plan: planContent,
  origin,
  htmlContent,
  onReady: (url, isRemote) => {
    handleServerReady(url, isRemote, server.port);
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
