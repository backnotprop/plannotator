/**
 * Plannotator Shared Server
 *
 * Provides a consistent server implementation for both Claude Code and OpenCode plugins.
 *
 * Environment variables:
 *   PLANNOTATOR_REMOTE - Set to "1" or "true" for remote/devcontainer mode
 *   PLANNOTATOR_PORT   - Fixed port to use (default: random locally, 19432 for remote)
 *   PLANNOTATOR_ORIGIN - Origin identifier ("claude-code" or "opencode")
 */

import { mkdirSync } from "fs";
import { isRemoteSession, getServerPort } from "./remote";
import { openBrowser } from "./browser";
import {
  detectObsidianVaults,
  saveToObsidian,
  saveToBear,
  type ObsidianConfig,
  type BearConfig,
} from "./integrations";
import {
  generateSlug,
  savePlan,
  saveAnnotations,
  saveFinalSnapshot,
  extractFirstHeading,
} from "./storage";
import {
  listVersions,
  saveVersion,
  loadVersion,
  getLatestVersion,
} from "./planHistory";
import { parseMarkdownToBlocks, diffBlocks, diffSummary } from "@plannotator/core";

// --- Version Tracking ---
// Track plan versions by title (H1) within a session
const planVersions = new Map<string, number>();

/**
 * Get the version number for a plan based on its title.
 * Increments version each time the same title is seen.
 */
function getPlanVersion(plan: string): number {
  const heading = extractFirstHeading(plan) || "untitled";
  const currentVersion = planVersions.get(heading) || 0;
  const newVersion = currentVersion + 1;
  planVersions.set(heading, newVersion);
  return newVersion;
}

// Re-export utilities
export { isRemoteSession, getServerPort } from "./remote";
export { openBrowser } from "./browser";
export * from "./integrations";
export * from "./storage";

// --- Types ---

