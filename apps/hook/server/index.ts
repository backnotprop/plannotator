/**
 * Plannotator Ephemeral Server
 *
 * Spawned by ExitPlanMode hook to serve Plannotator UI and handle approve/deny decisions.
 * Supports both local and SSH remote sessions.
 *
 * Environment variables:
 *   PLANNOTATOR_PORT - Fixed port to use (default: random locally, 19432 over SSH)
 *
 * Reads hook event from stdin, extracts plan content, serves UI, returns decision.
 */

import { $ } from "bun";

// Embed the built HTML at compile time
import indexHtml from "../dist/index.html" with { type: "text" };

// --- SSH Detection and Port Configuration ---

const DEFAULT_SSH_PORT = 19432;

function isSSHSession(): boolean {
  // SSH_TTY is set when SSH allocates a pseudo-terminal
  // SSH_CONNECTION contains "client_ip client_port server_ip server_port"
  return !!(process.env.SSH_TTY || process.env.SSH_CONNECTION);
}

function getServerPort(): number {
  // Explicit port from environment takes precedence
  const envPort = process.env.PLANNOTATOR_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) {
      return parsed;
    }
    console.error(`Warning: Invalid PLANNOTATOR_PORT "${envPort}", using default`);
  }

  // Over SSH, use fixed port for port forwarding; locally use random
  return isSSHSession() ? DEFAULT_SSH_PORT : 0;
}

const isRemote = isSSHSession();
const configuredPort = getServerPort();

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

// --- Server with port conflict handling ---

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 500;

async function startServer(): Promise<ReturnType<typeof Bun.serve>> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return Bun.serve({
        port: configuredPort,

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
    } catch (err: unknown) {
      const isAddressInUse = err instanceof Error && err.message.includes("EADDRINUSE");
      if (isAddressInUse && attempt < MAX_RETRIES) {
        console.error(`Port ${configuredPort} in use, retrying in ${RETRY_DELAY_MS}ms... (${attempt}/${MAX_RETRIES})`);
        await Bun.sleep(RETRY_DELAY_MS);
        continue;
      }
      if (isAddressInUse) {
        console.error(`\nError: Port ${configuredPort} is already in use after ${MAX_RETRIES} retries.`);
        if (isRemote) {
          console.error(`Another Plannotator session may be running.`);
          console.error(`To use a different port, set PLANNOTATOR_PORT environment variable.\n`);
        }
        process.exit(1);
      }
      throw err;
    }
  }
  throw new Error("Unreachable");
}

const server = await startServer();

// --- Conditional browser opening and messaging ---

const serverUrl = `http://localhost:${server.port}`;
console.error(`\nPlannotator server running on ${serverUrl}`);

if (isRemote) {
  // SSH session: print helpful setup instructions
  console.error(`\n[SSH Remote Session Detected]`);
  console.error(`Add this to your local ~/.ssh/config to access Plannotator:\n`);
  console.error(`  Host your-server-alias`);
  console.error(`    LocalForward ${server.port} localhost:${server.port}\n`);
  console.error(`Then open ${serverUrl} in your local browser.\n`);
} else {
  // Local session: try to open browser (cross-platform)
  try {
    const platform = process.platform;
    if (platform === "win32") {
      await $`cmd /c start ${serverUrl}`.quiet();
    } else if (platform === "darwin") {
      await $`open ${serverUrl}`.quiet();
    } else {
      await $`xdg-open ${serverUrl}`.quiet();
    }
  } catch {
    console.error(`Open browser manually: ${serverUrl}`);
  }
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
