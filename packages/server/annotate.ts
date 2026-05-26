/**
 * Annotate Server
 *
 * Provides a server for annotating arbitrary markdown files.
 * Follows the same patterns as the review server but serves
 * markdown content via /api/plan so the plan editor UI can
 * render it without modifications.
 *
 * Environment variables:
 *   PLANNOTATOR_REMOTE - Set to "1"/"true" for remote, "0"/"false" for local
 *   PLANNOTATOR_PORT   - Fixed port to use (default: random locally, 19432 for remote)
 */

import { isRemoteSession, getServerHostname, getServerPort } from "./remote";
import { getRepoInfo } from "./repo";
import type { Origin } from "@plannotator/shared/agents";
import { handleImage, handleUpload, handleServerReady, handleDraftSave, handleDraftLoad, handleDraftDelete, handleFavicon } from "./shared-handlers";
import { handleDoc, handleDocExists, handleFileBrowserFiles, handleObsidianVaults, handleObsidianFiles, handleObsidianDoc } from "./reference-handlers";
import { warmFileListCache } from "@plannotator/shared/resolve-file";
import { contentHash, deleteDraft } from "./draft";
import { createExternalAnnotationHandler } from "./external-annotations";
import { saveConfig, detectGitUser, getServerConfig } from "./config";
import { generateSlug, saveToHistory, getPlanVersion, getVersionCount, listVersions } from "./storage";
import { detectProjectName } from "./project";
import { dirname, resolve as resolvePath } from "path";
import { isWSL } from "./browser";
import { createDecisionCycle, resolveAndCycle } from "./session-handler";
import type { SessionEventBridge, SessionRequestHandler } from "./session-handler";

// Re-export utilities
export { isRemoteSession, getServerPort } from "./remote";
export { openBrowser } from "./browser";
export { handleServerReady as handleAnnotateServerReady } from "./shared-handlers";

// --- Types ---

export interface AnnotateServerOptions {
  /** Working directory for repo/project-relative behavior */
  cwd?: string;
  /** Markdown content of the file to annotate */
  markdown: string;
  /** Original file path (for display purposes) */
  filePath: string;
  /** HTML content to serve for the UI */
  htmlContent: string;
  /** Origin identifier for UI customization */
  origin?: Origin;
  /** UI mode: "annotate" for files, "annotate-last" for last agent message, "annotate-folder" for folders */
  mode?: "annotate" | "annotate-last" | "annotate-folder";
  /** Folder path when annotating a directory (used as projectRoot for file browser) */
  folderPath?: string;
  /** Whether URL sharing is enabled (default: true) */
  sharingEnabled?: boolean;
  /** Custom base URL for share links */
  shareBaseUrl?: string;
  /** Base URL of the paste service API for short URL sharing */
  pasteApiUrl?: string;
  /** Source attribution: original URL or filename (e.g. "https://..." or "index.html") */
  sourceInfo?: string;
  /** True when `markdown` was produced by Turndown/Jina (HTML or URL) —
   *  feedback line numbers won't match the original source. */
  sourceConverted?: boolean;
  /** Enable review-gate UX: adds an Approve button alongside Close/Send Annotations (#570) */
  gate?: boolean;
  /** Raw HTML content for direct iframe rendering (--render-html mode) */
  rawHtml?: string;
  /** Render HTML as-is in an iframe instead of converting to markdown */
  renderHtml?: boolean;
  /** Called when server starts with the URL, remote status, and port */
  onReady?: (url: string, isRemote: boolean, port: number) => void;
  /** Optional daemon event bridge for live session-scoped events. */
  sessionEvents?: SessionEventBridge;
}

export interface AnnotateServerResult {
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
    exit?: boolean;
    approved?: boolean;
  }>;
  /** Stop the server */
  stop: () => void;
}

export interface AnnotateSession {
  htmlContent: string;
  handleRequest: SessionRequestHandler;
  waitForDecision: AnnotateServerResult["waitForDecision"];
  dispose: () => void;
  updateContent: (newMarkdown: string, newRawHtml?: string) => void;
  getSnapshot?: () => unknown;
}

