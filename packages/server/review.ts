/**
 * Code Review Server
 *
 * Provides a server implementation for code review with git diff rendering.
 * Follows the same patterns as the plan server.
 *
 * Environment variables:
 *   PLANNOTATOR_REMOTE - Set to "1"/"true" for remote, "0"/"false" for local
 *   PLANNOTATOR_PORT   - Fixed port to use (default: random locally, 19432 for remote)
 */

import { isRemoteSession, getServerHostname, getServerPort } from "./remote";
import type { Origin } from "@plannotator/shared/agents";
import { type DiffType, type GitContext, runVcsDiff, getVcsFileContentsForDiff, canStageFiles, stageFile, unstageFile, resolveVcsCwd, validateFilePath, getVcsContext, gitRuntime } from "./vcs";
import { parseWorktreeDiffType, detectRemoteDefaultBranch, resolveBaseBranch } from "@plannotator/shared/review-core";
import type { AgentJobInfo } from "@plannotator/shared/agent-jobs";
import { getRepoInfo } from "./repo";
import { handleImage, handleUpload, handleAgents, handleServerReady, handleDraftSave, handleDraftLoad, handleDraftDelete, handleFavicon, type OpencodeClient } from "./shared-handlers";
import { contentHash, deleteDraft } from "./draft";
import { createEditorAnnotationHandler } from "./editor-annotations";
import { createExternalAnnotationHandler } from "./external-annotations";
import { createAgentJobHandler } from "./agent-jobs";
import {
  CODEX_REVIEW_SYSTEM_PROMPT,
  buildCodexReviewUserMessage,
  buildCodexCommand,
  generateOutputPath,
  parseCodexOutput,
  transformReviewFindings,
} from "./codex-review";
import {
  CLAUDE_REVIEW_PROMPT,
  buildClaudeCommand,
  parseClaudeStreamOutput,
  transformClaudeFindings,
} from "./claude-review";
import { createTourSession, TOUR_EMPTY_OUTPUT_ERROR } from "./tour/tour-review";
import { saveConfig, detectGitUser, getServerConfig } from "./config";
import { type PRMetadata, type PRReviewFileComment, fetchPRFileContent, fetchPRContext, submitPRReview, fetchPRViewedFiles, markPRFilesViewed, getPRUser, prRefFromMetadata, getDisplayRepo, getMRLabel, getMRNumberLabel } from "./pr";
import { createAIEndpoints, ProviderRegistry, SessionManager, createProvider, type AIEndpoints, type PiSDKConfig } from "@plannotator/ai";
import { isWSL } from "./browser";

