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
import { type DiffType, type GitContext, runVcsDiff, getVcsFileContentsForDiff, getVcsDiffFingerprint, canStageFiles, stageFile, unstageFile, resolveVcsCwd, validateFilePath, getVcsContext, detectRemoteDefaultCompareTarget, gitRuntime } from "./vcs";
import { basename } from "node:path";
import { existsSync } from "node:fs";
import { parseWorktreeDiffType, resolveBaseBranch } from "@plannotator/shared/review-core";
import {
  createDefaultSemanticDiffRuntime,
  getSemanticDiffAvailability,
  getSemanticDiffScratchCwd,
  runSemanticDiff,
  semanticDiffCacheKey,
  semanticDiffFileExtsFromSearchParams,
  SemanticDiffResponseCache,
} from "@plannotator/shared/semantic-diff";
import type { SemanticDiffAvailability, SemanticDiffResponse } from "@plannotator/shared/semantic-diff-types";
import {
  getPRDiffScopeOptions,
  getPRFullStackFingerprint,
  getPRStackInfo,
  resolveStackInfo,
  resolvePRFullStackBaseRef,
  runPRFullStackDiff,
  runPRLayerLocalDiff,
  checkoutPRHead,
  type PRDiffScope,
} from "@plannotator/shared/pr-stack";
import type { AgentJobInfo } from "@plannotator/shared/agent-jobs";
import { getRepoInfo } from "./repo";
import { handleImage, handleUpload, handleAgents, handleServerReady, handleDraftSave, handleDraftLoad, handleDraftDelete, handleFavicon, readDraftGenerationFromBody, readDraftGenerationFromUrl, type OpencodeClient } from "./shared-handlers";
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
import { buildAgentReviewUserMessage, buildAgentReviewUserMessageForTarget, type WorkspaceReviewPromptContext } from "./agent-review-message";
import {
  CLAUDE_REVIEW_PROMPT,
  buildClaudeCommand,
  parseClaudeStreamOutput,
  transformClaudeFindings,
} from "./claude-review";
import { createTourSession, TOUR_EMPTY_OUTPUT_ERROR } from "./tour/tour-review";
import {
  CURSOR_REVIEW_PROMPT,
  buildCursorCommand,
  parseCursorStreamOutput,
  transformCursorFindings,
} from "./cursor-review";
import { loadConfig, saveConfig, detectGitUser, getServerConfig } from "./config";
import { type PRMetadata, type PRReviewFileComment, type PRStackTree, type PRListItem, fetchPR, fetchPRFileContent, fetchPRContext, submitPRReview, fetchPRViewedFiles, markPRFilesViewed, fetchPRStack, fetchPRList, getPRUser, parsePRUrl, prRefFromMetadata, isSameProject, getDisplayRepo, getMRLabel, getMRNumberLabel } from "./pr";
import { AI_QUERY_ENDPOINT, createAIRuntime } from "./ai-runtime";
import type { AIEndpoints } from "@plannotator/ai";
import { isWSL } from "./browser";
import { handleOpenInApps, handleOpenIn } from "./open-in";
import type { LocalWorkspaceReview, WorkspaceDiffType } from "./review-workspace";
import { handleCodeNavResolve, extractChangedFiles } from "./code-nav";

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
  diffType?: DiffType | WorkspaceDiffType;
  /** Git context with branch info and available diff options */
  gitContext?: GitContext;
  /** Local parent directory containing multiple child VCS repositories. */
  workspace?: LocalWorkspaceReview;
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
  /**
   * The initial layer patch is missing per-file content (platform APIs
   * withhold patches on very large PRs). Enables the local recompute upgrade
   * once a pool checkout is ready.
   */
  prPatchIncomplete?: boolean;
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
  const workspace = options.workspace;
  const isWorkspaceMode = !!workspace;
  const hasLocalAccess = !!gitContext;
  const sessionVcsType = gitContext?.vcsType;
  let draftKey = contentHash(options.rawPatch);
  const editorAnnotations = createEditorAnnotationHandler();
  const externalAnnotations = createExternalAnnotationHandler("review");

  const tour = createTourSession();

  // Mutable state for diff switching
  let currentPatch = options.rawPatch;
  let currentGitRef = options.gitRef;
  let currentDiffType: DiffType | WorkspaceDiffType = options.diffType || workspace?.diffType || "uncommitted";
  let currentError = options.error;
  let currentHideWhitespace = loadConfig().diffOptions?.hideWhitespace ?? false;
  let originalPRPatch = options.rawPatch;
  let originalPRGitRef = options.gitRef;
  let originalPRError = options.error;
  let currentPRDiffScope: PRDiffScope = "layer";
  // Monotonic guard for PR scope/switch state writes. Scope requests now park
  // on long awaits (checkout warmup, full recompute) — a request that resumed
  // after a NEWER scope select or pr-switch must not overwrite their state.
  let prScopeEpoch = 0;
  // Platform APIs withhold per-file patches on very large PRs. When the layer
  // patch is incomplete, a local recompute (exact merge-base diff, no size
  // limits) becomes available once the checkout warmup finishes — the layer
  // fingerprint flips to drive the refresh notice, and the pr-diff-scope
  // "layer" branch performs the upgrade. Tracked per-PR across pr-switch.
  // Partiality is INFORMATION (the platform withheld content) and is always
  // reported; whether a local recompute can be OFFERED is a separate
  // capability, gated on the pool below (layerUpgradeAvailable).
  let layerPatchIncomplete = (options.prPatchIncomplete ?? false) && isPRMode;
  const layerUpgradeAvailable = !!options.worktreePool;
  let prListCache: PRListItem[] | null = null;
  let prListCacheTime = 0;
  const prSwitchCache = new Map<string, { metadata: PRMetadata; rawPatch: string; patchIncomplete?: boolean }>();
  if (isPRMode && prMetadata) {
    prSwitchCache.set(prMetadata.url, {
      metadata: prMetadata,
      rawPatch: options.rawPatch,
      patchIncomplete: layerPatchIncomplete,
    });
  }
  const prStackTreeCache = new Map<string, PRStackTree | null>();
  // Tracks the base branch the user picked from the UI. Agent review prompts
  // read this (not gitContext.defaultBranch) so they analyze the same diff
  // the reviewer is currently looking at. Honors an explicit initialBase from
  // the caller — e.g. programmatic Pi callers can request a non-detected base.
  const detectedCompareTarget = (): string => gitContext?.defaultBranch || gitContext?.compareTarget?.fallback || "main";
  let currentBase = options.initialBase || detectedCompareTarget();
  let baseEverSwitched = false;

  // --- PR local checkout resolution -----------------------------------------
  // The pool's initial entry may still be warming up: the checkout is built in
  // the background so the server can start on the platform diff alone. Three
  // states matter:
  //   ready entry      → use its path
  //   entry, not ready → the path does not exist on disk yet (or warmup
  //                      failed) — never hand it out; options.agentCwd points
  //                      at the same not-yet-created path
  //   no entry         → PR not in the pool (e.g. cross-repo pr-switch) —
  //                      legacy fallback to the initial checkout (agentCwd)
  // The initial checkout path is only trustworthy once it actually exists —
  // the warmup may not have created it yet, or may have failed and removed it.
  const agentCwdIfExists = (): string | undefined =>
    options.agentCwd && existsSync(options.agentCwd) ? options.agentCwd : undefined;
  const resolvePRLocalCwd = (meta: PRMetadata | undefined = prMetadata): string | undefined => {
    const pool = options.worktreePool;
    if (pool && meta) {
      const entry = pool.get(meta.url);
      if (entry?.ready) return entry.path;
      if (entry) return undefined;
    }
    return agentCwdIfExists();
  };
  // Failure memo: a persistently-failing checkout (network down, ref denied)
  // must not turn every code-nav hover / agent launch into a multi-second
  // re-fetch against origin. Failed URLs are skipped for a cooldown window.
  const prLocalFailureMemo = new Map<string, number>();
  const PR_LOCAL_RETRY_COOLDOWN_MS = 30_000;
  // Await the current PR's checkout: blocks on the in-flight warmup, retries
  // failed same-repo creations, returns undefined when no checkout can exist.
  const ensurePRLocalCwd = async (meta: PRMetadata | undefined = prMetadata): Promise<string | undefined> => {
    const pool = options.worktreePool;
    if (pool && meta) {
      const hadEntry = pool.has(meta.url);
      const failedAt = prLocalFailureMemo.get(meta.url);
      if (failedAt && Date.now() - failedAt < PR_LOCAL_RETRY_COOLDOWN_MS) {
        return hadEntry ? undefined : agentCwdIfExists();
      }
      try {
        const entry = await pool.ensure(gitRuntime, meta);
        prLocalFailureMemo.delete(meta.url);
        return entry.path;
      } catch {
        prLocalFailureMemo.set(meta.url, Date.now());
        return hadEntry ? undefined : agentCwdIfExists();
      }
    }
    return options.agentCwd;
  };

  // --- Diff staleness fingerprint -------------------------------------------
  // Captured beside every patch snapshot (startup + every switch endpoint);
  // GET /api/diff/fresh recomputes and compares so the client can show a
  // "diff out of date — refresh" notice when files change mid-review (e.g. an
  // agent editing/committing while the user reviews). Best-effort everywhere:
  // null means "cannot fingerprint" and is reported as fresh, never stale.
  let currentFingerprint: string | null = null;
  const computeDiffFingerprint = async (): Promise<string | null> => {
    try {
      if (workspace) return await workspace.getFingerprint();
      if (isPRMode) {
        if (currentPRDiffScope === "layer") {
          // Platform-computed diff — immutable locally. The :incomplete
          // suffix keeps the baseline honest across the local-recompute
          // upgrade (the upgrade recaptures without it); the upgrade notice
          // itself is client-driven via prPatchIncomplete, not this probe.
          // Recaptured on pr-switch; remote-side PR updates are out of scope.
          const suffix = layerPatchIncomplete ? ":incomplete" : "";
          return `pr-layer:${prMetadata?.url ?? ""}${suffix}`;
        }
        // Full-stack: three-dot diff against the local checkout — fingerprint
        // (merge-base, HEAD), which changes exactly when the patch can.
        const fullStackCwd = resolvePRLocalCwd();
        if (!prMetadata) return null;
        return await getPRFullStackFingerprint(gitRuntime, prMetadata, fullStackCwd);
      }
      if (!hasLocalAccess) return null;
      return await getVcsDiffFingerprint(currentDiffType as DiffType, currentBase, gitContext?.cwd, {
        hideWhitespace: currentHideWhitespace,
      });
    } catch {
      return null;
    }
  };
  // Fire-and-forget capture: never delays the snapshot response it describes.
  // Generation-guarded: two rapid switches can resolve their captures out of
  // order — only the LATEST capture may write the baseline, otherwise a stale
  // fingerprint would make /api/diff/fresh report stale forever.
  let fingerprintGeneration = 0;
  const captureDiffFingerprint = (): void => {
    const generation = ++fingerprintGeneration;
    void computeDiffFingerprint().then((fingerprint) => {
      if (generation === fingerprintGeneration) currentFingerprint = fingerprint;
    });
  };
  captureDiffFingerprint();

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
    if (workspace) return workspace.root;
    if (options.worktreePool && prMetadata) {
      return resolvePRLocalCwd()
        ?? resolveVcsCwd(currentDiffType as DiffType, gitContext?.cwd)
        ?? process.cwd();
    }
    return options.agentCwd ?? resolveVcsCwd(currentDiffType as DiffType, gitContext?.cwd) ?? process.cwd();
  };
  // Strict launch root for /api/open-in: in PR pool mode only the PR's own
  // checkout is acceptable — never the launch-repo fallback resolveAgentCwd
  // uses, which would open a file from the wrong tree. Returns [] until the
  // checkout is ready so resolveOpenInTarget rejects (the button is gated off
  // then anyway); non-PR resolves to the working tree as usual.
  const resolveOpenInRoot = (): string | string[] => {
    if (workspace) return workspace.root;
    if (options.worktreePool && prMetadata) return resolvePRLocalCwd() ?? [];
    return options.agentCwd ?? resolveVcsCwd(currentDiffType as DiffType, gitContext?.cwd) ?? process.cwd();
  };
  // Async sibling of resolveAgentCwd: waits for the current PR's checkout
  // warmup instead of falling back while it is still being created.
  const resolveAgentCwdReady = async (): Promise<string> => {
    if (options.worktreePool && prMetadata) {
      const poolPath = await ensurePRLocalCwd();
      if (poolPath) return poolPath;
    }
    return resolveAgentCwd();
  };
  const getWorkspacePromptContext = (): WorkspaceReviewPromptContext | undefined => {
    if (!workspace) return undefined;
    return workspace.getPromptContext();
  };
  const semanticDiffScratchCwd = getSemanticDiffScratchCwd();
  const resolveSemanticDiffCwd = (): string => {
    if (workspace) return workspace.root;
    if (options.worktreePool && prMetadata) {
      const poolPath = resolvePRLocalCwd();
      if (poolPath) return poolPath;
      // Checkout warming up — probe sem availability in the scratch dir; the
      // real run below awaits the checkout before resolving its cwd.
      if (options.worktreePool.has(prMetadata.url)) return semanticDiffScratchCwd;
    }
    if (options.agentCwd) return options.agentCwd;
    if (gitContext) {
      const vcsCwd = resolveVcsCwd(currentDiffType as DiffType, gitContext.cwd);
      if (vcsCwd) return vcsCwd;
      if (gitContext.cwd) return gitContext.cwd;
    }
    return semanticDiffScratchCwd;
  };
  const semanticDiffCache = new SemanticDiffResponseCache();
  const semanticDiffAvailabilityCache = new Map<string, Promise<SemanticDiffAvailability>>();

  const createSemanticDiffRuntime = (cwd: string) => ({
    ...createDefaultSemanticDiffRuntime(),
    cwd,
  });

  const getSemanticDiffAvailabilityForCwd = (cwd: string): Promise<SemanticDiffAvailability> => {
    const cached = semanticDiffAvailabilityCache.get(cwd);
    if (cached) return cached;

    const next: Promise<SemanticDiffAvailability> = getSemanticDiffAvailability(createSemanticDiffRuntime(cwd)).catch((error) => ({
      available: false,
      reason: "sem-probe-failed",
      message: error instanceof Error ? error.message : String(error),
    }));
    semanticDiffAvailabilityCache.set(cwd, next);
    return next;
  };

  const getSemanticDiffAdvert = async () => {
    const availability = await getSemanticDiffAvailabilityForCwd(resolveSemanticDiffCwd());
    return {
      available: availability.available,
      ...(availability.semVersion && { semVersion: availability.semVersion }),
      ...(availability.semSource && { semSource: availability.semSource }),
    };
  };

  const getSemanticDiff = async (url: URL): Promise<SemanticDiffResponse> => {
    // Semantic diff reads real files — wait out the checkout warmup in PR mode.
    if (isPRMode && options.worktreePool) await ensurePRLocalCwd();
    const cwd = resolveSemanticDiffCwd();
    const fileExts = semanticDiffFileExtsFromSearchParams(url.searchParams);
    const cacheKey = semanticDiffCacheKey({ rawPatch: currentPatch, cwd, fileExts });
    const cached = semanticDiffCache.get(cacheKey, currentPatch);
    if (cached) return cached;

    const result = await runSemanticDiff(
      { rawPatch: currentPatch, cwd, fileExts },
      createSemanticDiffRuntime(cwd),
    );
    if (result.status === "ok") {
      semanticDiffCache.set(cacheKey, currentPatch, result);
    } else if (result.status === "error") {
      // Cooldown-memoized: request rate (file badges remount on scroll) must
      // not drive sem execution rate when it's failing.
      semanticDiffCache.setFailure(cacheKey, currentPatch, result);
    }
    return result;
  };

  const agentJobs = createAgentJobHandler({
    mode: "review",
    getServerUrl: () => serverUrl,
    getCwd: resolveAgentCwd,

    async buildCommand(provider, config) {
      // Snapshot ALL launch-relevant state before any await: waiting out the
      // checkout warmup below yields to other requests (e.g. pr-switch), and
      // the job's cwd, prompt, and PR attribution must describe the same PR.
      const launchMetadata = prMetadata;
      const launchPatch = currentPatch;
      const launchDiffType = currentDiffType;
      const launchBase = currentBase;
      const launchScope = currentPRDiffScope;

      // Agents run inside the PR checkout — wait out the background warmup so
      // the spawn-time getCwd() below resolves to a path that exists.
      let cwd: string;
      if (options.worktreePool && launchMetadata) {
        const checkout = await ensurePRLocalCwd(launchMetadata);
        if (!checkout) {
          // Fail fast: without the checkout the job would run in whatever
          // directory the CLI was launched from — possibly an unrelated repo.
          throw new Error(
            "Local PR checkout unavailable — the agent can't run against the PR files. Retry shortly (the checkout may still be recovering).",
          );
        }
        cwd = checkout;
      } else {
        cwd = await resolveAgentCwdReady();
      }
      const workspacePrompt = getWorkspacePromptContext();
      // Honest local-access claim: in PR mode the checkout must actually be
      // available (warmup done, not failed) — the prompt tells the agent it
      // can read PR files, so a bare pool/agentCwd existence check would have
      // it confidently reviewing whatever directory it landed in.
      const hasAgentLocalAccess = !!workspacePrompt || !!gitContext ||
        (options.worktreePool && launchMetadata
          ? resolvePRLocalCwd(launchMetadata) !== undefined
          : !!options.agentCwd);
      const userMessageOptions = {
        defaultBranch: launchBase,
        hasLocalAccess: hasAgentLocalAccess,
        prDiffScope: launchScope,
        ...(workspacePrompt && { workspace: workspacePrompt }),
      };

      // Snapshot the diff context at launch — stored on the job so
      // downstream "Copy All" produces the same markdown as /api/feedback
      // would right now, even if the reviewer switches modes/bases later.
      // Skipped in PR mode (prMetadata carries equivalent context).
      const worktreeParts = String(launchDiffType).startsWith("worktree:")
        ? parseWorktreeDiffType(launchDiffType as DiffType)
        : null;
      const launchPrUrl = launchMetadata?.url;
      const launchDiffScope = isPRMode ? launchScope : undefined;
      const diffContext: AgentJobInfo["diffContext"] | undefined = workspacePrompt
        ? { mode: String(launchDiffType), worktreePath: null }
        : launchMetadata
        ? undefined
        : {
            mode: (worktreeParts?.subType ?? launchDiffType) as string,
            base: launchBase,
            worktreePath: worktreeParts?.path ?? null,
          };

      if (provider === "tour") {
        const built = await tour.buildCommand({
          cwd,
          patch: launchPatch,
          diffType: launchDiffType as DiffType,
          options: userMessageOptions,
          prMetadata: launchMetadata,
          config,
        });
        return built ? { ...built, prUrl: launchPrUrl, diffScope: launchDiffScope, diffContext } : built;
      }

      const userMessage = workspacePrompt
        ? buildAgentReviewUserMessageForTarget({
            kind: "workspace",
            patch: launchPatch,
            workspace: workspacePrompt,
          })
        : buildAgentReviewUserMessage(launchPatch, launchDiffType as DiffType, userMessageOptions, launchMetadata);
      const jobLabel = workspacePrompt ? "Workspace Review" : "Code Review";

      if (provider === "codex") {
        const model = typeof config?.model === "string" && config.model ? config.model : undefined;
        const reasoningEffort = typeof config?.reasoningEffort === "string" && config.reasoningEffort ? config.reasoningEffort : undefined;
        const fastMode = config?.fastMode === true;
        const outputPath = generateOutputPath();
        const prompt = CODEX_REVIEW_SYSTEM_PROMPT + "\n\n---\n\n" + userMessage;
        const command = await buildCodexCommand({ cwd, outputPath, prompt, model, reasoningEffort, fastMode });
        return { command, outputPath, prompt, cwd, label: jobLabel, model, reasoningEffort, fastMode: fastMode || undefined, prUrl: launchPrUrl, diffScope: launchDiffScope, diffContext };
      }

      if (provider === "claude") {
        const model = typeof config?.model === "string" && config.model ? config.model : undefined;
        const effort = typeof config?.effort === "string" && config.effort ? config.effort : undefined;
        const prompt = CLAUDE_REVIEW_PROMPT + "\n\n---\n\n" + userMessage;
        const { command, stdinPrompt } = buildClaudeCommand(prompt, model, effort);
        return { command, stdinPrompt, prompt, cwd, label: jobLabel, captureStdout: true, model, effort, prUrl: launchPrUrl, diffScope: launchDiffScope, diffContext };
      }

      if (provider === "cursor") {
        // Cursor has no schema flag — its marker-block output contract lives in
        // CURSOR_REVIEW_PROMPT. captureStdout is required (the marker block comes
        // back on stdout, like Claude). buildCursorCommand passes the prompt as
        // the trailing argv arg and threads --workspace=cwd to match the spawn cwd.
        const model = typeof config?.model === "string" && config.model ? config.model : undefined;
        const prompt = CURSOR_REVIEW_PROMPT + "\n\n---\n\n" + userMessage;
        const { command } = buildCursorCommand(prompt, model, cwd);
        return { command, prompt, cwd, label: jobLabel, captureStdout: true, model, prUrl: launchPrUrl, diffScope: launchDiffScope, diffContext };
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
          const annotations = transformReviewFindings(
            output.findings,
            job.source,
            cwd,
            "Codex",
            workspace ? (filePath) => workspace.normalizeAnnotationPath(filePath) : undefined,
          )
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
          const annotations = transformClaudeFindings(
            output.findings,
            job.source,
            cwd,
            workspace ? (filePath) => workspace.normalizeAnnotationPath(filePath) : undefined,
          )
            .map(a => ({ ...a, ...jobPrContext, ...(jobDiffScope && { diffScope: jobDiffScope }) }));
          const result = externalAnnotations.addAnnotations({ annotations });
          if ("error" in result) console.error(`[claude-review] addAnnotations error:`, result.error);
        }
        return;
      }

      // --- Cursor path ---
      // FAIL-CLOSED: Cursor output is prompt-enforced (no schema flag), so any
      // missing/malformed/schema/transform/insertion failure must MUTATE the job
      // to failed — NEVER throw (agent-jobs.ts swallows throws, silently leaving
      // an exit-0 job marked done). Mirrors the Tour fail-closed pattern below.
      if (job.provider === "cursor") {
        const output = meta.stdout ? parseCursorStreamOutput(meta.stdout) : null;
        if (!output) {
          job.status = "failed";
          job.error = "Cursor review output missing or unparseable (no valid marker JSON).";
          return;
        }

        // Derive the verdict from finding severities (like Claude) rather than
        // trusting Cursor's free-form `correctness` string. Cursor has no schema
        // flag, so a model value like "not correct" would be stored verbatim and
        // the detail panel (any string containing "correct" except "incorrect" →
        // green) would invert the displayed result.
        const hasImportant = output.findings.some((f) => f.severity === "important");
        job.summary = {
          correctness: hasImportant ? "Issues Found" : "Correct",
          explanation: output.summary.explanation,
          confidence: output.summary.confidence,
        };

        if (output.findings.length > 0) {
          const annotations = transformCursorFindings(
            output.findings,
            job.source,
            cwd,
            workspace ? (filePath) => workspace.normalizeAnnotationPath(filePath) : undefined,
          )
            .map(a => ({ ...a, ...jobPrContext, ...(jobDiffScope && { diffScope: jobDiffScope }) }));
          const result = externalAnnotations.addAnnotations({ annotations });
          if ("error" in result) {
            job.status = "failed";
            job.error = `Cursor annotation insertion failed: ${result.error}`;
            return;
          }
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

  // AI provider setup (graceful — capabilities report unavailable if no provider is registered)
  const aiRuntime = await createAIRuntime({ getCwd: resolveAgentCwd });

  const isRemote = isRemoteSession();
  const configuredPort = getServerPort();
  const wslFlag = await isWSL();
  const gitUser = detectGitUser();

  // Detect repo info (cached for this session)
  // In PR mode, derive from metadata instead of local git
  let repoInfo = isPRMode && prMetadata
    ? { display: getDisplayRepo(prMetadata), branch: `${getMRLabel(prMetadata)} ${getMRNumberLabel(prMetadata)}` }
    : workspace
      ? { display: basename(workspace.root), branch: "Workspace" }
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
        // Bun's default 10s idleTimeout kills requests that legitimately park:
        // PR-mode endpoints await the background checkout warmup (a clone that
        // can take minutes) and AI SSE streams can stall between bytes.
        idleTimeout: 0,

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
              mode: isWorkspaceMode ? "workspace" : undefined,
              diffType: hasLocalAccess || isWorkspaceMode ? currentDiffType : undefined,
              // Echo the active base so a page refresh or reconnect rehydrates
              // the picker to what the server is actually using — not the
              // detected default.
              base: hasLocalAccess ? currentBase : undefined,
              hideWhitespace: currentHideWhitespace,
              ...(workspace && { diffOptions: workspace.diffOptions }),
              gitContext: hasLocalAccess ? gitContext : undefined,
              sharingEnabled,
              shareBaseUrl,
              repoInfo,
              isWSL: wslFlag,
              // PR mode advertises the ready PR checkout (null while warming), so
              // the Open-in button gates correctly from the initial load — not
              // the launch repo. Non-PR keeps the workspace/local cwd.
              ...(isPRMode
                ? { agentCwd: resolvePRLocalCwd() ?? null }
                : workspace
                  ? { agentCwd: workspace.root }
                  : options.agentCwd
                    ? { agentCwd: options.agentCwd }
                    : {}),
              ...(isPRMode && {
                prMetadata,
                platformUser,
                prStackInfo,
                prStackTree,
                prDiffScope: currentPRDiffScope,
                prDiffScopeOptions,
              }),
              ...(isPRMode && layerPatchIncomplete && { prPatchIncomplete: true, prPatchUpgradeAvailable: layerUpgradeAvailable }),
              ...(isPRMode && initialViewedFiles.length > 0 && { viewedFiles: initialViewedFiles }),
              ...(currentError && { error: currentError }),
              semanticDiff: await getSemanticDiffAdvert(),
              serverConfig: getServerConfig(gitUser),
            });
          }

          // API: List apps the host can open a file in (Open in App control).
          if (url.pathname === "/api/open-in/apps" && req.method === "GET") {
            return handleOpenInApps();
          }

          // API: Open a file in an app. Resolves the repo-relative `git diff`
          // path against the VCS root server-side (resolveAgentCwd folds in
          // workspace.root, the PR local checkout, resolveVcsCwd(gitContext.cwd),
          // and process.cwd()) — not the client `base`, which is wrong when
          // review runs from a subdirectory — then containment-checks it.
          if (url.pathname === "/api/open-in" && req.method === "POST") {
            return handleOpenIn(req, { resolveRoot: resolveOpenInRoot });
          }

          // API: cheap staleness probe — has the underlying VCS state changed
          // since the current diff snapshot was computed? Best-effort: anything
          // that cannot be fingerprinted reports fresh (no banner).
          if (url.pathname === "/api/diff/fresh" && req.method === "GET") {
            // In PR review the local checkout can appear (pool warmup) or change
            // (in-place PR switch) after the initial /api/diff, so re-advertise it
            // on every probe — the Open-in control tracks the current checkout
            // without a page reload. resolvePRLocalCwd() is null until a usable
            // checkout exists. Non-PR sessions never carry this field.
            const prCwdAdvert = isPRMode ? { agentCwd: resolvePRLocalCwd() ?? null } : {};
            const baseline = currentFingerprint;
            if (baseline == null) return Response.json({ fresh: true, ...prCwdAdvert });
            const probe = await computeDiffFingerprint();
            // A diff switch landing mid-probe replaces the snapshot (and its
            // fingerprint); report fresh and let the next poll compare
            // against the new baseline.
            if (currentFingerprint !== baseline) return Response.json({ fresh: true, ...prCwdAdvert });
            const fresh = probe == null || probe === baseline;
            // The probe fingerprint lets the client distinguish "still the
            // same staleness I dismissed" from "ANOTHER change landed since".
            return Response.json({ fresh, ...(fresh ? {} : { fingerprint: probe }), ...prCwdAdvert });
          }

          // API: Get semantic diff content
          if (url.pathname === "/api/semantic-diff" && req.method === "GET") {
            return Response.json(await getSemanticDiff(url));
          }

          // API: Switch diff type (requires local file access)
          if (url.pathname === "/api/diff/switch" && req.method === "POST") {
            if (!hasLocalAccess && !workspace) {
              return Response.json(
                { error: "Not available without local file access" },
                { status: 400 },
              );
            }
            try {
              const body = (await req.json()) as { diffType: DiffType | WorkspaceDiffType; base?: string; hideWhitespace?: boolean };
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

              if (workspace) {
                const snapshot = await workspace.rebuild({
                  diffType: newDiffType,
                  hideWhitespace: currentHideWhitespace,
                });
                currentPatch = snapshot.rawPatch;
                currentGitRef = snapshot.gitRef;
                currentDiffType = workspace.diffType;
                currentError = snapshot.error;
                draftKey = contentHash(currentPatch);
                captureDiffFingerprint();

                return Response.json({
                  rawPatch: currentPatch,
                  gitRef: currentGitRef,
                  diffType: currentDiffType,
                  diffOptions: workspace.diffOptions,
                  hideWhitespace: currentHideWhitespace,
                  ...(currentError && { error: currentError }),
                  semanticDiff: await getSemanticDiffAdvert(),
                });
              }

              // Guard against non-string payloads — resolveBaseBranch calls
              // string methods and would throw a TypeError otherwise. Mirrors
              // Pi's guard so both runtimes validate identically.
              const requestedBase = typeof body.base === "string" ? body.base : undefined;
              const base = resolveReviewBase(requestedBase);
              const defaultCwd = gitContext?.cwd;

              // Run the new diff
              const result = await runVcsDiff(newDiffType as DiffType, base, defaultCwd, {
                hideWhitespace: currentHideWhitespace,
              });

              // Update state
              currentPatch = result.patch;
              currentGitRef = result.label;
              currentDiffType = newDiffType;
              currentBase = base;
              baseEverSwitched = true;
              currentError = result.error;
              captureDiffFingerprint();

              // Recompute gitContext for the effective cwd so the client's
              // sidebar (current branch, default branch, diff-mode options)
              // reflects the worktree we're now reviewing — not the main
              // repo's startup state. Best-effort: on failure the client
              // keeps its existing context.
              let updatedContext: GitContext | undefined;
              if (gitContext) {
                try {
                  const effectiveCwd = resolveVcsCwd(newDiffType as DiffType, gitContext.cwd);
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
                semanticDiff: await getSemanticDiffAdvert(),
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

              const scopeEpoch = ++prScopeEpoch;
              // A newer scope select or pr-switch landed while this request
              // was parked on an await: drop this request's writes and return
              // the newest state so the client converges on it.
              const supersededResponse = async () => {
                const semanticDiff = await getSemanticDiffAdvert();
                return Response.json({
                  rawPatch: currentPatch,
                  gitRef: currentGitRef,
                  prDiffScope: currentPRDiffScope,
                  ...(layerPatchIncomplete && { prPatchIncomplete: true, prPatchUpgradeAvailable: layerUpgradeAvailable }),
                  ...(currentError && { error: currentError }),
                  semanticDiff,
                });
              };

              if (body.scope === "layer") {
                // Upgrade path: the platform withheld per-file content for
                // this PR (too large). Once the local checkout is ready,
                // recompute the exact layer diff locally and replace the
                // truncated API reconstruction. Snapshot the PR before the
                // await — a pr-switch landing mid-recompute must not have its
                // patch overwritten with the previous PR's diff.
                const upgradeMetadata = prMetadata;
                let upgradeError: string | undefined;
                if (layerPatchIncomplete && options.worktreePool && upgradeMetadata) {
                  const upgradeCwd = await ensurePRLocalCwd(upgradeMetadata);
                  if (upgradeCwd && prMetadata === upgradeMetadata) {
                    const result = await runPRLayerLocalDiff(gitRuntime, upgradeMetadata, upgradeCwd);
                    if (prMetadata === upgradeMetadata) {
                      if (!result.error) {
                        originalPRPatch = result.patch;
                        originalPRError = undefined;
                        layerPatchIncomplete = false;
                        prSwitchCache.set(upgradeMetadata.url, {
                          metadata: upgradeMetadata,
                          rawPatch: result.patch,
                          patchIncomplete: false,
                        });
                      } else {
                        upgradeError = `Could not recompute the full diff locally: ${result.error}`;
                        console.error(`Local PR diff recompute failed: ${result.error}`);
                      }
                    }
                  }
                }
                if (scopeEpoch !== prScopeEpoch) return supersededResponse();
                currentPatch = originalPRPatch;
                currentGitRef = originalPRGitRef;
                currentError = originalPRError;
                currentPRDiffScope = "layer";
                // The upgrade changed the patch this session serves; drafts
                // must key off it so a pr-switch round-trip (which rehashes
                // from the cache) resolves to the same key.
                if (!layerPatchIncomplete) draftKey = contentHash(currentPatch);
                captureDiffFingerprint();
                return Response.json({
                  rawPatch: currentPatch,
                  gitRef: currentGitRef,
                  prDiffScope: currentPRDiffScope,
                  ...(layerPatchIncomplete && { prPatchIncomplete: true, prPatchUpgradeAvailable: layerUpgradeAvailable }),
                  ...((currentError ?? upgradeError) && { error: currentError ?? upgradeError }),
                  semanticDiff: await getSemanticDiffAdvert(),
                });
              }

              const fullStackOption = prDiffScopeOptions.find((option) => option.id === "full-stack");
              if (!fullStackOption?.enabled || !(options.worktreePool || options.agentCwd)) {
                return Response.json(
                  { error: "Full stack diff requires a stacked PR and a local checkout" },
                  { status: 400 },
                );
              }

              // Blocks on the background checkout warmup if it's still running.
              const fullStackCwd = await ensurePRLocalCwd();
              if (!fullStackCwd) {
                return Response.json(
                  { error: "Local checkout is unavailable — full stack diff cannot run" },
                  { status: 400 },
                );
              }
              const result = await runPRFullStackDiff(gitRuntime, prMetadata, fullStackCwd);

              if (result.error) {
                return Response.json({ error: result.error }, { status: 400 });
              }

              if (scopeEpoch !== prScopeEpoch) return supersededResponse();
              currentPatch = result.patch;
              currentGitRef = result.label;
              currentError = undefined;
              currentPRDiffScope = "full-stack";
              captureDiffFingerprint();

              return Response.json({
                rawPatch: currentPatch,
                gitRef: currentGitRef,
                prDiffScope: currentPRDiffScope,
                semanticDiff: await getSemanticDiffAdvert(),
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

              // Update mutable server state. Bump the scope epoch so a scope
              // request parked on a long await cannot overwrite this switch.
              prScopeEpoch++;
              prMetadata = pr.metadata;
              prRef = prRefFromMetadata(pr.metadata);
              currentPatch = pr.rawPatch;
              currentGitRef = `${getMRLabel(pr.metadata)} ${getMRNumberLabel(pr.metadata)}`;
              currentError = undefined;
              originalPRPatch = pr.rawPatch;
              originalPRGitRef = currentGitRef;
              originalPRError = undefined;
              currentPRDiffScope = "layer";
              layerPatchIncomplete = pr.patchIncomplete ?? false;
              draftKey = contentHash(pr.rawPatch);
              prListCache = null;
              captureDiffFingerprint();

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
                // The new PR's checkout (null while warming) so Open-in re-roots
                // immediately on switch instead of waiting for the 5s probe.
                agentCwd: resolvePRLocalCwd(pr.metadata) ?? null,
                prStackInfo,
                prStackTree,
                prDiffScope: currentPRDiffScope,
                prDiffScopeOptions,
                ...(layerPatchIncomplete && { prPatchIncomplete: true, prPatchUpgradeAvailable: layerUpgradeAvailable }),
                repoInfo,
                ...(switchedViewedFiles.length > 0 && { viewedFiles: switchedViewedFiles }),
                ...(currentError ? { error: currentError } : {}),
                semanticDiff: await getSemanticDiffAdvert(),
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

            if (workspace) {
              try {
                const result = await workspace.getFileContents(filePath, oldPath);
                return Response.json(result);
              } catch (error) {
                return Response.json(
                  { error: error instanceof Error ? error.message : "No file access available" },
                  { status: 400 },
                );
              }
            }

            // Full-stack PR mode uses local git for file expansion because
            // the patch is no longer the platform's layer diff.
            const fileContentCwd = resolvePRLocalCwd();
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
                currentDiffType as DiffType,
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

          // API: Code navigation (search-based symbol resolution)
          if (url.pathname === "/api/code-nav/resolve" && req.method === "POST") {
            const hasCodeNavAccess = !!workspace || !!gitContext || !!options.agentCwd || !!options.worktreePool;
            if (!hasCodeNavAccess) {
              return Response.json(
                { error: "Code navigation requires local access" },
                { status: 400 },
              );
            }
            // PR mode: the checkout must actually exist — ripgrep over a
            // fallback directory returns confidently-wrong results.
            const navCwd = options.worktreePool && prMetadata
              ? await ensurePRLocalCwd()
              : await resolveAgentCwdReady();
            if (!navCwd) {
              return Response.json({ error: "Local checkout unavailable" }, { status: 400 });
            }
            const changedFiles = extractChangedFiles(currentPatch);
            return handleCodeNavResolve(req, navCwd, changedFiles);
          }

          // API: Code navigation file preview (read file from working tree)
          if (url.pathname === "/api/code-nav/file" && req.method === "GET") {
            const hasCodeNavAccess = !!workspace || !!gitContext || !!options.agentCwd || !!options.worktreePool;
            if (!hasCodeNavAccess) {
              return Response.json({ error: "Code navigation requires local access" }, { status: 400 });
            }
            const filePath = url.searchParams.get("path");
            if (!filePath) {
              return Response.json({ error: "Missing path" }, { status: 400 });
            }
            try { validateFilePath(filePath); } catch {
              return Response.json({ error: "Invalid path" }, { status: 400 });
            }
            try {
              const navCwd = options.worktreePool && prMetadata
                ? await ensurePRLocalCwd()
                : await resolveAgentCwdReady();
              if (!navCwd) {
                return Response.json({ error: "Local checkout unavailable" }, { status: 400 });
              }
              const content = await Bun.file(`${navCwd}/${filePath}`).text();
              return Response.json({ content });
            } catch {
              return Response.json({ error: "File not found" }, { status: 404 });
            }
          }

          // API: Stage / unstage a file (disabled when VCS doesn't support it)
          if (url.pathname === "/api/git-add" && req.method === "POST") {
            try {
              const body = (await req.json()) as { filePath?: unknown; undo?: boolean };
              if (typeof body.filePath !== "string" || !body.filePath) {
                return Response.json({ error: "Missing filePath" }, { status: 400 });
              }
              try { validateFilePath(body.filePath); } catch {
                return Response.json({ error: "Invalid path" }, { status: 400 });
              }

              if (workspace) {
                try {
                  await workspace.stageFile(body.filePath, body.undo);
                  return Response.json({ ok: true });
                } catch (error) {
                  return Response.json(
                    { error: error instanceof Error ? error.message : "Failed to stage file" },
                    { status: 400 },
                  );
                }
              }

              const stageCwd = resolveVcsCwd(currentDiffType as DiffType, gitContext?.cwd);
              if (isPRMode || !(await canStageFiles(currentDiffType as DiffType, stageCwd))) {
                return Response.json(
                  { error: "Staging not available" },
                  { status: 400 },
                );
              }

              if (body.undo) {
                await unstageFile(currentDiffType as DiffType, body.filePath, stageCwd);
              } else {
                await stageFile(currentDiffType as DiffType, body.filePath, stageCwd);
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
            if (req.method === "DELETE") return handleDraftDelete(draftKey, req);
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
            deleteDraft(draftKey, readDraftGenerationFromUrl(req));
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
                draftGeneration?: number;
              };

              deleteDraft(draftKey, readDraftGenerationFromBody(body));
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
          if (url.pathname.startsWith("/api/ai/")) {
            const handler = aiRuntime.endpoints[url.pathname as keyof AIEndpoints];
            if (handler) {
              // AI sessions pin their cwd at creation — wait out the PR
              // checkout warmup so a session opened in the first seconds
              // isn't rooted in a transient fallback directory for life.
              // If the checkout can't be produced (warmup failed), refuse
              // instead of starting a session in the wrong directory.
              if (req.method === "POST" && url.pathname === "/api/ai/session" && options.worktreePool && prMetadata) {
                const checkout = await ensurePRLocalCwd();
                if (!checkout) {
                  return Response.json(
                    { error: "Local PR checkout unavailable — Ask AI can't read the PR files right now. Retry shortly." },
                    { status: 503 },
                  );
                }
              }
              if (url.pathname === AI_QUERY_ENDPOINT) {
                server.timeout(req, 0);
              }
              return handler(req);
            }
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
      aiRuntime.dispose();
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
