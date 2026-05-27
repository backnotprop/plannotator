/**
 * Plannotator Shared Server
 *
 * Provides a consistent server implementation for both Claude Code and OpenCode plugins.
 *
 * Environment variables:
 *   PLANNOTATOR_REMOTE - Set to "1"/"true" for remote, "0"/"false" for local
 *   PLANNOTATOR_PORT   - Fixed port to use (default: random locally, 19432 for remote)
 *   PLANNOTATOR_ORIGIN - Explicit origin override; validated against AGENT_CONFIG
 *                        in packages/shared/agents.ts. Supported values:
 *                        "claude-code", "opencode", "codex", "copilot-cli",
 *                        "gemini-cli", "pi".
 */

import type { Origin } from "@plannotator/shared/agents";
import { isRemoteSession, getServerPort } from "./remote";
import { openEditorDiff } from "./ide";
import {
  generateSlug,
  savePlan,
  saveAnnotations,
  saveFinalSnapshot,
  saveToHistory,
  getPlanVersion,
  getPlanVersionPath,
  getVersionCount,
  listVersions,
} from "./storage";
import { getRepoInfo } from "./repo";
import { detectProjectName } from "./project";
import { loadConfig, saveConfig, detectGitUser, getServerConfig } from "./config";
import { readImprovementHook, getImprovementHookExpectedPath } from "@plannotator/shared/improvement-hooks";
import { composeImproveContext } from "@plannotator/shared/pfm-reminder";
import { handleImage, handleUpload, handleAgents, handleServerReady, handleDraftSave, handleDraftLoad, handleDraftDelete, handleFavicon, type OpencodeClient } from "./shared-handlers";
import { contentHash, deleteDraft } from "./draft";
import { handleDoc, handleDocExists, handleFileBrowserFiles } from "./reference-handlers";
import { resolveUserPath, warmFileListCache } from "@plannotator/shared/resolve-file";
import { createEditorAnnotationHandler } from "./editor-annotations";
import { createExternalAnnotationHandler } from "./external-annotations";
import { isWSL } from "./browser";
import { createDecisionCycle, resolveAndCycle } from "./session-handler";
import type { SessionEventBridge, SessionRequestHandler } from "./session-handler";

// Re-export utilities
export { isRemoteSession, getServerPort } from "./remote";
export { openBrowser } from "./browser";
export * from "./storage";
export { handleServerReady } from "./shared-handlers";
export { type VaultNode, buildFileTree } from "@plannotator/shared/reference-common";

// --- Types ---

export interface ServerOptions {
  /** Working directory for repo/project-relative behavior */
  cwd?: string;
  /** The plan markdown content */
  plan: string;
  /** Origin identifier (e.g., "claude-code", "opencode") */
  origin: Origin;
  /** Current permission mode to preserve (Claude Code only) */
  permissionMode?: string;
  /** Whether URL sharing is enabled (default: true) */
  sharingEnabled?: boolean;
  /** Custom base URL for share links (default: https://share.plannotator.ai) */
  shareBaseUrl?: string;
  /** Base URL of the paste service API for short URL sharing */
  pasteApiUrl?: string;
  /** OpenCode client for querying available agents (OpenCode only) */
  opencodeClient?: OpencodeClient;
  /** Optional daemon event bridge for live session-scoped events. */
  sessionEvents?: SessionEventBridge;
}


export interface PlannotatorSession {
  handleRequest: SessionRequestHandler;
  waitForDecision: () => Promise<{ approved: boolean; feedback?: string; savedPath?: string; agentSwitch?: string; permissionMode?: string }>;
  dispose: () => void;
  slug?: string;
  updateContent?: (newPlan: string) => void;
  getSnapshot?: () => unknown;
}

// --- Server Implementation ---


/**
 * Start the Plannotator server
 *
 * Handles:
 * - Remote detection and port configuration
 * - All API routes (/api/plan, /api/approve, /api/deny, etc.)
 * - Port conflict retries
 */
