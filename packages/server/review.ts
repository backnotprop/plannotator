import { childPath } from "@plannotator/shared/child-env";
import { createPackageChangesService, MAX_PACKAGE_FILE_BYTES, PACKAGE_CHECKOUT_WAIT_MS, prSettingsSource, REMOTE_PACKAGE_READS, waitAtMost } from "@plannotator/shared/package-changes-service";
import { parseDiffToFiles } from "@plannotator/core/diff-files";
import { homedir } from "node:os";
import { isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";
import { likelyAppHtmlEncoding, prewarmAppHtml } from "@plannotator/shared/app-html";
import { openPackedApp, packedAppResponse } from "@plannotator/shared/packed-app";
import {
  answerDiagramEngineRequest,
  createDiagramEngineAssets,
  isDiagramEngineRequest,
  type DiagramEngineSource,
} from "@plannotator/shared/diagram-engine-assets";
import { isRemoteSession, getServerHostname, startBunServerOnAvailablePort, buildAdvertisedUrl, getLocalUrlHostname } from "./remote";
import { createRequestHostGuard } from "./request-host-guard";
import { withPlannotatorServerHeader } from "./plannotator-server-marker";
import { refuseCrossOriginWrite } from "./request-origin-guard";
import type { Origin } from "@plannotator/shared/agents";
import { type DiffType, type GitContext, runVcsDiff, getVcsFileContentsForDiff, getVcsFileBytesForDiff, listVcsFiles, getVcsDiffFingerprint, canStageFiles, stageFile, unstageFile, resolveVcsCwd, validateFilePath, getVcsContext, detectRemoteDefaultCompareTarget, resolveAvailableDiffType, vcsOwnsDiffType, vcsSupportsSnapshot, materializeVcsSnapshot, gitRuntime } from "./vcs";
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { SingleFlight } from "@plannotator/shared/single-flight";
import {
  commitFamilyId,
  isSameCwdCommitSwitch,
  parseCommitDiffType,
  parseJjCommitDiffType,
  parseWorktreeDiffType,
  resolveBaseBranch,
  getSinceBaseSections,
  detectRemoteDefaultInfo,
  nextRemoteBaseCheckInterval,
  REMOTE_BASE_CHECK_INTERVAL_MS,
  isBinaryPatchFile,
  getFileBytesForDiff,
  listPatchFiles,
  STATIC_PATCH_DIFF_TYPE,
  type RemoteDefaultInfo,
  type SinceBaseSections,
} from "@plannotator/shared/review-core";
import {
  getGitButlerContextRevision,
  getGitButlerPatchFingerprint,
} from "@plannotator/shared/gitbutler-core";
import {
  getCommitDiffInfo,
  getJjCommitDiffInfo,
  listCommitHistory,
  listJjCommitHistory,
  resolveJjCommitRailBase,
  type CommitDiffInfo,
} from "@plannotator/shared/commit-history";
import { runtime as jjRuntime } from "./jj";
import { canonicalizeJjCommitDiffType } from "@plannotator/shared/jj-core";
import { resolvePoolCwd } from "@plannotator/shared/worktree-pool";
import {
  REVIEW_IMAGE_ENDPOINT,
  REVIEW_IMAGE_READ_CONCURRENCY,
  createConcurrencyLimiter,
  handleReviewImageRequest,
  readPRImageSide,
} from "@plannotator/shared/review-image";
import {
  REVIEW_MARKDOWN_IMAGE_ENDPOINT,
  handleReviewMarkdownImageRequest,
} from "@plannotator/shared/review-markdown-image";
import type { DiffSide, FileBytesRead } from "@plannotator/shared/review-core";
import { listGitSideFiles, readDiffSideBytes, compareRepoPaths, type RepoFileListing } from "@plannotator/shared/review-core";
import {
  REPO_FILE_ENDPOINT,
  REPO_FILES_ENDPOINT,
  REPO_FILES_STREAM_ENDPOINT,
  REPO_FILES_SEARCH_ENDPOINT,
  createRepoListingCache,
  diffFileStates,
  findRepoOnDiskChanges,
  gitIgnoredEntries,
  gitLiveSignature,
  repoLiveMode,
  handleRepoFileRequest,
  handleRepoFilesRequest,
  handleRepoFilesSearchRequest,
  type RepoFileRead,
  type RepoFilesUnavailable,
} from "@plannotator/shared/repo-files";
import { createReviewRepoWatch } from "./review-repo-watch";
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
import { CallFlowService } from "@plannotator/shared/call-flow";
import { CallFlowInstallCoordinator, callFlowInstallOriginAllowed } from "@plannotator/shared/call-flow-install";
import type { CallFlowInstallCoordinatorOptions } from "@plannotator/shared/call-flow-install";
import { parseCallFlowInstallRequest, resolveCallFlowInstallTargets } from "@plannotator/shared/call-flow-languages";
import type { CallFlowResponse } from "@plannotator/shared/call-flow-types";
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
import { type AgentJobInfo, REVIEW_OUTPUT_FAILED, getAgentJobAnnotationContext, markJobReviewFailed } from "@plannotator/shared/agent-jobs";
import { createCommitAvatarResolver } from "@plannotator/shared/commit-avatars";
import { detectGeneratedFiles, detectGeneratedFilesByName } from "@plannotator/shared/generated-files";
import { getRepoInfo } from "./repo";
import { createRefCards, refCardRouteResponse, refCardsTailnetAllowed, type RefRunner } from "./ref-cards";
import { handleImage, handleStarAsk, handleUpload, handleAgents, handleServerReady, handleApiNotFound, handleFavicon, readDraftGenerationFromBody, readDraftGenerationFromUrl, type OpencodeClient } from "./shared-handlers";
import { contentHash } from "./draft";
import { createReviewDraftSession, localGitDraftTargetKey, localReviewDraftKeys, prDraftTargetKey, type ReviewDraftKeys } from "@plannotator/shared/review-draft";
import { captureReviewProgress, handleReviewProgress } from "@plannotator/shared/review-progress";
import { createEditorAnnotationHandler } from "./editor-annotations";
import { createExternalAnnotationHandler } from "./external-annotations";
import { createAgentJobHandler } from "./agent-jobs";
import {
  composeCodexReviewPrompt,
  buildCodexCommand,
  generateOutputPath,
  parseCodexOutput,
  transformReviewFindings,
} from "./codex-review";
import { buildAgentReviewUserMessage, buildAgentReviewUserMessageForTarget, type WorkspaceReviewPromptContext } from "./agent-review-message";
import {
  composeClaudeReviewPrompt,
  buildClaudeCommand,
  parseClaudeStreamOutput,
  transformClaudeFindings,
} from "./claude-review";
import { createTourSession, TOUR_EMPTY_OUTPUT_ERROR } from "./tour/tour-review";
import { createGuideSession, GUIDE_EMPTY_OUTPUT_ERROR } from "./guide/guide-review";
import { GuideShareError, shareGuide, unshareBeforeDelete, unshareGuide } from "./guide/guide-share";
import { createGuideStoreSession, SAVED_GUIDE_ID_PREFIX, updateGuideShare } from "@plannotator/shared/guide-store";
import { resolveGuideShareUrl, resolveSharingEnabled } from "@plannotator/shared/config";
import {
  buildGuideSnapshot,
  createGuideHtml,
  detectGuideLanguages,
  guideExportFilename,
  resolveGuideViewerAssets,
  type GuideLaunchReview,
  type GuideSnapshot,
  type GuideSnapshotSource,
} from "@plannotator/shared/guide-format";
import { GUIDE_VIEWER_MANIFEST } from "@plannotator/shared/guide-viewer-manifest";
import {
  MARKER_ENGINES,
  resolveMarkerBinary,
  composeMarkerReviewPrompt,
  buildMarkerCommand,
  parseMarkerStreamOutput,
  reduceMarkerStream,
  transformMarkerFindings,
  makeMarkerNonce,
  extractMarkerNonce,
  type MarkerEngineId,
} from "./marker-review";
import { agentSwitchConfigToSave, agentToolSaveFailed, cookieHostConfigWrite, loadConfig, saveConfig, detectGitUser, getServerConfig, parsePackageChangesConfig, parseReviewAnalysisConfig, resolveAIEnabled, resolvePackageLookup, resolveClaudeSandbox, resolveCursorSandbox, resolveFeedbackHistory, resolveGuideHistory, resolveGitRemoteCheck, resolveReviewProgress } from "./config";
import { getAutoUpdateAdvert, getUpdateAdvert, handleUpdateRoute } from "./auto-update";
import { appendFeedbackRecord, countChangedFiles, deriveFeedbackProject, type FeedbackDecision, type FeedbackReviewTarget } from "@plannotator/shared/feedback-archive";
import { isFaviconStyle, type FaviconStyle } from "@plannotator/shared/favicon";
import { type PRMetadata, type PRRef, type PRReviewFileComment, type PRStackTree, type PRListItem, fetchPR, fetchPRFileContent, fetchPRFileBytes, fetchPRTree, fetchPRContext, submitPRReview, parseFileLevelComments, parsePRReviewAction, fetchPRViewedFiles, markPRFilesViewed, fetchPRStack, fetchPRList, getPRUser, parsePRUrl, prRefFromMetadata, isSameProject, getDisplayRepo, getMRLabel, getMRNumberLabel, getPRNumber, prCommandRuntime } from "./pr";
import {
  PR_CONTEXT_HEARTBEAT_COMMENT,
  PR_CONTEXT_HEARTBEAT_INTERVAL_MS,
  createPRContextLiveCache,
  serializePRContextSSEEvent,
} from "@plannotator/shared/pr-context-live";
import {
  fetchPRArtifactContent,
  fetchPRArtifactDocument,
  PRArtifactDocumentError,
} from "@plannotator/shared/pr-artifact-document";
import { agentToolHostForServer, createAIRuntime } from "./ai-runtime";
import { assertTestHome } from "./test-home-guard";
import { handleHostControl, resolveHostControlToken, type HostControl } from "./host-control";
import { sessionTailnetAudience, sessionTailnetGate } from "./session-tailnet";
import { countUnsentDraftComments, hostSessionClosedEvent } from "@plannotator/shared/host-control";
import { checkServerSession, createServerSessionNonce, serverSessionMismatchBody } from "@plannotator/shared/server-session";
import { isAIEndpointPath, isLongLivedAIEndpointPath, type AIEndpoints, type SessionBridge } from "@plannotator/ai";
import { isWSL } from "./browser";
import { getExtraMarkdownExtensions } from "@plannotator/shared/resolve-file";
import { handleOpenInApps, handleOpenIn } from "./open-in";
import { resolveWorkspaceFilePath, type LocalWorkspaceReview, type WorkspaceDiffType } from "./review-workspace";
import { handleCodeNavResolve, handleCodeNavHover, extractChangedFiles } from "./code-nav";
import { readRepoFile, repoFileErrorBody, REPO_FILE_ERROR_STATUS } from "@plannotator/shared/repo-file";
import { readRepoWorkingTreeFile } from "@plannotator/shared/repo-files-node";
import { decodeBunText } from "./git";
import { discoverCuratedSkills, resolveRequestedReviewProfile, listAllSkills, enableReviewSkill } from "./review-skill-loader";
import { readGuideInstructions, writeGuideInstructions } from "@plannotator/shared/guide-instructions-store";
import {
  BUILTIN_DEFAULT_PROFILE,
  type ReviewProfilesResponse,
} from "@plannotator/shared/review-profiles";

export { isRemoteSession, getServerPort } from "./remote";
export { openBrowser } from "./browser";
export { type DiffType, type DiffOption, type GitContext, type WorktreeInfo } from "./vcs";
export { type PRMetadata } from "./pr";
export { handleServerReady as handleReviewServerReady } from "./shared-handlers";

export interface ReviewServerOptions {
  /** Tests only: how many paths All files sends whole before serving one folder at a time. */
  repoFilesLazyThreshold?: number;
  /** Tests only: how often a polled live listing looks (default `REPO_LIVE_POLL_MS`). */
  repoLivePollMs?: number;
  /** Tests only: the Call flow install and Node preflight, so a test never starts a real install. */
  callFlowInstall?: Pick<CallFlowInstallCoordinatorOptions, "install" | "preflight">;
  /** The host bridge to the agent session that opened this review. */
  sessionBridge?: SessionBridge;
  /** The token `/api/host/status` and `/api/host/close` accept. Default: the pull-bridge token the host launched the CLI with; off in remote mode either way. */
  hostControlToken?: string;
  /** Loopback-bound but published across the tailnet (--tailscale): the app page is served compressed, as in remote mode. */
  tailnetPublished?: boolean;
  /** Tests: run the hover cards' `gh` / `glab` through this instead of the real ones (ref-cards.ts). */
  refRunner?: RefRunner;
  rawPatch: string;
  gitRef: string;
  error?: string;
  /** The caller's `--title`: the whole tab title, in place of `<repo> · Code Review`. */
  title?: string;
  htmlContent: string;
  /** Diagram engine files, or a function that reads them on first need. Without them (absent or null) Mermaid and Graphviz fences show as code. */
  diagramEngine?: DiagramEngineSource;
  origin?: Origin;
  diffType?: DiffType | WorkspaceDiffType;
  gitContext?: GitContext;
  workspace?: LocalWorkspaceReview;
  /** Base the caller used to compute `rawPatch`; forward it so server state and agent prompts match the patch on screen. */
  initialBase?: string;
  /** The caller pinned `initialBase` deliberately (`--base`): seeds `baseExplicitlyChosen`, so no canonicalization and no startup upgrade. */
  initialBaseExplicit?: boolean;
  /** The caller pinned the opening diff type and/or base. Echoed on `/api/diff` so the client does not auto-switch or self-heal the persisted panel-view pair. */
  openStatePinned?: boolean;
  /** Freshness token captured atomically with the initial provider patch. */
  initialFingerprint?: string;
  initialFileIdentities?: Record<string, string>;
  sharingEnabled?: boolean;
  /** Whether the decision consumer delivers approve-time feedback. Echoed as `approvalNotesSupported` on every diff payload. Default false. */
  approvalNotesSupported?: boolean;
  shareBaseUrl?: string;
  onReady?: (url: string, isRemote: boolean, port: number) => void | Promise<void>;
  opencodeClient?: OpencodeClient;
  prMetadata?: PRMetadata;
  /** Platform review writer override used by isolated runtime tests. */
  prReviewSubmitter?: typeof submitPRReview;
  /** In-place PR switch fetcher override used by isolated runtime tests. */
  prFetcher?: typeof fetchPR;
  /** The initial layer patch lacks per-file content (platform APIs withhold patches on very large PRs); enables the local recompute upgrade once a checkout is ready. */
  prPatchIncomplete?: boolean;
  /** Project name keying the feedback archive. Without it the name is derived from the working directory, which is wrong in PR mode (`pool/pr-<n>`). */
  project?: string;
  includeReviewDirectory?: boolean;
  /** Working directory for agent processes (e.g., --local worktree). Independent of diff pipeline. */
  agentCwd?: string;
  worktreePool?: import("@plannotator/shared/worktree-pool").WorktreePool;
  /** `false` for `review --no-git-remote-check`; highest-priority input to `resolveGitRemoteCheck`. */
  gitRemoteCheck?: boolean;
  onCleanup?: () => void | Promise<void>;
}

export interface ReviewServerResult {
  port: number;
  url: string;
  isRemote: boolean;
  waitForDecision: () => Promise<{
    approved: boolean;
    feedback: string;
    reviewDirectory?: string;
    annotations: unknown[];
    agentSwitch?: string;
    exit?: boolean;
    /** The host closed the session (`POST /api/host/close`): an `exit` that keeps the draft. */
    closedBy?: "agent";
    /** With `closedBy`: the reviewer's unsent comments kept in the draft. */
    unsentAnnotations?: number;
    /** The review was posted to the PR platform (`POST /api/pr-action`); `feedback` is only its status line. */
    platform?: true;
    /** What the decision is about as of now: the active PR URL, the workspace root, or the working tree the active diff reads. Absent for a static patch. */
    target?: string;
  }>;
  stop: () => void;
  /** Host-only status and close, called in-process by a host that runs this server itself. */
  hostControl: HostControl;
}

export async function startReviewServer(
  options: ReviewServerOptions
): Promise<ReviewServerResult> {
  assertTestHome();
  const { htmlContent, origin, gitContext, sharingEnabled = true, shareBaseUrl, onReady } = options;
  const approvalNotesSupported = options.approvalNotesSupported === true;
  // Stale-tab guard: a decision echoing a different nonce is refused with 409 session_mismatch. A missing nonce is accepted.
  const serverSession = createServerSessionNonce();
  // Static patch mode: no repo or VCS behind the diff, so endpoints that would resolve patch paths against the server cwd answer 400.
  const isStaticPatchMode = options.diffType === STATIC_PATCH_DIFF_TYPE;
  // Off where nothing can be read: a static patch has no repository, and P4 drops binary files from its patch.
  const imagePreviewSupported = !isStaticPatchMode && gitContext?.vcsType !== "p4";
  // Offered wherever /api/file-content can read a file (never a static patch).
  const markdownPreviewSupported = !isStaticPatchMode;
  // A session with this can still answer `available: false` (no checkout and the platform cannot list, or the listing failed).
  const repoFilesSupported = !isStaticPatchMode && gitContext?.vcsType !== "p4";
  const runImageRead = createConcurrencyLimiter(REVIEW_IMAGE_READ_CONCURRENCY);
  const sourceKindAdvert = isStaticPatchMode
    ? ({ sourceKind: "patch" } as const)
    : ({} as Record<string, never>);
  const submitPlatformReview = options.prReviewSubmitter ?? submitPRReview;
  const aiEnabled = resolveAIEnabled();

  let prMetadata = options.prMetadata;
  const isPRMode = !!prMetadata;
  const workspace = options.workspace;
  const isWorkspaceMode = !!workspace;
  const hasLocalAccess = !!gitContext;
  const sessionVcsType = gitContext?.vcsType;
  let clientGitContext = gitContext;
  let draftKey = contentHash(options.rawPatch);
  const editorAnnotations = createEditorAnnotationHandler();
  const externalAnnotations = createExternalAnnotationHandler("review");

  const tour = createTourSession();
  const guide = createGuideSession();
  // Autosaves validated guides under ${PLANNOTATOR_DATA_DIR}/guides/{repo-key}/. Getters are late-bound: prMetadata/currentDiffType change mid-session.
  const guideStore = createGuideStoreSession({
    runGit: async (args, cwd) => {
      const result = await gitRuntime.runGit(args, { cwd });
      return result.exitCode === 0 ? result.stdout : null;
    },
    getGitCwd: () =>
      isPRMode || isWorkspaceMode
        ? undefined
        : gitContext
          ? resolveVcsCwd(currentDiffType as DiffType, gitContext.cwd) ?? gitContext.cwd ?? process.cwd()
          : undefined,
    getPRInfo: () =>
      prMetadata
        ? {
            url: prMetadata.url,
            headSha: prMetadata.headSha,
            label: `${getMRLabel(prMetadata)} ${getMRNumberLabel(prMetadata)}`,
          }
        : null,
    getBranchLabel: () => clientGitContext?.currentBranch || gitContext?.currentBranch,
    getFallbackDir: () => workspace?.root ?? options.agentCwd ?? process.cwd(),
    writesEnabled: () => resolveGuideHistory(loadConfig()),
  });

  const guideSaveJob = (job: AgentJobInfo) => ({
    id: job.id,
    engine: job.engine,
    model: job.model,
    generatedAt: job.endedAt ?? Date.now(),
  });

  /** Export snapshot: `saved:{id}` reads the store; a live job uses this session's launch review and guide, with the persisted copy as fallback. */
  async function resolveGuideSnapshotForExport(jobId: string): Promise<GuideSnapshot | null> {
    if (jobId.startsWith(SAVED_GUIDE_ID_PREFIX)) {
      return guideStore.getSavedGuideSnapshot(jobId.slice(SAVED_GUIDE_ID_PREFIX.length));
    }
    const live = guide.getGuide(jobId);
    const launchReview = guide.getLaunchReview(jobId);
    if (live && launchReview) {
      const job = agentJobs.getJob(jobId);
      return buildGuideSnapshot({
        guide: live,
        reviewed: live.reviewed,
        review: launchReview,
        generator: {
          engine: job?.engine,
          model: job?.model,
          generatedAt: job?.endedAt ? new Date(job.endedAt).toISOString() : undefined,
        },
      });
    }
    return guideStore.getJobGuideSnapshot(jobId);
  }

  let currentPatch = options.rawPatch;
  let currentFileIdentities = options.initialFileIdentities;
  let currentGitRef = options.gitRef;
  let currentDiffType: DiffType | WorkspaceDiffType = options.diffType || workspace?.diffType || "uncommitted";
  let currentError = options.error;
  let currentHideWhitespace = loadConfig().diffOptions?.hideWhitespace ?? false;
  let originalPRPatch = options.rawPatch;
  let originalPRGitRef = options.gitRef;
  let originalPRError = options.error;
  let currentPRDiffScope: PRDiffScope = "layer";
  // Draft keys for the displayed snapshot; local identity is captured with it so a later checkout cannot redirect draft writes.
  const reviewDrafts = createReviewDraftSession();
  let localDraftTarget: string | null = null;
  const currentDraftKeys = (): ReviewDraftKeys => {
    const patchKey = draftKey;
    return isPRMode && prMetadata
      ? { patchKey, targetKey: prDraftTargetKey(prMetadata, currentPRDiffScope) }
      : localReviewDraftKeys(patchKey, localDraftTarget);
  };
  // Monotonic guard: a scope request that resumes after a newer scope select or pr-switch must not overwrite their state.
  let prScopeEpoch = 0;
  // Monotonic guard for /api/diff/switch: a superseded request writes nothing and returns { superseded: true }.
  let diffSwitchEpoch = 0;
  // Older analysis-setting responses must not re-advertise capabilities for a superseded view.
  let reviewAnalysisEpoch = 0;
  let reviewAnalysisMutationEpoch: number | null = null;
  // Platforms withhold per-file patches on very large PRs. Partiality is always reported; offering a local recompute is a separate capability gated on the pool (layerUpgradeAvailable).
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
  const prContextLive = createPRContextLiveCache({ fetchContext: fetchPRContext });
  const warmPRContext = (url: string, ref: PRRef): void => {
    prContextLive.warm(url, ref);
  };
  // The base the user picked in the UI; agent review prompts read this so they analyze the diff on screen.
  const detectedCompareTarget = (): string => gitContext?.defaultBranch || gitContext?.compareTarget?.fallback || "main";
  let currentBase = options.initialBase || detectedCompareTarget();
  const isGitButlerCommittedView = (diffType: string = currentDiffType as string): boolean =>
    diffType.startsWith("gitbutler:stack:") || diffType.startsWith("gitbutler:branch:");
  let baseEverSwitched = false;
  // True once the user (or `--base` via initialBaseExplicit) picks a base: disables bare-local-name to origin/* canonicalization so an explicit local pick is honored.
  let baseExplicitlyChosen = options.initialBaseExplicit === true;
  const remoteCheckEnabled = resolveGitRemoteCheck(options.gitRemoteCheck === false, loadConfig());

  // The pool entry may still be warming up: until it is ready its path does not exist on disk (options.agentCwd points at the same path), so never hand it out.
  const agentCwdIfExists = (): string | undefined =>
    options.agentCwd && existsSync(options.agentCwd) ? options.agentCwd : undefined;
  const resolvePRLocalCwd = (meta: PRMetadata | undefined = prMetadata): string | undefined => {
    const pool = options.worktreePool;
    if (pool && meta) {
      const r = resolvePoolCwd(pool, meta.url);
      if (r.kind === "ready") return r.path;
      if (r.kind === "pending") return undefined; // warming up — don't fall back
    }
    return agentCwdIfExists();
  };
  // Failure memo: a persistently failing checkout must not turn every hover or agent launch into a re-fetch; failed URLs are skipped for a cooldown.
  const prLocalFailureMemo = new Map<string, number>();
  const PR_LOCAL_RETRY_COOLDOWN_MS = 30_000;
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
  const ensurePRCallFlowCwd = async (meta: PRMetadata | undefined = prMetadata): Promise<string | undefined> => {
    if (options.worktreePool && meta) {
      try {
        return (await options.worktreePool.ensure(gitRuntime, meta)).path;
      } catch {
        return undefined;
      }
    }
    return resolvePRLocalCwd(meta);
  };

  // Fingerprint captured beside every patch snapshot; null means "cannot fingerprint" and is reported as fresh, never stale.
  let currentFingerprint = options.initialFingerprint ?? getGitButlerPatchFingerprint(
      currentDiffType as DiffType,
      currentPatch,
      clientGitContext,
    );
  const computeDiffFingerprint = async (): Promise<string | null> => {
    try {
      if (workspace) return await workspace.getFingerprint();
      if (isPRMode) {
        if (currentPRDiffScope === "layer") {
          // Platform diff is immutable locally; the :incomplete suffix keeps the baseline honest across the local-recompute upgrade.
          const suffix = layerPatchIncomplete ? ":incomplete" : "";
          return `pr-layer:${prMetadata?.url ?? ""}${suffix}`;
        }
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
  // Generation-guarded: captures can resolve out of order, and only the latest may write the baseline or /api/diff/fresh would report stale forever.
  let fingerprintGeneration = 0;
  const repoListing = createRepoListingCache();
  const repoWatch = createReviewRepoWatch();
  let snapshotCapturedAt = Date.now();
  let pendingFingerprintCapture: Promise<string | null> | null = null;
  const fileContentFingerprintProbes = new SingleFlight<string | null>();
  const callFlowService = new CallFlowService();
  // Completion invalidates the service's 30 second runtime probe cache so the next capability advert sees the install.
  const callFlowInstall = new CallFlowInstallCoordinator({
    ...options.callFlowInstall,
    onSettled: (ok) => {
      if (ok) callFlowService.invalidateRuntimeState();
    },
  });
  const captureProgress = () => !resolveReviewProgress(loadConfig()) ? Promise.resolve(null) : captureReviewProgress({
    patch: currentPatch,
    fileIdentities: currentFileIdentities,
    diffType: currentDiffType,
    base: currentBase,
    cwd: gitContext ? gitContext.cwd ?? process.cwd() : undefined,
    vcsType: sessionVcsType,
    prUrl: prMetadata?.url,
    prScope: currentPRDiffScope,
    workspaceRoot: workspace?.root,
  }, gitRuntime.runGit);
  let progressSnapshot: ReturnType<typeof captureProgress> = Promise.resolve(null);
  const captureDraftTarget = (base = currentBase) => isPRMode || isStaticPatchMode ? Promise.resolve(null) : localGitDraftTargetKey({
    diffType: currentDiffType,
    base,
    defaultBase: remoteCheckEnabled && !baseExplicitlyChosen ? detectedCompareTarget() : undefined,
    cwd: gitContext ? gitContext.cwd ?? process.cwd() : undefined,
    vcsType: sessionVcsType,
    workspaceRoot: workspace?.root,
  }, gitRuntime.runGit);
  const captureDiffFingerprint = (knownFingerprint?: string, knownDraftTarget?: string | null): void => {
    snapshotCapturedAt = Date.now();
    repoListing.invalidate();
    progressSnapshot = captureProgress();
    if (knownDraftTarget !== undefined) localDraftTarget = knownDraftTarget;
    // A fingerprint capture marks a committed view change: stop work for the prior snapshot even when the new view cannot run CallDiff.
    callFlowService.cancelAll();
    fileContentFingerprintProbes.clear();
    const generation = ++fingerprintGeneration;
    if (knownFingerprint !== undefined) {
      currentFingerprint = knownFingerprint;
      pendingFingerprintCapture = null;
      return;
    }
    // The previous snapshot's fingerprint must not serve as the new baseline while this capture is in flight.
    currentFingerprint = null;
    const capture = computeDiffFingerprint();
    pendingFingerprintCapture = capture;
    void capture.then((fingerprint) => {
      if (generation === fingerprintGeneration) {
        currentFingerprint = fingerprint;
        pendingFingerprintCapture = null;
      }
    });
  };
  localDraftTarget = await captureDraftTarget();
  if (currentFingerprint === null) captureDiffFingerprint();
  else progressSnapshot = captureProgress();

  const resolveReviewBase = (
    requestedBase?: string,
    explicitlyChosen = baseExplicitlyChosen,
    activeBase = currentBase,
  ): string => {
    const resolved = resolveBaseBranch(requestedBase, detectedCompareTarget());
    // Canonicalize a bare local default name to its tracking ref: the startup upgrade races the first /api/diff, so an early client re-sends the bare name. Not when the user explicitly picked a base.
    const remoteBranch = remoteDefaultInfo?.branch;
    if (
      !explicitlyChosen &&
      remoteBranch &&
      remoteBranch.startsWith("origin/") &&
      resolved === remoteBranch.replace(/^origin\//, "")
    ) {
      return remoteBranch;
    }
    // Also stay on the tracking ref when a non-explicit request echoes the bare name: remoteDefaultInfo comes from a second probe that can lag the startup upgrade.
    if (!explicitlyChosen && activeBase === `origin/${resolved}`) {
      return activeBase;
    }
    return resolved;
  };

  let remoteDefaultInfo: RemoteDefaultInfo | null = null;
  let baseBehindRemote = false;
  let lastRemoteBaseCheck = 0;
  let remoteBaseCheckIntervalMs = REMOTE_BASE_CHECK_INTERVAL_MS;
  // Separate from the opt-out: an explicit Fetch is the user asking for the network, so `/api/fetch-base` stays reachable with the remote check off.
  const gitRemoteSessionApplies = (): boolean =>
    !!gitContext && !isPRMode && (!sessionVcsType || sessionVcsType === "git");
  const remoteBaseCheckApplies = (): boolean =>
    remoteCheckEnabled && gitRemoteSessionApplies();

  // Only meaningful for diff types that compare against a base.
  const baseRelevantDiffType = (diffType: string = currentDiffType as string): boolean => {
    const t = parseWorktreeDiffType(diffType)?.subType ?? diffType;
    return t === "since-base" || t === "branch" || t === "merge-base";
  };

  const computeBaseBehindRemote = async (
    base: string = currentBase,
    diffType: string = currentDiffType as string,
    explicitlyChosen = baseExplicitlyChosen,
  ): Promise<boolean> => {
    // Capture once: a concurrent refresh can null remoteDefaultInfo during the await below.
    const remoteInfo = remoteDefaultInfo;
    if (!remoteBaseCheckApplies() || !baseRelevantDiffType(diffType) || !remoteInfo?.remoteHeadSha) {
      return false;
    }
    // Compare by resolved SHA, not ref name, since currentBase may be the bare local name. A local name the user explicitly picked is exempt: Fetch advances origin/*, so the banner could never clear.
    const remoteBranch = remoteInfo.branch;
    const localName = remoteBranch.replace(/^origin\//, "");
    const matchesDefault =
      base === remoteBranch ||
      (base === localName && !explicitlyChosen);
    if (!matchesDefault) {
      return false;
    }
    // --verify: without it `rev-parse --end-of-options <ref>` echoes the flag as a first output line and the SHA never matches.
    const local = await gitRuntime.runGit(
      ["--no-optional-locks", "rev-parse", "--verify", "--end-of-options", base],
      { cwd: gitContext?.cwd },
    );
    return local.exitCode === 0 && local.stdout.trim() !== remoteInfo.remoteHeadSha;
  };

  const recomputeBaseBehindRemote = async (): Promise<void> => {
    baseBehindRemote = await computeBaseBehindRemote();
  };

  const refreshRemoteBaseInfo = async (): Promise<void> => {
    if (!remoteBaseCheckApplies()) return;
    lastRemoteBaseCheck = Date.now();
    remoteDefaultInfo = await detectRemoteDefaultInfo(gitRuntime, gitContext?.cwd);
    // Negative caching: detectRemoteDefaultInfo returns null for every failure mode. Back off on failure and reset when the remote answers.
    remoteBaseCheckIntervalMs = nextRemoteBaseCheckInterval(
      remoteBaseCheckIntervalMs,
      remoteDefaultInfo !== null,
    );
    await recomputeBaseBehindRemote();
  };

  const maybeRefreshRemoteBaseInfo = (): void => {
    if (!remoteBaseCheckApplies()) return;
    if (Date.now() - lastRemoteBaseCheck < remoteBaseCheckIntervalMs) return;
    lastRemoteBaseCheck = Date.now();
    void refreshRemoteBaseInfo().catch(() => {});
  };

  // Two independent startup probes: remote staleness at boot, and upgrading currentBase to the tracking ref when no explicit base was requested or the base is the bare local default name. Skipped when the remote check is off, since the upgrade itself runs an ls-remote.
  if (gitContext && !isPRMode && remoteCheckEnabled) {
    detectRemoteDefaultCompareTarget(gitContext.cwd, sessionVcsType).then(
      async (remote) => {
        if (remote && !baseEverSwitched && currentBase !== remote) {
          const localName = remote.replace(/^origin\//, "");
          // An explicitly pinned base (`--base main`) is never upgraded.
          if (!options.initialBaseExplicit && (!options.initialBase || currentBase === localName)) {
            // Rebuild the diff for the upgraded base before swapping it in and commit base, patch, ref and fingerprint together, else the review mixes bases. Skip if the user switched meanwhile.
            try {
              const rebuilt = await runVcsDiff(
                currentDiffType as DiffType,
                remote,
                gitContext.cwd,
                { hideWhitespace: currentHideWhitespace, captureFileIdentities: true },
              );
              const rebuiltDraftTarget = await captureDraftTarget(remote);
              if (!baseEverSwitched) {
                currentBase = remote;
                currentPatch = rebuilt.patch;
                currentFileIdentities = rebuilt.fileIdentities;
                currentGitRef = rebuilt.label;
                currentError = rebuilt.error;
                // draftKey doubles as the snapshot id the freshness probe compares against each client's ?snapshot=, so a client holding the pre-upgrade patch gets the refresh banner; that is why the fingerprint can re-baseline unconditionally.
                draftKey = contentHash(currentPatch);
                captureDiffFingerprint(undefined, rebuiltDraftTarget);
              }
            } catch {
              /* keep the initial base+patch — they still match each other */
            }
          }
        }
        void refreshRemoteBaseInfo().catch(() => {});
      },
      () => {
        void refreshRemoteBaseInfo().catch(() => {});
      },
    );
  }

  const commitAvatars = createCommitAvatarResolver(prCommandRuntime);

  const isSinceBaseActive = (diffType: string = currentDiffType as string): boolean => {
    if (isPRMode || workspace || !gitContext) return false;
    const effective = parseWorktreeDiffType(diffType)?.subType ?? diffType;
    return effective === "since-base";
  };
  // Base and diff type are parameters so callers can pin them to a snapshot taken before an await.
  const buildSectionsSidecar = async (
    base: string = currentBase,
    diffType: string = currentDiffType as string,
  ): Promise<SinceBaseSections | undefined> => {
    if (!isSinceBaseActive(diffType)) return undefined;
    const cwd = resolveVcsCwd(diffType as DiffType, gitContext?.cwd);
    return (await getSinceBaseSections(gitRuntime, base, cwd)) ?? undefined;
  };

  const buildCommitInfoSidecar = async (diffType: string = currentDiffType as string): Promise<CommitDiffInfo | undefined> => {
    if (isPRMode || workspace || !gitContext) return undefined;
    const effective = parseWorktreeDiffType(diffType)?.subType ?? diffType;
    const sha = parseCommitDiffType(effective as string)?.sha;
    const jjCommitId = parseJjCommitDiffType(effective as string)?.commitId;
    if (!sha && !jjCommitId) return undefined;
    const cwd = resolveVcsCwd(diffType as DiffType, gitContext.cwd);
    const info = jjCommitId
      ? await getJjCommitDiffInfo(jjRuntime, jjCommitId, cwd)
      : await getCommitDiffInfo(gitRuntime, sha!, cwd);
    if (!info) return undefined;
    const avatars = await commitAvatars.resolve(cwd, [info.authorEmail]);
    const avatarUrl = avatars.get(info.authorEmail);
    return avatarUrl ? { ...info, avatarUrl } : info;
  };

  // Attribute refinement (`linguist-generated`) runs for plain local Git sessions only; everything else gets name-based defaults. Presentation only: the patch is never filtered.
  const buildGeneratedFilesSidecar = async (
    patch: string = currentPatch,
    diffType: string = currentDiffType as string,
  ): Promise<string[] | undefined> => {
    const paths = listPatchFiles(patch).map((f) => f.path);
    const plainLocalGit =
      !isPRMode && !workspace && gitContext && (sessionVcsType ?? "git") === "git";
    const generated = plainLocalGit
      ? await detectGeneratedFiles(
          gitRuntime,
          resolveVcsCwd(diffType as DiffType, gitContext.cwd),
          paths,
        )
      : detectGeneratedFilesByName(paths);
    return generated.length > 0 ? generated : undefined;
  };

  // Spawned jobs run on this machine: API URL pinned to loopback, never the advertised-URL host override.
  let serverUrl = "";
  let agentApiUrl = "";
  const activeReviewTarget = (): string | undefined => {
    if (isPRMode) return prMetadata?.url;
    if (isStaticPatchMode) return undefined;
    if (workspace) return workspace.root;
    return resolveVcsCwd(currentDiffType as DiffType, gitContext?.cwd) ?? gitContext?.cwd ?? undefined;
  };
  const resolveAgentCwd = (): string => {
    if (workspace) return workspace.root;
    if (options.worktreePool && prMetadata) {
      return resolvePRLocalCwd()
        ?? resolveVcsCwd(currentDiffType as DiffType, gitContext?.cwd)
        ?? process.cwd();
    }
    return options.agentCwd ?? resolveVcsCwd(currentDiffType as DiffType, gitContext?.cwd) ?? process.cwd();
  };
  // Strict launch root for /api/open-in: in PR pool mode only the PR's own checkout, never the launch-repo fallback; [] until it is ready.
  const resolveOpenInRoot = (): string | string[] => {
    if (workspace) return workspace.root;
    if (options.worktreePool && prMetadata) return resolvePRLocalCwd() ?? [];
    return options.agentCwd ?? resolveVcsCwd(currentDiffType as DiffType, gitContext?.cwd) ?? process.cwd();
  };
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

  // GitButler's picker topology is live state: a compact revision in the snapshot id keeps another tab from rebaselining the fingerprint and making an old picker look fresh.
  let currentContextRevision = getGitButlerContextRevision(clientGitContext) ?? "";

  // The "changes under review" context for Ask AI, built from the current view. Parameterized so handlers that snapshot state before an await build it from that snapshot, not the live globals.
  // Snapshot id clients echo on freshness probes: content hash plus view mode, base deliberately excluded so main -> origin/main canonicalization stays banner-silent. draftKey stays a pure content hash.
  const currentSnapshotId = (): string =>
    `${draftKey}:${currentDiffType}${isPRMode ? `:${currentPRDiffScope}` : ""}${currentContextRevision ? `:${currentContextRevision}` : ""}${currentFileIdentities ? `:${contentHash(JSON.stringify(currentFileIdentities))}` : ""}`;

  // Every submission appends a record to feedback/{project}/index.jsonl before the draft is deleted. Prefer the caller's project name; the cwd fallback misfiles PR reviews (`--local` points agentCwd at `pool/pr-<n>`).
  const feedbackProject = (): string =>
    options.project?.trim()
      ? options.project
      : deriveFeedbackProject(gitContext?.cwd ?? options.agentCwd ?? process.cwd());

  // Diff identity only; the patch bytes are deliberately not archived.
  const feedbackReviewTarget = (): FeedbackReviewTarget => {
    const target: FeedbackReviewTarget = {
      diffType: String(currentDiffType),
      base: currentBase,
      gitRef: currentGitRef,
      snapshotId: currentSnapshotId(),
      changedFiles: countChangedFiles(currentPatch),
      patchBytes: currentPatch.length,
    };
    if (sessionVcsType) target.vcsType = sessionVcsType;
    else if (workspace) target.vcsType = "workspace";
    const cwd = gitContext?.cwd ?? options.agentCwd;
    if (cwd) target.cwd = cwd;
    if (prMetadata) {
      target.pr = {
        provider: prMetadata.platform,
        repo: getDisplayRepo(prMetadata),
        number: getPRNumber(prMetadata),
      };
    }
    return target;
  };

  /** Append the archive record for one submission. Returns whether the draft delete may proceed: false only when an expected durable write failed, so the draft stays as the recovery copy. */
  const archiveReviewSubmission = (
    feedback: unknown,
    annotations: unknown,
    decision: FeedbackDecision,
  ): boolean => {
    if (!resolveFeedbackHistory(loadConfig())) return true;
    const feedbackText = typeof feedback === "string" ? feedback : "";
    const annotationList = Array.isArray(annotations) ? annotations : [];
    const hasContent = feedbackText.trim().length > 0 || annotationList.length > 0;
    const written = appendFeedbackRecord({
      project: feedbackProject(),
      origin,
      surface: "review",
      decision,
      target: { review: feedbackReviewTarget() },
      feedback: feedbackText,
      annotations: annotationList,
    });
    return written !== null || !hasContent;
  };

  const buildCurrentAiReviewContext = (
    patch: string = currentPatch,
    base: string = currentBase,
    diffType: DiffType = currentDiffType as DiffType,
  ): string | undefined => {
    if (!aiEnabled) return undefined;
    const workspacePrompt = getWorkspacePromptContext();
    if (workspacePrompt) {
      return buildAgentReviewUserMessageForTarget(
        { kind: "workspace", patch, workspace: workspacePrompt },
        true,
      );
    }
    const hasLocalAccess = !!gitContext ||
      (options.worktreePool && prMetadata
        ? resolvePRLocalCwd(prMetadata) !== undefined
        : !!options.agentCwd);
    return buildAgentReviewUserMessage(
      patch,
      diffType,
      { defaultBranch: base, hasLocalAccess, prDiffScope: currentPRDiffScope },
      prMetadata,
      true,
    );
  };
  const semanticDiffScratchCwd = getSemanticDiffScratchCwd();
  const resolveSemanticDiffCwd = (diffType: DiffType = currentDiffType as DiffType): string => {
    if (workspace) return workspace.root;
    if (options.worktreePool && prMetadata) {
      const poolPath = resolvePRLocalCwd();
      if (poolPath) return poolPath;
      // Checkout warming up: probe sem availability in the scratch dir; the real run awaits the checkout.
      if (options.worktreePool.has(prMetadata.url)) return semanticDiffScratchCwd;
    }
    if (options.agentCwd) return options.agentCwd;
    if (gitContext) {
      const vcsCwd = resolveVcsCwd(diffType, gitContext.cwd);
      if (vcsCwd) return vcsCwd;
      if (gitContext.cwd) return gitContext.cwd;
    }
    return semanticDiffScratchCwd;
  };
  const semanticDiffCache = new SemanticDiffResponseCache();
  const semanticDiffAvailabilityCache = new Map<string, Promise<SemanticDiffAvailability>>();

  const semanticDiffEnabled = (): boolean => loadConfig().reviewAnalysis?.semanticDiff !== false;
  const callFlowEnabled = (): boolean => loadConfig().reviewAnalysis?.callFlow === true;

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

  const getSemanticDiffAdvert = async (
    diffType: DiffType = currentDiffType as DiffType,
    enabled = semanticDiffEnabled(),
  ) => {
    if (!enabled) return { available: false, enabled: false };
    if (isGitButlerCommittedView(diffType)) return { available: false };
    const availability = await getSemanticDiffAvailabilityForCwd(resolveSemanticDiffCwd(diffType));
    return {
      available: availability.available,
      ...(availability.semVersion && { semVersion: availability.semVersion }),
      ...(availability.semSource && { semSource: availability.semSource }),
    };
  };

  const getSemanticDiff = async (url: URL): Promise<SemanticDiffResponse> => {
    if (!semanticDiffEnabled()) {
      return { status: "unavailable", reason: "disabled", message: "Semantic diff is disabled in Settings → Analysis." };
    }
    if (isGitButlerCommittedView()) {
      return {
        status: "unavailable",
        reason: "gitbutler-committed-view",
        message: "Semantic diff is unavailable for committed GitButler views because the live workspace may contain other layers.",
      };
    }
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
      // Cooldown-memoized so request rate does not drive sem execution rate when it is failing.
      semanticDiffCache.setFailure(cacheKey, currentPatch, result);
    }
    return result;
  };

  const getCallFlowAdvert = (
    diffType: DiffType = currentDiffType as DiffType,
    enabled = callFlowEnabled(),
  ) =>
    callFlowService.getAdvert(enabled, {
      snapshotSupported: !workspace && (isPRMode || vcsSupportsSnapshot(sessionVcsType ?? "git", diffType)),
      rawPatch: currentPatch,
    });

  const getCallFlow = async (url: URL): Promise<CallFlowResponse> => {
    const requestedSnapshot = url.searchParams.get("snapshot");
    if (!requestedSnapshot || requestedSnapshot !== currentSnapshotId()) {
      return { status: "stale", reason: "snapshot-mismatch", message: "The review changed before call flow could start. Refresh and try again." };
    }
    if (!callFlowEnabled()) {
      return { status: "disabled", reason: "disabled", message: "Call flow is disabled in Settings → Analysis." };
    }
    if (workspace) {
      return { status: "unsupported", reason: "workspace-unsupported", message: "Call flow does not yet support multi-repository workspace reviews." };
    }
    const advert = await getCallFlowAdvert();
    if (advert.state === "unsupported") {
      return {
        status: "unsupported",
        reason: advert.reason ?? "view-unsupported",
        message: advert.message ?? "Call flow is not available for this review view.",
      };
    }

    let analysisCwd: string | undefined;
    let analysisDiffType = currentDiffType as string;
    let analysisBase = currentBase;
    let prCommitPair: { from: string; to: string } | undefined;
    if (isPRMode && prMetadata) {
      if (currentPRDiffScope === "layer" && layerPatchIncomplete) {
        return { status: "unsupported", reason: "incomplete-patch", message: "Call flow is unavailable until the complete PR layer diff is available locally." };
      }
      analysisCwd = await ensurePRCallFlowCwd();
      if (!analysisCwd) {
        return { status: "unavailable", reason: "checkout-unavailable", message: "Call flow needs a local PR checkout, which is not ready." };
      }
      if (currentPRDiffScope === "full-stack" && prMetadata.defaultBranch) {
        const baseRef = await resolvePRFullStackBaseRef(gitRuntime, prMetadata.defaultBranch, analysisCwd);
        if (!baseRef) return { status: "unavailable", reason: "base-unavailable", message: "The full-stack base commit is unavailable locally." };
        analysisDiffType = "merge-base";
        analysisBase = baseRef;
      } else {
        prCommitPair = { from: prMetadata.mergeBaseSha ?? prMetadata.baseSha, to: prMetadata.headSha };
      }
    } else {
      analysisCwd = resolveVcsCwd(currentDiffType as DiffType, gitContext?.cwd)
        ?? gitContext?.cwd
        ?? options.agentCwd
        ?? process.cwd();
    }
    if (!analysisCwd) {
      return { status: "unavailable", reason: "checkout-unavailable", message: "Call flow requires a local Git checkout." };
    }

    const baseline = pendingFingerprintCapture ? await pendingFingerprintCapture : currentFingerprint;
    const before = await computeDiffFingerprint();
    if (requestedSnapshot !== currentSnapshotId() || (baseline && before && baseline !== before)) {
      return { status: "stale", reason: "snapshot-stale", message: "The files changed before call flow could start. Refresh the review first." };
    }
    const analysisVcsType = isPRMode ? "git" : sessionVcsType ?? "git";
    return callFlowService.analyze({
      snapshotId: requestedSnapshot,
      rawPatch: currentPatch,
      snapshot: {
        materialize: ({ includedExtensions, signal }) => materializeVcsSnapshot(analysisVcsType, {
          cwd: analysisCwd,
          diffType: analysisDiffType as DiffType,
          base: analysisBase,
          rawPatch: currentPatch,
          includedExtensions,
          ...(prCommitPair && { prCommitPair }),
          signal,
        }),
      },
      verifySnapshot: async () => {
        const after = await computeDiffFingerprint();
        return requestedSnapshot === currentSnapshotId() && !(before && after && before !== after);
      },
    });
  };

  const agentJobs = createAgentJobHandler({
    mode: "review",
    getServerUrl: () => agentApiUrl,
    getCwd: resolveAgentCwd,
    serverSession,

    async buildCommand(provider, config) {
      // Snapshot all launch-relevant state before any await: other requests (e.g. pr-switch) run while the warmup is awaited.
      const launchMetadata = prMetadata;
      const launchPatch = currentPatch;
      const launchDiffType = currentDiffType;
      const launchBase = currentBase;
      const launchScope = currentPRDiffScope;
      const launchGitRef = currentGitRef;
      const launchSnapshotId = currentSnapshotId();
      const launchWorkspacePrompt = getWorkspacePromptContext();
      // Snapshotted with the patch it describes: layerPatchIncomplete is live state, and the guide branch's recompute must decide against the same moment.
      const launchLayerPatchIncomplete = layerPatchIncomplete;

      const requestedProfileId =
        typeof config?.reviewProfileId === "string" ? config.reviewProfileId : undefined;
      // An unresolvable non-default id never silently downgrades to the default; explicit selection is authoritative.
      const reviewProfile = resolveRequestedReviewProfile(requestedProfileId);

      // Agents run inside the PR checkout: wait out the warmup so the spawn-time getCwd() resolves to an existing path.
      let cwd: string;
      if (options.worktreePool && launchMetadata) {
        const checkout = await ensurePRLocalCwd(launchMetadata);
        if (!checkout) {
          // Fail fast: without the checkout the job would run in whatever directory the CLI was launched from.
          throw new Error(
            "Local PR checkout unavailable — the agent can't run against the PR files. Retry shortly (the checkout may still be recovering).",
          );
        }
        cwd = checkout;
      } else {
        cwd = await resolveAgentCwdReady();
      }
      const workspacePrompt = launchWorkspacePrompt;
      // In PR mode the checkout must actually be available (warmup done, not failed): the prompt tells the agent it can read PR files.
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

      // Snapshot the diff context at launch so "Copy All" matches /api/feedback even if the reviewer switches modes/bases later. Skipped in PR mode.
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
            ...(String(launchDiffType).startsWith("gitbutler:") && {
              label: launchGitRef,
              snapshotId: launchSnapshotId,
            }),
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
        return built ? { ...built, prUrl: launchPrUrl, diffScope: launchDiffScope, diffContext, reviewProfileId: reviewProfile.id, reviewProfileLabel: reviewProfile.label } : built;
      }

      if (provider === "guide") {
        // The changed-file list comes from the launch-time patch and is reused by onJobComplete to validate refs; re-deriving it would invalidate valid refs after a mid-generation switch.
        let changedFiles = listPatchFiles(launchPatch);
        // On very large PRs the layer patch is partial, but the prompt tells the agent to read the full local diff: recompute names and counts locally when the checkout is ready, else fall back to the partial list. Layer scope only; full-stack launchPatch is already the local full recompute.
        if (launchLayerPatchIncomplete && launchScope !== "full-stack" && launchMetadata?.baseBranch) {
          const localCwd = resolvePRLocalCwd(launchMetadata);
          if (localCwd) {
            try {
              const res = await gitRuntime.runGit(
                ["diff", "--numstat", `origin/${launchMetadata.baseBranch}...HEAD`],
                { cwd: localCwd },
              );
              if (res.exitCode === 0) {
                const recomputed = res.stdout
                  .split("\n")
                  .filter((line) => line.trim())
                  .map((line) => {
                    const [a, d, ...rest] = line.split("\t");
                    const raw = rest.join("\t");
                    if (!raw) return null;
                    // numstat rename forms: "src/{old => new}/f" or "old => new"; refs use post-image paths.
                    const brace = raw.match(/^(.*)\{.* => (.*)\}(.*)$/);
                    const path = brace
                      ? `${brace[1]}${brace[2]}${brace[3]}`.replace(/\/\//g, "/")
                      : raw.includes(" => ")
                        ? raw.split(" => ").pop()!
                        : raw;
                    return { path, additions: Number(a) || 0, deletions: Number(d) || 0 };
                  })
                  .filter((f): f is { path: string; additions: number; deletions: number } => f !== null);
                if (recomputed.length > 0) changedFiles = recomputed;
              }
            } catch {
              // keep the partial-patch list
            }
          }
        }

        const repairOf = typeof config?.repairOf === "string" ? config.repairOf : undefined;
        let repair: { payload: string } | undefined;
        let guideConfig = config;
        if (repairOf) {
          const payload = guide.getFailedPayload(repairOf);
          if (!payload) {
            throw new Error("No captured output to repair for that job — run the guide again instead.");
          }
          // Prefer the failed job's own engine when its binary is present: it provably ran here. claude/codex are only a fallback, since a broken claude repair would become the newest failed job and loop. Marker engines' binaries can differ from the engine id (resolveMarkerBinary).
          const failedEngine = typeof config?.engine === "string" && config.engine ? config.engine : undefined;
          const failedMarker = failedEngine ? MARKER_ENGINES[failedEngine as MarkerEngineId] : undefined;
          const failedEngineInstalled = failedMarker
            ? !!(await resolveMarkerBinary(failedMarker, (name) => Bun.which(name, { PATH: childPath() }) ?? null))
            : !!failedEngine && !!Bun.which(failedEngine, { PATH: childPath() });
          const repairEngine =
            failedEngine && failedEngineInstalled
              ? failedEngine
              : Bun.which("claude", { PATH: childPath() })
                ? "claude"
                : Bun.which("codex", { PATH: childPath() })
                  ? "codex"
                  : (failedEngine ?? "claude");
          repair = { payload };
          guideConfig = { ...config, engine: repairEngine };
        }

        const built = await guide.buildCommand({
          cwd,
          patch: launchPatch,
          diffType: launchDiffType as DiffType,
          options: userMessageOptions,
          prMetadata: launchMetadata,
          changedFiles,
          config: guideConfig,
          ...(repair && { repair }),
        });
        // A repair's payload is the failed job's captured output, so validate against that job's recorded changed-file set, not whatever is on screen now. Fall back only if it was never recorded.
        const changedFilesSnapshot = repairOf
          ? guide.getLaunchChangedFiles(repairOf) ?? changedFiles.map((f) => f.path)
          : changedFiles.map((f) => f.path);
        // Snapshot the launch-time review-target context: guide jobs run for minutes while the session supports PR/diff switching. Repairs reuse the failed job's snapshot.
        const guideContext = (repairOf ? agentJobs.getJob(repairOf)?.guideContext : undefined)
          ?? await guideStore.captureLaunchContext();
        // The review this guide describes, captured from the same launch-time snapshot as the patch, never re-read at export time. Repairs reuse the failed job's review.
        const commitSha = commitFamilyId(String(launchDiffType)) ?? undefined;
        const launchSource: GuideSnapshotSource = workspacePrompt
          ? { kind: "workspace", ...(repoInfo?.display && { repo: repoInfo.display }) }
          : launchMetadata
            ? {
                kind: "pr",
                repo: getDisplayRepo(launchMetadata),
                branch: launchMetadata.headBranch,
                headSha: launchMetadata.headSha,
                pr: {
                  url: launchMetadata.url,
                  number: getPRNumber(launchMetadata),
                  title: launchMetadata.title,
                  // The portable guide format names only github/gitlab; other platforms omit the field.
                  ...(launchMetadata.platform === "github" || launchMetadata.platform === "gitlab"
                    ? { platform: launchMetadata.platform }
                    : {}),
                },
              }
            : {
                kind: commitSha ? "commit" : "local",
                ...(repoInfo?.display && { repo: repoInfo.display }),
                ...(clientGitContext?.currentBranch && { branch: clientGitContext.currentBranch }),
                ...(guideContext.headSha && { headSha: guideContext.headSha }),
                ...(commitSha && { commitSha }),
              };
        const launchReview: GuideLaunchReview = (repairOf ? guide.getLaunchReview(repairOf) : null) ?? {
          rawPatch: launchPatch,
          gitRef: launchGitRef,
          diffType: String(launchDiffType),
          ...(launchBase && { base: launchBase }),
          source: launchSource,
          ...(typeof config?.instructions === "string" && config.instructions.trim() && { customInstructions: config.instructions }),
        };
        return {
          ...built,
          prUrl: launchPrUrl,
          diffScope: launchDiffScope,
          diffContext,
          reviewProfileId: reviewProfile.id,
          reviewProfileLabel: reviewProfile.label,
          changedFilesSnapshot,
          guideContext,
          launchReview,
        };
      }

      // A custom review skill becomes the whole prompt: strip the default framing prose so only the git/PR context remains.
      const isCustomReview = reviewProfile.source === "user";
      const userMessage = workspacePrompt
        ? buildAgentReviewUserMessageForTarget({
            kind: "workspace",
            patch: launchPatch,
            workspace: workspacePrompt,
          }, isCustomReview)
        : buildAgentReviewUserMessage(launchPatch, launchDiffType as DiffType, userMessageOptions, launchMetadata, isCustomReview);
      const jobLabel = workspacePrompt ? "Workspace Review" : "Code Review";

      if (provider === "codex") {
        const model = typeof config?.model === "string" && config.model ? config.model : undefined;
        const reasoningEffort = typeof config?.reasoningEffort === "string" && config.reasoningEffort ? config.reasoningEffort : undefined;
        const fastMode = config?.fastMode === true;
        const outputPath = generateOutputPath();
        const prompt = composeCodexReviewPrompt(userMessage, reviewProfile);
        const command = await buildCodexCommand({ cwd, outputPath, prompt, model, reasoningEffort, fastMode });
        return { command, outputPath, prompt, cwd, label: jobLabel, model, reasoningEffort, fastMode: fastMode || undefined, prUrl: launchPrUrl, diffScope: launchDiffScope, diffContext, reviewProfileId: reviewProfile.id, reviewProfileLabel: reviewProfile.label };
      }

      if (provider === "claude") {
        const model = typeof config?.model === "string" && config.model ? config.model : undefined;
        const effort = typeof config?.effort === "string" && config.effort ? config.effort : undefined;
        const prompt = composeClaudeReviewPrompt(userMessage, reviewProfile);
        const { command, stdinPrompt } = buildClaudeCommand(prompt, model, effort, { sandbox: resolveClaudeSandbox(loadConfig()) });
        return { command, stdinPrompt, prompt, cwd, label: jobLabel, captureStdout: true, model, effort, prUrl: launchPrUrl, diffScope: launchDiffScope, diffContext, reviewProfileId: reviewProfile.id, reviewProfileLabel: reviewProfile.label };
      }

      // Marker engines (Cursor, OpenCode, Pi) have no schema flag, so the marker-block output contract is always appended. captureStdout is required: the marker block comes back on stdout NDJSON.
      const markerEngine = MARKER_ENGINES[provider as MarkerEngineId];
      if (markerEngine) {
        const model = typeof config?.model === "string" && config.model ? config.model : undefined;
        const thinking = typeof config?.thinking === "string" && config.thinking ? config.thinking : undefined;
        // Per-job nonce in the marker contract, recovered from job.prompt at parse time so echoed bare tags are not mistaken for the payload.
        const nonce = makeMarkerNonce();
        const prompt = composeMarkerReviewPrompt(reviewProfile, userMessage, nonce);
        const { command } = buildMarkerCommand(markerEngine, prompt, model, cwd, { thinking, cursorSandbox: resolveCursorSandbox(loadConfig()) });
        return { command, prompt, cwd, label: jobLabel, captureStdout: true, model, thinking, prUrl: launchPrUrl, diffScope: launchDiffScope, diffContext, reviewProfileId: reviewProfile.id, reviewProfileLabel: reviewProfile.label };
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
        prNumber: getPRNumber(jobPrMeta),
        prTitle: jobPrMeta.title,
        prRepo: getDisplayRepo(jobPrMeta),
      } : jobPrUrl ? { prUrl: jobPrUrl } : {};

      const profileLabel =
        job.reviewProfileId && job.reviewProfileId !== BUILTIN_DEFAULT_PROFILE.id
          ? job.reviewProfileLabel
          : undefined;

      const ingest = <T extends object>(transformed: readonly T[], logTag: string) => {
        if (transformed.length === 0) return undefined;
        const annotations = transformed.map((a) => ({
          ...a,
          ...jobPrContext,
          ...(jobDiffScope && { diffScope: jobDiffScope }),
          ...getAgentJobAnnotationContext(job.diffContext),
          ...(profileLabel && { reviewProfileLabel: profileLabel }),
        }));
        const result = externalAnnotations.addAnnotations({ annotations });
        if ("error" in result) console.error(`[${logTag}] addAnnotations error:`, result.error);
        return result;
      };

      if (job.provider === "codex") {
        const output = meta.outputPath ? await parseCodexOutput(meta.outputPath) : null;
        if (!output) {
          // Exited 0 but output missing/unparseable: not a green run.
          markJobReviewFailed(job, REVIEW_OUTPUT_FAILED);
          return;
        }

        // Override the verdict on blocking findings (P0/P1): Codex's freeform correctness string can say "mostly correct" despite real bugs.
        const hasBlockingFindings = output.findings.some(f => f.priority !== null && f.priority <= 1);
        job.summary = {
          correctness: hasBlockingFindings ? "Issues Found" : output.overall_correctness,
          explanation: output.overall_explanation,
          confidence: output.overall_confidence_score,
        };

        ingest(
          transformReviewFindings(
            output.findings,
            job.source,
            cwd,
            "Codex",
            workspace ? (filePath) => workspace.normalizeAnnotationPath(filePath) : undefined,
          ),
          "codex-review",
        );
        return;
      }

      if (job.provider === "claude") {
        const stdout = meta.stdout ?? "";
        const output = parseClaudeStreamOutput(stdout);
        if (!output) {
          console.error(`[claude-review] Failed to parse output (${stdout.length} bytes, last 200: ${stdout.slice(-200)})`);
          markJobReviewFailed(job, REVIEW_OUTPUT_FAILED);
          return;
        }

        const transformed = transformClaudeFindings(
          output.findings,
          job.source,
          cwd,
          workspace ? (filePath) => workspace.normalizeAnnotationPath(filePath) : undefined,
        );
        const counts = { important: 0, nit: 0, pre_existing: 0 };
        for (const a of transformed) counts[a.severity]++;
        const total = counts.important + counts.nit + counts.pre_existing;
        job.summary = {
          correctness: counts.important === 0 ? "Correct" : "Issues Found",
          explanation: `${counts.important} important, ${counts.nit} nit, ${counts.pre_existing} pre-existing`,
          confidence: total === 0 ? 1.0 : Math.max(0, 1.0 - (counts.important * 0.2)),
        };

        ingest(transformed, "claude-review");
        return;
      }

      // FAIL-CLOSED: marker output is prompt-enforced (no schema flag), so any
      // Marker output is prompt-enforced: any failure must mutate the job to failed, never throw (agent-jobs.ts swallows throws and would leave an exit-0 job marked done).
      const markerEngine = MARKER_ENGINES[job.provider as MarkerEngineId];
      if (markerEngine) {
        // Recover the per-job nonce from the prompt; without it no block can be trusted, so parsing fails closed.
        const nonce = extractMarkerNonce(job.prompt ?? "");
        const output = nonce && meta.stdout ? parseMarkerStreamOutput(meta.stdout, markerEngine, nonce) : null;
        if (!output) {
          job.status = "failed";
          const providerError = meta.stdout
            ? reduceMarkerStream(meta.stdout, markerEngine).providerError
            : null;
          job.error = providerError
            ?? `${markerEngine.author} review output missing or unparseable (no valid marker JSON).`;
          if (providerError) {
            console.error(`[${markerEngine.id}-review] Provider error for job ${job.id}: ${providerError}`);
          }
          return;
        }

        // Derive the verdict from finding severities: marker engines have no schema flag, and a free-form `correctness` string like "not correct" would render green in the detail panel.
        const hasImportant = output.findings.some((f) => f.severity === "important");
        job.summary = {
          correctness: hasImportant ? "Issues Found" : "Correct",
          explanation: output.summary.explanation,
          confidence: output.summary.confidence,
        };

        const result = ingest(
          transformMarkerFindings(
            output.findings,
            job.source,
            markerEngine.author,
            cwd,
            workspace ? (filePath) => workspace.normalizeAnnotationPath(filePath) : undefined,
          ),
          `${markerEngine.id}-review`,
        );
        if (result && "error" in result) {
          job.status = "failed";
          job.error = `${markerEngine.author} annotation insertion failed: ${result.error}`;
          return;
        }
        return;
      }

      if (job.provider === "tour") {
        const { summary } = await tour.onJobComplete({ job, meta });
        if (summary) {
          job.summary = summary;
        } else {
          // Exit 0 with empty or malformed output and nothing stored: flip status so the client does not auto-open a card that 404s.
          job.status = "failed";
          job.error = TOUR_EMPTY_OUTPUT_ERROR;
        }
        return;
      }

      if (job.provider === "guide") {
        // Validate refs against the launch-time changed-file set snapshotted on the job, not the current patch: a mid-generation view change would invalidate valid refs. Falls back to the current patch if the snapshot is missing.
        const changedFiles = meta.changedFilesSnapshot ?? listPatchFiles(currentPatch).map((f) => f.path);
        const { summary, error } = await guide.onJobComplete({ job, meta, changedFiles, launchReview: meta.launchReview });
        if (summary) {
          job.summary = summary;
          // Only guides that passed validateGuideOutput reach guideResults, so a getGuide hit is the validation gate. The envelope is labeled by the job's launch-time snapshot, not live session state.
          const validated = guide.getGuide(job.id);
          if (validated) await guideStore.saveForJob(guideSaveJob(job), validated, job.guideContext, meta.launchReview);
        } else {
          // Fail closed as for Tour: exit 0 with empty, malformed or fully invalidated output must not look like a card that 404s.
          job.status = "failed";
          job.error = error ?? GUIDE_EMPTY_OUTPUT_ERROR;
        }
        return;
      }
    },
  });

  // Set once bound: "Ask this session" answers only a loopback Host with this port.
  let boundPort: number | undefined;
  // The localhost subdomain this session is advertised at, read once: the one extra name the loopback Host checks accept.
  const localHostname = getLocalUrlHostname();
  const aiRuntime = aiEnabled ? await createAIRuntime({ getCwd: resolveAgentCwd, sessionBridge: options.sessionBridge, getServerPort: () => boundPort, localHostname, ...(options.tailnetPublished === true ? { tailnet: sessionTailnetGate } : {}) }) : null;

  const isRemote = isRemoteSession();
  // Hover cards run nothing until asked for, and never in remote mode. In a `--tailscale` session only this machine's tabs and the tailnet owner's get them: other devices must not drive the user's gh / glab.
  const refCards = createRefCards(options.refRunner ? { run: options.refRunner } : {});
  // Served compressed only to sessions reachable from another device: remote mode or --tailscale.
  const compressAppHtml = isRemote || options.tailnetPublished === true;
  const app = openPackedApp(htmlContent);
  const diagramEngineAssets = createDiagramEngineAssets(options.diagramEngine);
  diagramEngineAssets.warm();
  const wslFlag = await isWSL();
  const gitUser = detectGitUser(workspace?.root ?? gitContext?.cwd);

  // Static patch: the repo the process sits in is not the patch's origin; advertising it would show an unrelated repo and branch.
  let repoInfo = isStaticPatchMode
    ? undefined
    : isPRMode && prMetadata
    ? { display: getDisplayRepo(prMetadata), branch: `${getMRLabel(prMetadata)} ${getMRNumberLabel(prMetadata)}` }
    : workspace
      ? { display: basename(workspace.root), branch: "Workspace" }
    : await getRepoInfo(gitContext?.cwd);
  if (!isStaticPatchMode && gitContext?.repository?.displayFallback) {
    repoInfo = {
      ...repoInfo,
      display: repoInfo?.display || gitContext.repository.displayFallback,
    };
  }

  let prRef = isPRMode && prMetadata ? prRefFromMetadata(prMetadata) : null;
  if (prRef && prMetadata) {
    warmPRContext(prMetadata.url, prRef);
  }
  const platformUser = prRef ? await getPRUser(prRef) : null;
  let prStackInfo = prMetadata ? getPRStackInfo(prMetadata) : null;
  let prDiffScopeOptions = prMetadata
    ? getPRDiffScopeOptions(prMetadata, !!(options.worktreePool || options.agentCwd))
    : [];

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

  let reviewDecided = false;
  let resolveDecision: (result: {
    approved: boolean;
    feedback: string;
    reviewDirectory?: string;
    annotations: unknown[];
    agentSwitch?: string;
    exit?: boolean;
    closedBy?: "agent";
    unsentAnnotations?: number;
    platform?: true;
    target?: string;
  }) => void;
  const decisionPromise = new Promise<{
    approved: boolean;
    feedback: string;
    reviewDirectory?: string;
    annotations: unknown[];
    agentSwitch?: string;
    exit?: boolean;
    closedBy?: "agent";
    unsentAnnotations?: number;
    platform?: true;
    target?: string;
  }>((resolve) => {
    resolveDecision = (result) => {
      reviewDecided = true;
      const target = result.target ?? activeReviewTarget();
      resolve(target ? { ...result, target } : result);
    };
  });

  const reviewAlreadyDecided = () =>
    Response.json({ error: "This review session has already been decided.", code: "already_decided" }, { status: 409 });

  // Closing is the reviewer's Close marked closedBy "agent", without settling the draft or archiving a decision the reviewer never made.
  const hostControlToken = resolveHostControlToken(options.hostControlToken);
  const unsentReviewComments = (): number => {
    const loaded = reviewDrafts.load(currentDraftKeys());
    return loaded.found ? countUnsentDraftComments(loaded.draft) : 0;
  };
  const hostControl: HostControl = {
    status: () => ({
      kind: "review",
      documents: isPRMode && prMetadata ? [prMetadata.url] : [],
      unsentAnnotations: unsentReviewComments(),
      decided: reviewDecided,
    }),
    close: () => {
      if (reviewDecided) return { closed: false, reason: "decided" };
      const unsentAnnotations = unsentReviewComments();
      resolveDecision({ approved: false, feedback: "", annotations: [], exit: true, closedBy: "agent", unsentAnnotations });
      externalAnnotations.broadcast(hostSessionClosedEvent(unsentAnnotations));
      return { closed: true, unsentAnnotations };
    },
  };

  /** Both sides of one path for the current diff, read the way the diff was made. */
  const readDiffFileContents = async (
    filePath: string,
    oldPath: string | undefined,
    requestedBase: string | undefined,
  ): Promise<{ oldContent: string | null; newContent: string | null } | { error: string }> => {
    if (isBinaryPatchFile(currentPatch, filePath)) {
      return { oldContent: null, newContent: null };
    }

    if (workspace) {
      try {
        return await workspace.getFileContents(filePath, oldPath);
      } catch (error) {
        return { error: error instanceof Error ? error.message : "No file access available" };
      }
    }

    // Full-stack PR mode expands files from local git: the patch is not the platform's layer diff.
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
      if (!baseRef) return { oldContent: null, newContent: null };
      return getVcsFileContentsForDiff(
        "merge-base",
        baseRef,
        filePath,
        oldPath,
        fileContentCwd,
      );
    }

    if (hasLocalAccess) {
      const base = resolveReviewBase(requestedBase);
      const defaultCwd = gitContext?.cwd;
      return getVcsFileContentsForDiff(
        currentDiffType as DiffType,
        base,
        filePath,
        oldPath,
        defaultCwd,
      );
    }

    // PR mode: the diff is against the merge-base, not the base tip, so contents must come from merge-base/head SHAs to match for hunk expansion.
    if (isPRMode && prMetadata) {
      const oldSha = prMetadata.mergeBaseSha ?? prMetadata.baseSha;
      const [oldContent, newContent] = await Promise.all([
        fetchPRFileContent(prRef!, oldSha, oldPath || filePath),
        fetchPRFileContent(prRef!, prMetadata.headSha, filePath),
      ]);
      return { oldContent, newContent };
    }

    return { error: "No file access available" };
  };

  // Where the current mode reads one side of a repository path as bytes, in the same priority order as /api/file-content.
  const readReviewSide = async (
    side: DiffSide,
    filePath: string,
    oldPath: string | undefined,
    maxBytes: number,
    signal?: AbortSignal,
    requestedBase?: string,
  ): Promise<FileBytesRead> => {
    if (workspace) return workspace.getFileBytes(filePath, oldPath, side, maxBytes);
    const prCwd = resolvePRLocalCwd();
    if (isPRMode && currentPRDiffScope === "full-stack" && prCwd && prMetadata?.defaultBranch) {
      const baseRef = await resolvePRFullStackBaseRef(gitRuntime, prMetadata.defaultBranch, prCwd);
      if (!baseRef) return { kind: "missing" };
      return getFileBytesForDiff(gitRuntime, "merge-base", baseRef, filePath, oldPath, side, maxBytes, prCwd);
    }
    if (hasLocalAccess) {
      return getVcsFileBytesForDiff(
        currentDiffType as DiffType,
        requestedBase !== undefined ? resolveReviewBase(requestedBase) : currentBase,
        filePath,
        oldPath,
        side,
        maxBytes,
        gitContext?.cwd,
      );
    }
    if (isPRMode && prMetadata && prRef) {
      const ref = prRef;
      return readPRImageSide({
        gitRuntime,
        poolCwd: prCwd,
        oldSha: prMetadata.mergeBaseSha ?? prMetadata.baseSha,
        headSha: prMetadata.headSha,
        side,
        filePath,
        oldPath,
        maxBytes,
        fetchBytes: (sha, path, max) => fetchPRFileBytes(ref, sha, path, max),
        signal,
      });
    }
    return { kind: "unavailable" };
  };

  let packageRepoRoot: { cwd: string | undefined; root: Promise<string | null> } | null = null;
  const packageChanges = createPackageChangesService({
    snapshotId: () => currentSnapshotId(),
    diffFiles: () => parseDiffToFiles(currentPatch),
    readSide: async (side, path, oldPath, base) => {
      try { validateFilePath(path); if (oldPath) validateFilePath(oldPath); } catch { return { kind: "unreadable", reason: "invalid path" }; }
      const read = await readReviewSide(side, path, oldPath, MAX_PACKAGE_FILE_BYTES, undefined, base);
      if (read.kind === "ok") return { kind: "ok", text: new TextDecoder().decode(read.bytes) };
      if (read.kind === "missing") return { kind: "missing" };
      if (read.kind === "too-large") return { kind: "unreadable", reason: "too large" };
      // No byte reader for this mode: the text reader's null cannot tell absent from unreadable, so it counts as unreadable.
      const text = await readDiffFileContents(path, oldPath, base);
      const value = "error" in text ? null : side === "old" ? text.oldContent : text.newContent;
      return value == null ? { kind: "unreadable", reason: "could not be read" } : { kind: "ok", text: value };
    },
    settings: () => {
      if (workspace) {
        const session = workspace;
        return {
          kind: "local",
          dirOf: async (path) => {
            const target = resolveWorkspaceFilePath(session.repos, path);
            return target ? dirname(join(target.repo.cwd, target.repoRelativePath)) : null;
          },
        };
      }
      if (isPRMode) {
        if (!prMetadata || !prRef) return { kind: "none" };
        const ref = prRef;
        return prSettingsSource({
          git: gitRuntime,
          checkout: resolvePRLocalCwd(),
          headSha: prMetadata.headSha,
          fetchBytes: (sha, path, max) => fetchPRFileBytes(ref, sha, path, max),
        });
      }
      if (!hasLocalAccess || isStaticPatchMode) return { kind: "none" };
      return {
        kind: "local",
        dirOf: async (path) => {
          // Patch paths are relative to the repository top level of the directory the diff ran in (a worktree mode runs elsewhere).
          const cwd = resolveVcsCwd(currentDiffType as DiffType, gitContext?.cwd) ?? gitContext?.cwd;
          if (!packageRepoRoot || packageRepoRoot.cwd !== cwd) {
            const known = cwd === gitContext?.cwd ? gitContext?.root : undefined;
            packageRepoRoot = {
              cwd,
              root: known
                ? Promise.resolve(known)
                : gitRuntime.runGit(["rev-parse", "--show-toplevel"], { cwd })
                  .then((r) => (r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : null))
                  .catch(() => null),
            };
          }
          const root = await packageRepoRoot.root;
          return root ? dirname(join(root, path)) : null;
        },
      };
    },
    homeDir: () => {
      try { return homedir(); } catch { return null; }
    },
    // A PR review reads from its checkout: wait for it, and use the platform API only when no checkout can exist, or for now after a timeout (not kept).
    prepare: async () => {
      if (!isPRMode || !prMetadata) return { final: true };
      const meta = prMetadata;
      let checkout = resolvePRLocalCwd(meta);
      let final = true;
      if (!checkout && options.worktreePool) {
        const waited = await waitAtMost(ensurePRLocalCwd(meta), PACKAGE_CHECKOUT_WAIT_MS);
        if (waited.timedOut) final = false;
        else checkout = waited.value;
      }
      if (checkout) return { final };
      return { final, remote: { key: `${meta.mergeBaseSha ?? meta.baseSha}:${meta.headSha}`, budget: REMOTE_PACKAGE_READS } };
    },
    lookupEnabled: () => resolvePackageLookup(loadConfig()),
    env: process.env,
  });

  const requestHostGuard = createRequestHostGuard();
  const server = await startBunServerOnAvailablePort((port) =>
    Bun.serve(withPlannotatorServerHeader({
        hostname: getServerHostname(),
        port,
        // Bun's default 10s idleTimeout kills requests that legitimately park: PR endpoints await the checkout warmup (minutes) and AI SSE streams stall between bytes.
        idleTimeout: 0,

        async fetch(req, server) {
          const hostRefusal = requestHostGuard.check(req);
          if (hostRefusal) return hostRefusal;
          const originRefusal = refuseCrossOriginWrite(req);
          if (originRefusal) return originRefusal;

          const url = new URL(req.url);

          const hostControlResponse = handleHostControl(req, url, {
            token: hostControlToken,
            getServerPort: () => boundPort,
            control: hostControl,
            ...(options.tailnetPublished === true ? { fromThisMachine: (r: Request) => sessionTailnetAudience(r) === "local" } : {}),
          });
          if (hostControlResponse) return hostControlResponse;

          if (url.pathname.match(/^\/api\/tour\/[^/]+$/) && req.method === "GET") {
            const jobId = url.pathname.slice("/api/tour/".length);
            const result = tour.getTour(jobId);
            if (!result) return Response.json({ error: "Tour not found" }, { status: 404 });
            return Response.json(result);
          }

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

          if (url.pathname.match(/^\/api\/guide\/[^/]+$/) && req.method === "GET") {
            const jobId = decodeURIComponent(url.pathname.slice("/api/guide/".length));
            if (jobId.startsWith(SAVED_GUIDE_ID_PREFIX)) {
              const saved = await guideStore.getSavedGuideData(jobId.slice(SAVED_GUIDE_ID_PREFIX.length));
              if (!saved) return Response.json({ error: "Guide not found" }, { status: 404 });
              return Response.json(saved);
            }
            const result = guide.getGuide(jobId);
            if (!result) return Response.json({ error: "Guide not found" }, { status: 404 });
            return Response.json({ ...result, ...(guideStore.isJobSaved(jobId) ? { saved: true } : {}) });
          }

          const reviewedMatch = url.pathname.match(/^\/api\/guide\/([^/]+)\/reviewed$/);
          if (reviewedMatch && req.method === "PUT") {
            const jobId = decodeURIComponent(reviewedMatch[1]);
            try {
              const body = await req.json() as { reviewed: boolean[] };
              if (Array.isArray(body.reviewed)) {
                if (jobId.startsWith(SAVED_GUIDE_ID_PREFIX)) {
                  const ok = await guideStore.updateSavedReviewed(jobId.slice(SAVED_GUIDE_ID_PREFIX.length), body.reviewed);
                  if (!ok) return Response.json({ error: "Guide not found" }, { status: 404 });
                } else {
                  guide.saveReviewed(jobId, body.reviewed);
                  await guideStore.writeThroughReviewed(jobId, body.reviewed);
                }
              }
              return Response.json({ ok: true });
            } catch {
              return Response.json({ error: "Invalid JSON" }, { status: 400 });
            }
          }

          // No size gate: the exported file is as big as the diff, and that is the user's call.
          const guideExportMatch = url.pathname.match(/^\/api\/guide\/([^/]+)\/(export|export-info)$/);
          if (guideExportMatch && req.method === "GET") {
            const jobId = decodeURIComponent(guideExportMatch[1]);
            const snapshot = await resolveGuideSnapshotForExport(jobId);
            if (!snapshot) {
              return Response.json({ error: "This guide cannot be exported: its diff was not retained." }, { status: 404 });
            }
            const viewer = resolveGuideViewerAssets(GUIDE_VIEWER_MANIFEST, { baseUrl: process.env.PLANNOTATOR_GUIDE_VIEWER_URL });
            const html = createGuideHtml(snapshot, { viewer });
            const filename = guideExportFilename(snapshot.guide.title);
            if (guideExportMatch[2] === "export-info") {
              return Response.json({
                bytes: new TextEncoder().encode(html).byteLength,
                filename,
                languages: detectGuideLanguages(snapshot.review.rawPatch),
              });
            }
            return new Response(html, {
              status: 200,
              headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Content-Disposition": `attachment; filename="${filename}"`,
                "Cache-Control": "no-store",
              },
            });
          }

          // The mutating verbs carry the cross-origin guard: an upload publishes the diff off-machine.
          const guideShareMatch = url.pathname.match(/^\/api\/guide\/([^/]+)\/(share|share-info)$/);
          if (guideShareMatch && guideShareMatch[2] === "share-info" && req.method === "GET") {
            const jobId = decodeURIComponent(guideShareMatch[1]);
            const config = loadConfig();
            const existing = (await guideStore.locateEnvelope(jobId))?.envelope.share;
            return Response.json({
              enabled: resolveSharingEnabled(config),
              serviceUrl: resolveGuideShareUrl(config),
              ...(existing ? { existing: { url: existing.url, createdAt: existing.createdAt } } : {}),
            });
          }
          if (guideShareMatch && guideShareMatch[2] === "share" && (req.method === "POST" || req.method === "DELETE")) {
            if (!callFlowInstallOriginAllowed(req.headers.get("origin"), url.host, req.headers.get("sec-fetch-site"))) {
              return Response.json({ error: "Cross-origin share requests are not allowed" }, { status: 403 });
            }
            const jobId = decodeURIComponent(guideShareMatch[1]);
            const config = loadConfig();
            const serviceUrl = resolveGuideShareUrl(config);
            if (req.method === "POST") {
              if (!resolveSharingEnabled(config)) return Response.json({ error: "sharing disabled" }, { status: 403 });
              let body: { public?: unknown; ttlSeconds?: unknown };
              try {
                const raw = await req.text();
                const parsed: unknown = raw.trim() === "" ? {} : JSON.parse(raw);
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
                body = parsed as { public?: unknown; ttlSeconds?: unknown };
              } catch {
                return Response.json({ error: "Invalid JSON" }, { status: 400 });
              }
              if (body.public !== undefined && typeof body.public !== "boolean") return Response.json({ error: "public must be a boolean" }, { status: 400 });
              if (body.ttlSeconds !== undefined && (typeof body.ttlSeconds !== "number" || !Number.isSafeInteger(body.ttlSeconds) || body.ttlSeconds <= 0)) {
                return Response.json({ error: "ttlSeconds must be a positive integer" }, { status: 400 });
              }
              // One link per guide: the envelope is the only place the delete token lives, so a second upload would orphan the first.
              const located = await guideStore.locateEnvelope(jobId);
              const existing = located?.envelope.share;
              if (existing) {
                return Response.json({ error: "This guide already has a share link. Remove it before creating another.", url: existing.url }, { status: 409 });
              }
              const snapshot = await resolveGuideSnapshotForExport(jobId);
              if (!snapshot) {
                return Response.json({ error: "This guide cannot be shared: its diff was not retained." }, { status: 404 });
              }
              try {
                const shared = await shareGuide(snapshot, {
                  serviceUrl,
                  mode: body.public === true ? "plain" : "encrypted",
                  ...(body.ttlSeconds !== undefined ? { ttlSeconds: body.ttlSeconds } : {}),
                  viewer: GUIDE_VIEWER_MANIFEST,
                });
                // `recorded` tells the client whether this Plannotator can remove the link later; without an envelope only the one-time token can.
                const recorded = located
                  ? updateGuideShare(located.repoKey, located.id, {
                      id: shared.id,
                      url: shared.url,
                      createdAt: new Date().toISOString(),
                      deleteToken: shared.deleteToken,
                      serviceUrl,
                    })
                  : false;
                return Response.json({ ...shared, recorded });
              } catch (e) {
                if (e instanceof GuideShareError) return Response.json({ error: e.message }, { status: 502 });
                throw e;
              }
            }
            // DELETE uses the host recorded on the link: the configured share URL may have changed, and a 404 from the wrong host would forget a live link.
            const located = await guideStore.locateEnvelope(jobId);
            const record = located?.envelope.share;
            if (!located || !record) return Response.json({ error: "No share link for this guide" }, { status: 404 });
            try {
              await unshareGuide(record.id, record.deleteToken, { serviceUrl: record.serviceUrl });
            } catch (e) {
              // Already gone on the host: the link is dead either way, so forget it here too.
              if (!(e instanceof GuideShareError && e.status === 404)) {
                if (e instanceof GuideShareError) return Response.json({ error: e.message }, { status: 502 });
                throw e;
              }
            }
            updateGuideShare(located.repoKey, located.id, null);
            return new Response(null, { status: 204 });
          }

          if (url.pathname === "/api/guides" && req.method === "GET") {
            return Response.json(await guideStore.listSaved());
          }

          // Its share link goes with it, best effort: the envelope is the only copy of the delete token.
          const savedGuideDeleteMatch = url.pathname.match(/^\/api\/guides\/([^/]+)$/);
          if (savedGuideDeleteMatch && req.method === "DELETE") {
            const savedId = decodeURIComponent(savedGuideDeleteMatch[1]);
            await unshareBeforeDelete((await guideStore.locateEnvelope(`${SAVED_GUIDE_ID_PREFIX}${savedId}`))?.envelope.share);
            const ok = await guideStore.deleteSaved(savedId);
            if (!ok) return Response.json({ error: "Guide not found" }, { status: 404 });
            return Response.json({ ok: true });
          }

          const guideOutputMatch = url.pathname.match(/^\/api\/guide\/([^/]+)\/output$/);
          if (guideOutputMatch && req.method === "GET") {
            const jobId = guideOutputMatch[1];
            const payload = guide.getFailedPayload(jobId);
            if (payload === null) return Response.json({ error: "No captured output" }, { status: 404 });
            return Response.json({ payload });
          }

          const guideSubmitMatch = url.pathname.match(/^\/api\/guide\/([^/]+)\/submit$/);
          if (guideSubmitMatch && req.method === "POST") {
            const jobId = guideSubmitMatch[1];
            const existingJob = agentJobs.getJob(jobId);
            if (!existingJob) return Response.json({ error: "Job not found" }, { status: 404 });
            if (existingJob.status !== "failed" && existingJob.status !== "killed") {
              return Response.json({ error: "This job already has a guide" }, { status: 409 });
            }
            try {
              const body = await req.json() as { payload?: string };
              const payload = typeof body.payload === "string" ? body.payload : "";
              const changedFiles = listPatchFiles(currentPatch).map((f) => f.path);
              const result = guide.submitManualOutput(jobId, payload, changedFiles);
              if ("error" in result) return Response.json({ error: result.error }, { status: 400 });
              const { sections, files } = result;
              agentJobs.completeJobExternally(jobId, {
                correctness: "Guide Generated",
                explanation: `${sections} section${sections !== 1 ? "s" : ""}, ${files} file${files !== 1 ? "s" : ""} placed (manually repaired)`,
                confidence: 1,
              });
              const repaired = guide.getGuide(jobId);
              if (repaired) await guideStore.saveForJob(guideSaveJob(existingJob), repaired, existingJob.guideContext, guide.getLaunchReview(jobId) ?? undefined);
              return Response.json({ ok: true, sections, files });
            } catch {
              return Response.json({ error: "Invalid JSON" }, { status: 400 });
            }
          }

          if (url.pathname === "/api/diff" && req.method === "GET") {
            maybeRefreshRemoteBaseInfo();
            // Snapshot the served state before the sidecar await: the startup base upgrade can land mid-await and pair a rebuilt patch with sections from the old base. snapshotId travels with its patch so the client's next probe raises the Refresh banner.
            const servedPatch = currentPatch;
            const servedBase = currentBase;
            const servedGitRef = currentGitRef;
            const servedError = currentError;
            const servedDiffType = currentDiffType;
            const servedHideWhitespace = currentHideWhitespace;
            const servedPRDiffScope = currentPRDiffScope;
            const servedSnapshotId = currentSnapshotId();
            const servedGitContext = clientGitContext;
            const servedDraftTarget = localDraftTarget;
            const sections = await buildSectionsSidecar(servedBase, servedDiffType as string);
            const commitInfo = await buildCommitInfoSidecar(servedDiffType as string);
            const generatedFiles = await buildGeneratedFilesSidecar(servedPatch, servedDiffType as string);
            return Response.json({
              rawPatch: servedPatch,
              aiReviewContext: buildCurrentAiReviewContext(servedPatch, servedBase, servedDiffType as DiffType),
              aiEnabled,
              gitRef: servedGitRef,
              snapshotId: servedSnapshotId,
              localDraftTarget: servedDraftTarget,
              origin,
              mode: isWorkspaceMode ? "workspace" : undefined,
              diffType: hasLocalAccess || isWorkspaceMode || isStaticPatchMode ? servedDiffType : undefined,
              // Echo the active base so a refresh rehydrates the picker to what the server uses.
              base: hasLocalAccess ? servedBase : undefined,
              hideWhitespace: servedHideWhitespace,
              ...(workspace && { diffOptions: workspace.diffOptions }),
              gitContext: hasLocalAccess ? servedGitContext : undefined,
              sharingEnabled,
              approvalNotesSupported,

              serverSession,
              imagePreviewSupported,
              markdownPreviewSupported,
              repoFilesSupported,
              diagramEngine: await diagramEngineAssets.advert(),
              ...sourceKindAdvert,
              // The pin matters only at mount, so it rides /api/diff alone.
              ...(options.openStatePinned && { openStatePinned: true }),
              ...(options.title && { title: options.title }),
              shareBaseUrl,
              repoInfo,
              isWSL: wslFlag,
              markdownExtensions: getExtraMarkdownExtensions(),
              // PR mode advertises the ready PR checkout (null while warming), not the launch repo, so Open-in gates correctly from the first load.
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
                prDiffScope: servedPRDiffScope,
                prDiffScopeOptions,
              }),
              ...(isPRMode && layerPatchIncomplete && { prPatchIncomplete: true, prPatchUpgradeAvailable: layerUpgradeAvailable }),
              ...(isPRMode && initialViewedFiles.length > 0 && { viewedFiles: initialViewedFiles }),
              ...(sections && { sections }),
              ...(commitInfo && { commitInfo }),
              ...(generatedFiles && { generatedFiles }),
              ...(baseBehindRemote && { baseBehindRemote: true }),
              ...(servedError && { error: servedError }),
              semanticDiff: await getSemanticDiffAdvert(servedDiffType as DiffType),
              callFlow: await getCallFlowAdvert(servedDiffType as DiffType),
              serverConfig: getServerConfig(gitUser, agentToolHostForServer(options.sessionBridge), { cookieHost: !isRemote && options.tailnetPublished !== true }),
              ...getAutoUpdateAdvert(),
              ...getUpdateAdvert(origin, { exposed: isRemote || options.tailnetPublished === true }),
            });
          }

          if (url.pathname === "/api/open-in/apps" && req.method === "GET") {
            // Static patch: no tree the patch's paths belong to, so advertise no apps rather than open a same-named file from an unrelated checkout.
            if (isStaticPatchMode) return Response.json({ available: false, apps: [] });
            return handleOpenInApps({ exposed: options.tailnetPublished === true });
          }

          // Resolve the repo-relative path against the VCS root server-side, not the client `base` (wrong when review runs from a subdirectory), then containment-check it.
          if (url.pathname === "/api/open-in" && req.method === "POST") {
            if (isGitButlerCommittedView()) {
              return Response.json(
                { error: "Open in app is unavailable for committed GitButler views" },
                { status: 400 },
              );
            }
            // A static patch's paths are relative to a tree this process cannot know; resolving against process.cwd() would open an unrelated file. Refuse.
            if (isStaticPatchMode) {
              return Response.json(
                { error: "Open in app is unavailable for a static patch review" },
                { status: 400 },
              );
            }
            return handleOpenIn(req, { resolveRoot: resolveOpenInRoot, serverSession, exposed: options.tailnetPublished === true });
          }

          // Cheap staleness probe; anything that cannot be fingerprinted reports fresh.
          if (url.pathname === "/api/diff/fresh" && req.method === "GET") {
            // In PR review the checkout can appear or change after the initial /api/diff, so re-advertise it on every probe. Non-PR sessions never carry this field.
            const prCwdAdvert = isPRMode ? { agentCwd: resolvePRLocalCwd() ?? null } : {};
            const baseline = currentFingerprint;
            // Carry baseBehindRemote on every response: the client sets the flag on each probe, so omitting it would flicker the banner away.
            const behind = baseBehindRemote ? { baseBehindRemote: true } : {};
            // Per-client staleness: a snapshotId mismatch means the server's snapshot moved under that tab, whatever the VCS fingerprint says. The "snapshot:" fingerprint keys the client's dismissal to the snapshot that made it stale.
            const clientSnapshot = url.searchParams.get("snapshot");
            const serverSnapshot = currentSnapshotId();
            if (clientSnapshot && clientSnapshot !== serverSnapshot) {
              return Response.json({
                fresh: false,
                fingerprint: `snapshot:${serverSnapshot}`,
                ...behind,
                ...prCwdAdvert,
              });
            }
            if (baseline == null) return Response.json({ fresh: true, ...behind, ...prCwdAdvert });
            const probe = await computeDiffFingerprint();
            // A diff switch landing mid-probe replaces the snapshot; report fresh and compare against the new baseline next poll.
            if (currentFingerprint !== baseline) return Response.json({ fresh: true, ...behind, ...prCwdAdvert });
            const fresh = probe == null || probe === baseline;
            // Deliberately no maybeRefreshRemoteBaseInfo() here: this endpoint is polled every 5s, so it would contact the remote every minute forever (a hardware-key touch prompt per minute on smartcard-backed SSH). The remote is queried on startup, /api/diff, /api/diff/switch and the explicit Fetch; baseBehindRemote rides every response from the cache.
            return Response.json({
              fresh,
              ...(fresh ? {} : { fingerprint: probe }),
              ...(baseBehindRemote && { baseBehindRemote: true }),
              ...prCwdAdvert,
            });
          }

          if (url.pathname === "/api/fetch-base" && req.method === "POST") {
            if (!gitRemoteSessionApplies()) {
              return Response.json({ error: "Not available in this mode" }, { status: 400 });
            }
            const branchRef =
              remoteDefaultInfo?.branch ??
              (currentBase.startsWith("origin/") ? currentBase : null);
            if (!branchRef) {
              return Response.json({ error: "No remote-tracking base to fetch" }, { status: 400 });
            }
            const branchName = branchRef.replace(/^origin\//, "");
            const result = await gitRuntime.runGit(
              ["fetch", "--end-of-options", "origin", branchName],
              { cwd: gitContext?.cwd, timeoutMs: 30_000 },
            );
            if (result.exitCode !== 0) {
              return Response.json(
                { error: result.stderr.trim() || "git fetch failed" },
                { status: 500 },
              );
            }
            // Re-query the remote (fresh ls-remote) rather than trust a cached tip: a narrow fetch refspec can exit 0 without advancing origin/<branch>, and the banner must honestly stay if the ref did not move.
            await refreshRemoteBaseInfo();
            return Response.json({ ok: true, baseBehindRemote });
          }

          if (url.pathname === "/api/semantic-diff" && req.method === "GET") {
            return Response.json(await getSemanticDiff(url));
          }

          if (url.pathname === "/api/call-flow" && req.method === "GET") {
            // A hard VCS failure before analyze() must still produce the JSON error envelope the client parses, never a bare 500.
            let result: CallFlowResponse;
            try {
              result = await getCallFlow(url);
            } catch (error) {
              result = {
                status: "error",
                reason: "analysis-failed",
                message: error instanceof Error ? error.message : String(error),
              };
            }
            return Response.json(result, {
              status: result.status === "stale" ? 409 : 200,
              headers: { "Cache-Control": "no-store" },
            });
          }

          // Single-flighted: concurrent POSTs join the in-flight install. Node preflight runs before any download; cross-origin POSTs are rejected because this starts a native runtime download and build.
          if (url.pathname === "/api/call-flow/install" && req.method === "POST") {
            if (!callFlowInstallOriginAllowed(req.headers.get("origin"), url.host, req.headers.get("sec-fetch-site"))) {
              return Response.json({ error: "Cross-origin install requests are not allowed" }, { status: 403 });
            }
            let request: ReturnType<typeof parseCallFlowInstallRequest>;
            try {
              request = parseCallFlowInstallRequest(await req.json());
            } catch {
              request = null;
            }
            if (!request) return Response.json({ error: "Invalid call-flow install request" }, { status: 400 });
            const advert = await getCallFlowAdvert(currentDiffType as DiffType, true);
            const languageIds = resolveCallFlowInstallTargets(
              request.languageIds,
              advert.installPlan?.languageIds,
              advert.available,
            );
            if (!advert.installable || languageIds.length === 0) {
              return Response.json({ error: advert.message ?? "No call-flow language support needs installation." }, { status: 409 });
            }
            const status = await callFlowInstall.start(languageIds);
            return Response.json(status, { headers: { "Cache-Control": "no-store" } });
          }

          if (url.pathname === "/api/call-flow/install-status" && req.method === "GET") {
            return Response.json(callFlowInstall.getStatus(), { headers: { "Cache-Control": "no-store" } });
          }

          // Deliberately not sharing the settings mutation epoch: install completion must not supersede a concurrent toggle write.
          if (url.pathname === "/api/review-analysis" && req.method === "GET") {
            if (reviewAnalysisMutationEpoch !== null) {
              return Response.json({ superseded: true }, { headers: { "Cache-Control": "no-store" } });
            }
            const analysisEpoch = reviewAnalysisEpoch;
            const viewEpoch = diffSwitchEpoch;
            const scopeEpoch = prScopeEpoch;
            const [semanticDiff, callFlow] = await Promise.all([
              getSemanticDiffAdvert(),
              getCallFlowAdvert(),
            ]);
            if (
              analysisEpoch !== reviewAnalysisEpoch
              || reviewAnalysisMutationEpoch !== null
              || viewEpoch !== diffSwitchEpoch
              || scopeEpoch !== prScopeEpoch
            ) {
              return Response.json({ superseded: true });
            }
            return Response.json({ semanticDiff, callFlow }, { headers: { "Cache-Control": "no-store" } });
          }

          if (url.pathname === "/api/review-analysis" && req.method === "POST") {
            const analysisEpoch = ++reviewAnalysisEpoch;
            reviewAnalysisMutationEpoch = analysisEpoch;
            const viewEpoch = diffSwitchEpoch;
            const scopeEpoch = prScopeEpoch;
            try {
              const reviewAnalysis = parseReviewAnalysisConfig(await req.json());
              if (!reviewAnalysis) {
                return Response.json({ error: "Invalid analysis settings" }, { status: 400 });
              }
              if (analysisEpoch !== reviewAnalysisEpoch) {
                return Response.json({ superseded: true });
              }
              const nextSemanticDiffEnabled = reviewAnalysis.semanticDiff ?? semanticDiffEnabled();
              const nextCallFlowEnabled = reviewAnalysis.callFlow ?? callFlowEnabled();
              const [semanticDiff, callFlow] = await Promise.all([
                getSemanticDiffAdvert(currentDiffType as DiffType, nextSemanticDiffEnabled),
                getCallFlowAdvert(currentDiffType as DiffType, nextCallFlowEnabled),
              ]);
              if (
                analysisEpoch !== reviewAnalysisEpoch
                || viewEpoch !== diffSwitchEpoch
                || scopeEpoch !== prScopeEpoch
              ) {
                return Response.json({ superseded: true });
              }
              if (!saveConfig({ reviewAnalysis })) return Response.json({ error: "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it." }, { status: 500 });
              if (!nextCallFlowEnabled) callFlowService.cancelAll();
              return Response.json({ semanticDiff, callFlow });
            } catch {
              return Response.json({ error: "Invalid request" }, { status: 400 });
            } finally {
              // A read-only advert refresh that began during this mutation must not publish capabilities computed from the old config after the mutation response.
              if (reviewAnalysisEpoch === analysisEpoch) reviewAnalysisEpoch++;
              if (reviewAnalysisMutationEpoch === analysisEpoch) reviewAnalysisMutationEpoch = null;
            }
          }

          // Local git and jj sessions only. Computed against the active diff's cwd and base so the divider matches the review baseline.
          if (url.pathname === "/api/commits" && req.method === "GET") {
            const commitsVcs = sessionVcsType ?? "git";
            if (!gitContext || isPRMode || workspace || (commitsVcs !== "git" && commitsVcs !== "jj")) {
              return Response.json(
                { error: "Commit history is only available for local git and jj reviews" },
                { status: 400 },
              );
            }
            const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
            const before = url.searchParams.get("before") ?? undefined;
            const commitsCwd = resolveVcsCwd(currentDiffType as DiffType, gitContext.cwd);
            const pageOptions = {
              ...(Number.isFinite(limitParam) && { limit: limitParam }),
              ...(before !== undefined && { before }),
            };
            let page;
            try {
              if (commitsVcs === "jj") {
                const railBase = resolveJjCommitRailBase(currentBase, clientGitContext ?? gitContext);
                page = await listJjCommitHistory(jjRuntime, railBase.target, commitsCwd, {
                  ...pageOptions,
                  baseLabel: railBase.label,
                });
              } else {
                page = await listCommitHistory(gitRuntime, currentBase, commitsCwd, pageOptions);
              }
            } catch (err) {
              return Response.json(
                { error: err instanceof Error ? err.message : "Could not read commit history" },
                { status: 500 },
              );
            }
            if (!page) {
              return Response.json({ error: "Could not read commit history" }, { status: 500 });
            }
            const avatars = await commitAvatars.resolve(
              commitsCwd,
              page.commits.map((c) => c.authorEmail),
            );
            for (const c of page.commits) {
              const avatarUrl = avatars.get(c.authorEmail);
              if (avatarUrl) c.avatarUrl = avatarUrl;
            }
            return Response.json(page);
          }

          if (url.pathname === "/api/diff/switch" && req.method === "POST") {
            // Capture the ordering token before any await: request bodies can finish out of arrival order, and capturing after `await req.json()` let an older request overwrite a newer confirmed switch.
            const switchEpoch = ++diffSwitchEpoch;
            // Remote probe lives here, not on the 5s poll: it fires when the reviewer asks for a fresh answer. Fire-and-forget so a hanging remote never delays the switch; this response reports the cached staleness.
            maybeRefreshRemoteBaseInfo();
            if (!hasLocalAccess && !workspace) {
              return Response.json(
                { error: "Not available without local file access" },
                { status: 400 },
              );
            }
            try {
              const body = (await req.json()) as { diffType: DiffType | WorkspaceDiffType; base?: string; hideWhitespace?: boolean; explicitBase?: boolean };
              let newDiffType = body.diffType;

              if (typeof newDiffType !== "string" || !newDiffType) {
                return Response.json(
                  { error: "Missing diffType" },
                  { status: 400 }
                );
              }

              // Do not commit hideWhitespace to shared state until we win the epoch check: a superseded request must leave nothing behind.
              const effectiveHideWhitespace = typeof body.hideWhitespace === "boolean"
                ? body.hideWhitespace
                : currentHideWhitespace;

              if (workspace) {
                const snapshot = await workspace.rebuild({
                  diffType: newDiffType,
                  hideWhitespace: effectiveHideWhitespace,
                });
                if (switchEpoch !== diffSwitchEpoch) {
                  return Response.json({ superseded: true });
                }
                currentHideWhitespace = effectiveHideWhitespace;
                currentPatch = snapshot.rawPatch;
                currentFileIdentities = undefined;
                currentGitRef = snapshot.gitRef;
                currentDiffType = workspace.diffType;
                currentError = snapshot.error;
                draftKey = contentHash(currentPatch);
                captureDiffFingerprint();

                return Response.json({
                  rawPatch: currentPatch,
                  aiReviewContext: buildCurrentAiReviewContext(snapshot.rawPatch),
                  gitRef: currentGitRef,
                  snapshotId: currentSnapshotId(),
                  approvalNotesSupported,

                  serverSession,
                  imagePreviewSupported,
                  markdownPreviewSupported,
                  repoFilesSupported,
                  ...sourceKindAdvert,
                  diffType: currentDiffType,
                  diffOptions: workspace.diffOptions,
                  hideWhitespace: currentHideWhitespace,
                  ...(currentError && { error: currentError }),
                  semanticDiff: await getSemanticDiffAdvert(),
                  callFlow: await getCallFlowAdvert(),
                });
              }

              if (sessionVcsType && !vcsOwnsDiffType(sessionVcsType, newDiffType as string)) {
                return Response.json(
                  { error: `Diff type is not available in this ${sessionVcsType} session` },
                  { status: 400 },
                );
              }

              // Guard against non-string payloads: resolveBaseBranch calls string methods. Mirrors Pi's guard.
              const requestedBase = typeof body.base === "string" ? body.base : undefined;
              // An explicit base pick is honored verbatim and stays sticky: local and remote refs are distinct choices, so "main" must not become "origin/main".
              const nextBaseExplicitlyChosen = baseExplicitlyChosen ||
                (body.explicitBase === true && !!requestedBase);
              const requestedDiffType = newDiffType as DiffType;
              const availability = clientGitContext
                ? resolveAvailableDiffType(clientGitContext, requestedDiffType, nextBaseExplicitlyChosen)
                : { diffType: requestedDiffType };
              newDiffType = availability.diffType;
              // A jj revision rewritten since it was opened resolves to its change's current version, so Refresh never serves a frozen snapshot.
              if (sessionVcsType === "jj") {
                newDiffType = await canonicalizeJjCommitDiffType(jjRuntime, newDiffType as string, gitContext?.cwd) as DiffType;
              }
              const base = resolveReviewBase(
                requestedBase,
                nextBaseExplicitlyChosen,
                currentBase,
              );
              const defaultCwd = gitContext?.cwd;

              const result = await runVcsDiff(newDiffType as DiffType, base, defaultCwd, {
                hideWhitespace: effectiveHideWhitespace,
                captureFileIdentities: sessionVcsType === "git",
              });
              const resultContext = sessionVcsType === "gitbutler" && result.gitContext?.vcsType === "gitbutler"
                ? result.gitContext
                : undefined;
              const resultBase = resultContext?.defaultBranch ?? base;

              // A newer switch started while we computed: abandon before touching shared state.
              if (switchEpoch !== diffSwitchEpoch) {
                return Response.json({ superseded: true });
              }

              // Stage every field locally and write shared state only after the final epoch guard, so a newer invalid request cannot strand a patch/fingerprint beside the prior GitButler context revision.
              const previousDiffType = currentDiffType;

              // Recompute gitContext for the effective cwd so the sidebar reflects the worktree under review. Skipped for same-cwd commit:<sha> switches (the commit-rail hot path: three git enumerations dominated click latency).
              let updatedContext = resultContext;
              let updatedContextRevision = resultContext
                ? getGitButlerContextRevision(resultContext) ?? ""
                : undefined;
              if (!updatedContext && gitContext && !isSameCwdCommitSwitch(previousDiffType as string, newDiffType as string)) {
                try {
                  const effectiveCwd = resolveVcsCwd(newDiffType as DiffType, gitContext.cwd);
                  updatedContext = await getVcsContext(effectiveCwd, sessionVcsType);
                  updatedContextRevision = getGitButlerContextRevision(updatedContext) ?? "";
                } catch {
                  /* best-effort */
                }
              }

              // Awaited so the response carries the recomputed baseBehindRemote; otherwise the banner lags or lingers a poll cycle. Local rev-parse only.
              const nextBase = updatedContext && sessionVcsType === "gitbutler"
                ? updatedContext.defaultBranch
                : resultBase;
              const nextBaseBehindRemote = await computeBaseBehindRemote(
                nextBase,
                newDiffType as string,
                nextBaseExplicitlyChosen,
              ).catch(() => false);
              const sections = await buildSectionsSidecar(nextBase, newDiffType as string);
              const commitInfo = await buildCommitInfoSidecar(newDiffType as string);
              const generatedFiles = await buildGeneratedFilesSidecar(result.patch, newDiffType as string);
              const [switchSemanticDiff, switchCallFlow, nextDraftTarget] = await Promise.all([
                getSemanticDiffAdvert(newDiffType as DiffType),
                getCallFlowAdvert(newDiffType as DiffType),
                isPRMode ? null : localGitDraftTargetKey({
                  diffType: newDiffType, base: nextBase, cwd: gitContext?.cwd ?? process.cwd(),
                  defaultBase: remoteCheckEnabled && !nextBaseExplicitlyChosen ? detectedCompareTarget() : undefined,
                  vcsType: sessionVcsType,
                }, gitRuntime.runGit),
              ]);
              // A newer switch took over: do not emit, the client would misapply this stale body over the newer one.
              if (switchEpoch !== diffSwitchEpoch) {
                return Response.json({ superseded: true });
              }
              currentHideWhitespace = effectiveHideWhitespace;
              currentPatch = result.patch;
              currentFileIdentities = result.fileIdentities;
              currentGitRef = result.label;
              currentDiffType = newDiffType;
              currentBase = nextBase;
              baseEverSwitched = true;
              baseExplicitlyChosen = nextBaseExplicitlyChosen;
              baseBehindRemote = nextBaseBehindRemote;
              currentError = result.error;
              draftKey = contentHash(currentPatch);
              // Session-context adoption is provider-scoped: gitbutler (stack topology) and jj (line availability). Plain git keeps the launch-frozen context: adopting a switched worktree's would repoint currentBranch labels on the next reload.
              const adoptContext =
                updatedContext !== undefined &&
                (sessionVcsType === "gitbutler" || sessionVcsType === "jj");
              const nextClientContext = adoptContext
                ? updatedContext
                : clientGitContext;
              if (nextClientContext) {
                clientGitContext = {
                  ...nextClientContext,
                  diffFallback: availability.fallback
                    ? {
                        requestedDiffType,
                        effectiveDiffType: newDiffType,
                        message: availability.fallback.message,
                        candidates: availability.fallback.candidates,
                      }
                    : undefined,
                };
              }
              if (updatedContext && sessionVcsType === "gitbutler") {
                currentContextRevision = updatedContextRevision ?? "";
              }
              captureDiffFingerprint(result.fingerprint, nextDraftTarget);
              return Response.json({
                rawPatch: currentPatch,
                aiReviewContext: buildCurrentAiReviewContext(result.patch, currentBase),
                gitRef: currentGitRef,
                snapshotId: currentSnapshotId(),
                localDraftTarget: nextDraftTarget,
                ...(nextDraftTarget && { draftState: reviewDrafts.state({ ...localReviewDraftKeys(draftKey, nextDraftTarget), legacyPatchKey: undefined }) }),
                approvalNotesSupported,

                serverSession,
                imagePreviewSupported,
                markdownPreviewSupported,
                repoFilesSupported,
                ...sourceKindAdvert,
                diffType: currentDiffType,
                // Echo the base actually used; resolveBaseBranch trusts the caller verbatim.
                base: currentBase,
                hideWhitespace: currentHideWhitespace,
                ...(sections && { sections }),
                ...(commitInfo && { commitInfo }),
                ...(generatedFiles && { generatedFiles }),
                ...(baseBehindRemote && { baseBehindRemote: true }),
                // The response carries a transiently recomputed context even when the session did not adopt it. Omitted when recompute was skipped (same-cwd commit:<sha>): echoing the launch-frozen context would revert the base picker on every Commits-rail click.
                ...(updatedContext
                  ? {
                      gitContext: {
                        ...updatedContext,
                        diffFallback: clientGitContext?.diffFallback,
                      },
                    }
                  : {}),
                ...(currentError && { error: currentError }),
                semanticDiff: switchSemanticDiff,
                callFlow: switchCallFlow,
              });
            } catch (err) {
              const message =
                err instanceof Error ? err.message : "Failed to switch diff";
              return Response.json({ error: message }, { status: 500 });
            }
          }

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
              const supersededResponse = async () => {
                const [semanticDiff, callFlow] = await Promise.all([
                  getSemanticDiffAdvert(),
                  getCallFlowAdvert(),
                ]);
                return Response.json({
                  rawPatch: currentPatch,
                  aiReviewContext: buildCurrentAiReviewContext(),
                  gitRef: currentGitRef,
                  snapshotId: currentSnapshotId(),
                  draftState: reviewDrafts.state(currentDraftKeys()),
                  approvalNotesSupported,

                  serverSession,
                  imagePreviewSupported,
                  markdownPreviewSupported,
                  repoFilesSupported,
                  ...sourceKindAdvert,
                  prDiffScope: currentPRDiffScope,
                  ...(layerPatchIncomplete && { prPatchIncomplete: true, prPatchUpgradeAvailable: layerUpgradeAvailable }),
                  ...(currentError && { error: currentError }),
                  semanticDiff,
                  callFlow,
                });
              };

              if (body.scope === "layer") {
                // Upgrade path: the platform withheld per-file content (too large); once the checkout is ready, recompute the layer diff locally. Snapshot the PR before the await so a mid-recompute pr-switch is not overwritten.
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
                currentFileIdentities = undefined;
                currentGitRef = originalPRGitRef;
                currentError = originalPRError;
                currentPRDiffScope = "layer";
                // Every commit point re-keys: draftKey doubles as the snapshotId clients echo and the draft-storage key, so it must always identify currentPatch.
                draftKey = contentHash(currentPatch);
                captureDiffFingerprint();
                return Response.json({
                  rawPatch: currentPatch,
                  aiReviewContext: buildCurrentAiReviewContext(),
                  gitRef: currentGitRef,
                  snapshotId: currentSnapshotId(),
                  draftState: reviewDrafts.state(currentDraftKeys()),
                  approvalNotesSupported,

                  serverSession,
                  imagePreviewSupported,
                  markdownPreviewSupported,
                  repoFilesSupported,
                  ...sourceKindAdvert,
                  prDiffScope: currentPRDiffScope,
                  ...(layerPatchIncomplete && { prPatchIncomplete: true, prPatchUpgradeAvailable: layerUpgradeAvailable }),
                  ...((currentError ?? upgradeError) && { error: currentError ?? upgradeError }),
                  semanticDiff: await getSemanticDiffAdvert(),
                  callFlow: await getCallFlowAdvert(),
                });
              }

              const fullStackOption = prDiffScopeOptions.find((option) => option.id === "full-stack");
              if (!fullStackOption?.enabled || !(options.worktreePool || options.agentCwd)) {
                return Response.json(
                  { error: "Full stack diff requires a stacked PR and a local checkout" },
                  { status: 400 },
                );
              }

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
              currentFileIdentities = undefined;
              currentGitRef = result.label;
              currentError = undefined;
              currentPRDiffScope = "full-stack";
              // Every commit point re-keys (see the layer branch): skipping it advertised the layer snapshot id for the full-stack patch and made drafts collide.
              draftKey = contentHash(currentPatch);
              captureDiffFingerprint();

              return Response.json({
                rawPatch: currentPatch,
                aiReviewContext: buildCurrentAiReviewContext(),
                gitRef: currentGitRef,
                snapshotId: currentSnapshotId(),
                draftState: reviewDrafts.state(currentDraftKeys()),
                approvalNotesSupported,

                serverSession,
                imagePreviewSupported,
                markdownPreviewSupported,
                repoFilesSupported,
                ...sourceKindAdvert,
                prDiffScope: currentPRDiffScope,
                semanticDiff: await getSemanticDiffAdvert(),
                callFlow: await getCallFlowAdvert(),
              });
            } catch (err) {
              const message =
                err instanceof Error ? err.message : "Failed to switch PR diff scope";
              return Response.json({ error: message }, { status: 500 });
            }
          }

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
              const pr = cached ?? await (options.prFetcher ?? fetchPR)(newRef);
              if (!cached) prSwitchCache.set(body.url, pr);

              // Bump the scope epoch so a scope request parked on a long await cannot overwrite this switch.
              prScopeEpoch++;
              prMetadata = pr.metadata;
              prRef = prRefFromMetadata(pr.metadata);
              warmPRContext(pr.metadata.url, prRef);
              currentPatch = pr.rawPatch;
              currentFileIdentities = undefined;
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

              prStackInfo = getPRStackInfo(pr.metadata);

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
                aiReviewContext: buildCurrentAiReviewContext(),
                gitRef: currentGitRef,
                snapshotId: currentSnapshotId(),
                draftState: reviewDrafts.state(currentDraftKeys()),
                approvalNotesSupported,

                serverSession,
                imagePreviewSupported,
                markdownPreviewSupported,
                repoFilesSupported,
                ...sourceKindAdvert,
                prMetadata: pr.metadata,
                // The new PR's checkout (null while warming) so Open-in re-roots immediately.
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
                callFlow: await getCallFlowAdvert(),
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : "Failed to switch PR";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          if (url.pathname === "/api/pr-context" && req.method === "GET") {
            if (!isPRMode || !prRef || !prMetadata) {
              return Response.json(
                { error: "Not in PR mode" },
                { status: 400 },
              );
            }
            try {
              const context = await prContextLive.getContext(prMetadata.url, prRef);
              return Response.json(context);
            } catch (err) {
              const message =
                err instanceof Error ? err.message : "Failed to fetch PR context";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // The shared helper owns URL and redirect validation so this never becomes an open proxy.
          if (url.pathname === "/api/pr-artifact-document" && req.method === "GET") {
            if (!isPRMode || !prRef || !prMetadata) {
              return Response.json({ error: "Not in PR mode" }, { status: 400 });
            }
            const artifactUrl = url.searchParams.get("url");
            if (!artifactUrl) {
              return Response.json({ error: "Missing artifact URL" }, { status: 400 });
            }
            try {
              const context = await prContextLive.getContext(prMetadata.url, prRef);
              const document = await fetchPRArtifactDocument(
                prCommandRuntime,
                prMetadata,
                context,
                artifactUrl,
              );
              return new Response(document.content, {
                headers: {
                  "Content-Type": "text/plain; charset=utf-8",
                  "Cache-Control": "private, max-age=300",
                  "Content-Security-Policy": "sandbox; default-src 'none'",
                  "X-Content-Type-Options": "nosniff",
                },
              });
            } catch (error) {
              const status = error instanceof PRArtifactDocumentError ? error.status : 500;
              const message = error instanceof Error ? error.message : "Failed to fetch artifact document";
              return Response.json({ error: message }, { status });
            }
          }

          // The helper validates both the source document and target URL before forwarding provider credentials.
          if (url.pathname === "/api/pr-artifact-content" && req.method === "GET") {
            if (!isPRMode || !prRef || !prMetadata) {
              return Response.json({ error: "Not in PR mode" }, { status: 400 });
            }
            const artifactUrl = url.searchParams.get("url");
            if (!artifactUrl) {
              return Response.json({ error: "Missing artifact URL" }, { status: 400 });
            }
            try {
              const context = await prContextLive.getContext(prMetadata.url, prRef);
              const content = await fetchPRArtifactContent(
                prCommandRuntime,
                prMetadata,
                context,
                artifactUrl,
                {
                  sourceUrl: url.searchParams.get("source") ?? undefined,
                  range: req.headers.get("range") ?? undefined,
                },
              );
              return new Response(Uint8Array.from(content.content).buffer, {
                status: content.status,
                headers: {
                  "Content-Type": content.contentType,
                  "Cache-Control": "private, max-age=300",
                  "Content-Security-Policy": "sandbox",
                  "X-Content-Type-Options": "nosniff",
                  "Content-Length": String(content.content.byteLength),
                  ...(content.contentRange ? { "Content-Range": content.contentRange } : {}),
                  ...(content.acceptRanges ? { "Accept-Ranges": content.acceptRanges } : {}),
                },
              });
            } catch (error) {
              const status = error instanceof PRArtifactDocumentError ? error.status : 500;
              const message = error instanceof Error ? error.message : "Failed to fetch artifact content";
              return Response.json({ error: message }, { status });
            }
          }


          if (url.pathname === REVIEW_MARKDOWN_IMAGE_ENDPOINT && req.method === "GET") {
            const result = await handleReviewMarkdownImageRequest({
              params: url.searchParams,
              ifNoneMatch: req.headers.get("if-none-match"),
              available: imagePreviewSupported,
              patch: currentPatch,
              markdownExtensions: getExtraMarkdownExtensions(),
              isCurrentSnapshot: (snapshot) => snapshot === currentSnapshotId(),
              signal: req.signal,
              readSide: (side, filePath, oldPath, maxBytes, signal) =>
                runImageRead(() => readReviewSide(side, filePath, oldPath, maxBytes, signal), signal),
            });
            return new Response(result.body as BodyInit | null, {
              status: result.status,
              headers: result.headers,
            });
          }

          if (url.pathname === REVIEW_IMAGE_ENDPOINT && req.method === "GET") {
            const result = await handleReviewImageRequest({
              params: url.searchParams,
              ifNoneMatch: req.headers.get("if-none-match"),
              available: imagePreviewSupported,
              patch: currentPatch,
              isCurrentSnapshot: (snapshot) => snapshot === currentSnapshotId(),
              signal: req.signal,
              readSide: (side, filePath, oldPath, maxBytes, signal) =>
                runImageRead(() => readReviewSide(side, filePath, oldPath, maxBytes, signal), signal),
            });
            return new Response(result.body as BodyInit | null, {
              status: result.status,
              headers: result.headers,
            });
          }

          const repoFilesUnavailable = (): RepoFilesUnavailable | null => {
            if (isStaticPatchMode) {
              return { reason: "static-patch", message: "A patch file has no repository to list." };
            }
            if (sessionVcsType === "p4") {
              return { reason: "unsupported", message: "All files is not available for Perforce reviews." };
            }
            if (!isPRMode && !workspace && !hasLocalAccess) {
              return { reason: "unsupported", message: "This review has no repository to list." };
            }
            return null;
          };
          // A PR review lists its checkout once ready; while a --local clone is still being made the platform tree API answers, and the listing cache key names the source so the checkout takes over.
          const prListingCwd = async (): Promise<string | "pending" | undefined> => {
            const pool = options.worktreePool;
            if (pool && prMetadata) {
              const entry = pool.get(prMetadata.url);
              if (entry?.ready) return entry.path;
              if (prRef) return "pending";
              return ensurePRLocalCwd();
            }
            return agentCwdIfExists();
          };
          const loadRepoListing = async (): Promise<RepoFileListing | null> => {
            const prCwd = isPRMode && prMetadata && !workspace ? await prListingCwd() : undefined;
            const source = prCwd === "pending" ? "platform" : "local";
            return repoListing.get(`${currentSnapshotId()}:${source}`, async () => {
              if (workspace) return workspace.listFiles();
              if (isPRMode && prMetadata) {
                const meta = prMetadata;
                if (prCwd && prCwd !== "pending") return listGitSideFiles(gitRuntime, { kind: "commit", rev: meta.headSha, cwd: prCwd });
                if (!prRef) return null;
                const tree = await fetchPRTree(prRef, meta.headSha);
                if (!tree) return null;
                return {
                  paths: [...tree.paths].sort(compareRepoPaths),
                  revision: { kind: "commit", label: meta.headSha.slice(0, 7) },
                  live: false,
                  truncated: tree.truncated || undefined,
                };
              }
              if (!hasLocalAccess) return null;
              return listVcsFiles(currentDiffType as DiffType, currentBase, gitContext?.cwd);
            });
          };
          const readListedRepoFile = async (path: string, maxBytes: number): Promise<RepoFileRead> => {
            if (workspace) return workspace.getFileBytes(path, undefined, "new", maxBytes);
            if (isPRMode && prMetadata) {
              const prCwd = await prListingCwd();
              if (prCwd && prCwd !== "pending") return readDiffSideBytes(gitRuntime, { kind: "object", rev: prMetadata.headSha, path }, maxBytes, prCwd);
              if (!prRef) return { kind: "unavailable" };
              // Capped and as bytes, so a binary file is said to be one.
              return fetchPRFileBytes(prRef, prMetadata.headSha, path, maxBytes);
            }
            return getVcsFileBytesForDiff(currentDiffType as DiffType, currentBase, path, undefined, "new", maxBytes, gitContext?.cwd);
          };

          if (url.pathname === REPO_FILES_ENDPOINT && req.method === "GET") {
            const result = await handleRepoFilesRequest({
              params: url.searchParams,
              unavailable: repoFilesUnavailable(),
              isCurrentSnapshot: (snapshot) => snapshot === currentSnapshotId(),
              loadListing: loadRepoListing,
              loadOnDisk: (listing) =>
                listing.root
                  ? findRepoOnDiskChanges(gitRuntime, listing.root, diffFileStates(currentPatch), snapshotCapturedAt)
                  : Promise.resolve(null),
              lazyThreshold: options.repoFilesLazyThreshold,
            });
            return Response.json(result.body, { status: result.status });
          }

          if (url.pathname === REPO_FILES_SEARCH_ENDPOINT && req.method === "GET") {
            const result = await handleRepoFilesSearchRequest({
              params: url.searchParams,
              unavailable: repoFilesUnavailable(),
              isCurrentSnapshot: (snapshot) => snapshot === currentSnapshotId(),
              loadListing: loadRepoListing,
              preferred: new Set(diffFileStates(currentPatch).keys()),
            });
            return Response.json(result.body, { status: result.status });
          }

          if (url.pathname === REPO_FILES_STREAM_ENDPOINT && req.method === "GET") {
            const snapshot = url.searchParams.get("snapshot");
            if (!snapshot) return Response.json({ error: "Missing snapshot", reason: "bad-request" }, { status: 400 });
            const unavailable = repoFilesUnavailable();
            if (unavailable) return Response.json({ error: unavailable.message, reason: unavailable.reason }, { status: 400 });
            if (snapshot !== currentSnapshotId()) return Response.json({ error: "Diff snapshot is stale; refresh first", reason: "stale" }, { status: 409 });
            const listing = await loadRepoListing();
            if (!listing?.live || !listing.root) {
              return Response.json({ error: "This listing does not change while the review is open", reason: "not-live" }, { status: 400 });
            }
            const root = listing.root;
            const liveWorkspace = workspace;
            return repoWatch.stream(root, {
              mode: repoLiveMode(listing, { workspace: !!liveWorkspace, lazyThreshold: options.repoFilesLazyThreshold }),
              signature: liveWorkspace
                ? async () => (await liveWorkspace.listFiles())?.paths.join("\n") ?? null
                : () => gitLiveSignature(gitRuntime, root),
              ignored: liveWorkspace ? undefined : () => gitIgnoredEntries(gitRuntime, root),
              onChange: () => repoListing.invalidate(),
              pollMs: options.repoLivePollMs,
              signal: req.signal,
            }, () => server.timeout(req, 0));
          }

          if (url.pathname === REPO_FILE_ENDPOINT && req.method === "GET") {
            const result = await handleRepoFileRequest({
              params: url.searchParams,
              unavailable: repoFilesUnavailable(),
              isCurrentSnapshot: (snapshot) => snapshot === currentSnapshotId(),
              loadListing: loadRepoListing,
              read: readListedRepoFile,
              readWorkingTree: readRepoWorkingTreeFile,
            });
            return Response.json(result.body, { status: result.status });
          }

          if (url.pathname === "/api/file-content" && req.method === "GET") {
            // No working tree behind a static patch: nothing to expand into.
            if (isStaticPatchMode) {
              return Response.json(
                { error: "File content is unavailable for a static patch review" },
                { status: 400 },
              );
            }
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

            // File expansion must describe the exact patch the tab rendered: reject cross-tab switches and mutable VCS changes rather than mix an old patch with new contents.
            const requestedSnapshot = url.searchParams.get("snapshot");
            if (requestedSnapshot) {
              if (requestedSnapshot !== currentSnapshotId()) {
                return Response.json({ error: "Diff snapshot is stale; refresh before expanding context" }, { status: 409 });
              }
              const baselineGeneration = fingerprintGeneration;
              let baseline = currentFingerprint;
              const pendingCapture = pendingFingerprintCapture;
              if (baseline == null && pendingCapture) {
                baseline = await pendingCapture;
              }
              if (
                requestedSnapshot !== currentSnapshotId() ||
                baselineGeneration !== fingerprintGeneration
              ) {
                return Response.json({ error: "Diff snapshot is stale; refresh before expanding context" }, { status: 409 });
              }
              if (baseline != null) {
                const probe = await fileContentFingerprintProbes.run(
                  `${requestedSnapshot}:${baselineGeneration}`,
                  computeDiffFingerprint,
                );
                if (
                  requestedSnapshot !== currentSnapshotId() ||
                  currentFingerprint !== baseline ||
                  (probe != null && probe !== baseline)
                ) {
                  return Response.json({ error: "Diff snapshot is stale; refresh before expanding context" }, { status: 409 });
                }
              }
            }

            const result = await readDiffFileContents(filePath, oldPath, url.searchParams.get("base") ?? undefined);
            if ("error" in result) return Response.json(result, { status: 400 });
            return Response.json(result);
          }

          // Read only: the lookup below is the one route that reaches npm.
          if (url.pathname === "/api/package-changes" && req.method === "GET") {
            if (isStaticPatchMode) {
              return Response.json({ error: "Package changes need the files behind the diff" }, { status: 400 });
            }
            const out = await packageChanges.get({
              snapshot: url.searchParams.get("snapshot"),
              base: url.searchParams.get("base") ?? undefined,
            });
            return Response.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } });
          }

          // POST so the cross-origin write guard refuses another site; 403 until the reviewer turned the lookup on.
          if (url.pathname === "/api/package-changes/lookup" && req.method === "POST") {
            if (isStaticPatchMode) {
              return Response.json({ error: "Package changes need the files behind the diff" }, { status: 400 });
            }
            let body: unknown;
            try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
            const out = await packageChanges.lookup(body);
            return Response.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } });
          }

          if (url.pathname === "/api/code-nav/resolve" && req.method === "POST") {
            if (isGitButlerCommittedView()) {
              return Response.json(
                { error: "Code navigation is unavailable for committed GitButler views" },
                { status: 400 },
              );
            }
            const hasCodeNavAccess = !!workspace || !!gitContext || !!options.agentCwd || !!options.worktreePool;
            if (!hasCodeNavAccess) {
              return Response.json(
                { error: "Code navigation requires local access" },
                { status: 400 },
              );
            }
            // PR mode: the checkout must actually exist; ripgrep over a fallback directory returns confidently wrong results.
            const navCwd = options.worktreePool && prMetadata
              ? await ensurePRLocalCwd()
              : await resolveAgentCwdReady();
            if (!navCwd) {
              return Response.json({ error: "Local checkout unavailable" }, { status: 400 });
            }
            const changedFiles = extractChangedFiles(currentPatch);
            return handleCodeNavResolve(req, navCwd, changedFiles);
          }

          if (url.pathname === "/api/code-nav/hover" && req.method === "POST") {
            if (isGitButlerCommittedView()) {
              return Response.json(
                { error: "Code navigation is unavailable for committed GitButler views" },
                { status: 400 },
              );
            }
            const hasCodeNavAccess = !!workspace || !!gitContext || !!options.agentCwd || !!options.worktreePool;
            if (!hasCodeNavAccess) {
              return Response.json(
                { error: "Code navigation requires local access" },
                { status: 400 },
              );
            }
            // PR mode: the checkout must actually exist; ripgrep over a fallback directory returns confidently wrong results.
            const navCwd = options.worktreePool && prMetadata
              ? await ensurePRLocalCwd()
              : await resolveAgentCwdReady();
            if (!navCwd) {
              return Response.json({ error: "Local checkout unavailable" }, { status: 400 });
            }
            const changedFiles = extractChangedFiles(currentPatch);
            return handleCodeNavHover(req, navCwd, changedFiles);
          }

          if (url.pathname === "/api/code-nav/file" && req.method === "GET") {
            if (isGitButlerCommittedView()) {
              return Response.json(
                { error: "Code navigation is unavailable for committed GitButler views" },
                { status: 400 },
              );
            }
            const hasCodeNavAccess = !!workspace || !!gitContext || !!options.agentCwd || !!options.worktreePool;
            if (!hasCodeNavAccess) {
              return Response.json({ error: "Code navigation requires local access" }, { status: 400 });
            }
            const navCwd = options.worktreePool && prMetadata
              ? await ensurePRLocalCwd()
              : await resolveAgentCwdReady();
            if (!navCwd) {
              return Response.json({ error: "Local checkout unavailable" }, { status: 400 });
            }
            // Links followed like an editor; 5 MB cap and no FIFO hang (packages/shared/repo-file.ts).
            const read = await readRepoFile(navCwd, url.searchParams.get("path"), { decode: decodeBunText });
            if (!read.ok) {
              return Response.json(repoFileErrorBody(read), { status: REPO_FILE_ERROR_STATUS[read.reason] });
            }
            return Response.json({ content: read.content });
          }

          if (url.pathname === "/api/git-add" && req.method === "POST") {
            if (isStaticPatchMode) {
              return Response.json(
                { error: "Staging is unavailable for a static patch review" },
                { status: 400 },
              );
            }
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
              if (
                isPRMode ||
                (sessionVcsType && !vcsOwnsDiffType(sessionVcsType, currentDiffType as string)) ||
                !(await canStageFiles(currentDiffType as DiffType, stageCwd))
              ) {
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

          const updateRoute = handleUpdateRoute(req, url, { port: boundPort, exposed: isRemote || options.tailnetPublished === true, serverSession, localHostname });

          if (updateRoute) return updateRoute;

          const refRoute = await refCardRouteResponse(req, url, refCards, {
            enabled: isRemote ? false : options.tailnetPublished === true ? refCardsTailnetAllowed : true,
            serverSession,
          });
          if (refRoute) return refRoute;


          if (url.pathname === "/api/config" && req.method === "POST") {
            if (!isSameOriginOrNoOrigin(req.headers.get("origin"), url.host, req.headers.get("sec-fetch-site"))) {
              return Response.json({ error: "Cross-origin config writes are not allowed" }, { status: 403 });
            }
            try {
              const body = (await req.json()) as { agentSwitch?: unknown; displayName?: string; diffOptions?: Record<string, unknown>; reviewDefaults?: Record<string, { defaultDiffType?: string }>; theme?: Record<string, unknown>; favicon?: FaviconStyle; autoUpdate?: unknown; updateCheck?: unknown; agentTool?: unknown; reviewAnalysis?: Record<string, unknown>; packageChanges?: unknown; conventionalComments?: boolean; conventionalLabels?: unknown[] | null };
              const toSave: Record<string, unknown> = {};
              const agentSwitch = agentSwitchConfigToSave(body);
              if (agentSwitch === null) return Response.json({ error: "Invalid agentSwitch" }, { status: 400 });
              if (agentSwitch !== undefined) toSave.agentSwitch = agentSwitch;
              if (body.displayName !== undefined) toSave.displayName = body.displayName;
              if (body.diffOptions !== undefined) toSave.diffOptions = body.diffOptions;
              if (body.reviewDefaults !== undefined) toSave.reviewDefaults = body.reviewDefaults;
              if (body.theme !== undefined) toSave.theme = body.theme;
              if (isFaviconStyle(body.favicon)) toSave.favicon = body.favicon;
              if (typeof body.autoUpdate === "boolean") toSave.autoUpdate = body.autoUpdate;
              if (typeof body.updateCheck === "boolean") toSave.updateCheck = body.updateCheck;
              if (typeof body.agentTool === "boolean") toSave.agentTool = body.agentTool;
              if (body.reviewAnalysis !== undefined) {
                const reviewAnalysis = parseReviewAnalysisConfig(body.reviewAnalysis);
                if (!reviewAnalysis) {
                  return Response.json({ error: "Invalid analysis settings" }, { status: 400 });
                }
                toSave.reviewAnalysis = reviewAnalysis;
                if (reviewAnalysis.callFlow === false) callFlowService.cancelAll();
              }
              if (body.packageChanges !== undefined) {
                const packageChangesConfig = parsePackageChangesConfig(body.packageChanges);
                if (!packageChangesConfig) return Response.json({ error: "Invalid packageChanges" }, { status: 400 });
                toSave.packageChanges = packageChangesConfig;
              }
              if (body.conventionalComments !== undefined) toSave.conventionalComments = body.conventionalComments;
              if (body.conventionalLabels !== undefined) toSave.conventionalLabels = body.conventionalLabels;
              // The cookie switch is its own write, never replaces another urlHost; refused in remote mode and --tailscale sessions.
              const cookieHostWrite = cookieHostConfigWrite((body as { cookieHost?: unknown }).cookieHost, isRemote || options.tailnetPublished === true);
              if (cookieHostWrite && cookieHostWrite.status !== 200) return Response.json(cookieHostWrite.body, { status: cookieHostWrite.status });
              if (Object.keys(toSave).length > 0 && !saveConfig(toSave as Parameters<typeof saveConfig>[0])) return Response.json({ error: "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it." }, { status: 500 });
              if (agentToolSaveFailed(toSave)) return Response.json({ error: "Could not save the setting to config.json." }, { status: 500 });
              return Response.json(cookieHostWrite ? cookieHostWrite.body : { ok: true });
            } catch {
              return Response.json({ error: "Invalid request" }, { status: 400 });
            }
          }

          if (url.pathname.startsWith("/api/star-ask/")) {
            return (await handleStarAsk(req, url, "review", { remote: isRemote })) ?? handleApiNotFound(url.pathname);
          }

          if (url.pathname === "/api/image") {
            return handleImage(req);
          }

          if (url.pathname === "/api/upload" && req.method === "POST") {
            return handleUpload(req);
          }

          if (url.pathname === "/api/agents") {
            return handleAgents(options.opencodeClient);
          }

          // AI-disabled sessions expose no agent discovery or launch surface; the exact endpoint above is feedback routing, not a job.
          if (!aiEnabled && url.pathname.startsWith("/api/agents/")) {
            if (
              url.pathname.slice("/api/agents/".length) === "capabilities" &&
              req.method === "GET"
            ) {
              return Response.json({ mode: "review", providers: [], available: false });
            }
            return Response.json({ error: "AI features disabled" }, { status: 503 });
          }

          if (url.pathname === "/api/agents/review-profiles" && req.method === "GET") {
            // Catalog only; SKILL.md bodies are read at launch for the selected skill.
            const body: ReviewProfilesResponse = {
              profiles: [
                {
                  id: BUILTIN_DEFAULT_PROFILE.id,
                  label: BUILTIN_DEFAULT_PROFILE.label,
                  source: BUILTIN_DEFAULT_PROFILE.source,
                  default: BUILTIN_DEFAULT_PROFILE.default,
                },
                ...discoverCuratedSkills().map((s) => ({
                  id: `skill:${s.name}`,
                  label: s.name,
                  source: "user" as const,
                  sourcePath: s.sourcePath,
                })),
              ],
            };
            return Response.json(body);
          }

          if (url.pathname === "/api/agents/skills" && req.method === "GET") {
            return Response.json({ skills: listAllSkills() });
          }

          if (url.pathname === "/api/agents/review-skills" && req.method === "POST") {
            let name: unknown;
            try {
              ({ name } = (await req.json()) as { name?: unknown });
            } catch {
              return Response.json({ error: "Invalid JSON" }, { status: 400 });
            }
            if (typeof name !== "string" || name.length === 0) {
              return Response.json({ error: "`name` is required." }, { status: 400 });
            }
            try {
              return Response.json(enableReviewSkill(name));
            } catch (err) {
              return Response.json(
                { error: err instanceof Error ? err.message : "Could not enable review." },
                { status: 400 },
              );
            }
          }

          if (url.pathname === "/api/agents/guide-instructions") {
            if (req.method === "GET") {
              return Response.json({ instructions: readGuideInstructions() });
            }
            if (req.method === "PUT") {
              let instructions: unknown;
              try {
                ({ instructions } = (await req.json()) as { instructions?: unknown });
              } catch {
                return Response.json({ error: "Invalid JSON" }, { status: 400 });
              }
              if (typeof instructions !== "string") {
                return Response.json({ error: "`instructions` must be a string." }, { status: 400 });
              }
              return Response.json({ instructions: writeGuideInstructions(instructions) });
            }
          }

          if (url.pathname === "/api/review-progress") {
            if (req.method === "POST" && !callFlowInstallOriginAllowed(req.headers.get("origin"), url.host, req.headers.get("sec-fetch-site"))) {
              return Response.json({ error: "Cross-origin progress updates are not allowed" }, { status: 403 });
            }
            let body: unknown;
            if (req.method === "POST") {
              try {
                body = await req.json();
              } catch {
                return Response.json({ error: "Invalid JSON" }, { status: 400 });
              }
            }
            const result = await handleReviewProgress({
              method: req.method, snapshotId: url.searchParams.get("snapshot"),
              currentSnapshotId, progress: progressSnapshot, currentProgress: () => progressSnapshot,
              body, platformViewed: isPRMode ? initialViewedFiles : [],
            });
            return Response.json(result.body, { status: result.status });
          }

          if (url.pathname === "/api/draft") {
            const keys = currentDraftKeys();
            if (url.searchParams.has("target") && url.searchParams.get("target") !== keys.targetKey) {
              return Response.json({ code: "draft_target_changed", error: "Review draft target changed" }, { status: 409 });
            }
            if (req.method === "POST") {
              try {
                const saved = reviewDrafts.save(keys, await req.json(), url.searchParams.get("client"));
                if (!saved && keys.targetKey) {
                  return Response.json(
                    { ok: false, error: "stale draft generation", ...reviewDrafts.state(keys) },
                    { status: 409 },
                  );
                }
                return Response.json({ ok: true });
              } catch (err) {
                const message = err instanceof Error ? err.message : "Failed to save draft";
                console.error(`[draft] save failed: ${message}`);
                return Response.json({ error: message }, { status: 500 });
              }
            }
            if (req.method === "DELETE") {
              reviewDrafts.remove(keys, readDraftGenerationFromUrl(req), url.searchParams.get("client"));
              return Response.json({ ok: true });
            }
            const loaded = reviewDrafts.load(keys, url.searchParams.get("client"));
            if (loaded.found) return Response.json(loaded.draft);
            return Response.json(
              { found: false, ...(loaded.draftGeneration !== null ? { draftGeneration: loaded.draftGeneration } : {}) },
              { status: 404 },
            );
          }

          if (isGitButlerCommittedView() && url.pathname === "/api/editor-annotations" && req.method === "GET") {
            return Response.json({ annotations: [] });
          }
          if (isGitButlerCommittedView() && url.pathname === "/api/editor-annotation" && req.method === "POST") {
            return Response.json(
              { error: "Editor annotations are unavailable for committed GitButler views" },
              { status: 400 },
            );
          }
          const editorResponse = await editorAnnotations.handle(req, url);
          if (editorResponse) return editorResponse;

          if (url.pathname === "/api/pr-context/stream" && req.method === "GET") {
            if (!isPRMode || !prRef || !prMetadata) {
              return Response.json(
                { error: "Not in PR mode" },
                { status: 400 },
              );
            }

            server.timeout(req, 0);

            const encoder = new TextEncoder();
            const activeRef = prRef;
            const activeUrl = prMetadata.url;
            let unsubscribe: (() => void) | null = null;
            let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

            const stream = new ReadableStream({
              start(controller) {
                unsubscribe = prContextLive.watch(activeUrl, activeRef, (event) => {
                  controller.enqueue(encoder.encode(serializePRContextSSEEvent(event)));
                });

                heartbeatTimer = setInterval(() => {
                  try {
                    controller.enqueue(encoder.encode(PR_CONTEXT_HEARTBEAT_COMMENT));
                  } catch {
                    if (heartbeatTimer) clearInterval(heartbeatTimer);
                    heartbeatTimer = null;
                    unsubscribe?.();
                    unsubscribe = null;
                  }
                }, PR_CONTEXT_HEARTBEAT_INTERVAL_MS);
              },
              cancel() {
                if (heartbeatTimer) clearInterval(heartbeatTimer);
                heartbeatTimer = null;
                unsubscribe?.();
                unsubscribe = null;
              },
            });

            return new Response(stream, {
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
              },
            });
          }

          const externalResponse = await externalAnnotations.handle(req, url, {
            disableIdleTimeout: () => server.timeout(req, 0),
          });
          if (externalResponse) return externalResponse;

          const agentResponse = await agentJobs.handle(req, url, {
            disableIdleTimeout: () => server.timeout(req, 0),
          });
          if (agentResponse) return agentResponse;

          if (url.pathname === "/api/exit" && req.method === "POST") {
            // Already decided (host closed it, or another tab decided): archiving or settling now would delete a draft the close kept. Exit posts carry the nonce in the query string.
            if (checkServerSession({ serverSession: url.searchParams.get("serverSession") ?? undefined }, serverSession) === "mismatch") {
              return Response.json(serverSessionMismatchBody(), { status: 409 });
            }
            if (reviewDecided) return reviewAlreadyDecided();
            // Decision-only line: dismissals carry no content, and how often reviews are closed without feedback is what the archive answers.
            archiveReviewSubmission("", [], "dismissed");
            reviewDrafts.settle(currentDraftKeys(), readDraftGenerationFromUrl(req), url.searchParams.get("client"));
            resolveDecision({ approved: false, feedback: "", annotations: [], exit: true });
            return Response.json({ ok: true });
          }

          if (url.pathname === "/api/feedback" && req.method === "POST") {
            try {
              const body = (await req.json()) as {
                approved?: boolean;
                feedback: string;
                annotations: unknown[];
                agentSwitch?: string;
                draftGeneration?: number;
                platform?: unknown;
              };
              if (checkServerSession(body, serverSession) === "mismatch") {
                return Response.json(serverSessionMismatchBody(), { status: 409 });
              }

              // Checked after the body is read: a host close can land while it streams, and a decided session must not archive, delete the draft, or answer ok.
              if (reviewDecided) return reviewAlreadyDecided();

              // Archive before the draft delete: a failed write keeps the draft as the recovery copy. A malformed body value degrades to the legacy behavior (settle + 200), never throws.
              const approved = body.approved ?? false;
              const feedbackValue = body.feedback || "";
              const annotationsValue = body.annotations || [];
              const hasContent =
                (typeof feedbackValue === "string" && feedbackValue.trim().length > 0) ||
                (Array.isArray(annotationsValue) && annotationsValue.length > 0);
              const durable = archiveReviewSubmission(
                feedbackValue,
                annotationsValue,
                approved ? (hasContent ? "approved-with-notes" : "lgtm") : "feedback",
              );
              if (durable) reviewDrafts.settle(currentDraftKeys(), readDraftGenerationFromBody(body), url.searchParams.get("client"));
              resolveDecision({
                approved,
                feedback: feedbackValue,
                ...(options.includeReviewDirectory && !isPRMode && !isStaticPatchMode
                  ? { reviewDirectory: resolveAgentCwd() } : {}),
                annotations: annotationsValue,
                agentSwitch: body.agentSwitch,
                // Only a real boolean true counts as the platform status post, so consumers never infer it from an empty annotation list.
                ...(body.platform === true && { platform: true as const }),
              });

              return Response.json({ ok: true });
            } catch (err) {
              const message =
                err instanceof Error ? err.message : "Failed to process feedback";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          if (url.pathname === "/api/pr-action" && req.method === "POST") {
            if (!isPRMode || !prMetadata) {
              return Response.json({ error: "Not in PR mode" }, { status: 400 });
            }
            try {
              const body = (await req.json()) as {
                action: unknown;
                body: string;
                fileComments: PRReviewFileComment[];
                fileLevelComments?: unknown;
                targetPrUrl?: string;
              };
              // Stale-tab guard: a tab of an earlier session on this port must not post a review to the platform as this one's.
              if (checkServerSession(body, serverSession) === "mismatch") {
                return Response.json(serverSessionMismatchBody(), { status: 409 });
              }
              const action = parsePRReviewAction(body.action);
              if (!action) {
                return Response.json(
                  { error: "action must be one of approve, comment, request_changes" },
                  { status: 400 },
                );
              }
              const fileLevelComments = parseFileLevelComments(body.fileLevelComments);

              // With an explicit targetPrUrl the client has already filtered annotations by diffScope, so the server-side scope guard is skipped.
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

              console.error(`[pr-action] ${action} with ${body.fileComments.length} line comment(s) and ${fileLevelComments.length} file-level comment(s), target=${targetUrl}, headSha=${targetHeadSha}`);

              const submission = await submitPlatformReview(
                targetRef,
                targetHeadSha,
                action,
                body.body,
                body.fileComments,
                fileLevelComments,
              );

              console.error(`[pr-action] ${submission.status === "complete" ? "Success" : "Partial success"}`);
              prContextLive.refreshAfterWrite(targetUrl, targetRef);
              return Response.json({ ok: true, prUrl: targetUrl, submission });
            } catch (err) {
              const message =
                err instanceof Error ? err.message : "Failed to submit PR review";
              console.error(`[pr-action] Failed: ${message}`);
              return Response.json({ error: message }, { status: 500 });
            }
          }

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

          if (url.pathname.startsWith("/api/ai/")) {
            if (!aiRuntime) {
              if (!isAIEndpointPath(url.pathname)) {
                return handleApiNotFound(url.pathname);
              }
              if (url.pathname.slice("/api/ai/".length) === "capabilities" && req.method === "GET") {
                return Response.json({ available: false, providers: [] });
              }
              return Response.json({ error: "AI backend not available" }, { status: 503 });
            }
            const handler = aiRuntime.endpoints[url.pathname as keyof AIEndpoints];
            if (handler) {
              // AI sessions pin their cwd at creation: wait out the PR checkout warmup, and refuse if it cannot be produced rather than root the session in the wrong directory.
              if (req.method === "POST" && url.pathname === "/api/ai/session" && options.worktreePool && prMetadata) {
                const checkout = await ensurePRLocalCwd();
                if (!checkout) {
                  return Response.json(
                    { error: "Local PR checkout unavailable — Ask AI can't read the PR files right now. Retry shortly." },
                    { status: 503 },
                  );
                }
              }
              if (isLongLivedAIEndpointPath(url.pathname)) {
                server.timeout(req, 0);
              }
              return handler(req);
            }
            return handleApiNotFound(url.pathname);
          }

          if (url.pathname === "/favicon.png" || url.pathname === "/favicon.ico") return handleFavicon(url.pathname);

          if (isDiagramEngineRequest(url.pathname)) {
            const answer = await answerDiagramEngineRequest(
              diagramEngineAssets,
              url.pathname,
              req.method,
              req.headers.get("accept-encoding"),
              compressAppHtml,
            );
            return new Response(answer.body as BodyInit, { status: answer.status, headers: answer.headers });
          }

          if (url.pathname.startsWith("/api/")) {
            return handleApiNotFound(url.pathname);
          }

          return packedAppResponse(app, req, url.pathname, compressAppHtml);
        },

        error(err) {
          console.error("[plannotator] Server error:", err);
          return new Response(
            `Internal Server Error: ${err instanceof Error ? err.message : String(err)}`,
            { status: 500, headers: { "Content-Type": "text/plain" } },
          );
        },
    })),
  );

  const port = server.port!;
  boundPort = port;
  serverUrl = buildAdvertisedUrl(port);
  agentApiUrl = `http://127.0.0.1:${port}`;
  const exitHandler = () => agentJobs.killAll();
  process.once("exit", exitHandler);

  const stop = () => {
    process.removeListener("exit", exitHandler);
    agentJobs.killAll();
    callFlowService.cancelAll();
    aiRuntime?.dispose();
    repoWatch.closeAll();
    server.stop();
    if (options.onCleanup) {
      try {
        const result = options.onCleanup();
        if (result instanceof Promise) result.catch(() => {});
      } catch { /* best effort */ }
    }
  };

  // Start the likely encoding now (gzip for plain-http remote, brotli behind tailscale serve) so the first load does not wait.
  if (compressAppHtml) {
    prewarmAppHtml(app.html, likelyAppHtmlEncoding(options.tailnetPublished === true));
  }

  // An async ready handler that rejects (e.g. --tailscale publishing failed) must stop the server and propagate, or the loopback server keeps listening and the session hangs.
  if (onReady) {
    try {
      await onReady(serverUrl, isRemote, port);
    } catch (error) {
      stop();
      throw error;
    }
  }

  return {
    port,
    url: serverUrl,
    isRemote,
    waitForDecision: () => decisionPromise,
    stop,
    hostControl,
  };
}
