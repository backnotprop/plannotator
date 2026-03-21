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

import { isRemoteSession, getServerPort } from "./remote";
import { type DiffType, type GitContext, runGitDiff, getFileContentsForDiff, gitAddFile, gitResetFile, parseWorktreeDiffType, validateFilePath } from "./git";
import { getRepoInfo } from "./repo";
import { handleImage, handleUpload, handleAgents, handleServerReady, handleDraftSave, handleDraftLoad, handleDraftDelete, handleFavicon, type OpencodeClient } from "./shared-handlers";
import { contentHash, deleteDraft } from "./draft";
import { createEditorAnnotationHandler } from "./editor-annotations";
import { type PRMetadata, type PRReviewFileComment, fetchPRFileContent, fetchPRContext, submitPRReview, getUser, prRefFromMetadata, getDisplayRepo, getMRLabel, getMRNumberLabel } from "./pr";

// Re-export utilities
export { isRemoteSession, getServerPort } from "./remote";
export { openBrowser } from "./browser";
export { type DiffType, type DiffOption, type GitContext, type WorktreeInfo } from "./git";
export { type PRMetadata } from "./pr";
export { handleServerReady as handleReviewServerReady } from "./shared-handlers";

// --- Types ---

export interface ReviewServerOptions {
  /** Raw git diff patch string */
  rawPatch: string;
  /** Git ref used for the diff (e.g., "HEAD", "main..HEAD", "--staged") */
  gitRef: string;
  /** Error message if git diff failed */
  error?: string;
  /** HTML content to serve for the UI */
  htmlContent: string;
  /** Origin identifier for UI customization */
  origin?: "opencode" | "claude-code" | "pi";
  /** Current diff type being displayed */
  diffType?: DiffType;
  /** Git context with branch info and available diff options */
  gitContext?: GitContext;
  /** Whether URL sharing is enabled (default: true) */
  sharingEnabled?: boolean;
  /** Custom base URL for share links (default: https://share.plannotator.ai) */
  shareBaseUrl?: string;
  /** Called when server starts with the URL, remote status, and port */
  onReady?: (url: string, isRemote: boolean, port: number) => void;
  /** OpenCode client for querying available agents (OpenCode only) */
  opencodeClient?: OpencodeClient;
  /** PR metadata when reviewing a pull request (PR mode) */
  prMetadata?: PRMetadata;
}