export interface ServerOptions {
  /** The plan markdown content */
  plan: string;
  /** Origin identifier (e.g., "claude-code", "opencode") */
  origin: string;
  /** HTML content to serve for the UI */
  htmlContent: string;
  /** Current permission mode to preserve (Claude Code only) */
  permissionMode?: string;
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

export interface ServerResult {
  /** The port the server is running on */
  port: number;
  /** The full URL to access the server */
  url: string;
  /** Whether running in remote mode */
  isRemote: boolean;
  /** Wait for user decision (approve/deny) */
  waitForDecision: () => Promise<{
    approved: boolean;
    feedback?: string;
    savedPath?: string;
    agentSwitch?: string;
    permissionMode?: string;
  }>;
  /** Stop the server */
  stop: () => void;
}

// --- Server Implementation ---

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 500;

/**
 * Start the Plannotator server
 *
 * Handles:
 * - Remote detection and port configuration
 * - All API routes (/api/plan, /api/approve, /api/deny, etc.)
 * - Obsidian/Bear integrations
 * - Port conflict retries
 */
export async function startPlannotatorServer(
  options: ServerOptions
): Promise<ServerResult> {
  const { plan, origin, htmlContent, permissionMode, sharingEnabled = true, onReady } = options;

  const isRemote = isRemoteSession();
  const configuredPort = getServerPort();

  // Generate slug for potential saving (actual save happens on decision)
  const slug = generateSlug(plan);

  // Extract metadata for UI display
  const planTitle = extractFirstHeading(plan) || "Untitled Plan";
  const planVersion = getPlanVersion(plan);
  const planTimestamp = new Date().toISOString();

  // Decision promise
  let resolveDecision: (result: {
    approved: boolean;
    feedback?: string;
    savedPath?: string;
    agentSwitch?: string;
    permissionMode?: string;
  }) => void;
  const decisionPromise = new Promise<{
    approved: boolean;
    feedback?: string;
    savedPath?: string;
    agentSwitch?: string;
    permissionMode?: string;
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

          // API: Get plan content
          if (url.pathname === "/api/plan") {
            return Response.json({
              plan,
              origin,
              permissionMode,
              sharingEnabled,
              // Metadata for UI header
              title: planTitle,
              version: planVersion,
              timestamp: planTimestamp,
            });
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

          // API: Detect Obsidian vaults
          if (url.pathname === "/api/obsidian/vaults") {
            const vaults = detectObsidianVaults();
            return Response.json({ vaults });
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

          // API: List plan versions
          if (url.pathname === "/api/plan/versions") {
            const slugParam = url.searchParams.get("slug");
            const targetSlug = slugParam || slug;

            try {
              const versions = listVersions(targetSlug);
              return Response.json({
                slug: targetSlug,
                versions,
                currentVersion: planVersion,
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : "Failed to list versions";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: Get diff between two versions
          if (url.pathname === "/api/plan/diff") {
            const slugParam = url.searchParams.get("slug");
            const v1Param = url.searchParams.get("v1");
            const v2Param = url.searchParams.get("v2");

            if (!v1Param || !v2Param) {
              return Response.json(
                { error: "Missing v1 or v2 parameters" },
                { status: 400 }
              );
            }

            const targetSlug = slugParam || slug;
            const v1 = parseInt(v1Param, 10);
            const v2 = parseInt(v2Param, 10);

            try {
              const content1 = loadVersion(targetSlug, v1);
              const content2 = loadVersion(targetSlug, v2);

              if (!content1 || !content2) {
                return Response.json(
                  { error: `Version ${!content1 ? v1 : v2} not found` },
                  { status: 404 }
                );
              }

              const blocks1 = parseMarkdownToBlocks(content1);
              const blocks2 = parseMarkdownToBlocks(content2);
              const diff = diffBlocks(blocks1, blocks2);
              const summary = diffSummary(diff);

              return Response.json({
                slug: targetSlug,
                v1,
                v2,
                diff,
                summary,
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : "Failed to compute diff";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: Load a specific version
          if (url.pathname === "/api/plan/version") {
            const slugParam = url.searchParams.get("slug");
            const versionParam = url.searchParams.get("version");

            if (!versionParam) {
              return Response.json(
                { error: "Missing version parameter" },
                { status: 400 }
              );
            }

            const targetSlug = slugParam || slug;
            const version = parseInt(versionParam, 10);

            try {
              const content = loadVersion(targetSlug, version);
              if (!content) {
                return Response.json(
                  { error: `Version ${version} not found` },
                  { status: 404 }
                );
              }

              const blocks = parseMarkdownToBlocks(content);
              return Response.json({
                slug: targetSlug,
                version,
                content,
                blocks,
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : "Failed to load version";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: Approve plan
          if (url.pathname === "/api/approve" && req.method === "POST") {
            // Check for note integrations and optional feedback
            let feedback: string | undefined;
            let agentSwitch: string | undefined;
            let requestedPermissionMode: string | undefined;
            let planSaveEnabled = true; // default to enabled for backwards compat
            let planSaveCustomPath: string | undefined;
            try {
              const body = (await req.json().catch(() => ({}))) as {
                obsidian?: ObsidianConfig;
                bear?: BearConfig;
                feedback?: string;
                agentSwitch?: string;
                planSave?: { enabled: boolean; customPath?: string };
                permissionMode?: string;
              };

              // Capture feedback if provided (for "approve with notes")
              if (body.feedback) {
                feedback = body.feedback;
              }

              // Capture agent switch setting for OpenCode
              if (body.agentSwitch) {
                agentSwitch = body.agentSwitch;
              }

              // Capture permission mode from client request (Claude Code)
              if (body.permissionMode) {
                requestedPermissionMode = body.permissionMode;
              }

              // Capture plan save settings
              if (body.planSave !== undefined) {
                planSaveEnabled = body.planSave.enabled;
                planSaveCustomPath = body.planSave.customPath;
              }

              // Obsidian integration
              if (body.obsidian?.vaultPath && body.obsidian?.plan) {
                const result = await saveToObsidian(body.obsidian);
                if (result.success) {
                  console.error(`[Obsidian] Saved plan to: ${result.path}`);
                } else {
                  console.error(`[Obsidian] Save failed: ${result.error}`);
                }
              }

              // Bear integration
              if (body.bear?.plan) {
                const result = await saveToBear(body.bear);
                if (result.success) {
                  console.error(`[Bear] Saved plan to Bear`);
                } else {
                  console.error(`[Bear] Save failed: ${result.error}`);
                }
              }
            } catch (err) {
              // Don't block approval on integration errors
              console.error(`[Integration] Error:`, err);
            }

            // Auto-save version for plan evolution tracking
            let versionSaved: { version: number; path: string; skipped: boolean } | undefined;
            if (planSaveEnabled) {
              try {
                versionSaved = saveVersion(slug, plan, planSaveCustomPath);
                if (!versionSaved.skipped) {
                  console.error(`[PlanHistory] Saved version ${versionSaved.version}: ${versionSaved.path}`);
                }
              } catch (err) {
                console.error(`[PlanHistory] Failed to save version:`, err);
              }
            }

            // Save annotations and final snapshot (if enabled)
            let savedPath: string | undefined;
            if (planSaveEnabled) {
              const diff = feedback || "";
              if (diff) {
                saveAnnotations(slug, diff, planSaveCustomPath);
              }
              savedPath = saveFinalSnapshot(slug, "approved", plan, diff, planSaveCustomPath);
            }

            // Use permission mode from client request if provided, otherwise fall back to hook input
            const effectivePermissionMode = requestedPermissionMode || permissionMode;
            resolveDecision({ approved: true, feedback, savedPath, agentSwitch, permissionMode: effectivePermissionMode });
            return Response.json({ ok: true, savedPath });
          }

          // API: Deny with feedback
          if (url.pathname === "/api/deny" && req.method === "POST") {
            let feedback = "Plan rejected by user";
            let planSaveEnabled = true; // default to enabled for backwards compat
            let planSaveCustomPath: string | undefined;
            try {
              const body = (await req.json()) as {
                feedback?: string;
                planSave?: { enabled: boolean; customPath?: string };
              };
              feedback = body.feedback || feedback;

              // Capture plan save settings
              if (body.planSave !== undefined) {
                planSaveEnabled = body.planSave.enabled;
                planSaveCustomPath = body.planSave.customPath;
              }
            } catch {
              // Use default feedback
            }

            // Auto-save version for plan evolution tracking (even on deny)
            if (planSaveEnabled) {
              try {
                const versionSaved = saveVersion(slug, plan, planSaveCustomPath);
                if (!versionSaved.skipped) {
                  console.error(`[PlanHistory] Saved version ${versionSaved.version}: ${versionSaved.path}`);
                }
              } catch (err) {
                console.error(`[PlanHistory] Failed to save version:`, err);
              }
            }

            // Save annotations and final snapshot (if enabled)
            let savedPath: string | undefined;
            if (planSaveEnabled) {
              saveAnnotations(slug, feedback, planSaveCustomPath);
              savedPath = saveFinalSnapshot(slug, "denied", plan, feedback, planSaveCustomPath);
            }

            resolveDecision({ approved: false, feedback, savedPath });
            return Response.json({ ok: true, savedPath });
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
export async function handleServerReady(
  url: string,
  isRemote: boolean,
  _port: number
): Promise<void> {
  if (!isRemote) {
    await openBrowser(url);
  }
}