// Re-export utilities
export { isRemoteSession, getServerPort } from "./remote";
export { openBrowser } from "./browser";
export { type DiffType, type DiffOption, type GitContext, type WorktreeInfo } from "./vcs";
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
  origin?: Origin;
  /** Current diff type being displayed */
  diffType?: DiffType;
  /** Git context with branch info and available diff options */
  gitContext?: GitContext;
  /**
   * Initial base branch the caller used to compute `rawPatch`. When a caller
   * overrides the detected default (e.g. Pi's `openCodeReview` accepting a
   * custom `defaultBranch`), this must be forwarded so the server's internal
   * `currentBase` state, the `/api/diff` response, and downstream agent
   * prompts stay consistent with the patch that's already on screen.
   */
  initialBase?: string;
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
  /** Working directory for agent processes (e.g., --local worktree). Independent of diff pipeline. */
  agentCwd?: string;
  /** Cleanup callback invoked when server stops (e.g., remove temp worktree) */
  onCleanup?: () => void | Promise<void>;
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
    exit?: boolean;
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
  const hasLocalAccess = !!gitContext;
  const draftKey = contentHash(options.rawPatch);
  const editorAnnotations = createEditorAnnotationHandler();
  const externalAnnotations = createExternalAnnotationHandler("review");

  const tour = createTourSession();

  // Mutable state for diff switching
  let currentPatch = options.rawPatch;
  let currentGitRef = options.gitRef;
  let currentDiffType: DiffType = options.diffType || "uncommitted";
  let currentError = options.error;
  // Tracks the base branch the user picked from the UI. Agent review prompts
  // read this (not gitContext.defaultBranch) so they analyze the same diff
  // the reviewer is currently looking at. Honors an explicit initialBase from
  // the caller — e.g. programmatic Pi callers can request a non-detected base.
  let currentBase = options.initialBase || gitContext?.defaultBranch || "main";
  let baseEverSwitched = false;

  // Fire-and-forget: query the remote for its actual default branch. If it
  // arrives before the user interacts, quietly upgrade currentBase from the
  // local fallback (e.g. "main") to the upstream ref (e.g. "origin/main").
  // Non-blocking — the server is already listening by the time this resolves.
  if (gitContext && !options.initialBase && !isPRMode) {
    detectRemoteDefaultBranch(gitRuntime, gitContext.cwd).then((remote) => {
      if (remote && !baseEverSwitched) currentBase = remote;
    });
  }

  // Agent jobs — background process manager (late-binds serverUrl via getter)
  let serverUrl = "";
  const resolveAgentCwd = (): string =>
    options.agentCwd ?? resolveVcsCwd(currentDiffType, gitContext?.cwd) ?? process.cwd();
  const agentJobs = createAgentJobHandler({
    mode: "review",
    getServerUrl: () => serverUrl,
    getCwd: resolveAgentCwd,

    async buildCommand(provider, config) {
      const cwd = resolveAgentCwd();
      const hasAgentLocalAccess = !!options.agentCwd || !!gitContext;
      const userMessageOptions = { defaultBranch: currentBase, hasLocalAccess: hasAgentLocalAccess };

      // Snapshot the diff context at launch — stored on the job so
      // downstream "Copy All" produces the same markdown as /api/feedback
      // would right now, even if the reviewer switches modes/bases later.
      // Skipped in PR mode (prMetadata carries equivalent context).
      const worktreeParts = currentDiffType.startsWith("worktree:")
        ? parseWorktreeDiffType(currentDiffType)
        : null;
      const diffContext: AgentJobInfo["diffContext"] | undefined = prMetadata
        ? undefined
        : {
            mode: (worktreeParts?.subType ?? currentDiffType) as string,
            base: currentBase,
            worktreePath: worktreeParts?.path ?? null,
          };

      if (provider === "tour") {
        const built = await tour.buildCommand({
          cwd,
          patch: currentPatch,
          diffType: currentDiffType,
          options: userMessageOptions,
          prMetadata,
          config,
        });
        return built ? { ...built, diffContext } : built;
      }

      const userMessage = buildCodexReviewUserMessage(currentPatch, currentDiffType, userMessageOptions, prMetadata);

      if (provider === "codex") {
        const model = typeof config?.model === "string" && config.model ? config.model : undefined;
        const reasoningEffort = typeof config?.reasoningEffort === "string" && config.reasoningEffort ? config.reasoningEffort : undefined;
        const fastMode = config?.fastMode === true;
        const outputPath = generateOutputPath();
        const prompt = CODEX_REVIEW_SYSTEM_PROMPT + "\n\n---\n\n" + userMessage;
        const command = await buildCodexCommand({ cwd, outputPath, prompt, model, reasoningEffort, fastMode });
        return { command, outputPath, prompt, label: "Code Review", model, reasoningEffort, fastMode: fastMode || undefined, diffContext };
      }

      if (provider === "claude") {
        const model = typeof config?.model === "string" && config.model ? config.model : undefined;
        const effort = typeof config?.effort === "string" && config.effort ? config.effort : undefined;
        const prompt = CLAUDE_REVIEW_PROMPT + "\n\n---\n\n" + userMessage;
        const { command, stdinPrompt } = buildClaudeCommand(prompt, model, effort);
        return { command, stdinPrompt, prompt, cwd, label: "Code Review", captureStdout: true, model, effort, diffContext };
      }

      return null;
    },

    async onJobComplete(job, meta) {
      const cwd = resolveAgentCwd();

      // --- Codex path ---
      if (job.provider === "codex" && meta.outputPath) {
        const output = await parseCodexOutput(meta.outputPath);
        if (!output) return;

        // Override verdict if there are blocking findings (P0/P1) — Codex's
        // freeform correctness string can say "mostly correct" with real bugs.
        const hasBlockingFindings = output.findings.some(f => f.priority !== null && f.priority <= 1);
        job.summary = {
          correctness: hasBlockingFindings ? "Issues Found" : output.overall_correctness,
          explanation: output.overall_explanation,
          confidence: output.overall_confidence_score,
        };

        if (output.findings.length > 0) {
          const annotations = transformReviewFindings(output.findings, job.source, cwd, "Codex");
          const result = externalAnnotations.addAnnotations({ annotations });
          if ("error" in result) console.error(`[codex-review] addAnnotations error:`, result.error);
        }
        return;
      }

      // --- Claude path ---
      if (job.provider === "claude" && meta.stdout) {
        const output = parseClaudeStreamOutput(meta.stdout);
        if (!output) {
          console.error(`[claude-review] Failed to parse output (${meta.stdout.length} bytes, last 200: ${meta.stdout.slice(-200)})`);
          return;
        }

        const total = output.summary.important + output.summary.nit + output.summary.pre_existing;
        job.summary = {
          correctness: output.summary.important === 0 ? "Correct" : "Issues Found",
          explanation: `${output.summary.important} important, ${output.summary.nit} nit, ${output.summary.pre_existing} pre-existing`,
          confidence: total === 0 ? 1.0 : Math.max(0, 1.0 - (output.summary.important * 0.2)),
        };

        if (output.findings.length > 0) {
          const annotations = transformClaudeFindings(output.findings, job.source, cwd);
          const result = externalAnnotations.addAnnotations({ annotations });
          if ("error" in result) console.error(`[claude-review] addAnnotations error:`, result.error);
        }
        return;
      }

      // --- Tour path ---
      if (job.provider === "tour") {
        const { summary } = await tour.onJobComplete({ job, meta });
        if (summary) {
          job.summary = summary;
        } else {
          // The process exited 0 but the model returned empty or malformed output
          // and nothing was stored. Flip status so the client doesn't auto-open
          // a successful-looking card that 404s on /api/tour/:id.
          job.status = "failed";
          job.error = TOUR_EMPTY_OUTPUT_ERROR;
        }
        return;
      }
    },
  });

  // AI provider setup (graceful — AI features degrade if SDK unavailable)
  const aiRegistry = new ProviderRegistry();
  const aiSessionManager = new SessionManager();
  let aiEndpoints: AIEndpoints | null = null;

  // Try Claude Agent SDK
  try {
    await import("@plannotator/ai/providers/claude-agent-sdk");
    const claudePath = Bun.which("claude");
    const provider = await createProvider({
      type: "claude-agent-sdk",
      cwd: process.cwd(),
      ...(claudePath && { claudeExecutablePath: claudePath }),
    });
    aiRegistry.register(provider);
  } catch {
    // Claude SDK not available
  }

  // Try Codex SDK
  try {
    await import("@plannotator/ai/providers/codex-sdk");
    // Eagerly verify the SDK is importable so we don't advertise a broken provider.
    await import("@openai/codex-sdk");
    const codexPath = Bun.which("codex");
    const provider = await createProvider({
      type: "codex-sdk",
      cwd: process.cwd(),
      ...(codexPath && { codexExecutablePath: codexPath }),
    });
    aiRegistry.register(provider);
  } catch {
    // Codex SDK not available
  }

  // Try Pi
  try {
    const { PiSDKProvider } = await import("@plannotator/ai/providers/pi-sdk");
    const piPath = Bun.which("pi");
    if (piPath) {
      const provider = await createProvider({
        type: "pi-sdk",
        cwd: process.cwd(),
        piExecutablePath: piPath,
      } as PiSDKConfig);
      if (provider instanceof PiSDKProvider) {
        await provider.fetchModels();
      }
      aiRegistry.register(provider);
    }
  } catch {
    // Pi not available
  }

  // Try OpenCode
  try {
    const { OpenCodeProvider } = await import("@plannotator/ai/providers/opencode-sdk");
    const opencodePath = Bun.which("opencode");
    if (opencodePath) {
      const provider = await createProvider({
        type: "opencode-sdk",
        cwd: process.cwd(),
      });
      if (provider instanceof OpenCodeProvider) {
        await provider.fetchModels();
      }
      aiRegistry.register(provider);
    }
  } catch {
    // OpenCode not available
  }

  // Create endpoints if any provider registered
  if (aiRegistry.size > 0) {
    aiEndpoints = createAIEndpoints({
      registry: aiRegistry,
      sessionManager: aiSessionManager,
      getCwd: () => {
        if (options.agentCwd) return options.agentCwd;
        return resolveVcsCwd(currentDiffType, gitContext?.cwd) ?? process.cwd();
      },
    });
  }

  const isRemote = isRemoteSession();
  const configuredPort = getServerPort();
  const wslFlag = await isWSL();
  const gitUser = detectGitUser();

  // Detect repo info (cached for this session)
  // In PR mode, derive from metadata instead of local git
  const repoInfo = isPRMode
    ? { display: getDisplayRepo(prMetadata), branch: `${getMRLabel(prMetadata)} ${getMRNumberLabel(prMetadata)}` }
    : await getRepoInfo();

  // Fetch current platform user (for own-PR/MR detection)
  const prRef = isPRMode ? prRefFromMetadata(prMetadata) : null;
  const platformUser = prRef ? await getPRUser(prRef) : null;

  // Fetch GitHub viewed file state (non-blocking — errors are silently ignored)
  let initialViewedFiles: string[] = [];
  if (isPRMode && prRef) {
    try {
      const viewedMap = await fetchPRViewedFiles(prRef);
      initialViewedFiles = Object.entries(viewedMap)
        .filter(([, isViewed]) => isViewed)
        .map(([path]) => path);
    } catch {
      // Non-fatal: viewed state is best-effort
    }
  }

  // Decision promise
  let resolveDecision: (result: {
    approved: boolean;
    feedback: string;
    annotations: unknown[];
    agentSwitch?: string;
    exit?: boolean;
  }) => void;
  const decisionPromise = new Promise<{
    approved: boolean;
    feedback: string;
    annotations: unknown[];
    agentSwitch?: string;
    exit?: boolean;
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

          // API: Get tour result
          if (url.pathname.match(/^\/api\/tour\/[^/]+$/) && req.method === "GET") {
            const jobId = url.pathname.slice("/api/tour/".length);
            const result = tour.getTour(jobId);
            if (!result) return Response.json({ error: "Tour not found" }, { status: 404 });
            return Response.json(result);
          }

          // API: Save tour checklist state
          const checklistMatch = url.pathname.match(/^\/api\/tour\/([^/]+)\/checklist$/);
          if (checklistMatch && req.method === "PUT") {
            const jobId = checklistMatch[1];
            try {
              const body = await req.json() as { checked: boolean[] };
              if (Array.isArray(body.checked)) tour.saveChecklist(jobId, body.checked);
              return Response.json({ ok: true });
            } catch {
              return Response.json({ error: "Invalid JSON" }, { status: 400 });
            }
          }

          // API: Get diff content
          if (url.pathname === "/api/diff" && req.method === "GET") {
            return Response.json({
              rawPatch: currentPatch,
              gitRef: currentGitRef,
              origin,
              diffType: hasLocalAccess ? currentDiffType : undefined,
              // Echo the active base so a page refresh or reconnect rehydrates
              // the picker to what the server is actually using — not the
              // detected default.
              base: hasLocalAccess ? currentBase : undefined,
              gitContext: hasLocalAccess ? gitContext : undefined,
              sharingEnabled,
              shareBaseUrl,
              repoInfo,
              isWSL: wslFlag,
              ...(options.agentCwd && { agentCwd: options.agentCwd }),
              ...(isPRMode && { prMetadata, platformUser }),
              ...(isPRMode && initialViewedFiles.length > 0 && { viewedFiles: initialViewedFiles }),
              ...(currentError && { error: currentError }),
              serverConfig: getServerConfig(gitUser),
            });
          }

          // API: Switch diff type (requires local file access)
          if (url.pathname === "/api/diff/switch" && req.method === "POST") {
            if (!hasLocalAccess) {
              return Response.json(
                { error: "Not available without local file access" },
                { status: 400 },
              );
            }
            try {
              const body = (await req.json()) as { diffType: DiffType; base?: string };
              let newDiffType = body.diffType;

              if (!newDiffType) {
                return Response.json(
                  { error: "Missing diffType" },
                  { status: 400 }
                );
              }

              const detectedBase = gitContext?.defaultBranch || "main";
              // Guard against non-string payloads — resolveBaseBranch calls
              // string methods and would throw a TypeError otherwise. Mirrors
              // Pi's guard so both runtimes validate identically.
              const requestedBase = typeof body.base === "string" ? body.base : undefined;
              const base = resolveBaseBranch(requestedBase, detectedBase);
              const defaultCwd = gitContext?.cwd;

              // Run the new diff
              const result = await runVcsDiff(newDiffType, base, defaultCwd);

              // Update state
              currentPatch = result.patch;
              currentGitRef = result.label;
              currentDiffType = newDiffType;
              currentBase = base;
              baseEverSwitched = true;
              currentError = result.error;

              // Recompute gitContext for the effective cwd so the client's
              // sidebar (current branch, default branch, diff-mode options)
              // reflects the worktree we're now reviewing — not the main
              // repo's startup state. Best-effort: on failure the client
              // keeps its existing context.
              let updatedContext: GitContext | undefined;
              if (gitContext) {
                try {
                  const effectiveCwd = resolveVcsCwd(newDiffType, gitContext.cwd);
                  updatedContext = await getVcsContext(effectiveCwd);
                } catch {
                  /* best-effort */
                }
              }

              return Response.json({
                rawPatch: currentPatch,
                gitRef: currentGitRef,
                diffType: currentDiffType,
                // Echo the base the server actually used. resolveBaseBranch
                // trusts the caller verbatim; this echo lets the client
                // confirm the request landed (and pick it up when the client
                // didn't supply one and we fell back to detected default).
                base: currentBase,
                ...(updatedContext && { gitContext: updatedContext }),
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

            // Local review: read file contents from local git
            if (hasLocalAccess) {
              const detectedBase = gitContext?.defaultBranch || "main";
              const base = resolveBaseBranch(
                url.searchParams.get("base") ?? undefined,
                detectedBase,
              );
              const defaultCwd = gitContext?.cwd;
              const result = await getVcsFileContentsForDiff(
                currentDiffType,
                base,
                filePath,
                oldPath,
                defaultCwd,
              );
              return Response.json(result);
            }

            // PR mode: fetch from platform API using merge-base/head SHAs.
            // The diff is computed against the merge-base (common ancestor), not the
            // base branch tip. File contents must match the diff for hunk expansion.
            if (isPRMode) {
              const oldSha = prMetadata.mergeBaseSha ?? prMetadata.baseSha;
              const [oldContent, newContent] = await Promise.all([
                fetchPRFileContent(prRef!, oldSha, oldPath || filePath),
                fetchPRFileContent(prRef!, prMetadata.headSha, filePath),
              ]);
              return Response.json({ oldContent, newContent });
            }

            return Response.json({ error: "No file access available" }, { status: 400 });
          }

          // API: Stage / unstage a file (disabled when VCS doesn't support it)
          if (url.pathname === "/api/git-add" && req.method === "POST") {
            if (isPRMode || !canStageFiles(currentDiffType)) {
              return Response.json(
                { error: "Staging not available" },
                { status: 400 },
              );
            }
            try {
              const body = (await req.json()) as { filePath: string; undo?: boolean };
              if (!body.filePath) {
                return Response.json({ error: "Missing filePath" }, { status: 400 });
              }

              const cwd = resolveVcsCwd(currentDiffType, gitContext?.cwd);

              if (body.undo) {
                await unstageFile(currentDiffType, body.filePath, cwd);
              } else {
                await stageFile(currentDiffType, body.filePath, cwd);
              }

              return Response.json({ ok: true });
            } catch (err) {
              const message = err instanceof Error ? err.message : "Failed to stage file";
              return Response.json({ error: message }, { status: 500 });
            }
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

          // API: External annotations (SSE-based, for any external tool)
          const externalResponse = await externalAnnotations.handle(req, url, {
            disableIdleTimeout: () => server.timeout(req, 0),
          });
          if (externalResponse) return externalResponse;

          // API: Agent jobs (background review agents)
          const agentResponse = await agentJobs.handle(req, url, {
            disableIdleTimeout: () => server.timeout(req, 0),
          });
          if (agentResponse) return agentResponse;

          // API: Exit review session without feedback
          if (url.pathname === "/api/exit" && req.method === "POST") {
            deleteDraft(draftKey);
            resolveDecision({ approved: false, feedback: "", annotations: [], exit: true });
            return Response.json({ ok: true });
          }

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

              console.error(`[pr-action] ${body.action} with ${body.fileComments.length} file comment(s), headSha=${prMetadata.headSha}`);

              await submitPRReview(
                prRef!,
                prMetadata.headSha,
                body.action,
                body.body,
                body.fileComments,
              );

              console.error(`[pr-action] Success`);
              return Response.json({ ok: true, prUrl: prMetadata.url });
            } catch (err) {
              const message =
                err instanceof Error ? err.message : "Failed to submit PR review";
              console.error(`[pr-action] Failed: ${message}`);
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: Mark/unmark PR files as viewed on GitHub (PR mode, GitHub only)
          if (url.pathname === "/api/pr-viewed" && req.method === "POST") {
            if (!isPRMode || !prMetadata) {
              return Response.json({ error: "Not in PR mode" }, { status: 400 });
            }
            if (prMetadata.platform !== "github") {
              return Response.json({ error: "Viewed sync only supported for GitHub" }, { status: 400 });
            }
            const prNodeId = prMetadata.prNodeId;
            if (!prNodeId) {
              return Response.json({ error: "PR node ID not available" }, { status: 400 });
            }
            try {
              const body = (await req.json()) as {
                filePaths: string[];
                viewed: boolean;
              };
              await markPRFilesViewed(prRef!, prNodeId, body.filePaths, body.viewed);
              return Response.json({ ok: true });
            } catch (err) {
              const message =
                err instanceof Error ? err.message : "Failed to update viewed state";
              console.error("[plannotator] /api/pr-viewed error:", message);
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // AI endpoints
          if (aiEndpoints && url.pathname.startsWith("/api/ai/")) {
            const handler = aiEndpoints[url.pathname as keyof AIEndpoints];
            if (handler) return handler(req);
            return Response.json({ error: "Not found" }, { status: 404 });
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
        const hint = isRemote ? " (set PLANNOTATOR_PORT to use different port)" : "";
        throw new Error(`Port ${configuredPort} in use after ${MAX_RETRIES} retries${hint}`);
      }

      throw err;
    }
  }

  if (!server) {
    throw new Error("Failed to start server");
  }

  const port = server.port!;
  serverUrl = `http://localhost:${port}`;
  const exitHandler = () => agentJobs.killAll();
  process.once("exit", exitHandler);

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
      process.removeListener("exit", exitHandler);
      agentJobs.killAll();
      aiSessionManager.disposeAll();
      aiRegistry.disposeAll();
      server.stop();
      // Invoke cleanup callback (e.g., remove temp worktree)
      if (options.onCleanup) {
        try {
          const result = options.onCleanup();
          if (result instanceof Promise) result.catch(() => {});
        } catch { /* best effort */ }
      }
    },
  };
}
