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
import { type DiffType, type GitContext, runVcsDiff, getVcsFileContentsForDiff, canStageFiles, stageFile, unstageFile, resolveVcsCwd, validateFilePath, getVcsContext, detectRemoteDefaultCompareTarget, gitRuntime } from "./vcs";
import { parseWorktreeDiffType, resolveBaseBranch } from "@plannotator/shared/review-core";
import {
  getPRDiffScopeOptions,
  getPRStackInfo,
  resolveStackInfo,
  resolvePRFullStackBaseRef,
  runPRFullStackDiff,
  checkoutPRHead,
  type PRDiffScope,
} from "@plannotator/shared/pr-stack";
import type { AgentJobInfo } from "@plannotator/shared/agent-jobs";
import { getRepoInfo } from "./repo";
import { handleImage, handleUpload, handleAgents, handleServerReady, handleDraftSave, handleDraftLoad, handleDraftDelete, handleFavicon, type OpencodeClient } from "./shared-handlers";
import { contentHash, deleteDraft } from "./draft";
import { createEditorAnnotationHandler } from "./editor-annotations";
import { createExternalAnnotationHandler } from "./external-annotations";
import { createAgentJobHandler } from "./agent-jobs";
import {
  CODEX_REVIEW_SYSTEM_PROMPT,
  buildCodexCommand,
  generateOutputPath,
  parseCodexOutput,
  transformReviewFindings,
} from "./codex-review";
import { buildAgentReviewUserMessage } from "./agent-review-message";
import {
  CLAUDE_REVIEW_PROMPT,
  buildClaudeCommand,
  parseClaudeStreamOutput,
  transformClaudeFindings,
} from "./claude-review";
import { createTourSession, TOUR_EMPTY_OUTPUT_ERROR } from "./tour/tour-review";
import { loadConfig, saveConfig, detectGitUser, getServerConfig } from "./config";
import { type PRMetadata, type PRReviewFileComment, type PRStackTree, type PRListItem, fetchPR, fetchPRFileContent, fetchPRContext, submitPRReview, fetchPRViewedFiles, markPRFilesViewed, fetchPRStack, fetchPRList, getPRUser, parsePRUrl, prRefFromMetadata, isSameProject, getDisplayRepo, getMRLabel, getMRNumberLabel } from "./pr";
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
  /** Per-PR worktree pool. When set, pr-switch creates worktrees instead of checking out. */
  worktreePool?: import("@plannotator/shared/worktree-pool").WorktreePool;
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
  const { htmlContent, origin, gitContext, sharingEnabled = true, shareBaseUrl, onReady } = options;

  let prMetadata = options.prMetadata;
  const isPRMode = !!prMetadata;
  const hasLocalAccess = !!gitContext;
  const sessionVcsType = gitContext?.vcsType;
  let draftKey = contentHash(options.rawPatch);
  const editorAnnotations = createEditorAnnotationHandler();
  const externalAnnotations = createExternalAnnotationHandler("review");

  const tour = createTourSession();

  // Mutable state for diff switching
  let currentPatch = options.rawPatch;
  let currentGitRef = options.gitRef;
  let currentDiffType: DiffType = options.diffType || "uncommitted";
  let currentError = options.error;
  let currentHideWhitespace = loadConfig().diffOptions?.hideWhitespace ?? false;
  let originalPRPatch = options.rawPatch;
  let originalPRGitRef = options.gitRef;
  let originalPRError = options.error;
  let currentPRDiffScope: PRDiffScope = "layer";
  let prListCache: PRListItem[] | null = null;
  let prListCacheTime = 0;
  const prSwitchCache = new Map<string, { metadata: PRMetadata; rawPatch: string }>();
  if (isPRMode && prMetadata) prSwitchCache.set(prMetadata.url, { metadata: prMetadata, rawPatch: options.rawPatch });
  const prStackTreeCache = new Map<string, PRStackTree | null>();
  // Tracks the base branch the user picked from the UI. Agent review prompts
  // read this (not gitContext.defaultBranch) so they analyze the same diff
  // the reviewer is currently looking at. Honors an explicit initialBase from
  // the caller — e.g. programmatic Pi callers can request a non-detected base.
  const detectedCompareTarget = (): string => gitContext?.defaultBranch || gitContext?.compareTarget?.fallback || "main";
  let currentBase = options.initialBase || detectedCompareTarget();
  let baseEverSwitched = false;

  const resolveReviewBase = (requestedBase?: string): string => {
    return resolveBaseBranch(requestedBase, detectedCompareTarget());
  };

  // Fire-and-forget: query the remote for its actual default branch. If it
  // arrives before the user interacts, quietly upgrade currentBase from the
  // local fallback (e.g. "main") to the upstream ref (e.g. "origin/main").
  // Non-blocking — the server is already listening by the time this resolves.
  if (gitContext && !options.initialBase && !isPRMode) {
    detectRemoteDefaultCompareTarget(gitContext.cwd, sessionVcsType).then((remote) => {
      if (remote && !baseEverSwitched) currentBase = remote;
    });
  }

  // Agent jobs — background process manager (late-binds serverUrl via getter)
  let serverUrl = "";
  const resolveAgentCwd = (): string => {
    if (options.worktreePool && prMetadata) {
      const poolPath = options.worktreePool.resolve(prMetadata.url);
      if (poolPath) return poolPath;
    }
    return options.agentCwd ?? resolveVcsCwd(currentDiffType, gitContext?.cwd) ?? process.cwd();
  };
  const agentJobs = createAgentJobHandler({
    mode: "review",
    getServerUrl: () => serverUrl,
    getCwd: resolveAgentCwd,

    async buildCommand(provider, config) {
      const cwd = resolveAgentCwd();
      const hasAgentLocalAccess = !!options.worktreePool || !!options.agentCwd || !!gitContext;
      const userMessageOptions = { defaultBranch: currentBase, hasLocalAccess: hasAgentLocalAccess, prDiffScope: currentPRDiffScope };

      // Snapshot the diff context at launch — stored on the job so
      // downstream "Copy All" produces the same markdown as /api/feedback
      // would right now, even if the reviewer switches modes/bases later.
      // Skipped in PR mode (prMetadata carries equivalent context).
      const worktreeParts = currentDiffType.startsWith("worktree:")
        ? parseWorktreeDiffType(currentDiffType)
        : null;
      const launchPrUrl = prMetadata?.url;
      const launchDiffScope = isPRMode ? currentPRDiffScope : undefined;
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
        return built ? { ...built, prUrl: launchPrUrl, diffScope: launchDiffScope, diffContext } : built;
      }

      const userMessage = buildAgentReviewUserMessage(currentPatch, currentDiffType, userMessageOptions, prMetadata);

      if (provider === "codex") {
        const model = typeof config?.model === "string" && config.model ? config.model : undefined;
        const reasoningEffort = typeof config?.reasoningEffort === "string" && config.reasoningEffort ? config.reasoningEffort : undefined;
        const fastMode = config?.fastMode === true;
        const outputPath = generateOutputPath();
        const prompt = CODEX_REVIEW_SYSTEM_PROMPT + "\n\n---\n\n" + userMessage;
        const command = await buildCodexCommand({ cwd, outputPath, prompt, model, reasoningEffort, fastMode });
        return { command, outputPath, prompt, cwd, label: "Code Review", model, reasoningEffort, fastMode: fastMode || undefined, prUrl: launchPrUrl, diffScope: launchDiffScope, diffContext };
      }

      if (provider === "claude") {
        const model = typeof config?.model === "string" && config.model ? config.model : undefined;
        const effort = typeof config?.effort === "string" && config.effort ? config.effort : undefined;
        const prompt = CLAUDE_REVIEW_PROMPT + "\n\n---\n\n" + userMessage;
        const { command, stdinPrompt } = buildClaudeCommand(prompt, model, effort);
        return { command, stdinPrompt, prompt, cwd, label: "Code Review", captureStdout: true, model, effort, prUrl: launchPrUrl, diffScope: launchDiffScope, diffContext };
      }

      return null;
    },

    async onJobComplete(job, meta) {
      const cwd = meta.cwd ?? resolveAgentCwd();
      const jobPrUrl = job.prUrl;
      const jobDiffScope = job.diffScope;
      const jobPrMeta = jobPrUrl ? prSwitchCache.get(jobPrUrl)?.metadata : undefined;
      const jobPrContext = jobPrMeta ? {
        prUrl: jobPrUrl,
        prNumber: jobPrMeta.platform === "github" ? jobPrMeta.number : jobPrMeta.iid,
        prTitle: jobPrMeta.title,
        prRepo: getDisplayRepo(jobPrMeta),
      } : jobPrUrl ? { prUrl: jobPrUrl } : {};

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
          const annotations = transformReviewFindings(output.findings, job.source, cwd, "Codex")
            .map(a => ({ ...a, ...jobPrContext, ...(jobDiffScope && { diffScope: jobDiffScope }) }));
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
          const annotations = transformClaudeFindings(output.findings, job.source, cwd)
            .map(a => ({ ...a, ...jobPrContext, ...(jobDiffScope && { diffScope: jobDiffScope }) }));
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
      getCwd: resolveAgentCwd,
    });
  }

  const isRemote = isRemoteSession();
  const configuredPort = getServerPort();
  const wslFlag = await isWSL();
  const gitUser = detectGitUser();

  // Detect repo info (cached for this session)
  // In PR mode, derive from metadata instead of local git
  let repoInfo = isPRMode && prMetadata
    ? { display: getDisplayRepo(prMetadata), branch: `${getMRLabel(prMetadata)} ${getMRNumberLabel(prMetadata)}` }
    : await getRepoInfo();
  if (gitContext?.repository?.displayFallback) {
    repoInfo = {
      ...repoInfo,
      display: repoInfo?.display || gitContext.repository.displayFallback,
    };
  }

  // Fetch current platform user (for own-PR/MR detection)
  let prRef = isPRMode && prMetadata ? prRefFromMetadata(prMetadata) : null;
  const platformUser = prRef ? await getPRUser(prRef) : null;
  let prStackInfo = prMetadata ? getPRStackInfo(prMetadata) : null;
  let prDiffScopeOptions = prMetadata
    ? getPRDiffScopeOptions(prMetadata, !!(options.worktreePool || options.agentCwd))
    : [];

  // Fetch full stack tree (best-effort — always try in PR mode so root PRs
  // that target the default branch can still discover descendant PRs)
  let prStackTree: PRStackTree | null = null;
  if (prRef && prMetadata) {
    try {
      prStackTree = await fetchPRStack(prRef, prMetadata);
    } catch {
      // Non-fatal: client falls back to buildMinimalStackTree()
    }
    prStackTreeCache.set(prMetadata.url, prStackTree);
    const resolved = resolveStackInfo(prMetadata, prStackTree, prStackInfo);
    if (resolved && !prStackInfo) {
      prStackInfo = resolved;
      prDiffScopeOptions = getPRDiffScopeOptions(prMetadata, !!(options.worktreePool || options.agentCwd));
    }
  }

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
              hideWhitespace: currentHideWhitespace,
              gitContext: hasLocalAccess ? gitContext : undefined,
              sharingEnabled,
              shareBaseUrl,
              repoInfo,
              isWSL: wslFlag,
              ...(options.agentCwd && { agentCwd: options.agentCwd }),
              ...(isPRMode && {
                prMetadata,
                platformUser,
                prStackInfo,
                prStackTree,
                prDiffScope: currentPRDiffScope,
                prDiffScopeOptions,
              }),
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
              const body = (await req.json()) as { diffType: DiffType; base?: string; hideWhitespace?: boolean };
              let newDiffType = body.diffType;

              if (!newDiffType) {
                return Response.json(
                  { error: "Missing diffType" },
                  { status: 400 }
                );
              }

              if (typeof body.hideWhitespace === "boolean") {
                currentHideWhitespace = body.hideWhitespace;
              }

              // Guard against non-string payloads — resolveBaseBranch calls
              // string methods and would throw a TypeError otherwise. Mirrors
              // Pi's guard so both runtimes validate identically.
              const requestedBase = typeof body.base === "string" ? body.base : undefined;
              const base = resolveReviewBase(requestedBase);
              const defaultCwd = gitContext?.cwd;

              // Run the new diff
              const result = await runVcsDiff(newDiffType, base, defaultCwd, {
                hideWhitespace: currentHideWhitespace,
              });

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
                  updatedContext = await getVcsContext(effectiveCwd, sessionVcsType);
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
                hideWhitespace: currentHideWhitespace,
                ...(updatedContext && { gitContext: updatedContext }),
                ...(currentError && { error: currentError }),
              });
            } catch (err) {
              const message =
                err instanceof Error ? err.message : "Failed to switch diff";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: Switch PR diff scope between the platform layer diff and a local full-stack diff.
          if (url.pathname === "/api/pr-diff-scope" && req.method === "POST") {
            if (!isPRMode || !prMetadata) {
              return Response.json({ error: "Not in PR mode" }, { status: 400 });
            }

            try {
              const body = (await req.json()) as { scope?: PRDiffScope };
              if (body.scope !== "layer" && body.scope !== "full-stack") {
                return Response.json({ error: "Invalid PR diff scope" }, { status: 400 });
              }

              if (body.scope === "layer") {
                currentPatch = originalPRPatch;
                currentGitRef = originalPRGitRef;
                currentError = originalPRError;
                currentPRDiffScope = "layer";
                return Response.json({
                  rawPatch: currentPatch,
                  gitRef: currentGitRef,
                  prDiffScope: currentPRDiffScope,
                  ...(currentError && { error: currentError }),
                });
              }

              const fullStackOption = prDiffScopeOptions.find((option) => option.id === "full-stack");
              if (!fullStackOption?.enabled || !(options.worktreePool || options.agentCwd)) {
                return Response.json(
                  { error: "Full stack diff requires a stacked PR and a local checkout" },
                  { status: 400 },
                );
              }

              const fullStackCwd = (options.worktreePool && prMetadata ? options.worktreePool.resolve(prMetadata.url) : undefined) ?? options.agentCwd;
              const result = await runPRFullStackDiff(gitRuntime, prMetadata, fullStackCwd);

              if (result.error) {
                return Response.json({ error: result.error }, { status: 400 });
              }

              currentPatch = result.patch;
              currentGitRef = result.label;
              currentError = undefined;
              currentPRDiffScope = "full-stack";

              return Response.json({
                rawPatch: currentPatch,
                gitRef: currentGitRef,
                prDiffScope: currentPRDiffScope,
              });
            } catch (err) {
              const message =
                err instanceof Error ? err.message : "Failed to switch PR diff scope";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: List PRs for the current repo (cached for 30s)
          if (url.pathname === "/api/pr-list" && req.method === "GET") {
            if (!isPRMode || !prRef) {
              return Response.json({ error: "Not in PR mode" }, { status: 400 });
            }
            try {
              const now = Date.now();
              if (prListCache && now - prListCacheTime < 30_000) {
                return Response.json({ prs: prListCache });
              }
              const prs = await fetchPRList(prRef);
              prListCache = prs;
              prListCacheTime = now;
              return Response.json({ prs });
            } catch (err) {
              return Response.json({ error: "Failed to fetch PR list" }, { status: 500 });
            }
          }

          // API: Switch to a different PR in the stack (in-place navigation)
          if (url.pathname === "/api/pr-switch" && req.method === "POST") {
            if (!isPRMode || !prRef) {
              return Response.json({ error: "Not in PR mode" }, { status: 400 });
            }

            try {
              const body = (await req.json()) as { url?: string };
              if (!body.url) {
                return Response.json({ error: "Missing PR URL" }, { status: 400 });
              }

              const newRef = parsePRUrl(body.url);
              if (!newRef) {
                return Response.json({ error: "Invalid PR URL" }, { status: 400 });
              }
              if (!isSameProject(newRef, prRef!)) {
                return Response.json({ error: "Cannot switch to a PR in a different repository" }, { status: 400 });
              }

              const cached = prSwitchCache.get(body.url);
              const pr = cached ?? await fetchPR(newRef);
              if (!cached) prSwitchCache.set(body.url, pr);

              // Update mutable server state
              prMetadata = pr.metadata;
              prRef = prRefFromMetadata(pr.metadata);
              currentPatch = pr.rawPatch;
              currentGitRef = `${getMRLabel(pr.metadata)} ${getMRNumberLabel(pr.metadata)}`;
              currentError = undefined;
              originalPRPatch = pr.rawPatch;
              originalPRGitRef = currentGitRef;
              originalPRError = undefined;
              currentPRDiffScope = "layer";
              draftKey = contentHash(pr.rawPatch);
              prListCache = null;

              // Recompute stack info
              prStackInfo = getPRStackInfo(pr.metadata);

              // Fetch stack tree (cached per PR for the session)
              if (prStackTreeCache.has(body.url)) {
                prStackTree = prStackTreeCache.get(body.url) ?? null;
              } else {
                try {
                  prStackTree = await fetchPRStack(prRef, pr.metadata);
                } catch {
                  prStackTree = null;
                }
                prStackTreeCache.set(body.url, prStackTree);
              }

              // Ensure worktree for the new PR (pool creates a fresh one, no shared-state mutation)
              let hasLocalForNewPR = false;
              if (options.worktreePool) {
                try {
                  await options.worktreePool.ensure(gitRuntime, pr.metadata);
                  hasLocalForNewPR = true;
                } catch {
                  // Pool creation failed — full-stack will be disabled
                }
              } else if (options.agentCwd) {
                hasLocalForNewPR = await checkoutPRHead(gitRuntime, pr.metadata, options.agentCwd);
              }

              prStackInfo = resolveStackInfo(pr.metadata, prStackTree, prStackInfo);

              prDiffScopeOptions = prStackInfo
                ? getPRDiffScopeOptions(pr.metadata, hasLocalForNewPR)
                : [];

              // Fetch viewed files for the new PR
              let switchedViewedFiles: string[] = [];
              try {
                const viewedMap = await fetchPRViewedFiles(prRef);
                switchedViewedFiles = Object.entries(viewedMap)
                  .filter(([, isViewed]) => isViewed)
                  .map(([path]) => path);
              } catch {
                // Non-fatal
              }
              initialViewedFiles = switchedViewedFiles;

              repoInfo = {
                display: getDisplayRepo(pr.metadata),
                branch: `${getMRLabel(pr.metadata)} ${getMRNumberLabel(pr.metadata)}`,
              };

              return Response.json({
                rawPatch: currentPatch,
                gitRef: currentGitRef,
                prMetadata: pr.metadata,
                prStackInfo,
                prStackTree,
                prDiffScope: currentPRDiffScope,
                prDiffScopeOptions,
                repoInfo,
                ...(switchedViewedFiles.length > 0 && { viewedFiles: switchedViewedFiles }),
                ...(currentError ? { error: currentError } : {}),
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : "Failed to switch PR";
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

            // Full-stack PR mode uses local git for file expansion because
            // the patch is no longer the platform's layer diff.
            const fileContentCwd = (options.worktreePool && prMetadata) ? options.worktreePool.resolve(prMetadata.url) : options.agentCwd;
            if (
              isPRMode &&
              currentPRDiffScope === "full-stack" &&
              fileContentCwd &&
              prMetadata?.defaultBranch
            ) {
              const baseRef = await resolvePRFullStackBaseRef(
                gitRuntime,
                prMetadata!.defaultBranch,
                fileContentCwd,
              );
              if (!baseRef) {
                return Response.json(
                  { oldContent: null, newContent: null },
                );
              }
              const result = await getVcsFileContentsForDiff(
                "merge-base",
                baseRef,
                filePath,
                oldPath,
                fileContentCwd,
              );
              return Response.json(result);
            }

            // Local review: read file contents from local git
            if (hasLocalAccess) {
              const requestedBase = url.searchParams.get("base") ?? undefined;
              const base = resolveReviewBase(requestedBase);
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
            if (isPRMode && prMetadata) {
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
            const stageCwd = resolveVcsCwd(currentDiffType, gitContext?.cwd);
            if (isPRMode || !(await canStageFiles(currentDiffType, stageCwd))) {
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

              if (body.undo) {
                await unstageFile(currentDiffType, body.filePath, stageCwd);
              } else {
                await stageFile(currentDiffType, body.filePath, stageCwd);
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
                targetPrUrl?: string;
              };

              // Resolve target PR — either explicit target or current.
              // When targetPrUrl is provided, the client has already filtered
              // annotations by diffScope, so we skip the server-side scope guard.
              let targetRef = prRef!;
              let targetHeadSha = prMetadata.headSha;
              let targetUrl = prMetadata.url;

              if (body.targetPrUrl) {
                const cached = prSwitchCache.get(body.targetPrUrl);
                if (!cached) {
                  return Response.json({ error: "Target PR not found in session" }, { status: 400 });
                }
                targetRef = prRefFromMetadata(cached.metadata);
                targetHeadSha = cached.metadata.headSha;
                targetUrl = cached.metadata.url;
              } else if (currentPRDiffScope !== "layer") {
                return Response.json(
                  { error: "Switch to Layer diff before posting a platform review" },
                  { status: 400 },
                );
              }

              console.error(`[pr-action] ${body.action} with ${body.fileComments.length} file comment(s), target=${targetUrl}, headSha=${targetHeadSha}`);

              await submitPRReview(
                targetRef,
                targetHeadSha,
                body.action,
                body.body,
                body.fileComments,
              );

              console.error(`[pr-action] Success`);
              return Response.json({ ok: true, prUrl: targetUrl });
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
