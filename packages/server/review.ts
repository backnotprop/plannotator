/**
 * Code Review Server
 *
 * Provides a server implementation for code review with git diff rendering.
 * Follows the same patterns as the plan server.
 *
 * Environment variables:
 *   PLANNOTATOR_REMOTE - Set to "1" or "true" for remote/devcontainer mode
 *   PLANNOTATOR_PORT   - Fixed port to use (default: random locally, 19432 for remote)
 */

import { mkdirSync } from "fs";
import { isRemoteSession, getServerPort } from "./remote";
import { openBrowser } from "./browser";
import { type DiffType, type GitContext, runGitDiff } from "./git";
import { getRepoInfo } from "./repo";

// Re-export utilities
export { isRemoteSession, getServerPort } from "./remote";
export { openBrowser } from "./browser";
export { type DiffType, type DiffOption, type GitContext } from "./git";

// --- Types ---

export interface ReviewServerOptions {
  /** Raw git diff patch string */
  rawPatch: string;
  /** Git ref used for the diff (e.g., "HEAD", "main..HEAD", "--staged") */
  gitRef: string;
  /** HTML content to serve for the UI */
  htmlContent: string;
  /** Origin identifier for UI customization */
  origin?: "opencode" | "claude-code";
  /** Current diff type being displayed */
  diffType?: DiffType;
  /** Git context with branch info and available diff options */
  gitContext?: GitContext;
  /** Whether URL sharing is enabled (default: true) */
  sharingEnabled?: boolean;
  /** Called when server starts with the URL, remote status, and port */
  onReady?: (url: string, isRemote: boolean, port: number) => void;
  /** OpenCode client for querying available agents (OpenCode only) */
  opencodeClient?: {
    app: {
      agents: (options?: object) => Promise<{ data?: Array<{ name: string; description?: string; mode: string; hidden?: boolean }> }>;
    };
  };
}

export interface ReviewServerResult {
  /** The port the server is running on */
  port: number;
  /** The full URL to access the server */
  url: string;
  /** Whether running in remote mode */
  isRemote: boolean;
  /** Wait for user feedback submission */
  waitForDecision: () => Promise<{
    feedback: string;
    annotations: unknown[];
    agentSwitch?: string;
  }>;
  /** Stop the server */
  stop: () => void;
}

// --- Server Implementation ---

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 500;

/**
 * Start the Code Review server
 *
 * Handles:
 * - Remote detection and port configuration
 * - API routes (/api/diff, /api/feedback)
 * - Port conflict retries
 */