export async function createPlannotatorSession(
  options: ServerOptions
): Promise<PlannotatorSession> {
  const { cwd = process.cwd(), plan: initialPlan, origin, permissionMode, sharingEnabled = true, shareBaseUrl, pasteApiUrl } = options;
  let plan = initialPlan;
  const resolvePlanStoragePath = (customPath?: string | null): string | undefined => {
    if (!customPath?.trim()) return undefined;
    return resolveUserPath(customPath, cwd);
  };

  const wslFlag = await isWSL();
  const gitUser = detectGitUser(cwd);

  // Side-channel pre-warm: kick off the code-file walk now so the
  // renderer's POST /api/doc/exists lands on warm cache.
  void warmFileListCache(cwd, "code");

  // --- Plan review mode setup ---
  let draftKey = contentHash(plan);
  const editorAnnotations = createEditorAnnotationHandler();
  const externalAnnotations = createExternalAnnotationHandler("plan", {
    publishEvent: (event) => options.sessionEvents?.publishEvent("external-annotations", event),
    registerSnapshotProvider: (provider) =>
      options.sessionEvents?.registerSnapshotProvider("external-annotations", provider),
  });
  options.sessionEvents?.registerSnapshotProvider("session-revision", () => ({ plan, previousPlan, versionInfo }));
  const slug = generateSlug(plan);

  // Plan-specific: repo info, version history, decision promise
  let repoInfo: Awaited<ReturnType<typeof getRepoInfo>> | null = null;
  let project = "";
  let currentPlanPath = "";
  let previousPlan: string | null = null;
  let versionInfo = { version: 0, totalVersions: 0, project: "" };

  type DecisionResult = {
    approved: boolean;
    feedback?: string;
    savedPath?: string;
    agentSwitch?: string;
    permissionMode?: string;
  };
  const decisionCycle = createDecisionCycle<DecisionResult>();
  let lastDecision: 'approved' | 'denied' | null = null;

  repoInfo = await getRepoInfo(cwd);
  project = (await detectProjectName(cwd)) ?? "_unknown";
  const historyResult = saveToHistory(project, slug, plan);
  currentPlanPath = historyResult.path;
  previousPlan =
    historyResult.version > 1
      ? getPlanVersion(project, slug, historyResult.version - 1)
      : null;
  versionInfo = {
    version: historyResult.version,
    totalVersions: getVersionCount(project, slug),
    project,
  };

  const handleRequest: SessionRequestHandler = async (req, url, context) => {

          // API: Get a specific plan version from history
          if (url.pathname === "/api/plan/version") {
            const vParam = url.searchParams.get("v");
            if (!vParam) {
              return new Response("Missing v parameter", { status: 400 });
            }
            const v = parseInt(vParam, 10);
            if (isNaN(v) || v < 1) {
              return new Response("Invalid version number", { status: 400 });
            }
            const content = getPlanVersion(project, slug, v);
            if (content === null) {
              return Response.json({ error: "Version not found" }, { status: 404 });
            }
            return Response.json({ plan: content, version: v });
          }

          // API: List all versions for the current plan
          if (url.pathname === "/api/plan/versions") {
            return Response.json({
              project,
              slug,
              versions: listVersions(project, slug),
            });
          }

          // API: Get plan content
          if (url.pathname === "/api/plan") {
            return Response.json({ plan, origin, permissionMode, sharingEnabled, shareBaseUrl, pasteApiUrl, repoInfo, previousPlan, versionInfo, projectRoot: cwd, isWSL: wslFlag, serverConfig: getServerConfig(gitUser), lastDecision });
          }

          // API: Serve a linked markdown document
          if (url.pathname === "/api/doc" && req.method === "GET") {
            return handleDoc(req, { projectRoot: cwd });
          }

          // API: Batch existence check for code-file paths the renderer detected
          if (url.pathname === "/api/doc/exists" && req.method === "POST") {
            return handleDocExists(req, { projectRoot: cwd });
          }

          // API: Hook status for the Settings Hooks tab
          if (url.pathname === "/api/hooks/status" && req.method === "GET") {
            const config = loadConfig();
            const hook = readImprovementHook("enterplanmode-improve");
            const pfmEnabled = config.pfmReminder === true;
            const composed = composeImproveContext({
              pfmEnabled,
              improvementHookContent: hook?.content ?? null,
            });
            return Response.json({
              pfmReminder: { enabled: pfmEnabled },
              improvementHook: {
                present: !!hook,
                filePath: hook?.filePath ?? getImprovementHookExpectedPath("enterplanmode-improve"),
                fileSize: hook?.content?.length ?? null,
                content: hook?.content ?? null,
              },
              composedLength: composed?.length ?? null,
            });
          }

          // API: Update user config (write-back to ~/.plannotator/config.json)
          if (url.pathname === "/api/config" && req.method === "POST") {
            try {
              const body = (await req.json()) as { displayName?: string; diffOptions?: Record<string, unknown>; conventionalComments?: boolean; conventionalLabels?: unknown[] | null; pfmReminder?: boolean };
              const toSave: Record<string, unknown> = {};
              if (body.displayName !== undefined) toSave.displayName = body.displayName;
              if (body.diffOptions !== undefined) toSave.diffOptions = body.diffOptions;
              if (body.conventionalComments !== undefined) toSave.conventionalComments = body.conventionalComments;
              if (body.conventionalLabels !== undefined) toSave.conventionalLabels = body.conventionalLabels;
              if (body.pfmReminder !== undefined) toSave.pfmReminder = body.pfmReminder;
              if (Object.keys(toSave).length > 0) saveConfig(toSave as Parameters<typeof saveConfig>[0]);
              return Response.json({ ok: true });
            } catch {
              return Response.json({ error: "Invalid request" }, { status: 400 });
            }
          }

          // API: Serve images (local paths or temp uploads)
          if (url.pathname === "/api/image") {
            return handleImage(req, cwd);
          }

          // API: Upload image -> save to temp -> return path
          if (url.pathname === "/api/upload" && req.method === "POST") {
            return handleUpload(req);
          }

          // API: Open plan diff in VS Code
          if (url.pathname === "/api/plan/vscode-diff" && req.method === "POST") {
            try {
              const body = (await req.json()) as { baseVersion: number };

              if (!body.baseVersion) {
                return Response.json({ error: "Missing baseVersion" }, { status: 400 });
              }

              const basePath = getPlanVersionPath(project, slug, body.baseVersion);
              if (!basePath) {
                return Response.json({ error: `Version ${body.baseVersion} not found` }, { status: 404 });
              }

              const result = await openEditorDiff(basePath, currentPlanPath);
              if ("error" in result) {
                return Response.json({ error: result.error }, { status: 500 });
              }
              return Response.json({ ok: true });
            } catch (err) {
              const message = err instanceof Error ? err.message : "Failed to open VS Code diff";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: List markdown files in a directory as a tree
          if (url.pathname === "/api/reference/files" && req.method === "GET") {
            return handleFileBrowserFiles(req, cwd);
          }

          // API: Get available agents (OpenCode only)
          if (url.pathname === "/api/agents") {
            return handleAgents(options.opencodeClient);
          }

          // API: Annotation draft persistence
          if (url.pathname === "/api/draft") {
            if (req.method === "POST") return handleDraftSave(req, draftKey);
            if (req.method === "DELETE") return handleDraftDelete(draftKey);
            return handleDraftLoad(draftKey);
          }

          // API: Editor annotations (VS Code extension)
          const editorResponse = await editorAnnotations?.handle(req, url);
          if (editorResponse) return editorResponse;

          // API: External annotations (HTTP mutations + daemon WebSocket events)
          const externalResponse = await externalAnnotations?.handle(req, url, {
            disableIdleTimeout: () => context?.disableIdleTimeout?.(),
          });
          if (externalResponse) return externalResponse;

          // API: Approve plan
          if (url.pathname === "/api/approve" && req.method === "POST") {
            let feedback: string | undefined;
            let agentSwitch: string | undefined;
            let requestedPermissionMode: string | undefined;
            let planSaveEnabled = true; // default to enabled for backwards compat
            let planSaveCustomPath: string | undefined;
            try {
              const body = (await req.json().catch(() => ({}))) as {
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
                planSaveCustomPath = resolvePlanStoragePath(body.planSave.customPath);
              }
            } catch (err) {
              console.error(`[Approve] Error parsing body:`, err);
            }

            // Save annotations and final snapshot (if enabled)
            let savedPath: string | undefined;
            if (planSaveEnabled) {
              const annotations = feedback || "";
              if (annotations) {
                saveAnnotations(slug, annotations, planSaveCustomPath);
              }
              savedPath = saveFinalSnapshot(slug, "approved", plan, annotations, planSaveCustomPath);
            }

            // Clean up draft on successful submit
            deleteDraft(draftKey);

            // Use permission mode from client request if provided, otherwise fall back to hook input
            const effectivePermissionMode = requestedPermissionMode || permissionMode;
            lastDecision = 'approved';
            resolveAndCycle(decisionCycle, { approved: true, feedback, savedPath, agentSwitch, permissionMode: effectivePermissionMode }, origin);
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
                planSaveCustomPath = resolvePlanStoragePath(body.planSave.customPath);
              }
            } catch {
              // Use default feedback
            }

            // Save annotations and final snapshot (if enabled)
            let savedPath: string | undefined;
            if (planSaveEnabled) {
              saveAnnotations(slug, feedback, planSaveCustomPath);
              savedPath = saveFinalSnapshot(slug, "denied", plan, feedback, planSaveCustomPath);
            }

            deleteDraft(draftKey);
            lastDecision = 'denied';
            const resubmit = resolveAndCycle(decisionCycle, { approved: false, feedback, savedPath }, origin);
            return Response.json({ ok: true, savedPath, ...resubmit });
          }

          // Favicon
          if (url.pathname === "/favicon.svg") return handleFavicon();

          return new Response("Not found", { status: 404 });
  };

  function handleUpdateContent(newPlan: string) {
    plan = newPlan;
    lastDecision = null;
    const historyResult = saveToHistory(project, slug, newPlan);
    currentPlanPath = historyResult.path;
    previousPlan = historyResult.version > 1
      ? getPlanVersion(project, slug, historyResult.version - 1)
      : null;
    versionInfo = {
      version: historyResult.version,
      totalVersions: getVersionCount(project, slug),
      project,
    };
    externalAnnotations?.clearAll();
    editorAnnotations?.clearAll();
    deleteDraft(draftKey);
    draftKey = contentHash(newPlan);
    options.sessionEvents?.publishEvent("session-revision", { plan: newPlan, previousPlan, versionInfo });
  }

  return {
    handleRequest,
    waitForDecision: () => decisionCycle.promise(),
    dispose: () => {
      externalAnnotations?.dispose();
    },
    slug,
    getSnapshot: () => ({ plan, origin }),
    updateContent: handleUpdateContent,
  };
}
