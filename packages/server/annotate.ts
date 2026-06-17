/**
 * Annotate Server
 *
 * Provides a server for annotating arbitrary files, URLs, and folders.
 * Follows the same patterns as the review server but serves
 * annotation-session content via /api/plan so the plan editor UI can
 * render it without separate app bundles.
 *
 * Environment variables:
 *   PLANNOTATOR_REMOTE - Set to "1"/"true" for remote, "0"/"false" for local
 *   PLANNOTATOR_PORT   - Fixed port to use (default: random locally, 19432 for remote)
 */

import { isRemoteSession, getServerHostname, getServerPort } from "./remote";
import { getRepoInfo } from "./repo";
import type { Origin } from "@plannotator/shared/agents";
import { handleImage, handleUpload, handleServerReady, handleDraftSave, handleDraftLoad, handleDraftDelete, handleFavicon, handleSaveNotes } from "./shared-handlers";
import { handleDoc, handleDocExists, handleFileBrowserFiles, handleObsidianVaults, handleObsidianFiles, handleObsidianDoc } from "./reference-handlers";
import { warmFileListCache } from "@plannotator/shared/resolve-file";
import { contentHash, deleteDraft } from "./draft";
import { disabledSourceSave, type SourceSaveRequest } from "@plannotator/shared/source-save";
import {
	createSourceSaveCapability,
	readSourceFileSnapshot,
	resolveFolderSourceFile,
	saveSourceFileAtomic,
} from "@plannotator/shared/source-save-node";
import { createExternalAnnotationHandler } from "./external-annotations";
import { saveConfig, detectGitUser, getServerConfig } from "./config";
import { dirname, resolve as resolvePath } from "path";
import { isWithinDirectory } from "@plannotator/shared/html-assets-node";
import { isWSL } from "./browser";
import { AI_QUERY_ENDPOINT, createAIRuntime } from "./ai-runtime";
import type { AIEndpoints } from "@plannotator/ai";
import { createHtmlAssetRegistry } from "./html-assets";

// Re-export utilities
export { isRemoteSession, getServerPort } from "./remote";
export { openBrowser } from "./browser";
export { handleServerReady as handleAnnotateServerReady } from "./shared-handlers";

// --- Types ---

export interface AnnotateServerOptions {
  /** Markdown content of the file to annotate. Empty when rendering raw HTML. */
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
  /**
   * Recent assistant messages for `annotate-last` mode (newest-first). When
   * provided with more than one entry, the editor renders a picker so users
   * can choose which message to annotate; index 0 is the default selection
   * and matches the legacy "last message" behavior.
   */
  recentMessages?: { messageId: string; text: string; timestamp?: string }[];
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
  /** Enable review-gate UX: adds an Approve button alongside Close/Send Annotations */
  gate?: boolean;
  /** Raw HTML content for direct iframe rendering. */
  rawHtml?: string;
  /** Render HTML as-is in an iframe. */
  renderHtml?: boolean;
  /** Session-level force-markdown preference (`--markdown`). Exposed in /api/plan so the
   *  frontend appends `&convert=1` when navigating folder/linked HTML files. */
  convertHtml?: boolean;
  /** Called when server starts with the URL, remote status, and port */
  onReady?: (url: string, isRemote: boolean, port: number) => void;
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
    selectedMessageId?: string;
    feedbackScope?: "message" | "messages";
  }>;
  /** Stop the server */
  stop: () => void;
}