export async function startReviewServer(
  options: ReviewServerOptions
): Promise<ReviewServerResult> {
  const { htmlContent, origin, gitContext, sharingEnabled = true, onReady } = options;

  // Mutable state for diff switching
  let currentPatch = options.rawPatch;
  let currentGitRef = options.gitRef;
  let currentDiffType: DiffType = options.diffType || "uncommitted";

  const isRemote = isRemoteSession();
  const configuredPort = getServerPort();

  // Detect repo info (cached for this session)
  const repoInfo = await getRepoInfo();

  // Decision promise
  let resolveDecision: (result: {
    feedback: string;
    annotations: unknown[];
    agentSwitch?: string;
  }) => void;
  const decisionPromise = new Promise<{
    feedback: string;
    annotations: unknown[];
    agentSwitch?: string;
  }>((resolve) => {
    resolveDecision = resolve;
  });

  // Start server with retry logic
  let server: ReturnType<typeof Bun.serve> | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      server = Bun.serve({
        port: configuredPort,

        async fetch(req) {
          const url = new URL(req.url);

          // API: Get diff content
          if (url.pathname === "/api/diff" && req.method === "GET") {
            return Response.json({
              rawPatch: currentPatch,
              gitRef: currentGitRef,
              origin,
              diffType: currentDiffType,
              gitContext,
              sharingEnabled,
              repoInfo,
            });
          }

          // API: Switch diff type
          if (url.pathname === "/api/diff/switch" && req.method === "POST") {
            try {
              const body = (await req.json()) as { diffType: DiffType };
              const newDiffType = body.diffType;

              if (!newDiffType) {
                return Response.json(
                  { error: "Missing diffType" },
                  { status: 400 }
                );
              }

              // Run the new diff
              const defaultBranch = gitContext?.defaultBranch || "main";
              const result = await runGitDiff(newDiffType, defaultBranch);

              // Update state
              currentPatch = result.patch;
              currentGitRef = result.label;
              currentDiffType = newDiffType;

              return Response.json({
                rawPatch: currentPatch,
                gitRef: currentGitRef,
                diffType: currentDiffType,
              });
            } catch (err) {
              const message =
                err instanceof Error ? err.message : "Failed to switch diff";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: Serve images (local paths or temp uploads)
          if (url.pathname === "/api/image") {
            const imagePath = url.searchParams.get("path");
            if (!imagePath) {
              return new Response("Missing path parameter", { status: 400 });
            }
            try {
              const file = Bun.file(imagePath);
              if (!(await file.exists())) {
                return new Response("File not found", { status: 404 });
              }
              return new Response(file);
            } catch {
              return new Response("Failed to read file", { status: 500 });
            }
          }

          // API: Upload image -> save to temp -> return path
          if (url.pathname === "/api/upload" && req.method === "POST") {
            try {
              const formData = await req.formData();
              const file = formData.get("file") as File;
              if (!file) {
                return new Response("No file provided", { status: 400 });
              }

              const ext = file.name.split(".").pop() || "png";
              const tempDir = "/tmp/plannotator";
              mkdirSync(tempDir, { recursive: true });
              const tempPath = `${tempDir}/${crypto.randomUUID()}.${ext}`;

              await Bun.write(tempPath, file);
              return Response.json({ path: tempPath });
            } catch (err) {
              const message =
                err instanceof Error ? err.message : "Upload failed";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: Get available agents (OpenCode only)
          if (url.pathname === "/api/agents") {
            if (!options.opencodeClient) {
              return Response.json({ agents: [] });
            }

            try {
              const result = await options.opencodeClient.app.agents({});
              const agents = (result.data ?? [])
                .filter((a) => a.mode === "primary" && !a.hidden)
                .map((a) => ({ id: a.name, name: a.name, description: a.description }));

              return Response.json({ agents });
            } catch {
              return Response.json({ agents: [], error: "Failed to fetch agents" });
            }
          }

          // API: Submit review feedback
          if (url.pathname === "/api/feedback" && req.method === "POST") {
            try {
              const body = (await req.json()) as {
                feedback: string;
                annotations: unknown[];
                agentSwitch?: string;
              };

              resolveDecision({
                feedback: body.feedback || "",
                annotations: body.annotations || [],
                agentSwitch: body.agentSwitch,
              });

              return Response.json({ ok: true });
            } catch (err) {
              const message =
                err instanceof Error ? err.message : "Failed to process feedback";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // Serve embedded HTML for all other routes (SPA)
          return new Response(htmlContent, {
            headers: { "Content-Type": "text/html" },
          });
        },
      });

      break; // Success, exit retry loop
    } catch (err: unknown) {
      const isAddressInUse =
        err instanceof Error && err.message.includes("EADDRINUSE");

      if (isAddressInUse && attempt < MAX_RETRIES) {
        await Bun.sleep(RETRY_DELAY_MS);
        continue;
      }

      if (isAddressInUse) {
        const hint = isRemote ? " (set PLANNOTATOR_PORT to use different port)" : "";
        throw new Error(`Port ${configuredPort} in use after ${MAX_RETRIES} retries${hint}`);
      }

      throw err;
    }
  }

  if (!server) {
    throw new Error("Failed to start server");
  }

  const serverUrl = `http://localhost:${server.port}`;

  // Notify caller that server is ready
  if (onReady) {
    onReady(serverUrl, isRemote, server.port);
  }

  return {
    port: server.port,
    url: serverUrl,
    isRemote,
    waitForDecision: () => decisionPromise,
    stop: () => server.stop(),
  };
}

/**
 * Default behavior: open browser for local sessions
 */
export async function handleReviewServerReady(
  url: string,
  isRemote: boolean,
  _port: number
): Promise<void> {
  if (!isRemote) {
    await openBrowser(url);
  }
}
