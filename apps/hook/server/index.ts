/**
 * Plannotator Ephemeral Server
 *
 * Spawned by ExitPlanMode hook to serve Plannotator UI and handle approve/deny decisions.
 * Uses random port to support multiple concurrent Claude Code sessions.
 *
 * Reads hook event from stdin, extracts plan content, serves UI, returns decision.
 */

import { $ } from "bun";

// Embed the built HTML at compile time
import indexHtml from "../dist/index.html" with { type: "text" };

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

// Promise that resolves when user makes a decision
let resolveDecision: (result: { approved: boolean; feedback?: string }) => void;
const decisionPromise = new Promise<{ approved: boolean; feedback?: string }>(
  (resolve) => { resolveDecision = resolve; }
);

const server = Bun.serve({
  port: 0, // Random available port - critical for multi-instance support

  async fetch(req) {
    const url = new URL(req.url);

    // API: Get plan content
    if (url.pathname === "/api/plan") {
      return Response.json({ plan: planContent });
    }

    // API: Approve plan
    if (url.pathname === "/api/approve" && req.method === "POST") {
      resolveDecision({ approved: true });
      return Response.json({ ok: true });
    }

    // API: Deny with feedback
    if (url.pathname === "/api/deny" && req.method === "POST") {
      try {
        const body = await req.json() as { feedback?: string };
        resolveDecision({ approved: false, feedback: body.feedback || "Plan rejected by user" });
      } catch {
        resolveDecision({ approved: false, feedback: "Plan rejected by user" });
      }
      return Response.json({ ok: true });
    }

    // Serve embedded HTML for all other routes (SPA)
    return new Response(indexHtml, {
      headers: { "Content-Type": "text/html" }
    });
  },
});

// Log to stderr so it doesn't interfere with hook stdout
console.error(`Plannotator server running on http://localhost:${server.port}`);

// Open browser - cross-platform support
  const url = `http://localhost:${server.port}`;
  console.error(`Plannotator server running on ${url}`);

  try {
    const platform = process.platform;
    if (platform === "win32") {
      await $`cmd /c start ${url}`.quiet();
    } else if (platform === "darwin") {
      await $`open ${url}`.quiet();
    } else {
      await $`xdg-open ${url}`.quiet();
    }
  } catch {
    console.error(`Open browser manually: ${url}`);
  }

// Wait for user decision (blocks until approve/deny)
const result = await decisionPromise;

// Give browser time to receive response and update UI
await Bun.sleep(1500);

// Cleanup
server.stop();

// Output JSON for PermissionRequest hook decision control
if (result.approved) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "allow"
      }
    }
  }));
} else {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "deny",
        message: result.feedback || "Plan changes requested"
      }
    }
  }));
}

process.exit(0);