// --- Server Implementation ---

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 500;

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
  // Side-channel pre-warm so /api/doc/exists POSTs land on warm cache.
  void warmFileListCache(process.cwd(), "code");

  const {
    markdown,
    filePath,
    htmlContent,
    origin,
    mode = "annotate",
    folderPath,
    recentMessages,
    sourceInfo,
    sourceConverted,
    sharingEnabled = true,
    shareBaseUrl,
    pasteApiUrl,
    gate = false,
    rawHtml,
    renderHtml = false,
    convertHtml = false,
    onReady,
  } = options;

  const isRemote = isRemoteSession();
  const configuredPort = getServerPort();
  const wslFlag = await isWSL();
  const gitUser = detectGitUser();
  const draftSource =
    mode === "annotate-folder" && folderPath
      ? `folder:${resolvePath(folderPath)}`
      : renderHtml && rawHtml ? rawHtml : markdown;
  const draftKey = contentHash(draftSource);
  const externalAnnotations = createExternalAnnotationHandler("plan");
  const aiRuntime = await createAIRuntime();
  const htmlAssets = createHtmlAssetRegistry();

  async function loadShareHtml(pathParam: string | null): Promise<Response> {
    if (/^https?:\/\//i.test(filePath)) {
      return Response.json({ error: "Raw HTML sharing is unavailable for URL annotations" }, { status: 400 });
    }

    const sourcePath = resolvePath(filePath);
    const requestedPath = pathParam ? resolvePath(pathParam) : sourcePath;
    if (!/\.html?$/i.test(requestedPath)) {
      return Response.json({ error: "Share HTML is only available for HTML documents" }, { status: 400 });
    }
    if (!isAllowedHtmlSharePath(requestedPath)) {
      return Response.json({ error: "Access denied" }, { status: 403 });
    }

    try {
      const html = renderHtml && rawHtml && requestedPath === sourcePath
        ? rawHtml
        : await Bun.file(requestedPath).text();
      return Response.json({ shareHtml: htmlAssets.inlineHtml(html, requestedPath) });
    } catch {
      return Response.json({ error: "Failed to prepare share HTML" }, { status: 500 });
    }
  }

  function isAllowedHtmlSharePath(targetPath: string): boolean {
    const roots = new Set<string>([process.cwd()]);
    if (folderPath) roots.add(folderPath);
    if (!/^https?:\/\//i.test(filePath)) roots.add(dirname(filePath));
    for (const root of roots) {
      if (isWithinDirectory(targetPath, root)) return true;
    }
    return false;
  }

  const getPrimarySource = () => {
    if (mode === "annotate-last") {
      return { plan: markdown, sourceSave: disabledSourceSave("message-mode") };
    }
    if (mode === "annotate-folder") {
      return { plan: markdown, sourceSave: disabledSourceSave("folder-mode") };
    }
    if (renderHtml && rawHtml) {
      return { plan: markdown, sourceSave: disabledSourceSave("html-render") };
    }
    if (sourceConverted) {
      return { plan: markdown, sourceSave: disabledSourceSave("converted-source") };
    }
    if (/^https?:\/\//i.test(filePath)) {
      return { plan: markdown, sourceSave: disabledSourceSave("not-local-file") };
    }

    const sourceSave = createSourceSaveCapability("single-file", filePath);
    if (!sourceSave.enabled) {
      return { plan: markdown, sourceSave };
    }

    try {
      const snapshot = readSourceFileSnapshot(sourceSave.path);
      return {
        plan: snapshot.text,
        sourceSave: {
          ...sourceSave,
          hash: snapshot.hash,
          mtimeMs: snapshot.mtimeMs,
          size: snapshot.size,
          eol: snapshot.eol,
        },
      };
    } catch {
      return { plan: markdown, sourceSave: disabledSourceSave("unreadable-file") };
    }
  };

  const getReferenceRootPaths = () => {
    if (mode === "annotate-folder" && folderPath) {
      return [folderPath];
    }
    if (/^https?:\/\//i.test(filePath)) {
      return [process.cwd()];
    }
    return [process.cwd(), dirname(filePath)];
  };

  // Detect repo info (cached for this session)
  const repoInfo = await getRepoInfo();

  // Decision promise
  let resolveDecision: (result: {
    feedback: string;
    annotations: unknown[];
    exit?: boolean;
    approved?: boolean;
    selectedMessageId?: string;
    feedbackScope?: "message" | "messages";
  }) => void;
  const decisionPromise = new Promise<{
    feedback: string;
    annotations: unknown[];
    exit?: boolean;
    approved?: boolean;
    selectedMessageId?: string;
    feedbackScope?: "message" | "messages";
  }>((resolve) => {
    resolveDecision = resolve;
  });

  // Start server with retry logic
  let server: ReturnType<typeof Bun.serve> | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      server = Bun.serve({
        hostname: getServerHostname(),
        port: configuredPort,
        // Bun's default 10s idleTimeout kills AI SSE streams that stall
        // between bytes (e.g. while a permission prompt waits on the user).
        idleTimeout: 0,

        async fetch(req, server) {
          const url = new URL(req.url);

          // API: Get plan content (reuse /api/plan so the plan editor UI works)
          if (url.pathname === "/api/plan" && req.method === "GET") {
            const displayRawHtml = renderHtml && rawHtml ? htmlAssets.rewriteHtml(rawHtml, filePath) : undefined;
            const primarySource = getPrimarySource();
            return Response.json({
              plan: primarySource.plan,
              origin,
              mode,
              filePath,
              sourceInfo,
              sourceConverted: sourceConverted ?? false,
              sourceSave: primarySource.sourceSave,
              gate,
              renderAs: displayRawHtml ? 'html' as const : 'markdown' as const,
              ...(displayRawHtml ? { rawHtml: displayRawHtml } : {}),
              convertHtml,
              sharingEnabled,
              shareBaseUrl,
              pasteApiUrl,
              repoInfo,
              projectRoot: folderPath || process.cwd(),
              isWSL: wslFlag,
              serverConfig: getServerConfig(gitUser),
              ...(recentMessages ? { recentMessages } : {}),
            });
          }

          if (url.pathname === "/api/share-html" && req.method === "GET") {
            return loadShareHtml(url.searchParams.get("path"));
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
            return handleImage(req);
          }

          const htmlAssetResponse = await htmlAssets.handle(req, url);
          if (htmlAssetResponse) {
            return htmlAssetResponse;
          }

          // API: Serve a linked markdown document. The annotate session owns the
          // source-file base and --markdown preference, so enforce both here.
          if (url.pathname === "/api/doc" && req.method === "GET") {
            const docUrl = new URL(req.url);
            let changed = false;
            if (!docUrl.searchParams.has("base") && !/^https?:\/\//i.test(filePath)) {
              docUrl.searchParams.set("base", mode === "annotate-folder" && folderPath ? folderPath : dirname(filePath));
              changed = true;
            }
            if (convertHtml && !docUrl.searchParams.has("convert")) {
              docUrl.searchParams.set("convert", "1");
              changed = true;
            }
            const docReq = changed ? new Request(docUrl.toString()) : req;
            return handleDoc(docReq, {
              rewriteHtml: htmlAssets.rewriteHtml,
              sourceSaveFolderPath: mode === "annotate-folder" ? folderPath : undefined,
              rootPaths: getReferenceRootPaths(),
            });
          }

          if (url.pathname === "/api/source/save" && req.method === "POST") {
            let body: SourceSaveRequest;
            try {
              body = (await req.json()) as SourceSaveRequest;
            } catch {
              return Response.json(
                { ok: false, code: "invalid-request", message: "Invalid JSON body." },
                { status: 400 },
              );
            }

            if (typeof body.text !== "string" || typeof body.baseHash !== "string") {
              return Response.json(
                { ok: false, code: "invalid-request", message: "Expected text and baseHash." },
                { status: 400 },
              );
            }

            let targetPath: string | null = null;
            if (mode === "annotate" && !sourceConverted && !(renderHtml && rawHtml)) {
              const capability = createSourceSaveCapability("single-file", filePath);
              targetPath = capability.enabled ? capability.path : null;
            } else if (mode === "annotate-folder" && folderPath && typeof body.path === "string") {
              targetPath = resolveFolderSourceFile(body.path, folderPath);
            }

            if (!targetPath) {
              return Response.json(
                { ok: false, code: "not-writable", message: "This document cannot be saved to a file." },
                { status: 403 },
              );
            }

            const result = saveSourceFileAtomic(targetPath, body.text, body.baseHash);
            const status = result.ok
              ? 200
              : result.code === "conflict"
                ? 409
                : result.code === "invalid-request"
                  ? 400
                  : result.code === "not-writable"
                    ? 403
                    : 500;
            return Response.json(result, { status });
          }

          // API: Batch existence check for code-file paths the renderer detected
          if (url.pathname === "/api/doc/exists" && req.method === "POST") {
            return handleDocExists(req, { rootPaths: getReferenceRootPaths() });
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
            return handleFileBrowserFiles(req);
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

          // API: External annotations (SSE-based, for any external tool)
          const externalResponse = await externalAnnotations.handle(req, url, {
            disableIdleTimeout: () => server.timeout(req, 0),
          });
          if (externalResponse) return externalResponse;

          if (url.pathname.startsWith("/api/ai/")) {
            const handler = aiRuntime.endpoints[url.pathname as keyof AIEndpoints];
            if (handler) {
              if (url.pathname === AI_QUERY_ENDPOINT) {
                server.timeout(req, 0);
              }
              return handler(req);
            }
            return Response.json({ error: "Not found" }, { status: 404 });
          }

          // API: Exit annotation session without feedback
          if (url.pathname === "/api/exit" && req.method === "POST") {
            deleteDraft(draftKey);
            resolveDecision({ feedback: "", annotations: [], exit: true });
            return Response.json({ ok: true });
          }

          // API: Approve the annotation session (review-gate UX)
          if (url.pathname === "/api/approve" && req.method === "POST") {
            deleteDraft(draftKey);
            resolveDecision({ feedback: "", annotations: [], approved: true });
            return Response.json({ ok: true });
          }

          // API: Submit annotation feedback
          if (url.pathname === "/api/feedback" && req.method === "POST") {
            try {
              const body = (await req.json()) as {
                feedback: string;
                annotations: unknown[];
                selectedMessageId?: string;
                feedbackScope?: "message" | "messages";
              };

              deleteDraft(draftKey);
              resolveDecision({
                feedback: body.feedback || "",
                annotations: body.annotations || [],
                selectedMessageId: body.selectedMessageId,
                feedbackScope: body.feedbackScope,
              });

              return Response.json({ ok: true });
            } catch (err) {
              const message =
                err instanceof Error
                  ? err.message
                  : "Failed to process feedback";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: Save notes to external integrations (Obsidian, Bear, Octarine)
          if (url.pathname === "/api/save-notes" && req.method === "POST") {
            return handleSaveNotes(req);
          }

          // Favicon
          if (url.pathname === "/favicon.svg") return handleFavicon();

          // Serve embedded HTML for all other routes (SPA)
          return new Response(htmlContent, {
            headers: { "Content-Type": "text/html" },
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
    waitForDecision: () => decisionPromise,
    stop: () => {
      aiRuntime.dispose();
      server.stop();
    },
  };
}