// --- Server Implementation ---

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 500;

export async function createAnnotateSession(
  options: AnnotateServerOptions
): Promise<AnnotateSession> {
  const {
    cwd = process.cwd(),
    markdown: initialMarkdown,
    filePath,
    htmlContent,
    origin,
    mode = "annotate",
    folderPath,
    sourceInfo,
    sourceConverted,
    sharingEnabled = true,
    shareBaseUrl,
    pasteApiUrl,
    gate = false,
    rawHtml: initialRawHtml,
    renderHtml = false,
  } = options;
  let markdown = initialMarkdown;
  let rawHtml = initialRawHtml;

  // Side-channel pre-warm so /api/doc/exists POSTs land on warm cache.
  void warmFileListCache(cwd, "code");

  const wslFlag = await isWSL();
  const gitUser = detectGitUser(cwd);
  const draftSource =
    mode === "annotate-folder" && folderPath
      ? `folder:${resolvePath(folderPath)}`
      : renderHtml && rawHtml ? rawHtml : markdown;
  let draftKey = contentHash(draftSource);
  const externalAnnotations = createExternalAnnotationHandler("plan", {
    publishEvent: (event) => options.sessionEvents?.publishEvent("external-annotations", event),
    registerSnapshotProvider: (provider) =>
      options.sessionEvents?.registerSnapshotProvider("external-annotations", provider),
  });
  options.sessionEvents?.registerSnapshotProvider("session-revision", () => ({
    plan: markdown, previousPlan, versionInfo,
    ...(rawHtml !== undefined && { rawHtml }),
  }));

  // Detect repo info (cached for this session)
  const repoInfo = await getRepoInfo(cwd);

  // Version history (single-file annotate only — folders have no single document to track)
  const isFileBased = mode === "annotate";
  const project = isFileBased ? ((await detectProjectName(cwd)) ?? "_unknown") : "";
  const slug = isFileBased ? generateSlug(markdown) : "";
  let previousPlan: string | null = null;
  let versionInfo: { version: number; totalVersions: number; project: string } | null = null;

  if (isFileBased && markdown.trim()) {
    const historyResult = saveToHistory(project, slug, markdown);
    previousPlan = historyResult.version > 1
      ? getPlanVersion(project, slug, historyResult.version - 1)
      : null;
    versionInfo = {
      version: historyResult.version,
      totalVersions: getVersionCount(project, slug),
      project,
    };
  }

  type AnnotateDecisionResult = { feedback: string; annotations: unknown[]; exit?: boolean; approved?: boolean };
  const decisionCycle = createDecisionCycle<AnnotateDecisionResult>();
  let lastDecision: 'approved' | 'exited' | 'feedback' | null = null;

  const handleRequest: SessionRequestHandler = async (req, url, context) => {

          // API: Get plan content (reuse /api/plan so the plan editor UI works)
          if (url.pathname === "/api/plan" && req.method === "GET") {
            return Response.json({
              plan: markdown,
              origin,
              mode,
              filePath,
              sourceInfo,
              sourceConverted: sourceConverted ?? false,
              gate,
              renderAs: renderHtml && rawHtml ? 'html' as const : 'markdown' as const,
              ...(renderHtml && rawHtml ? { rawHtml } : {}),
              sharingEnabled,
              shareBaseUrl,
              pasteApiUrl,
              repoInfo,
              previousPlan,
              versionInfo,
              projectRoot: folderPath || cwd,
              isWSL: wslFlag,
              serverConfig: getServerConfig(gitUser),
              lastDecision,
            });
          }

          // API: Get a specific version from history
          if (url.pathname === "/api/plan/version" && isFileBased) {
            const vParam = url.searchParams.get("v");
            if (!vParam) return new Response("Missing v parameter", { status: 400 });
            const v = parseInt(vParam, 10);
            if (isNaN(v) || v < 1) return new Response("Invalid version number", { status: 400 });
            const content = getPlanVersion(project, slug, v);
            if (content === null) return Response.json({ error: "Version not found" }, { status: 404 });
            return Response.json({ plan: content, version: v });
          }

          // API: List all versions
          if (url.pathname === "/api/plan/versions" && isFileBased) {
            return Response.json({ project, slug, versions: listVersions(project, slug) });
          }

          // API: Update user config (write-back to ~/.plannotator/config.json)
          if (url.pathname === "/api/config" && req.method === "POST") {
            try {
              const body = (await req.json()) as { displayName?: string; diffOptions?: Record<string, unknown>; conventionalComments?: boolean; conventionalLabels?: unknown[] | null };
              const toSave: Record<string, unknown> = {};
              if (body.displayName !== undefined) toSave.displayName = body.displayName;
              if (body.diffOptions !== undefined) toSave.diffOptions = body.diffOptions;
              if (body.conventionalComments !== undefined) toSave.conventionalComments = body.conventionalComments;
              if (body.conventionalLabels !== undefined) toSave.conventionalLabels = body.conventionalLabels;
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

          // API: Serve a linked markdown document
          // Inject source file's directory as base for relative path resolution.
          // Skip base injection for URL annotations — there's no local directory to resolve against.
          if (url.pathname === "/api/doc" && req.method === "GET") {
            if (!url.searchParams.has("base") && !/^https?:\/\//i.test(filePath)) {
              const docUrl = new URL(req.url);
              docUrl.searchParams.set("base", dirname(filePath));
              return handleDoc(new Request(docUrl.toString()), { projectRoot: cwd });
            }
            return handleDoc(req, { projectRoot: cwd });
          }

          // API: Batch existence check for code-file paths the renderer detected
          if (url.pathname === "/api/doc/exists" && req.method === "POST") {
            return handleDocExists(req, { projectRoot: cwd });
          }

          // API: Detect Obsidian vaults
          if (url.pathname === "/api/obsidian/vaults") {
            return handleObsidianVaults();
          }

          // API: List Obsidian vault files as a tree
          if (url.pathname === "/api/reference/obsidian/files" && req.method === "GET") {
            return handleObsidianFiles(req);
          }

          // API: Read an Obsidian vault document
          if (url.pathname === "/api/reference/obsidian/doc" && req.method === "GET") {
            return handleObsidianDoc(req);
          }

          // API: List markdown files in a directory as a tree
          if (url.pathname === "/api/reference/files" && req.method === "GET") {
            return handleFileBrowserFiles(req, folderPath || cwd);
          }

          // API: Upload image -> save to temp -> return path
          if (url.pathname === "/api/upload" && req.method === "POST") {
            return handleUpload(req);
          }

          // API: Annotation draft persistence
          if (url.pathname === "/api/draft") {
            if (req.method === "POST") return handleDraftSave(req, draftKey);
            if (req.method === "DELETE") return handleDraftDelete(draftKey);
            return handleDraftLoad(draftKey);
          }

          // API: External annotations (HTTP mutations + daemon WebSocket events)
          const externalResponse = await externalAnnotations.handle(req, url, {
            disableIdleTimeout: () => context?.disableIdleTimeout?.(),
          });
          if (externalResponse) return externalResponse;

          // API: Exit annotation session without feedback
          if (url.pathname === "/api/exit" && req.method === "POST") {
            deleteDraft(draftKey);
            lastDecision = 'exited';
            resolveAndCycle(decisionCycle, { feedback: "", annotations: [], exit: true }, origin);
            return Response.json({ ok: true });
          }

          // API: Approve the annotation session (review-gate UX, #570)
          if (url.pathname === "/api/approve" && req.method === "POST") {
            deleteDraft(draftKey);
            lastDecision = 'approved';
            resolveAndCycle(decisionCycle, { feedback: "", annotations: [], approved: true }, origin);
            return Response.json({ ok: true });
          }

          // API: Submit annotation feedback
          if (url.pathname === "/api/feedback" && req.method === "POST") {
            try {
              const body = (await req.json()) as {
                feedback: string;
                annotations: unknown[];
              };

              deleteDraft(draftKey);
              lastDecision = 'feedback';
              const resubmit = resolveAndCycle(decisionCycle, {
                feedback: body.feedback || "",
                annotations: body.annotations || [],
              }, origin);

              if (resubmit.awaitingResubmission && !isFileBased) {
                return Response.json({ ok: true, feedbackSent: true });
              }
              return Response.json({ ok: true, ...resubmit });
            } catch (err) {
              const message =
                err instanceof Error
                  ? err.message
                  : "Failed to process feedback";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // Favicon
          if (url.pathname === "/favicon.svg") return handleFavicon();

          // Serve embedded HTML for all other routes (SPA)
          return new Response(htmlContent, {
            headers: { "Content-Type": "text/html" },
          });
  };

  function handleUpdateContent(newMarkdown: string, newRawHtml?: string) {
    markdown = newMarkdown;
    lastDecision = null;
    rawHtml = newRawHtml;
    if (isFileBased && newMarkdown.trim()) {
      const historyResult = saveToHistory(project, slug, newMarkdown);
      previousPlan = historyResult.version > 1
        ? getPlanVersion(project, slug, historyResult.version - 1)
        : null;
      versionInfo = {
        version: historyResult.version,
        totalVersions: getVersionCount(project, slug),
        project,
      };
    }
    externalAnnotations.clearAll();
    deleteDraft(draftKey);
    draftKey = contentHash(renderHtml && rawHtml ? rawHtml : newMarkdown);
    options.sessionEvents?.publishEvent("session-revision", {
      plan: newMarkdown, previousPlan, versionInfo,
      ...(rawHtml !== undefined && { rawHtml }),
    });
  }

  return {
    htmlContent,
    handleRequest,
    waitForDecision: () => decisionCycle.promise(),
    dispose: () => {
      externalAnnotations.dispose();
    },
    getSnapshot: isFileBased ? () => ({ plan: markdown, filePath, mode, sourceInfo }) : undefined,
    updateContent: handleUpdateContent,
  };
}

/**
 * Start the Annotate server
 *
 * Handles:
 * - Remote detection and port configuration
 * - API routes (/api/plan with mode:"annotate", /api/feedback)
 * - Port conflict retries
 */
export async function startAnnotateServer(
  options: AnnotateServerOptions
): Promise<AnnotateServerResult> {
  const { onReady } = options;
  const session = await createAnnotateSession(options);
  const isRemote = isRemoteSession();
  const configuredPort = getServerPort();

  // Start server with retry logic
  let server: ReturnType<typeof Bun.serve> | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      server = Bun.serve({
        hostname: getServerHostname(),
        port: configuredPort,

        async fetch(req, server) {
          const url = new URL(req.url);
          return session.handleRequest(req, url, {
            disableIdleTimeout: () => server.timeout(req, 0),
          });
        },

        error(err) {
          console.error("[plannotator] Server error:", err);
          return new Response(
            `Internal Server Error: ${err instanceof Error ? err.message : String(err)}`,
            { status: 500, headers: { "Content-Type": "text/plain" } },
          );
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
        const hint = isRemote
          ? " (set PLANNOTATOR_PORT to use different port)"
          : "";
        throw new Error(
          `Port ${configuredPort} in use after ${MAX_RETRIES} retries${hint}`
        );
      }

      throw err;
    }
  }

  if (!server) {
    throw new Error("Failed to start server");
  }

  const port = server.port!;
  const serverUrl = `http://localhost:${port}`;

  // Notify caller that server is ready
  if (onReady) {
    onReady(serverUrl, isRemote, port);
  }

  return {
    port,
    url: serverUrl,
    isRemote,
    waitForDecision: session.waitForDecision,
    stop: () => {
      server.stop();
      session.dispose();
    },
  };
}
