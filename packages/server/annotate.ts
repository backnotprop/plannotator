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
import { dirname, resolve as resolvePath } from "path";
import { isWSL } from "./browser";

// Re-export utilities
export { isRemoteSession, getServerPort } from "./remote";
export { openBrowser } from "./browser";
export { handleServerReady as handleAnnotateServerReady } from "./shared-handlers";

// --- Types ---

export interface AnnotateServerOptions {
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
    sourceInfo,
    sourceConverted,
    sharingEnabled = true,
    shareBaseUrl,
    pasteApiUrl,
    gate = false,
    onReady,
  } = options;

  const isRemote = isRemoteSession();
  const configuredPort = getServerPort();
  const wslFlag = await isWSL();
  const gitUser = detectGitUser();
  const draftSource =
    mode === "annotate-folder" && folderPath
      ? `folder:${resolvePath(folderPath)}`
      : markdown;
  const draftKey = contentHash(draftSource);
  const externalAnnotations = createExternalAnnotationHandler("plan");

  // Detect repo info (cached for this session)
  const repoInfo = await getRepoInfo();

  // Decision promise
  let resolveDecision: (result: {
    feedback: string;
    annotations: unknown[];
    exit?: boolean;
    approved?: boolean;
  }) => void;
  const decisionPromise = new Promise<{
    feedback: string;
    annotations: unknown[];
    exit?: boolean;
    approved?: boolean;
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

        async fetch(req, server) {
          const url = new URL(req.url);

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
              sharingEnabled,
              shareBaseUrl,
              pasteApiUrl,
              repoInfo,
              projectRoot: folderPath || process.cwd(),
              isWSL: wslFlag,
              serverConfig: getServerConfig(gitUser),
            });
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

          // API: Serve a linked markdown document
          // Inject source file's directory as base for relative path resolution.
          // Skip base injection for URL annotations — there's no local directory to resolve against.
          if (url.pathname === "/api/doc" && req.method === "GET") {
            if (!url.searchParams.has("base") && !/^https?:\/\//i.test(filePath)) {
              const docUrl = new URL(req.url);
              docUrl.searchParams.set("base", dirname(filePath));
              return handleDoc(new Request(docUrl.toString()));
            }
            return handleDoc(req);
          }

          // API: Batch existence check for code-file paths the renderer detected
          if (url.pathname === "/api/doc/exists" && req.method === "POST") {
            return handleDocExists(req);
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

          // API: Exit annotation session without feedback
          if (url.pathname === "/api/exit" && req.method === "POST") {
            deleteDraft(draftKey);
            resolveDecision({ feedback: "", annotations: [], exit: true });
            return Response.json({ ok: true });
          }

          // API: Approve the annotation session (review-gate UX, #570)
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
              };

              deleteDraft(draftKey);
              resolveDecision({
                feedback: body.feedback || "",
                annotations: body.annotations || [],
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
    stop: () => server.stop(),
  };
}