export interface ReviewServerResult {
  /** The port the server is running on */
  port: number;
  /** The full URL to access the server */
  url: string;
  /** Whether running in remote mode */
  isRemote: boolean;
  /** Wait for user review decision */
  waitForDecision: () => Promise<{
    approved: boolean;
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
  const { htmlContent, origin, gitContext, sharingEnabled = true, shareBaseUrl, onReady, prMetadata } = options;

  const isPRMode = !!prMetadata;
  const draftKey = contentHash(options.rawPatch);
  const editorAnnotations = createEditorAnnotationHandler();

  // Mutable state for diff switching
  let currentPatch = options.rawPatch;
  let currentGitRef = options.gitRef;
  let currentDiffType: DiffType = options.diffType || "uncommitted";
  let currentError = options.error;

  const isRemote = isRemoteSession();
  const configuredPort = getServerPort();

  // Detect repo info (cached for this session)
  // In PR mode, derive from metadata instead of local git
  const repoInfo = isPRMode
    ? { display: getDisplayRepo(prMetadata), branch: `${getMRLabel(prMetadata)} ${getMRNumberLabel(prMetadata)}` }
    : await getRepoInfo();

  // Fetch current platform user (for own-PR/MR detection)
  const prRef = isPRMode ? prRefFromMetadata(prMetadata) : null;
  const platformUser = prRef ? await getUser(prRef) : null;

  // Decision promise
  let resolveDecision: (result: {
    approved: boolean;
    feedback: string;
    annotations: unknown[];
    agentSwitch?: string;
  }) => void;
  const decisionPromise = new Promise<{
    approved: boolean;
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
              diffType: isPRMode ? undefined : currentDiffType,
              gitContext: isPRMode ? undefined : gitContext,
              sharingEnabled,
              shareBaseUrl,
              repoInfo,
              ...(isPRMode && { prMetadata, platformUser }),
              ...(currentError && { error: currentError }),
            });
          }

          // API: Switch diff type (disabled in PR mode)
          if (url.pathname === "/api/diff/switch" && req.method === "POST") {
            if (isPRMode) {
              return Response.json(
                { error: "Not available for PR reviews" },
                { status: 400 },
              );
            }
            try {
              const body = (await req.json()) as { diffType: DiffType };
              let newDiffType = body.diffType;

              if (!newDiffType) {
                return Response.json(
                  { error: "Missing diffType" },
                  { status: 400 }
                );
              }

              const defaultBranch = gitContext?.defaultBranch || "main";
              const defaultCwd = gitContext?.cwd;

              // Run the new diff
              const result = await runGitDiff(newDiffType, defaultBranch, defaultCwd);

              // Update state
              currentPatch = result.patch;
              currentGitRef = result.label;
              currentDiffType = newDiffType;
              currentError = result.error;

              return Response.json({
                rawPatch: currentPatch,
                gitRef: currentGitRef,
                diffType: currentDiffType,
                ...(currentError && { error: currentError }),
              });
            } catch (err) {
              const message =
                err instanceof Error ? err.message : "Failed to switch diff";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: Fetch PR context (comments, checks, merge status) — PR mode only
          if (url.pathname === "/api/pr-context" && req.method === "GET") {
            if (!isPRMode) {
              return Response.json(
                { error: "Not in PR mode" },
                { status: 400 },
              );
            }
            try {
              const context = await fetchPRContext(prRef!);
              return Response.json(context);
            } catch (err) {
              const message =
                err instanceof Error ? err.message : "Failed to fetch PR context";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: Get file content for expandable diff context
          if (url.pathname === "/api/file-content" && req.method === "GET") {
            const filePath = url.searchParams.get("path");
            if (!filePath) {
              return Response.json({ error: "Missing path" }, { status: 400 });
            }
            try { validateFilePath(filePath); } catch {
              return Response.json({ error: "Invalid path" }, { status: 400 });
            }
            const oldPath = url.searchParams.get("oldPath") || undefined;
            if (oldPath) {
              try { validateFilePath(oldPath); } catch {
                return Response.json({ error: "Invalid path" }, { status: 400 });
              }
            }

            if (isPRMode) {
              // Fetch file content from platform API using base/head SHAs
              const [oldContent, newContent] = await Promise.all([
                fetchPRFileContent(prRef!, prMetadata.baseSha, oldPath || filePath),
                fetchPRFileContent(prRef!, prMetadata.headSha, filePath),
              ]);
              return Response.json({ oldContent, newContent });
            }

            const defaultBranch = gitContext?.defaultBranch || "main";
            const defaultCwd = gitContext?.cwd;
            const result = await getFileContentsForDiff(
              currentDiffType,
              defaultBranch,
              filePath,
              oldPath,
              defaultCwd,
            );
            return Response.json(result);
          }

          // API: Git add / reset (stage / unstage) a file (disabled in PR mode)
          if (url.pathname === "/api/git-add" && req.method === "POST") {
            if (isPRMode) {
              return Response.json(
                { error: "Not available for PR reviews" },
                { status: 400 },
              );
            }
            try {
              const body = (await req.json()) as { filePath: string; undo?: boolean };
              if (!body.filePath) {
                return Response.json({ error: "Missing filePath" }, { status: 400 });
              }

              // Determine cwd for worktree support
              let cwd: string | undefined;
              if (currentDiffType.startsWith("worktree:")) {
                const parsed = parseWorktreeDiffType(currentDiffType);
                if (parsed) cwd = parsed.path;
              }
              if (!cwd) {
                cwd = gitContext?.cwd;
              }

              if (body.undo) {
                await gitResetFile(body.filePath, cwd);
              } else {
                await gitAddFile(body.filePath, cwd);
              }

              return Response.json({ ok: true });
            } catch (err) {
              const message = err instanceof Error ? err.message : "Failed to git add";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: Serve images (local paths or temp uploads)
          if (url.pathname === "/api/image") {
            return handleImage(req);
          }

          // API: Upload image -> save to temp -> return path
          if (url.pathname === "/api/upload" && req.method === "POST") {
            return handleUpload(req);
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
          const editorResponse = await editorAnnotations.handle(req, url);
          if (editorResponse) return editorResponse;

          // API: Submit review feedback
          if (url.pathname === "/api/feedback" && req.method === "POST") {
            try {
              const body = (await req.json()) as {
                approved?: boolean;
                feedback: string;
                annotations: unknown[];
                agentSwitch?: string;
              };

              deleteDraft(draftKey);
              resolveDecision({
                approved: body.approved ?? false,
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

          // API: Submit PR review directly to GitHub (PR mode only)
          if (url.pathname === "/api/pr-action" && req.method === "POST") {
            if (!isPRMode || !prMetadata) {
              return Response.json({ error: "Not in PR mode" }, { status: 400 });
            }
            try {
              const body = (await req.json()) as {
                action: "approve" | "comment";
                body: string;
                fileComments: PRReviewFileComment[];
              };

              await submitPRReview(
                prRef!,
                prMetadata.headSha,
                body.action,
                body.body,
                body.fileComments,
              );

              return Response.json({ ok: true, prUrl: prMetadata.url });
            } catch (err) {
              const message =
                err instanceof Error ? err.message : "Failed to submit PR review";
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
