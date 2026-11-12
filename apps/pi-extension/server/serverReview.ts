import { piUpdateAdvert } from "./update-advert.ts";
import { schedulePiDailyPing } from "./daily-ping.ts";
import { createPackageChangesService, MAX_PACKAGE_FILE_BYTES, PACKAGE_CHECKOUT_WAIT_MS, prSettingsSource, REMOTE_PACKAGE_READS, waitAtMost } from "../generated/package-changes-service.ts";
import { parseDiffToFiles } from "../generated/diff-files.ts";
import { isSameOriginOrNoOrigin } from "../generated/request-origin.ts";
import { likelyAppHtmlEncoding, prewarmAppHtml } from "../generated/app-html.ts";
import { openPackedApp } from "../generated/packed-app.ts";
import {
	answerDiagramEngineRequest,
	createDiagramEngineAssets,
	isDiagramEngineRequest,
	type DiagramEngineSource,
} from "../generated/diagram-engine-assets.ts";
import { readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import { basename, dirname as dirnamePath, join as joinPath, resolve as resolvePath } from "node:path";

import { SingleFlight } from "../generated/single-flight.ts";
import { contentHash } from "../generated/draft.ts";
import { countUnsentDraftComments, hostSessionClosedEvent } from "../generated/host-control.ts";
import { checkServerSession, createServerSessionNonce, serverSessionMismatchBody } from "../generated/server-session.ts";
import { handleHostControl, resolveHostControlToken, type HostControl } from "./host-control.ts";
import { createPiRefCards, handleRefCards, type RefRunner } from "./ref-cards.ts";
import { createRequestHostGuard } from "./request-host-guard.ts";
import { refuseCrossOriginWrite } from "./request-origin-guard.ts";
import { createReviewDraftSession, localGitDraftTargetKey, localReviewDraftKeys, prDraftTargetKey, type ReviewDraftKeys } from "../generated/review-draft.ts";
import { agentSwitchConfigToSave, agentToolSaveFailed, cookieHostConfigWrite, loadConfig, saveConfig, detectGitUser, getServerConfig, parsePackageChangesConfig, parseReviewAnalysisConfig, resolveAIEnabled, resolvePackageLookup, resolveSharingEnabled, resolveClaudeSandbox, resolveCursorSandbox, resolveFeedbackHistory, resolveGuideHistory, resolveGuideShareUrl, resolveGitRemoteCheck, resolveReviewProgress } from "../generated/config.ts";
import { currentPiHost } from "../pi-host.ts";
import { appendFeedbackRecord, countChangedFiles, deriveFeedbackProject, type FeedbackDecision, type FeedbackReviewTarget } from "../generated/feedback-archive.ts";
import { isFaviconStyle, type FaviconStyle } from "../generated/favicon.ts";
import { getExtraMarkdownExtensions } from "../generated/resolve-file.ts";

export type {
	DiffOption,
	DiffType,
	GitContext,
} from "../generated/review-core.ts";

import {
	getDisplayRepo,
	getMRLabel,
	getMRNumberLabel,
	getPRNumber,
	isSameProject,
	type PRMetadata,
	type PRListItem,
	type PRRef,
	type PRReviewFileComment,
	prRefFromMetadata,
} from "../generated/pr-types.ts";
import {
	PR_CONTEXT_HEARTBEAT_COMMENT,
	PR_CONTEXT_HEARTBEAT_INTERVAL_MS,
	createPRContextLiveCache,
	serializePRContextSSEEvent,
} from "../generated/pr-context-live.ts";
import {
	fetchPRArtifactContent,
	fetchPRArtifactDocument,
	PRArtifactDocumentError,
} from "../generated/pr-artifact-document.ts";
import {
	type DiffType,
	type GitContext,
	type RemoteDefaultInfo,
	type SinceBaseSections,
	detectRemoteDefaultInfo,
	nextRemoteBaseCheckInterval,
	REMOTE_BASE_CHECK_INTERVAL_MS,
	getFileContentsForDiff as getFileContentsForDiffCore,
	getFileBytesForDiff as getFileBytesForDiffCore,
	type DiffSide,
	type FileBytesRead,
	getSinceBaseSections,
	isBinaryPatchFile,
	commitFamilyId,
	isSameCwdCommitSwitch,
	listPatchFiles,
	STATIC_PATCH_DIFF_TYPE,
	parseCommitDiffType,
	parseJjCommitDiffType,
	parseWorktreeDiffType,
	resolveBaseBranch,
	validateFilePath,
	listGitSideFiles,
	readDiffSideBytes,
	compareRepoPaths,
	type RepoFileListing,
} from "../generated/review-core.ts";
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
} from "../generated/repo-files.ts";
import { createReviewRepoWatch } from "./review-repo-watch.ts";
import {
	REVIEW_IMAGE_ENDPOINT,
	REVIEW_IMAGE_READ_CONCURRENCY,
	createConcurrencyLimiter,
	handleReviewImageRequest,
	readPRImageSide,
} from "../generated/review-image.ts";
import {
	REVIEW_MARKDOWN_IMAGE_ENDPOINT,
	handleReviewMarkdownImageRequest,
} from "../generated/review-markdown-image.ts";
import {
	getGitButlerContextRevision,
	getGitButlerPatchFingerprint,
} from "../generated/gitbutler-core.ts";
import { canonicalizeJjCommitDiffType } from "../generated/jj-core.ts";
import {
	getCommitDiffInfo,
	getJjCommitDiffInfo,
	listCommitHistory,
	listJjCommitHistory,
	resolveJjCommitRailBase,
	type CommitDiffInfo,
} from "../generated/commit-history.ts";
import {
	checkoutPRHead,
	getPRDiffScopeOptions,
	getPRFullStackFingerprint,
	getPRStackInfo,
	resolveStackInfo,
	resolvePRFullStackBaseRef,
	runPRFullStackDiff,
	runPRLayerLocalDiff,
	type PRDiffScope,
} from "../generated/pr-stack.ts";

import { resolvePoolCwd, type WorktreePool } from "../generated/worktree-pool.ts";
import { createCommitAvatarResolver } from "../generated/commit-avatars.ts";
import { detectGeneratedFiles, detectGeneratedFilesByName } from "../generated/generated-files.ts";

import { createEditorAnnotationHandler } from "./annotations.ts";
import { createAgentJobHandler, whichCmd as commandExists, whichPath } from "./agent-jobs.ts";
import { type AgentJobInfo, REVIEW_OUTPUT_FAILED, getAgentJobAnnotationContext, markJobReviewFailed } from "../generated/agent-jobs.ts";
import { createExternalAnnotationHandler } from "./external-annotations.ts";
import {
	handleReviewDraftRequest,
	handleFavicon,
	handleImageRequest,
	handleStarAskRequest,
	readDraftGenerationFromBody,
	readDraftGenerationFromUrl,
	handleUploadRequest,
} from "./handlers.ts";
import { handleApiNotFound, serveApp, json, parseBody, parseJsonBody, readBody, requestUrl, send } from "./helpers.ts";
import { captureReviewProgress, handleReviewProgress } from "../generated/review-progress.ts";
import { createPiAIRuntime, handlePiAIRequest } from "./ai-runtime.ts";
import type { SessionBridge } from "../generated/ai/session-bridge.ts";

import { buildAdvertisedUrl, isRemoteSession, listenOnPort } from "./network.ts";
import { getAvailableOpenInApps, handleOpenInRequest } from "./open-in-apps.ts";
import {
	fetchPR,
	fetchPRContext,
	fetchPRFileContent,
	fetchPRFileBytes,
	fetchPRTree,
	fetchPRList,
	fetchPRStack,
	fetchPRViewedFiles,
	getPRUser,
	markPRFilesViewed,
	parseFileLevelComments,
	parsePRReviewAction,
	parsePRUrl,
	prCommandRuntime,
	submitPRReview,
} from "./pr.ts";
import { getRepoInfo } from "./project.ts";
import {
	composeCodexReviewPrompt,
	buildCodexCommand,
	generateOutputPath,
	parseCodexOutput,
	transformReviewFindings,
} from "../generated/codex-review.ts";
import { buildAgentReviewUserMessage, buildAgentReviewUserMessageForTarget, type WorkspaceReviewPromptContext } from "../generated/agent-review-message.ts";
import {
	composeClaudeReviewPrompt,
	buildClaudeCommand,
	parseClaudeStreamOutput,
	transformClaudeFindings,
} from "../generated/claude-review.ts";
import { createTourSession, TOUR_EMPTY_OUTPUT_ERROR } from "../generated/tour-review.ts";
import { createGuideSession, GUIDE_EMPTY_OUTPUT_ERROR } from "../generated/guide-review.ts";
import { GuideShareError, shareGuide, unshareBeforeDelete, unshareGuide } from "../generated/guide-share.ts";
import { createGuideStoreSession, SAVED_GUIDE_ID_PREFIX, updateGuideShare } from "../generated/guide-store.ts";
import {
	buildGuideSnapshot,
	createGuideHtml,
	detectGuideLanguages,
	guideExportFilename,
	resolveGuideViewerAssets,
	type GuideLaunchReview,
	type GuideSnapshot,
	type GuideSnapshotSource,
} from "../generated/guide-format.ts";
import { GUIDE_VIEWER_MANIFEST } from "../generated/guide-viewer-manifest.ts";
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
} from "../generated/marker-review.ts";
import {
	WorkspaceReviewSession,
	type WorkspaceDiffType,
} from "../generated/review-workspace.ts";
import { resolveWorkspaceFilePath } from "../generated/review-workspace-node.ts";
import {
	type CodeNavRequest,
	resolveCodeNav,
	resolveCodeNavHover,
	validateCodeNavRequest,
	extractChangedFiles,
} from "../generated/code-nav.ts";
import { readRepoFile, repoFileErrorBody, REPO_FILE_ERROR_STATUS } from "../generated/repo-file.ts";
import { piCodeNavRuntime } from "./code-nav-runtime.ts";
import { readRepoWorkingTreeFile } from "../generated/repo-files-node.ts";
import {
	createDefaultSemanticDiffRuntime,
	getSemanticDiffAvailability,
	getSemanticDiffScratchCwd,
	runSemanticDiff,
	semanticDiffCacheKey,
	semanticDiffFileExtsFromSearchParams,
	SemanticDiffResponseCache,
} from "../generated/semantic-diff.ts";
import type { SemanticDiffAvailability, SemanticDiffResponse } from "../generated/semantic-diff-types.ts";
import { CallFlowService } from "../generated/call-flow.ts";
import { CallFlowInstallCoordinator, callFlowInstallOriginAllowed } from "../generated/call-flow-install.ts";
import type { CallFlowInstallCoordinatorOptions } from "../generated/call-flow-install.ts";
import { parseCallFlowInstallRequest, resolveCallFlowInstallTargets } from "../generated/call-flow-languages.ts";
import type { CallFlowResponse } from "../generated/call-flow-types.ts";
import { discoverCuratedSkills, resolveRequestedReviewProfile, listAllSkills, enableReviewSkill } from "../generated/review-skill-loader.ts";
import { readGuideInstructions, writeGuideInstructions } from "../generated/guide-instructions-store.ts";
import {
	BUILTIN_DEFAULT_PROFILE,
	type ReviewProfilesResponse,
} from "../generated/review-profiles.ts";
import {
	canStageFiles,
	detectRemoteDefaultCompareTarget,
	getVcsContext,
	getVcsDiffFingerprint,
	getVcsFileContentsForDiff,
	getVcsFileBytesForDiff,
	listVcsFiles,
	jjRuntime,
	resolveVcsCwd,
	resolveAvailableDiffType,
	reviewRuntime,
	materializeVcsSnapshot,
	runVcsDiff,
	stageFile,
	unstageFile,
	vcsOwnsDiffType,
	vcsSupportsSnapshot,
} from "./vcs.ts";

function detectWSL(): boolean {
	if (process.platform !== "linux") return false;
	if (os.release().toLowerCase().includes("microsoft")) return true;
	try {
		if (existsSync("/proc/version")) {
			const content = readFileSync("/proc/version", "utf-8").toLowerCase();
			return content.includes("wsl") || content.includes("microsoft");
		}
	} catch { }
	return false;
}

export interface ReviewServerResult {
	port: number;
	portSource: "env" | "remote-default" | "random";
	url: string;
	isRemote: boolean;
	waitForDecision: () => Promise<{
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
	}>;
	stop: () => void;
	hostControl: HostControl;
}

export async function startReviewServer(options: {
	repoFilesLazyThreshold?: number;
	repoLivePollMs?: number;
	callFlowInstall?: Pick<CallFlowInstallCoordinatorOptions, "install" | "preflight">;
	refRunner?: RefRunner;
	sessionBridge?: SessionBridge;
	hostControlToken?: string;
	includeReviewDirectory?: boolean;
	rawPatch: string;
	gitRef: string;
	htmlContent: string;
	diagramEngine?: DiagramEngineSource;
	origin?: string;
	diffType?: DiffType | WorkspaceDiffType;
	gitContext?: GitContext;
	initialBase?: string;
	initialBaseExplicit?: boolean;
	openStatePinned?: boolean;
	initialFingerprint?: string;
	initialFileIdentities?: Record<string, string>;
	error?: string;
	sharingEnabled?: boolean;
	approvalNotesSupported?: boolean;
	shareBaseUrl?: string;
	pasteApiUrl?: string;
	prMetadata?: PRMetadata;
	prReviewSubmitter?: typeof submitPRReview;
	prFetcher?: typeof fetchPR;
	prPatchIncomplete?: boolean;
	project?: string;
	agentCwd?: string;
	workspace?: WorkspaceReviewSession;
	worktreePool?: WorktreePool;
	gitRemoteCheck?: boolean;
	onCleanup?: () => void | Promise<void>;
	onReady?: (url: string, isRemote: boolean, port: number) => void;
}): Promise<ReviewServerResult> {
	schedulePiDailyPing("review");
	const gitUser = detectGitUser(options.workspace?.root ?? options.gitContext?.cwd);
	const aiEnabled = resolveAIEnabled();
	const submitPlatformReview = options.prReviewSubmitter ?? submitPRReview;
	let draftKey = contentHash(options.rawPatch);
	let prMeta = options.prMetadata;
	const isPRMode = !!prMeta;
	const workspace = options.workspace;
	const isWorkspaceMode = !!workspace;
	const hasLocalAccess = !!options.gitContext;
	const sessionVcsType = options.gitContext?.vcsType;
	let clientGitContext = options.gitContext;
	const isRemote = isRemoteSession();
	const wslFlag = detectWSL();
	let prRef = prMeta ? prRefFromMetadata(prMeta) : null;
	const platformUser = prRef ? await getPRUser(prRef) : null;
	let prStackInfo = isPRMode ? getPRStackInfo(prMeta) : null;
	let prDiffScopeOptions = isPRMode
		? getPRDiffScopeOptions(prMeta, !!(options.worktreePool || options.agentCwd))
		: [];

	let prListCache: PRListItem[] | null = null;
	let prListCacheTime = 0;
	let layerPatchIncomplete = (options.prPatchIncomplete ?? false) && isPRMode;
	const layerUpgradeAvailable = !!options.worktreePool;
	const prSwitchCache = new Map<string, { metadata: PRMetadata; rawPatch: string; patchIncomplete?: boolean }>();
	if (isPRMode && prMeta) {
		prSwitchCache.set(prMeta.url, {
			metadata: prMeta,
			rawPatch: options.rawPatch,
			patchIncomplete: layerPatchIncomplete,
		});
	}
	const prStackTreeCache = new Map<string, import("../generated/pr-types.ts").PRStackTree | null>();
	const prContextLive = createPRContextLiveCache({ fetchContext: fetchPRContext });
	const warmPRContext = (url: string, ref: PRRef): void => {
		prContextLive.warm(url, ref);
	};

	let prStackTree: import("../generated/pr-types.ts").PRStackTree | null = null;
	if (prRef && prMeta) {
		warmPRContext(prMeta.url, prRef);
		try {
			prStackTree = await fetchPRStack(prRef, prMeta);
		} catch {
		}
		prStackTreeCache.set(prMeta.url, prStackTree);
		const resolved = resolveStackInfo(prMeta, prStackTree, prStackInfo);
		if (resolved && !prStackInfo) {
			prStackInfo = resolved;
			prDiffScopeOptions = getPRDiffScopeOptions(prMeta, !!(options.worktreePool || options.agentCwd));
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
		}
	}
	let repoInfo = options.diffType === STATIC_PATCH_DIFF_TYPE
		? undefined
		: prMeta
		? {
				display: getDisplayRepo(prMeta),
				branch: `${getMRLabel(prMeta)} ${getMRNumberLabel(prMeta)}`,
			}
		: workspace
			? { display: basename(workspace.root), branch: "Workspace" }
		: getRepoInfo(options.gitContext?.cwd);
	const editorAnnotations = createEditorAnnotationHandler();
	const externalAnnotations = createExternalAnnotationHandler("review");

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
	const reviewDrafts = createReviewDraftSession();
	let localDraftTarget: string | null = null;
	const currentDraftKeys = (): ReviewDraftKeys => {
		const patchKey = draftKey;
		return isPRMode && prMeta
			? { patchKey, targetKey: prDraftTargetKey(prMeta, currentPRDiffScope) }
			: localReviewDraftKeys(patchKey, localDraftTarget);
	};
	let prScopeEpoch = 0;
	let diffSwitchEpoch = 0;
	let reviewAnalysisEpoch = 0;
	let reviewAnalysisMutationEpoch: number | null = null;
	const detectedCompareTarget = (): string =>
		options.gitContext?.defaultBranch || options.gitContext?.compareTarget?.fallback || "main";
	let currentBase = options.initialBase || detectedCompareTarget();
	const isGitButlerCommittedView = (diffType: string = currentDiffType as string): boolean =>
		diffType.startsWith("gitbutler:stack:") || diffType.startsWith("gitbutler:branch:");
	let baseEverSwitched = false;
	let baseExplicitlyChosen = options.initialBaseExplicit === true;
	const remoteCheckEnabled = resolveGitRemoteCheck(options.gitRemoteCheck === false, loadConfig());
	const resolveReviewBase = (
		requestedBase?: string,
		explicitlyChosen = baseExplicitlyChosen,
		activeBase = currentBase,
	): string => {
		const resolved = resolveBaseBranch(requestedBase, detectedCompareTarget());
		const remoteBranch = remoteDefaultInfo?.branch;
		if (
			!explicitlyChosen &&
			remoteBranch &&
			remoteBranch.startsWith("origin/") &&
			resolved === remoteBranch.replace(/^origin\//, "")
		) {
			return remoteBranch;
		}
		if (!explicitlyChosen && activeBase === `origin/${resolved}`) {
			return activeBase;
		}
		return resolved;
	};

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
					const suffix = layerPatchIncomplete ? ":incomplete" : "";
					return `pr-layer:${prMeta?.url ?? ""}${suffix}`;
				}
				const fullStackCwd =
					(options.worktreePool && prMeta ? options.worktreePool.resolve(prMeta.url) : undefined) ??
					options.agentCwd;
				if (!prMeta) return null;
				return await getPRFullStackFingerprint(reviewRuntime, prMeta, fullStackCwd);
			}
			if (!hasLocalAccess) return null;
			return await getVcsDiffFingerprint(
				currentDiffType as DiffType,
				currentBase,
				options.gitContext?.cwd,
				{ hideWhitespace: currentHideWhitespace },
			);
		} catch {
			return null;
		}
	};
	let fingerprintGeneration = 0;
	const repoListing = createRepoListingCache();
	const repoWatch = createReviewRepoWatch();
	let snapshotCapturedAt = Date.now();
	let pendingFingerprintCapture: Promise<string | null> | null = null;
	const fileContentFingerprintProbes = new SingleFlight<string | null>();
	const callFlowService = new CallFlowService();
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
		cwd: options.gitContext ? options.gitContext.cwd ?? process.cwd() : undefined,
		vcsType: sessionVcsType,
		prUrl: prMeta?.url,
		prScope: currentPRDiffScope,
		workspaceRoot: workspace?.root,
	}, reviewRuntime.runGit);
	let progressSnapshot: ReturnType<typeof captureProgress> = Promise.resolve(null);
	const captureDraftTarget = (base = currentBase) => isPRMode || options.diffType === STATIC_PATCH_DIFF_TYPE ? Promise.resolve(null) : localGitDraftTargetKey({
		diffType: currentDiffType,
		base,
		defaultBase: remoteCheckEnabled && !baseExplicitlyChosen ? detectedCompareTarget() : undefined,
		cwd: options.gitContext ? options.gitContext.cwd ?? process.cwd() : undefined,
		vcsType: sessionVcsType,
		workspaceRoot: workspace?.root,
	}, reviewRuntime.runGit);
	const captureDiffFingerprint = (knownFingerprint?: string, knownDraftTarget?: string | null): void => {
		snapshotCapturedAt = Date.now();
		repoListing.invalidate();
		progressSnapshot = captureProgress();
		if (knownDraftTarget !== undefined) localDraftTarget = knownDraftTarget;
		callFlowService.cancelAll();
		fileContentFingerprintProbes.clear();
		const generation = ++fingerprintGeneration;
		if (knownFingerprint !== undefined) {
			currentFingerprint = knownFingerprint;
			pendingFingerprintCapture = null;
			return;
		}
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

	let remoteDefaultInfo: RemoteDefaultInfo | null = null;
	let baseBehindRemote = false;
	let lastRemoteBaseCheck = 0;
	let remoteBaseCheckIntervalMs = REMOTE_BASE_CHECK_INTERVAL_MS;
	const gitRemoteSessionApplies = (): boolean =>
		!!options.gitContext && !isPRMode && (!sessionVcsType || sessionVcsType === "git");
	const remoteBaseCheckApplies = (): boolean =>
		remoteCheckEnabled && gitRemoteSessionApplies();

	const baseRelevantDiffType = (diffType: string = currentDiffType as string): boolean => {
		const t = parseWorktreeDiffType(diffType)?.subType ?? diffType;
		return t === "since-base" || t === "branch" || t === "merge-base";
	};

	async function computeBaseBehindRemote(
		base: string = currentBase,
		diffType: string = currentDiffType as string,
		explicitlyChosen = baseExplicitlyChosen,
	): Promise<boolean> {
		const remoteInfo = remoteDefaultInfo;
		if (!remoteBaseCheckApplies() || !baseRelevantDiffType(diffType) || !remoteInfo?.remoteHeadSha) {
			return false;
		}
		const remoteBranch = remoteInfo.branch;
		const localName = remoteBranch.replace(/^origin\//, "");
		const matchesDefault =
			base === remoteBranch ||
			(base === localName && !explicitlyChosen);
		if (!matchesDefault) {
			return false;
		}
		const local = await reviewRuntime.runGit(
			["--no-optional-locks", "rev-parse", "--verify", "--end-of-options", base],
			{ cwd: options.gitContext?.cwd },
		);
		return local.exitCode === 0 && local.stdout.trim() !== remoteInfo.remoteHeadSha;
	}

	async function recomputeBaseBehindRemote(): Promise<void> {
		baseBehindRemote = await computeBaseBehindRemote();
	}

	async function refreshRemoteBaseInfo(): Promise<void> {
		if (!remoteBaseCheckApplies()) return;
		lastRemoteBaseCheck = Date.now();
		remoteDefaultInfo = await detectRemoteDefaultInfo(reviewRuntime, options.gitContext?.cwd);
		remoteBaseCheckIntervalMs = nextRemoteBaseCheckInterval(
			remoteBaseCheckIntervalMs,
			remoteDefaultInfo !== null,
		);
		await recomputeBaseBehindRemote();
	}

	function maybeRefreshRemoteBaseInfo(): void {
		if (!remoteBaseCheckApplies()) return;
		if (Date.now() - lastRemoteBaseCheck < remoteBaseCheckIntervalMs) return;
		lastRemoteBaseCheck = Date.now();
		void refreshRemoteBaseInfo().catch(() => {});
	}

	const commitAvatars = createCommitAvatarResolver(prCommandRuntime);

	function isSinceBaseActive(diffType: string = currentDiffType as string): boolean {
		if (isPRMode || workspace || !options.gitContext) return false;
		const effective = parseWorktreeDiffType(diffType)?.subType ?? diffType;
		return effective === "since-base";
	}
	async function buildCommitInfoSidecar(diffType: string = currentDiffType as string): Promise<CommitDiffInfo | undefined> {
		if (isPRMode || workspace || !options.gitContext) return undefined;
		const effective = parseWorktreeDiffType(diffType)?.subType ?? diffType;
		const sha = parseCommitDiffType(effective as string)?.sha;
		const jjCommitId = parseJjCommitDiffType(effective as string)?.commitId;
		if (!sha && !jjCommitId) return undefined;
		const cwd = resolveVcsCwd(diffType as DiffType, options.gitContext.cwd);
		const info = jjCommitId
			? await getJjCommitDiffInfo(jjRuntime, jjCommitId, cwd)
			: await getCommitDiffInfo(reviewRuntime, sha!, cwd);
		if (!info) return undefined;
		const avatars = await commitAvatars.resolve(cwd, [info.authorEmail]);
		const avatarUrl = avatars.get(info.authorEmail);
		return avatarUrl ? { ...info, avatarUrl } : info;
	}

	async function buildSectionsSidecar(
		base: string = currentBase,
		diffType: string = currentDiffType as string,
	): Promise<SinceBaseSections | undefined> {
		if (!isSinceBaseActive(diffType)) return undefined;
		const cwd = resolveVcsCwd(diffType as DiffType, options.gitContext?.cwd);
		return (await getSinceBaseSections(reviewRuntime, base, cwd)) ?? undefined;
	}

	async function buildGeneratedFilesSidecar(
		patch: string = currentPatch,
		diffType: string = currentDiffType as string,
	): Promise<string[] | undefined> {
		const paths = listPatchFiles(patch).map((f) => f.path);
		const plainLocalGit =
			!isPRMode && !workspace && options.gitContext && (sessionVcsType ?? "git") === "git";
		const generated = plainLocalGit
			? await detectGeneratedFiles(
					reviewRuntime,
					resolveVcsCwd(diffType as DiffType, options.gitContext!.cwd),
					paths,
				)
			: detectGeneratedFilesByName(paths);
		return generated.length > 0 ? generated : undefined;
	}

	if (options.gitContext && !isPRMode && remoteCheckEnabled) {
		const gitCwd = options.gitContext.cwd;
		detectRemoteDefaultCompareTarget(gitCwd, sessionVcsType).then(
			async (remote) => {
				if (remote && !baseEverSwitched && currentBase !== remote) {
					const localName = remote.replace(/^origin\//, "");
					if (!options.initialBaseExplicit && (!options.initialBase || currentBase === localName)) {
						try {
							const rebuilt = await runVcsDiff(
								currentDiffType as DiffType,
								remote,
								gitCwd,
								{ hideWhitespace: currentHideWhitespace, captureFileIdentities: true },
							);
							const rebuiltDraftTarget = await captureDraftTarget(remote);
							if (!baseEverSwitched) {
								currentBase = remote;
								currentPatch = rebuilt.patch;
								currentFileIdentities = rebuilt.fileIdentities;
								currentGitRef = rebuilt.label;
								currentError = rebuilt.error;
								draftKey = contentHash(currentPatch);
								captureDiffFingerprint(undefined, rebuiltDraftTarget);
							}
						} catch {
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

	let serverUrl = "";
	let agentApiUrl = "";
	function activeReviewTarget(): string | undefined {
		if (isPRMode) return prMeta?.url;
		if (isStaticPatchMode) return undefined;
		if (workspace) return workspace.root;
		return resolveVcsCwd(currentDiffType as DiffType, options.gitContext?.cwd) ?? options.gitContext?.cwd ?? undefined;
	}
	function resolveAgentCwd(): string {
		if (workspace) return workspace.root;
		if (options.worktreePool && prMeta) {
			const poolPath = options.worktreePool.resolve(prMeta.url);
			if (poolPath) return poolPath;
		}
		if (options.agentCwd) return options.agentCwd;
		return resolveVcsCwd(currentDiffType as DiffType, options.gitContext?.cwd) ?? process.cwd();
	}
	function resolvePRLocalCwd(): string | null {
		const pool = options.worktreePool;
		if (pool && prMeta) {
			const r = resolvePoolCwd(pool, prMeta.url);
			if (r.kind === "ready") return r.path;
			if (r.kind === "pending") return null;
		}
		return options.agentCwd && existsSync(options.agentCwd) ? options.agentCwd : null;
	}
	async function ensurePRCallFlowCwd(): Promise<string | null> {
		if (options.worktreePool && prMeta) {
			try {
				return (await options.worktreePool.ensure(reviewRuntime, prMeta)).path;
			} catch {
				return null;
			}
		}
		return resolvePRLocalCwd();
	}
	function resolveOpenInRoot(): string | string[] {
		if (workspace) return workspace.root;
		if (options.worktreePool && prMeta) return resolvePRLocalCwd() ?? [];
		return options.agentCwd ?? resolveVcsCwd(currentDiffType as DiffType, options.gitContext?.cwd) ?? process.cwd();
	}
	function getWorkspacePromptContext(): WorkspaceReviewPromptContext | undefined {
		if (!workspace) return undefined;
		return workspace.getPromptContext();
	}

	let currentContextRevision = getGitButlerContextRevision(clientGitContext) ?? "";

	function currentSnapshotId(): string {
		return `${draftKey}:${currentDiffType}${isPRMode ? `:${currentPRDiffScope}` : ""}${currentContextRevision ? `:${currentContextRevision}` : ""}${currentFileIdentities ? `:${contentHash(JSON.stringify(currentFileIdentities))}` : ""}`;
	}

	const feedbackProject = (): string =>
		options.project?.trim()
			? options.project
			: deriveFeedbackProject(options.gitContext?.cwd ?? options.agentCwd ?? process.cwd());

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
		const cwd = options.gitContext?.cwd ?? options.agentCwd;
		if (cwd) target.cwd = cwd;
		if (prMeta) {
			target.pr = {
				provider: prMeta.platform,
				repo: getDisplayRepo(prMeta),
				number: getPRNumber(prMeta),
			};
		}
		return target;
	};

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
			origin: options.origin ?? "pi",
			surface: "review",
			decision,
			target: { review: feedbackReviewTarget() },
			feedback: feedbackText,
			annotations: annotationList,
		});
		return written !== null || !hasContent;
	};

	function buildCurrentAiReviewContext(
		patch: string = currentPatch,
		base: string = currentBase,
		diffType: DiffType = currentDiffType as DiffType,
	): string | undefined {
		if (!aiEnabled) return undefined;
		const workspacePrompt = getWorkspacePromptContext();
		if (workspacePrompt) {
			return buildAgentReviewUserMessageForTarget(
				{ kind: "workspace", patch, workspace: workspacePrompt },
				true,
			);
		}
		const hasLocalAccess = !!options.gitContext ||
			(options.worktreePool && prMeta ? resolvePRLocalCwd() !== null : !!options.agentCwd);
		return buildAgentReviewUserMessage(
			patch,
			diffType,
			{ defaultBranch: base, hasLocalAccess, prDiffScope: currentPRDiffScope },
			prMeta,
			true,
		);
	}
	const tour = createTourSession();
	const guide = createGuideSession();
	const guideStore = createGuideStoreSession({
		runGit: async (args, cwd) => {
			const result = await reviewRuntime.runGit(args, { cwd });
			return result.exitCode === 0 ? result.stdout : null;
		},
		getGitCwd: () =>
			isPRMode || isWorkspaceMode
				? undefined
				: options.gitContext
					? resolveVcsCwd(currentDiffType as DiffType, options.gitContext.cwd) ?? options.gitContext.cwd ?? process.cwd()
					: undefined,
		getPRInfo: () =>
			prMeta
				? {
						url: prMeta.url,
						headSha: prMeta.headSha,
						label: `${getMRLabel(prMeta)} ${getMRNumberLabel(prMeta)}`,
					}
				: null,
		getBranchLabel: () => clientGitContext?.currentBranch || options.gitContext?.currentBranch,
		getFallbackDir: () => workspace?.root ?? options.agentCwd ?? process.cwd(),
		writesEnabled: () => resolveGuideHistory(loadConfig()),
	});

	const guideSaveJob = (job: AgentJobInfo) => ({
		id: job.id,
		engine: job.engine,
		model: job.model,
		generatedAt: job.endedAt ?? Date.now(),
	});

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
	const semanticDiffScratchCwd = getSemanticDiffScratchCwd();
	function resolveSemanticDiffCwd(diffType: DiffType = currentDiffType as DiffType): string {
		if (workspace) return workspace.root;
		if (options.worktreePool && prMeta) {
			const poolPath = options.worktreePool.resolve(prMeta.url);
			if (poolPath) return poolPath;
		}
		if (options.agentCwd) return options.agentCwd;
		if (options.gitContext) {
			const vcsCwd = resolveVcsCwd(diffType, options.gitContext.cwd);
			if (vcsCwd) return vcsCwd;
			if (options.gitContext.cwd) return options.gitContext.cwd;
		}
		return semanticDiffScratchCwd;
	}
	const semanticDiffCache = new SemanticDiffResponseCache();
	const semanticDiffAvailabilityCache = new Map<string, Promise<SemanticDiffAvailability>>();

	const semanticDiffEnabled = (): boolean => loadConfig().reviewAnalysis?.semanticDiff !== false;
	const callFlowEnabled = (): boolean => loadConfig().reviewAnalysis?.callFlow === true;

	function createSemanticDiffRuntime(cwd: string) {
		return {
			...createDefaultSemanticDiffRuntime(),
			cwd,
		};
	}

	function getSemanticDiffAvailabilityForCwd(cwd: string): Promise<SemanticDiffAvailability> {
		const cached = semanticDiffAvailabilityCache.get(cwd);
		if (cached) return cached;

		const next: Promise<SemanticDiffAvailability> = getSemanticDiffAvailability(createSemanticDiffRuntime(cwd)).catch((error) => ({
			available: false,
			reason: "sem-probe-failed",
			message: error instanceof Error ? error.message : String(error),
		}));
		semanticDiffAvailabilityCache.set(cwd, next);
		return next;
	}

	async function getSemanticDiffAdvert(
		diffType: DiffType = currentDiffType as DiffType,
		enabled = semanticDiffEnabled(),
	) {
		if (!enabled) return { available: false, enabled: false };
		if (isGitButlerCommittedView(diffType)) return { available: false };
		const availability = await getSemanticDiffAvailabilityForCwd(resolveSemanticDiffCwd(diffType));
		return {
			available: availability.available,
			...(availability.semVersion ? { semVersion: availability.semVersion } : {}),
			...(availability.semSource ? { semSource: availability.semSource } : {}),
		};
	}

	async function getSemanticDiff(url: URL): Promise<SemanticDiffResponse> {
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
			semanticDiffCache.setFailure(cacheKey, currentPatch, result);
		}
		return result;
	}

	function getCallFlowAdvert(
		diffType: DiffType = currentDiffType as DiffType,
		enabled = callFlowEnabled(),
	) {
		return callFlowService.getAdvert(enabled, {
			snapshotSupported: !workspace && (isPRMode || vcsSupportsSnapshot(sessionVcsType ?? "git", diffType)),
			rawPatch: currentPatch,
		});
	}

	async function getCallFlow(url: URL): Promise<CallFlowResponse> {
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
		if (isPRMode && prMeta) {
			if (currentPRDiffScope === "layer" && layerPatchIncomplete) {
				return { status: "unsupported", reason: "incomplete-patch", message: "Call flow is unavailable until the complete PR layer diff is available locally." };
			}
			analysisCwd = await ensurePRCallFlowCwd() ?? undefined;
			if (!analysisCwd) {
				return { status: "unavailable", reason: "checkout-unavailable", message: "Call flow needs a local PR checkout, which is not ready." };
			}
			if (currentPRDiffScope === "full-stack" && prMeta.defaultBranch) {
				const baseRef = await resolvePRFullStackBaseRef(reviewRuntime, prMeta.defaultBranch, analysisCwd);
				if (!baseRef) return { status: "unavailable", reason: "base-unavailable", message: "The full-stack base commit is unavailable locally." };
				analysisDiffType = "merge-base";
				analysisBase = baseRef;
			} else {
				prCommitPair = { from: prMeta.mergeBaseSha ?? prMeta.baseSha, to: prMeta.headSha };
			}
		} else {
			analysisCwd = resolveVcsCwd(currentDiffType as DiffType, options.gitContext?.cwd)
				?? options.gitContext?.cwd
				?? options.agentCwd
				?? process.cwd();
		}
		if (!analysisCwd) return { status: "unavailable", reason: "checkout-unavailable", message: "Call flow requires a local Git checkout." };

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
					...(prCommitPair ? { prCommitPair } : {}),
					signal,
				}),
			},
			verifySnapshot: async () => {
				const after = await computeDiffFingerprint();
				return requestedSnapshot === currentSnapshotId() && !(before && after && before !== after);
			},
		});
	}

	const agentJobs = createAgentJobHandler({
		mode: "review",
		getServerUrl: () => agentApiUrl,
		getCwd: resolveAgentCwd,
		getServerSession: () => serverSession,

		async buildCommand(provider, config) {
			const launchPrMeta = prMeta;
			const launchPatch = currentPatch;
			const launchDiffType = currentDiffType;
			const launchBase = currentBase;
			const launchScope = currentPRDiffScope;
			const launchGitRef = currentGitRef;
			const launchSnapshotId = currentSnapshotId();
			const launchWorkspacePrompt = getWorkspacePromptContext();
			const launchLayerPatchIncomplete = layerPatchIncomplete;
			if (options.worktreePool && launchPrMeta && !options.worktreePool.resolve(launchPrMeta.url)) {
				throw new Error(
					"Local PR checkout unavailable — the agent can't run against the PR files. Retry shortly (the checkout may still be recovering).",
				);
			}
			const cwd = resolveAgentCwd();
			const workspacePrompt = launchWorkspacePrompt;
			const hasAgentLocalAccess = !!workspacePrompt || !!options.worktreePool || !!options.agentCwd || !!options.gitContext;
			const userMessageOptions = {
				defaultBranch: launchBase,
				hasLocalAccess: hasAgentLocalAccess,
				prDiffScope: launchScope,
				...(workspacePrompt && { workspace: workspacePrompt }),
			};

			const worktreeParts = String(launchDiffType).startsWith("worktree:")
				? parseWorktreeDiffType(launchDiffType as DiffType)
				: null;
			const launchPrUrl = launchPrMeta?.url;
			const launchDiffScope = isPRMode ? launchScope : undefined;

			const requestedProfileId =
				typeof config?.reviewProfileId === "string" ? config.reviewProfileId : undefined;
			const reviewProfile = resolveRequestedReviewProfile(requestedProfileId);

			const diffContext: AgentJobInfo["diffContext"] | undefined = workspacePrompt
				? { mode: String(launchDiffType), worktreePath: null }
				: launchPrMeta
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
					prMetadata: launchPrMeta,
					config,
				});
				return built ? { ...built, prUrl: launchPrUrl, diffScope: launchDiffScope, diffContext, reviewProfileId: reviewProfile.id, reviewProfileLabel: reviewProfile.label } : built;
			}

			if (provider === "guide") {
				const launchPRDiffScope = launchScope;

				let changedFiles = listPatchFiles(launchPatch);
				if (launchLayerPatchIncomplete && launchPRDiffScope !== "full-stack" && launchPrMeta?.baseBranch) {
					const localCwd = resolvePRLocalCwd();
					if (localCwd) {
						try {
							const res = await reviewRuntime.runGit(
								["diff", "--numstat", `origin/${launchPrMeta.baseBranch}...HEAD`],
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
					const failedEngine = typeof config?.engine === "string" && config.engine ? config.engine : undefined;
					const failedMarker = failedEngine ? MARKER_ENGINES[failedEngine as MarkerEngineId] : undefined;
					const failedEngineInstalled = failedMarker
						? !!(await resolveMarkerBinary(failedMarker, whichPath))
						: !!failedEngine && commandExists(failedEngine);
					const repairEngine =
						failedEngine && failedEngineInstalled
							? failedEngine
							: commandExists("claude")
								? "claude"
								: commandExists("codex")
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
					prMetadata: launchPrMeta,
					changedFiles,
					config: guideConfig,
					...(repair && { repair }),
				});
				const changedFilesSnapshot = repairOf
					? guide.getLaunchChangedFiles(repairOf) ?? changedFiles.map((f) => f.path)
					: changedFiles.map((f) => f.path);
				const guideContext = (repairOf ? agentJobs.getJob(repairOf)?.guideContext : undefined)
					?? await guideStore.captureLaunchContext();
				const commitSha = commitFamilyId(String(launchDiffType)) ?? undefined;
				const launchSource: GuideSnapshotSource = workspacePrompt
					? { kind: "workspace", ...(repoInfo?.display && { repo: repoInfo.display }) }
					: launchPrMeta
						? {
								kind: "pr",
								repo: getDisplayRepo(launchPrMeta),
								branch: launchPrMeta.headBranch,
								headSha: launchPrMeta.headSha,
								pr: {
									url: launchPrMeta.url,
									number: getPRNumber(launchPrMeta),
									title: launchPrMeta.title,
									...(launchPrMeta.platform === "github" || launchPrMeta.platform === "gitlab"
										? { platform: launchPrMeta.platform }
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

			const isCustomReview = reviewProfile.source === "user";
			const userMessage = workspacePrompt
				? buildAgentReviewUserMessageForTarget({
						kind: "workspace",
						patch: launchPatch,
						workspace: workspacePrompt,
					}, isCustomReview)
				: buildAgentReviewUserMessage(launchPatch, launchDiffType as DiffType, userMessageOptions, launchPrMeta, isCustomReview);
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

			const markerEngine = MARKER_ENGINES[provider as MarkerEngineId];
			if (markerEngine) {
				const model = typeof config?.model === "string" && config.model ? config.model : undefined;
				const thinking = typeof config?.thinking === "string" && config.thinking ? config.thinking : undefined;
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
					markJobReviewFailed(job, REVIEW_OUTPUT_FAILED);
					return;
				}

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

			const markerEngine = MARKER_ENGINES[job.provider as MarkerEngineId];
			if (markerEngine) {
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
					job.status = "failed";
					job.error = TOUR_EMPTY_OUTPUT_ERROR;
				}
				return;
			}

			if (job.provider === "guide") {
				const changedFiles = meta.changedFilesSnapshot ?? listPatchFiles(currentPatch).map((f) => f.path);
				const { summary, error } = await guide.onJobComplete({ job, meta, changedFiles, launchReview: meta.launchReview });
				if (summary) {
					job.summary = summary;
					const validated = guide.getGuide(job.id);
					if (validated) await guideStore.saveForJob(guideSaveJob(job), validated, job.guideContext, meta.launchReview);
				} else {
					job.status = "failed";
					job.error = error ?? GUIDE_EMPTY_OUTPUT_ERROR;
				}
				return;
			}
		},
	});
	const sharingEnabled =
		options.sharingEnabled ?? resolveSharingEnabled(loadConfig());
	const approvalNotesSupported = options.approvalNotesSupported === true;
	const serverSession = createServerSessionNonce();
	const refCards = createPiRefCards(options.refRunner);
	const isStaticPatchMode = options.diffType === STATIC_PATCH_DIFF_TYPE;
	const imagePreviewSupported = !isStaticPatchMode;
	const runImageRead = createConcurrencyLimiter(REVIEW_IMAGE_READ_CONCURRENCY);
	const markdownPreviewSupported = !isStaticPatchMode;
	const repoFilesSupported = !isStaticPatchMode && sessionVcsType !== "p4";
	const repoFilesUnavailable = (): RepoFilesUnavailable | null => {
		if (isStaticPatchMode) return { reason: "static-patch", message: "A patch file has no repository to list." };
		if (sessionVcsType === "p4") return { reason: "unsupported", message: "All files is not available for Perforce reviews." };
		if (!isPRMode && !workspace && !hasLocalAccess) {
			return { reason: "unsupported", message: "This review has no repository to list." };
		}
		return null;
	};
	const prListingCwd = async (): Promise<string | "pending" | null> => {
		const pool = options.worktreePool;
		if (pool && prMeta) {
			const entry = pool.get(prMeta.url);
			if (entry?.ready) return entry.path;
			if (prRef) return "pending";
		}
		return ensurePRCallFlowCwd();
	};
	const loadRepoListing = async (): Promise<RepoFileListing | null> => {
		const prCwd = isPRMode && prMeta && !workspace ? await prListingCwd() : null;
		const source = prCwd === "pending" ? "platform" : "local";
		return repoListing.get(`${currentSnapshotId()}:${source}`, async () => {
			if (workspace) return workspace.listFiles();
			if (isPRMode && prMeta) {
				const meta = prMeta;
				if (prCwd && prCwd !== "pending") return listGitSideFiles(reviewRuntime, { kind: "commit", rev: meta.headSha, cwd: prCwd });
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
			return listVcsFiles(currentDiffType as DiffType, currentBase, options.gitContext?.cwd);
		});
	};
	const readListedRepoFile = async (path: string, maxBytes: number): Promise<RepoFileRead> => {
		if (workspace) return workspace.getFileBytes(path, undefined, "new", maxBytes);
		if (isPRMode && prMeta) {
			const prCwd = await prListingCwd();
			if (prCwd && prCwd !== "pending") return readDiffSideBytes(reviewRuntime, { kind: "object", rev: prMeta.headSha, path }, maxBytes, prCwd);
			if (!prRef) return { kind: "unavailable" };
			return fetchPRFileBytes(prRef, prMeta.headSha, path, maxBytes);
		}
		return getVcsFileBytesForDiff(currentDiffType as DiffType, currentBase, path, undefined, "new", maxBytes, options.gitContext?.cwd);
	};
	const diagramEngineAssets = createDiagramEngineAssets(options.diagramEngine);
	diagramEngineAssets.warm();
	const readReviewSide = async (
		side: DiffSide,
		filePath: string,
		oldPath: string | undefined,
		maxBytes: number,
		signal?: AbortSignal,
		requestedBase?: string,
	): Promise<FileBytesRead> => {
		if (workspace) return workspace.getFileBytes(filePath, oldPath, side, maxBytes);
		const prCwd = (options.worktreePool && prMeta) ? options.worktreePool.resolve(prMeta.url) : options.agentCwd;
		if (isPRMode && currentPRDiffScope === "full-stack" && prCwd && prMeta?.defaultBranch) {
			const baseRef = await resolvePRFullStackBaseRef(reviewRuntime, prMeta.defaultBranch, prCwd);
			if (!baseRef) return { kind: "missing" };
			return getFileBytesForDiffCore(reviewRuntime, "merge-base", baseRef, filePath, oldPath, side, maxBytes, prCwd);
		}
		if (hasLocalAccess && !isPRMode) {
			return getVcsFileBytesForDiff(
				currentDiffType as DiffType,
				requestedBase !== undefined ? resolveReviewBase(requestedBase) : currentBase,
				filePath,
				oldPath,
				side,
				maxBytes,
				options.gitContext?.cwd,
			);
		}
		if (isPRMode && prMeta && prRef) {
			const ref = prRef;
			return readPRImageSide({
				gitRuntime: reviewRuntime,
				poolCwd: prCwd,
				oldSha: prMeta.mergeBaseSha ?? prMeta.baseSha,
				headSha: prMeta.headSha,
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
	const sourceKindAdvert = isStaticPatchMode
		? ({ sourceKind: "patch" } as const)
		: ({} as Record<string, never>);
	const shareBaseUrl =
		(options.shareBaseUrl ?? process.env.PLANNOTATOR_SHARE_URL) || undefined;
	const pasteApiUrl =
		(options.pasteApiUrl ?? process.env.PLANNOTATOR_PASTE_URL) || undefined;
	let reviewDecided = false;
	let resolveDecision!: (result: {
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
	}>((r) => {
		resolveDecision = (result) => {
			reviewDecided = true;
			const target = result.target ?? activeReviewTarget();
			r(target ? { ...result, target } : result);
		};
	});

	const reviewAlreadyDecided = (res: import("node:http").ServerResponse) =>
		json(res, { error: "This review session has already been decided.", code: "already_decided" }, 409);

	const hostControlToken = resolveHostControlToken(options.hostControlToken);
	const unsentReviewComments = (): number => {
		const loaded = reviewDrafts.load(currentDraftKeys());
		return loaded.found ? countUnsentDraftComments(loaded.draft) : 0;
	};
	const hostControl: HostControl = {
		status: () => ({
			kind: "review",
			documents: isPRMode && prMeta ? [prMeta.url] : [],
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

	let boundPort: number | undefined;
	const aiRuntime = aiEnabled ? await createPiAIRuntime({ getCwd: resolveAgentCwd, sessionBridge: options.sessionBridge, getServerPort: () => boundPort }) : null;

	const readDiffFileContents = async (
		filePath: string,
		oldPath: string | undefined,
		requestedBase: string | undefined,
	): Promise<{ oldContent: string | null; newContent: string | null } | { error: string; status: number }> => {
		if (isBinaryPatchFile(currentPatch, filePath)) {
			return { oldContent: null, newContent: null };
		}

		if (workspace) {
			try {
				return await workspace.getFileContents(filePath, oldPath);
			} catch (error) {
				return { error: error instanceof Error ? error.message : "No file access available", status: 400 };
			}
		}

		const fileContentCwd = (options.worktreePool && prMeta) ? options.worktreePool.resolve(prMeta.url) : options.agentCwd;
		if (
			isPRMode &&
			currentPRDiffScope === "full-stack" &&
			fileContentCwd &&
			prMeta?.defaultBranch
		) {
			const baseRef = await resolvePRFullStackBaseRef(
				reviewRuntime,
				prMeta.defaultBranch,
				fileContentCwd,
			);
			if (!baseRef) return { oldContent: null, newContent: null };
			return getFileContentsForDiffCore(
				reviewRuntime,
				"merge-base",
				baseRef,
				filePath,
				oldPath,
				fileContentCwd,
			);
		}

		if (hasLocalAccess && !isPRMode) {
			const base = resolveReviewBase(requestedBase);
			const defaultCwd = options.gitContext?.cwd;
			return getVcsFileContentsForDiff(
				currentDiffType as DiffType,
				base,
				filePath,
				oldPath,
				defaultCwd,
			);
		}

		if (isPRMode && prRef && prMeta) {
			try {
				const oldSha = prMeta.mergeBaseSha ?? prMeta.baseSha;
				const [oldContent, newContent] = await Promise.all([
					fetchPRFileContent(prRef, oldSha, oldPath || filePath),
					fetchPRFileContent(prRef, prMeta.headSha, filePath),
				]);
				return { oldContent, newContent };
			} catch (err) {
				return { error: err instanceof Error ? err.message : "Failed to fetch file content", status: 500 };
			}
		}

		return { error: "No file access available", status: 400 };
	};

	let packageRepoRoot: { cwd: string | undefined; root: Promise<string | null> } | null = null;
	const packageChanges = createPackageChangesService({
		snapshotId: () => currentSnapshotId(),
		diffFiles: () => parseDiffToFiles(currentPatch),
		readSide: async (side, path, oldPath, base) => {
			try {
				validateFilePath(path);
				if (oldPath) validateFilePath(oldPath);
			} catch {
				return { kind: "unreadable", reason: "invalid path" };
			}
			const read = await readReviewSide(side, path, oldPath, MAX_PACKAGE_FILE_BYTES, undefined, base);
			if (read.kind === "ok") return { kind: "ok", text: new TextDecoder().decode(read.bytes) };
			if (read.kind === "missing") return { kind: "missing" };
			if (read.kind === "too-large") return { kind: "unreadable", reason: "too large" };
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
						return target ? dirnamePath(joinPath(target.repo.cwd, target.repoRelativePath)) : null;
					},
				};
			}
			if (isPRMode) {
				if (!prMeta || !prRef) return { kind: "none" };
				const ref = prRef;
				return prSettingsSource({
					git: reviewRuntime,
					checkout: options.worktreePool ? options.worktreePool.resolve(prMeta.url) : options.agentCwd,
					headSha: prMeta.headSha,
					fetchBytes: (sha, path, max) => fetchPRFileBytes(ref, sha, path, max),
				});
			}
			if (!hasLocalAccess || isStaticPatchMode) return { kind: "none" };
			return {
				kind: "local",
				dirOf: async (path) => {
					const cwd = resolveVcsCwd(currentDiffType as DiffType, options.gitContext?.cwd) ?? options.gitContext?.cwd;
					if (!packageRepoRoot || packageRepoRoot.cwd !== cwd) {
						const known = cwd === options.gitContext?.cwd ? options.gitContext?.root : undefined;
						packageRepoRoot = {
							cwd,
							root: known
								? Promise.resolve(known)
								: reviewRuntime.runGit(["rev-parse", "--show-toplevel"], { cwd })
									.then((r) => (r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : null))
									.catch(() => null),
						};
					}
					const root = await packageRepoRoot.root;
					return root ? dirnamePath(joinPath(root, path)) : null;
				},
			};
		},
		homeDir: () => {
			try {
				return os.homedir();
			} catch {
				return null;
			}
		},
		prepare: async () => {
			if (!isPRMode || !prMeta) return { final: true };
			const meta = prMeta;
			const pool = options.worktreePool;
			let checkout = pool ? pool.resolve(meta.url) : options.agentCwd;
			let final = true;
			if (!checkout && pool) {
				const waited = await waitAtMost(
					pool.ensure(reviewRuntime, meta).then((entry) => entry.path, () => undefined),
					PACKAGE_CHECKOUT_WAIT_MS,
				);
				if (waited.timedOut) final = false;
				else checkout = waited.value;
			}
			if (checkout) return { final };
			return { final, remote: { key: `${meta.mergeBaseSha ?? meta.baseSha}:${meta.headSha}`, budget: REMOTE_PACKAGE_READS } };
		},
		lookupEnabled: () => resolvePackageLookup(loadConfig()),
		env: process.env,
	});

	const app = openPackedApp(options.htmlContent);
	const requestHostGuard = createRequestHostGuard();
	const server = createServer(async (req, res) => {
		if (requestHostGuard.refuse(req, res)) return;
		if (refuseCrossOriginWrite(req, res)) return;
		const url = requestUrl(req);

		if (handleHostControl(req, res, url, { token: hostControlToken, getServerPort: () => boundPort, control: hostControl })) return;
		if (await handleRefCards(req, res, url, refCards, serverSession)) return;

		if (url.pathname.match(/^\/api\/tour\/[^/]+$/) && req.method === "GET") {
			const jobId = url.pathname.slice("/api/tour/".length);
			const result = tour.getTour(jobId);
			if (!result) {
				json(res, { error: "Tour not found" }, 404);
				return;
			}
			json(res, result);
			return;
		}

		const checklistMatch = url.pathname.match(/^\/api\/tour\/([^/]+)\/checklist$/);
		if (checklistMatch && req.method === "PUT") {
			const jobId = checklistMatch[1];
			try {
				const body = await parseBody(req) as { checked: boolean[] };
				if (Array.isArray(body.checked)) tour.saveChecklist(jobId, body.checked);
				json(res, { ok: true });
			} catch {
				json(res, { error: "Invalid JSON" }, 400);
			}
			return;
		}

		if (url.pathname.match(/^\/api\/guide\/[^/]+$/) && req.method === "GET") {
			const jobId = decodeURIComponent(url.pathname.slice("/api/guide/".length));
			if (jobId.startsWith(SAVED_GUIDE_ID_PREFIX)) {
				const saved = await guideStore.getSavedGuideData(jobId.slice(SAVED_GUIDE_ID_PREFIX.length));
				if (!saved) {
					json(res, { error: "Guide not found" }, 404);
					return;
				}
				json(res, saved);
				return;
			}
			const result = guide.getGuide(jobId);
			if (!result) {
				json(res, { error: "Guide not found" }, 404);
				return;
			}
			json(res, { ...result, ...(guideStore.isJobSaved(jobId) ? { saved: true } : {}) });
			return;
		}

		const reviewedMatch = url.pathname.match(/^\/api\/guide\/([^/]+)\/reviewed$/);
		if (reviewedMatch && req.method === "PUT") {
			const jobId = decodeURIComponent(reviewedMatch[1]);
			try {
				const body = await parseBody(req) as { reviewed: boolean[] };
				if (Array.isArray(body.reviewed)) {
					if (jobId.startsWith(SAVED_GUIDE_ID_PREFIX)) {
						const ok = await guideStore.updateSavedReviewed(jobId.slice(SAVED_GUIDE_ID_PREFIX.length), body.reviewed);
						if (!ok) {
							json(res, { error: "Guide not found" }, 404);
							return;
						}
					} else {
						guide.saveReviewed(jobId, body.reviewed);
						await guideStore.writeThroughReviewed(jobId, body.reviewed);
					}
				}
				json(res, { ok: true });
			} catch {
				json(res, { error: "Invalid JSON" }, 400);
			}
			return;
		}

		const guideExportMatch = url.pathname.match(/^\/api\/guide\/([^/]+)\/(export|export-info)$/);
		if (guideExportMatch && req.method === "GET") {
			const jobId = decodeURIComponent(guideExportMatch[1]);
			let snapshot: GuideSnapshot | null;
			let html: string;
			try {
				snapshot = await resolveGuideSnapshotForExport(jobId);
				if (!snapshot) {
					json(res, { error: "This guide cannot be exported: its diff was not retained." }, 404);
					return;
				}
				const viewer = resolveGuideViewerAssets(GUIDE_VIEWER_MANIFEST, { baseUrl: process.env.PLANNOTATOR_GUIDE_VIEWER_URL });
				html = createGuideHtml(snapshot, { viewer });
			} catch {
				json(res, { error: "internal error" }, 500);
				return;
			}
			const filename = guideExportFilename(snapshot.guide.title);
			if (guideExportMatch[2] === "export-info") {
				json(res, {
					bytes: Buffer.byteLength(html, "utf8"),
					filename,
					languages: detectGuideLanguages(snapshot.review.rawPatch),
				});
				return;
			}
			res.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Content-Disposition": `attachment; filename="${filename}"`,
				"Cache-Control": "no-store",
			});
			res.end(html);
			return;
		}

		const guideShareMatch = url.pathname.match(/^\/api\/guide\/([^/]+)\/(share|share-info)$/);
		if (guideShareMatch && guideShareMatch[2] === "share-info" && req.method === "GET") {
			const jobId = decodeURIComponent(guideShareMatch[1]);
			const config = loadConfig();
			const existing = (await guideStore.locateEnvelope(jobId))?.envelope.share;
			json(res, {
				enabled: resolveSharingEnabled(config),
				serviceUrl: resolveGuideShareUrl(config),
				...(existing ? { existing: { url: existing.url, createdAt: existing.createdAt } } : {}),
			});
			return;
		}
		if (guideShareMatch && guideShareMatch[2] === "share" && (req.method === "POST" || req.method === "DELETE")) {
			if (!callFlowInstallOriginAllowed(req.headers.origin ?? null, req.headers.host ?? "", req.headers["sec-fetch-site"])) {
				json(res, { error: "Cross-origin share requests are not allowed" }, 403);
				return;
			}
			const jobId = decodeURIComponent(guideShareMatch[1]);
			const config = loadConfig();
			const serviceUrl = resolveGuideShareUrl(config);
			if (req.method === "POST") {
				if (!resolveSharingEnabled(config)) {
					json(res, { error: "sharing disabled" }, 403);
					return;
				}
				let body: { public?: unknown; ttlSeconds?: unknown };
				try {
					const raw = await readBody(req);
					const parsed: unknown = raw.trim() === "" ? {} : JSON.parse(raw);
					if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
					body = parsed as { public?: unknown; ttlSeconds?: unknown };
				} catch {
					json(res, { error: "Invalid JSON" }, 400);
					return;
				}
				if (body.public !== undefined && typeof body.public !== "boolean") {
					json(res, { error: "public must be a boolean" }, 400);
					return;
				}
				if (body.ttlSeconds !== undefined && (typeof body.ttlSeconds !== "number" || !Number.isSafeInteger(body.ttlSeconds) || body.ttlSeconds <= 0)) {
					json(res, { error: "ttlSeconds must be a positive integer" }, 400);
					return;
				}
				const located = await guideStore.locateEnvelope(jobId);
				const existing = located?.envelope.share;
				if (existing) {
					json(res, { error: "This guide already has a share link. Remove it before creating another.", url: existing.url }, 409);
					return;
				}
				try {
					const snapshot = await resolveGuideSnapshotForExport(jobId);
					if (!snapshot) {
						json(res, { error: "This guide cannot be shared: its diff was not retained." }, 404);
						return;
					}
					const shared = await shareGuide(snapshot, {
						serviceUrl,
						mode: body.public === true ? "plain" : "encrypted",
						...(body.ttlSeconds !== undefined ? { ttlSeconds: body.ttlSeconds } : {}),
						viewer: GUIDE_VIEWER_MANIFEST,
					});
					const recorded = located
						? updateGuideShare(located.repoKey, located.id, {
								id: shared.id,
								url: shared.url,
								createdAt: new Date().toISOString(),
								deleteToken: shared.deleteToken,
								serviceUrl,
							})
						: false;
					json(res, { ...shared, recorded });
				} catch (e) {
					json(res, { error: e instanceof GuideShareError ? e.message : "internal error" }, e instanceof GuideShareError ? 502 : 500);
				}
				return;
			}
			const located = await guideStore.locateEnvelope(jobId);
			const record = located?.envelope.share;
			if (!located || !record) {
				json(res, { error: "No share link for this guide" }, 404);
				return;
			}
			try {
				await unshareGuide(record.id, record.deleteToken, { serviceUrl: record.serviceUrl });
			} catch (e) {
				if (!(e instanceof GuideShareError && e.status === 404)) {
					json(res, { error: e instanceof GuideShareError ? e.message : "internal error" }, e instanceof GuideShareError ? 502 : 500);
					return;
				}
			}
			updateGuideShare(located.repoKey, located.id, null);
			res.writeHead(204);
			res.end();
			return;
		}

		if (url.pathname === "/api/guides" && req.method === "GET") {
			json(res, await guideStore.listSaved());
			return;
		}

		const savedGuideDeleteMatch = url.pathname.match(/^\/api\/guides\/([^/]+)$/);
		if (savedGuideDeleteMatch && req.method === "DELETE") {
			const savedId = decodeURIComponent(savedGuideDeleteMatch[1]);
			await unshareBeforeDelete((await guideStore.locateEnvelope(`${SAVED_GUIDE_ID_PREFIX}${savedId}`))?.envelope.share);
			const ok = await guideStore.deleteSaved(savedId);
			if (!ok) {
				json(res, { error: "Guide not found" }, 404);
				return;
			}
			json(res, { ok: true });
			return;
		}

		const guideOutputMatch = url.pathname.match(/^\/api\/guide\/([^/]+)\/output$/);
		if (guideOutputMatch && req.method === "GET") {
			const jobId = guideOutputMatch[1];
			const payload = guide.getFailedPayload(jobId);
			if (payload === null) {
				json(res, { error: "No captured output" }, 404);
				return;
			}
			json(res, { payload });
			return;
		}

		const guideSubmitMatch = url.pathname.match(/^\/api\/guide\/([^/]+)\/submit$/);
		if (guideSubmitMatch && req.method === "POST") {
			const jobId = guideSubmitMatch[1];
			const existingJob = agentJobs.getJob(jobId);
			if (!existingJob) {
				json(res, { error: "Job not found" }, 404);
				return;
			}
			if (existingJob.status !== "failed" && existingJob.status !== "killed") {
				json(res, { error: "This job already has a guide" }, 409);
				return;
			}
			try {
				const body = await parseBody(req) as { payload?: string };
				const payload = typeof body.payload === "string" ? body.payload : "";
				const changedFiles = listPatchFiles(currentPatch).map((f) => f.path);
				const result = guide.submitManualOutput(jobId, payload, changedFiles);
				if ("error" in result) {
					json(res, { error: result.error }, 400);
					return;
				}
				const { sections, files } = result;
				agentJobs.completeJobExternally(jobId, {
					correctness: "Guide Generated",
					explanation: `${sections} section${sections !== 1 ? "s" : ""}, ${files} file${files !== 1 ? "s" : ""} placed (manually repaired)`,
					confidence: 1,
				});
				const repaired = guide.getGuide(jobId);
				if (repaired) await guideStore.saveForJob(guideSaveJob(existingJob), repaired, existingJob.guideContext, guide.getLaunchReview(jobId) ?? undefined);
				json(res, { ok: true, sections, files });
			} catch {
				json(res, { error: "Invalid JSON" }, 400);
			}
			return;
		}

		if (url.pathname === "/api/diff" && req.method === "GET") {
			maybeRefreshRemoteBaseInfo();
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
			json(res, {
				rawPatch: servedPatch,
				aiReviewContext: buildCurrentAiReviewContext(servedPatch, servedBase, servedDiffType as DiffType),
				aiEnabled,
				gitRef: servedGitRef,
				snapshotId: servedSnapshotId,
				localDraftTarget: servedDraftTarget,
				origin: options.origin ?? "pi",
				mode: isWorkspaceMode ? "workspace" : undefined,
				diffType: hasLocalAccess || isWorkspaceMode || isStaticPatchMode ? servedDiffType : undefined,
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
				...(options.openStatePinned && { openStatePinned: true }),
				shareBaseUrl,
				pasteApiUrl,
				repoInfo,
				isWSL: wslFlag,
				markdownExtensions: getExtraMarkdownExtensions(),
				...(isPRMode
					? { agentCwd: resolvePRLocalCwd() }
					: workspace
						? { agentCwd: workspace.root }
						: options.agentCwd
							? { agentCwd: options.agentCwd }
							: {}),
				...(isPRMode && {
					prMetadata: prMeta,
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
				serverConfig: getServerConfig(gitUser, currentPiHost(), { cookieHost: !isRemoteSession() }),
				...piUpdateAdvert(options.origin),
			});
		} else if (url.pathname === "/api/fetch-base" && req.method === "POST") {
			if (!gitRemoteSessionApplies()) {
				json(res, { error: "Not available in this mode" }, 400);
				return;
			}
			const branchRef =
				remoteDefaultInfo?.branch ??
				(currentBase.startsWith("origin/") ? currentBase : null);
			if (!branchRef) {
				json(res, { error: "No remote-tracking base to fetch" }, 400);
				return;
			}
			const branchName = branchRef.replace(/^origin\//, "");
			const result = await reviewRuntime.runGit(
				["fetch", "--end-of-options", "origin", branchName],
				{ cwd: options.gitContext?.cwd, timeoutMs: 30_000 },
			);
			if (result.exitCode !== 0) {
				json(res, { error: result.stderr.trim() || "git fetch failed" }, 500);
				return;
			}
			await refreshRemoteBaseInfo();
			json(res, { ok: true, baseBehindRemote });
		} else if (url.pathname === "/api/diff/fresh" && req.method === "GET") {
			const prCwdAdvert = isPRMode ? { agentCwd: resolvePRLocalCwd() } : {};
			const baseline = currentFingerprint;
			const behind = baseBehindRemote ? { baseBehindRemote: true } : {};
			const clientSnapshot = url.searchParams.get("snapshot");
			const serverSnapshot = currentSnapshotId();
			if (clientSnapshot && clientSnapshot !== serverSnapshot) {
				json(res, { fresh: false, fingerprint: `snapshot:${serverSnapshot}`, ...behind, ...prCwdAdvert });
				return;
			}
			if (baseline == null) {
				json(res, { fresh: true, ...behind, ...prCwdAdvert });
				return;
			}
			const probe = await computeDiffFingerprint();
			if (currentFingerprint !== baseline) {
				json(res, { fresh: true, ...behind, ...prCwdAdvert });
				return;
			}
			const fresh = probe == null || probe === baseline;
			json(res, {
				fresh,
				...(fresh ? {} : { fingerprint: probe }),
				...(baseBehindRemote && { baseBehindRemote: true }),
				...prCwdAdvert,
			});
		} else if (url.pathname === "/api/semantic-diff" && req.method === "GET") {
			json(res, await getSemanticDiff(url));
		} else if (url.pathname === "/api/call-flow" && req.method === "GET") {
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
			res.setHeader("Cache-Control", "no-store");
			json(res, result, result.status === "stale" ? 409 : 200);
		} else if (url.pathname === "/api/call-flow/install" && req.method === "POST") {
			if (!callFlowInstallOriginAllowed(req.headers.origin ?? null, req.headers.host ?? "", req.headers["sec-fetch-site"])) {
				json(res, { error: "Cross-origin install requests are not allowed" }, 403);
				return;
			}
			let installRequest: ReturnType<typeof parseCallFlowInstallRequest>;
			try {
				installRequest = parseCallFlowInstallRequest(await parseJsonBody(req));
			} catch {
				installRequest = null;
			}
			if (!installRequest) return json(res, { error: "Invalid call-flow install request" }, 400);
			const advert = await getCallFlowAdvert(currentDiffType as DiffType, true);
			const languageIds = resolveCallFlowInstallTargets(
				installRequest.languageIds,
				advert.installPlan?.languageIds,
				advert.available,
			);
			if (!advert.installable || languageIds.length === 0) {
				return json(res, { error: advert.message ?? "No call-flow language support needs installation." }, 409);
			}
			const status = await callFlowInstall.start(languageIds);
			res.setHeader("Cache-Control", "no-store");
			json(res, status);
		} else if (url.pathname === "/api/call-flow/install-status" && req.method === "GET") {
			res.setHeader("Cache-Control", "no-store");
			json(res, callFlowInstall.getStatus());
		} else if (url.pathname === "/api/review-analysis" && req.method === "GET") {
			if (reviewAnalysisMutationEpoch !== null) {
				res.setHeader("Cache-Control", "no-store");
				return json(res, { superseded: true });
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
				return json(res, { superseded: true });
			}
			res.setHeader("Cache-Control", "no-store");
			json(res, { semanticDiff, callFlow });
		} else if (url.pathname === "/api/review-analysis" && req.method === "POST") {
			const analysisEpoch = ++reviewAnalysisEpoch;
			reviewAnalysisMutationEpoch = analysisEpoch;
			const viewEpoch = diffSwitchEpoch;
			const scopeEpoch = prScopeEpoch;
			try {
				const reviewAnalysis = parseReviewAnalysisConfig(await parseBody(req));
				if (!reviewAnalysis) return json(res, { error: "Invalid analysis settings" }, 400);
				if (analysisEpoch !== reviewAnalysisEpoch) return json(res, { superseded: true });
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
					return json(res, { superseded: true });
				}
				if (!saveConfig({ reviewAnalysis })) return json(res, { error: "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it." }, 500);
				if (!nextCallFlowEnabled) callFlowService.cancelAll();
				json(res, { semanticDiff, callFlow });
			} catch {
				json(res, { error: "Invalid request" }, 400);
			} finally {
				if (reviewAnalysisEpoch === analysisEpoch) reviewAnalysisEpoch++;
				if (reviewAnalysisMutationEpoch === analysisEpoch) reviewAnalysisMutationEpoch = null;
			}
		} else if (url.pathname === "/api/commits" && req.method === "GET") {
			const commitsVcs = sessionVcsType ?? "git";
			if (!options.gitContext || isPRMode || workspace || (commitsVcs !== "git" && commitsVcs !== "jj")) {
				json(res, { error: "Commit history is only available for local git and jj reviews" }, 400);
				return;
			}
			const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
			const before = url.searchParams.get("before") ?? undefined;
			const commitsCwd = resolveVcsCwd(currentDiffType as DiffType, options.gitContext.cwd);
			const pageOptions = {
				...(Number.isFinite(limitParam) && { limit: limitParam }),
				...(before !== undefined && { before }),
			};
			let page;
			try {
				if (commitsVcs === "jj") {
					const railBase = resolveJjCommitRailBase(currentBase, clientGitContext ?? options.gitContext);
					page = await listJjCommitHistory(jjRuntime, railBase.target, commitsCwd, {
						...pageOptions,
						baseLabel: railBase.label,
					});
				} else {
					page = await listCommitHistory(reviewRuntime, currentBase, commitsCwd, pageOptions);
				}
			} catch (err) {
				json(res, { error: err instanceof Error ? err.message : "Could not read commit history" }, 500);
				return;
			}
			if (!page) {
				json(res, { error: "Could not read commit history" }, 500);
				return;
			}
			const avatars = await commitAvatars.resolve(
				commitsCwd,
				page.commits.map((c) => c.authorEmail),
			);
			for (const c of page.commits) {
				const avatarUrl = avatars.get(c.authorEmail);
				if (avatarUrl) c.avatarUrl = avatarUrl;
			}
			json(res, page);
		} else if (url.pathname === "/api/diff/switch" && req.method === "POST") {
			const switchEpoch = ++diffSwitchEpoch;
			maybeRefreshRemoteBaseInfo();
			if (!hasLocalAccess && !workspace) {
				json(res, { error: "Not available without local file access" }, 400);
				return;
			}
			try {
				const body = await parseBody(req);
				let newType = body.diffType as DiffType | WorkspaceDiffType;
				if (typeof newType !== "string" || !newType) {
					json(res, { error: "Missing diffType" }, 400);
					return;
				}
				const effectiveHideWhitespace = typeof body.hideWhitespace === "boolean"
					? body.hideWhitespace
					: currentHideWhitespace;
				if (workspace) {
					const snapshot = await workspace.rebuild({
						diffType: newType,
						hideWhitespace: effectiveHideWhitespace,
					});
					if (switchEpoch !== diffSwitchEpoch) {
						json(res, { superseded: true });
						return;
					}
					currentHideWhitespace = effectiveHideWhitespace;
					currentPatch = snapshot.rawPatch;
					currentFileIdentities = undefined;
					currentGitRef = snapshot.gitRef;
					currentDiffType = workspace.diffType;
					currentError = snapshot.error;
					draftKey = contentHash(currentPatch);
					captureDiffFingerprint();

					json(res, {
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
						...(currentError ? { error: currentError } : {}),
						semanticDiff: await getSemanticDiffAdvert(),
						callFlow: await getCallFlowAdvert(),
					});
					return;
				}
				if (sessionVcsType && !vcsOwnsDiffType(sessionVcsType, newType as string)) {
					json(res, { error: `Diff type is not available in this ${sessionVcsType} session` }, 400);
					return;
				}
				const nextBaseExplicitlyChosen = baseExplicitlyChosen ||
					(body.explicitBase === true && typeof body.base === "string" && !!body.base);
				const requestedDiffType = newType as DiffType;
				const availability = clientGitContext
					? resolveAvailableDiffType(clientGitContext, requestedDiffType, nextBaseExplicitlyChosen)
					: { diffType: requestedDiffType };
				newType = availability.diffType;
				if (sessionVcsType === "jj") {
					newType = await canonicalizeJjCommitDiffType(jjRuntime, newType as string, options.gitContext?.cwd) as DiffType;
				}
				const base = resolveReviewBase(
					typeof body.base === "string" ? body.base : undefined,
					nextBaseExplicitlyChosen,
					currentBase,
				);
				const defaultCwd = options.gitContext?.cwd;
				const result = await runVcsDiff(newType as DiffType, base, defaultCwd, {
					captureFileIdentities: sessionVcsType === "git",
					hideWhitespace: effectiveHideWhitespace,
				});
				const resultContext = sessionVcsType === "gitbutler" && result.gitContext?.vcsType === "gitbutler"
					? result.gitContext
					: undefined;
				const resultBase = resultContext?.defaultBranch ?? base;
				if (switchEpoch !== diffSwitchEpoch) {
					json(res, { superseded: true });
					return;
				}
				const previousDiffType = currentDiffType;

				let updatedContext = resultContext;
				let updatedContextRevision = resultContext
					? getGitButlerContextRevision(resultContext) ?? ""
					: undefined;
				if (!updatedContext && options.gitContext && !isSameCwdCommitSwitch(previousDiffType as string, newType as string)) {
					try {
						const effectiveCwd = resolveVcsCwd(newType as DiffType, options.gitContext.cwd);
						updatedContext = await getVcsContext(effectiveCwd, sessionVcsType);
						updatedContextRevision = getGitButlerContextRevision(updatedContext) ?? "";
					} catch {
					}
				}

				const nextBase = updatedContext && sessionVcsType === "gitbutler"
					? updatedContext.defaultBranch
					: resultBase;
				const nextBaseBehindRemote = await computeBaseBehindRemote(
					nextBase,
					newType as string,
					nextBaseExplicitlyChosen,
				).catch(() => false);
				const sections = await buildSectionsSidecar(nextBase, newType as string);
				const commitInfo = await buildCommitInfoSidecar(newType as string);
				const generatedFiles = await buildGeneratedFilesSidecar(result.patch, newType as string);
				const [switchSemanticDiff, switchCallFlow, nextDraftTarget] = await Promise.all([
					getSemanticDiffAdvert(newType as DiffType),
					getCallFlowAdvert(newType as DiffType),
					isPRMode ? null : localGitDraftTargetKey({
						diffType: newType, base: nextBase, cwd: options.gitContext?.cwd ?? process.cwd(),
						defaultBase: remoteCheckEnabled && !nextBaseExplicitlyChosen ? detectedCompareTarget() : undefined,
						vcsType: sessionVcsType,
					}, reviewRuntime.runGit),
				]);
				if (switchEpoch !== diffSwitchEpoch) {
					json(res, { superseded: true });
					return;
				}
				currentHideWhitespace = effectiveHideWhitespace;
				currentPatch = result.patch;
				currentFileIdentities = result.fileIdentities;
				currentGitRef = result.label;
				currentDiffType = newType;
				currentBase = nextBase;
				baseEverSwitched = true;
				baseExplicitlyChosen = nextBaseExplicitlyChosen;
				baseBehindRemote = nextBaseBehindRemote;
				currentError = result.error;
				draftKey = contentHash(currentPatch);
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
								effectiveDiffType: newType,
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
				json(res, {
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
					base: currentBase,
					hideWhitespace: currentHideWhitespace,
					...(sections ? { sections } : {}),
					...(commitInfo ? { commitInfo } : {}),
					...(generatedFiles ? { generatedFiles } : {}),
					...(baseBehindRemote ? { baseBehindRemote: true } : {}),
					...(updatedContext
						? {
							gitContext: {
								...updatedContext,
								diffFallback: clientGitContext?.diffFallback,
							},
						}
						: {}),
					...(currentError ? { error: currentError } : {}),
					semanticDiff: switchSemanticDiff,
					callFlow: switchCallFlow,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : "Failed to switch diff";
				json(res, { error: message }, 500);
			}
		} else if (url.pathname === "/api/pr-diff-scope" && req.method === "POST") {
			if (!isPRMode || !prMeta) {
				json(res, { error: "Not in PR mode" }, 400);
				return;
			}
			try {
				const body = await parseBody(req) as { scope?: PRDiffScope };
				if (body.scope !== "layer" && body.scope !== "full-stack") {
					json(res, { error: "Invalid PR diff scope" }, 400);
					return;
				}

				const scopeEpoch = ++prScopeEpoch;
				const respondSuperseded = async () => {
					const [semanticDiff, callFlow] = await Promise.all([
						getSemanticDiffAdvert(),
						getCallFlowAdvert(),
					]);
					json(res, {
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
						...(layerPatchIncomplete ? { prPatchIncomplete: true, prPatchUpgradeAvailable: layerUpgradeAvailable } : {}),
						...(currentError ? { error: currentError } : {}),
						semanticDiff,
						callFlow,
					});
				};

				if (body.scope === "layer") {
					const upgradeMeta = prMeta;
					let upgradeError: string | undefined;
					if (layerPatchIncomplete && options.worktreePool && upgradeMeta) {
						let upgradeCwd: string | undefined;
						try {
							upgradeCwd = (await options.worktreePool.ensure(reviewRuntime, upgradeMeta)).path;
						} catch {
							upgradeCwd = options.agentCwd && existsSync(options.agentCwd) ? options.agentCwd : undefined;
						}
						if (upgradeCwd && prMeta === upgradeMeta) {
							const result = await runPRLayerLocalDiff(reviewRuntime, upgradeMeta, upgradeCwd);
							if (prMeta === upgradeMeta) {
								if (!result.error) {
									originalPRPatch = result.patch;
									originalPRError = undefined;
									layerPatchIncomplete = false;
									prSwitchCache.set(upgradeMeta.url, {
										metadata: upgradeMeta,
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
					if (scopeEpoch !== prScopeEpoch) return respondSuperseded();
					currentPatch = originalPRPatch;
					currentFileIdentities = undefined;
					currentGitRef = originalPRGitRef;
					currentError = originalPRError;
					currentPRDiffScope = "layer";
					draftKey = contentHash(currentPatch);
					captureDiffFingerprint();
					json(res, {
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
						...(layerPatchIncomplete ? { prPatchIncomplete: true, prPatchUpgradeAvailable: layerUpgradeAvailable } : {}),
						...((currentError ?? upgradeError) ? { error: currentError ?? upgradeError } : {}),
						semanticDiff: await getSemanticDiffAdvert(),
						callFlow: await getCallFlowAdvert(),
					});
					return;
				}

				const fullStackOption = prDiffScopeOptions.find((option) => option.id === "full-stack");
				if (!fullStackOption?.enabled || !(options.worktreePool || options.agentCwd)) {
					json(res, { error: "Full stack diff requires a stacked PR and a local checkout" }, 400);
					return;
				}

				const fullStackCwd = (options.worktreePool && prMeta ? options.worktreePool.resolve(prMeta.url) : undefined) ?? options.agentCwd;
				const result = await runPRFullStackDiff(reviewRuntime, prMeta, fullStackCwd);

				if (result.error) {
					json(res, { error: result.error }, 400);
					return;
				}

				if (scopeEpoch !== prScopeEpoch) return respondSuperseded();
				currentPatch = result.patch;
				currentFileIdentities = undefined;
				currentGitRef = result.label;
				currentError = undefined;
				currentPRDiffScope = "full-stack";
				draftKey = contentHash(currentPatch);
				captureDiffFingerprint();
				json(res, {
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
				const message = err instanceof Error ? err.message : "Failed to switch PR diff scope";
				json(res, { error: message }, 500);
			}
		} else if (url.pathname === "/api/pr-switch" && req.method === "POST") {
			if (!isPRMode || !prRef) {
				return json(res, { error: "Not in PR mode" }, 400);
			}
			try {
				const body = (await parseBody(req)) as { url?: string };
				if (!body?.url) return json(res, { error: "Missing PR URL" }, 400);
				const newRef = parsePRUrl(body.url);
				if (!newRef) return json(res, { error: "Invalid PR URL" }, 400);
				if (!isSameProject(newRef, prRef!)) return json(res, { error: "Cannot switch to a PR in a different repository" }, 400);

				const cached = prSwitchCache.get(body.url);
				const pr = cached ?? await (options.prFetcher ?? fetchPR)(newRef);
				if (!cached) prSwitchCache.set(body.url, pr);
				prScopeEpoch++;
				prMeta = pr.metadata;
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
					} catch { prStackTree = null; }
					prStackTreeCache.set(body.url, prStackTree);
				}

				let hasLocalForNewPR = false;
				if (options.worktreePool) {
					try {
						await options.worktreePool.ensure(reviewRuntime, pr.metadata);
						hasLocalForNewPR = true;
					} catch {}
				} else if (options.agentCwd) {
					hasLocalForNewPR = await checkoutPRHead(reviewRuntime, pr.metadata, options.agentCwd);
				}

				prStackInfo = resolveStackInfo(pr.metadata, prStackTree, prStackInfo);

				prDiffScopeOptions = prStackInfo
					? getPRDiffScopeOptions(pr.metadata, hasLocalForNewPR)
					: [];

				let switchedViewedFiles: string[] = [];
				try {
					const viewedMap = await fetchPRViewedFiles(prRef);
					switchedViewedFiles = Object.entries(viewedMap)
						.filter(([, v]) => v).map(([p]) => p);
				} catch {}
				initialViewedFiles = switchedViewedFiles;

				repoInfo = {
					display: getDisplayRepo(pr.metadata),
					branch: `${getMRLabel(pr.metadata)} ${getMRNumberLabel(pr.metadata)}`,
				};

				return json(res, {
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
					agentCwd: resolvePRLocalCwd() ?? null,
					prStackInfo,
					prStackTree,
					prDiffScope: currentPRDiffScope,
					prDiffScopeOptions,
					...(layerPatchIncomplete ? { prPatchIncomplete: true, prPatchUpgradeAvailable: layerUpgradeAvailable } : {}),
					repoInfo,
					...(switchedViewedFiles.length > 0 && { viewedFiles: switchedViewedFiles }),
					...(currentError ? { error: currentError } : {}),
					semanticDiff: await getSemanticDiffAdvert(),
					callFlow: await getCallFlowAdvert(),
				});
			} catch (err) {
				return json(res, { error: err instanceof Error ? err.message : "Failed to switch PR" }, 500);
			}
		} else if (url.pathname === "/api/pr-list" && req.method === "GET") {
			if (!isPRMode || !prRef) {
				return json(res, { error: "Not in PR mode" }, 400);
			}
			try {
				const now = Date.now();
				if (prListCache && now - prListCacheTime < 30_000) {
					return json(res, { prs: prListCache });
				}
				const prs = await fetchPRList(prRef);
				prListCache = prs;
				prListCacheTime = now;
				return json(res, { prs });
			} catch {
				return json(res, { error: "Failed to fetch PR list" }, 500);
			}
		} else if (url.pathname === "/api/pr-context" && req.method === "GET") {
			if (!isPRMode || !prRef || !prMeta) {
				json(res, { error: "Not in PR mode" }, 400);
				return;
			}
			try {
				const context = await prContextLive.getContext(prMeta.url, prRef);
				json(res, context);
			} catch (err) {
				json(
					res,
					{
						error:
							err instanceof Error ? err.message : "Failed to fetch PR context",
					},
					500,
				);
			}
		} else if (url.pathname === "/api/pr-artifact-document" && req.method === "GET") {
			if (!isPRMode || !prRef || !prMeta) {
				json(res, { error: "Not in PR mode" }, 400);
				return;
			}
			const artifactUrl = url.searchParams.get("url");
			if (!artifactUrl) {
				json(res, { error: "Missing artifact URL" }, 400);
				return;
			}
			try {
				const context = await prContextLive.getContext(prMeta.url, prRef);
				const document = await fetchPRArtifactDocument(
					prCommandRuntime,
					prMeta,
					context,
					artifactUrl,
				);
				send(res, document.content, 200, {
					"Content-Type": "text/plain; charset=utf-8",
					"Cache-Control": "private, max-age=300",
					"Content-Security-Policy": "sandbox; default-src 'none'",
					"X-Content-Type-Options": "nosniff",
				});
			} catch (error) {
				const status = error instanceof PRArtifactDocumentError ? error.status : 500;
				const message = error instanceof Error ? error.message : "Failed to fetch artifact document";
				json(res, { error: message }, status);
			}
		} else if (url.pathname === "/api/pr-artifact-content" && req.method === "GET") {
			if (!isPRMode || !prRef || !prMeta) {
				json(res, { error: "Not in PR mode" }, 400);
				return;
			}
			const artifactUrl = url.searchParams.get("url");
			if (!artifactUrl) {
				json(res, { error: "Missing artifact URL" }, 400);
				return;
			}
			try {
				const context = await prContextLive.getContext(prMeta.url, prRef);
				const content = await fetchPRArtifactContent(
					prCommandRuntime,
					prMeta,
					context,
					artifactUrl,
					{
						sourceUrl: url.searchParams.get("source") ?? undefined,
						range: typeof req.headers.range === "string" ? req.headers.range : undefined,
					},
				);
				send(res, Buffer.from(content.content), content.status, {
					"Content-Type": content.contentType,
					"Cache-Control": "private, max-age=300",
					"Content-Security-Policy": "sandbox",
					"X-Content-Type-Options": "nosniff",
					"Content-Length": String(content.content.byteLength),
					...(content.contentRange ? { "Content-Range": content.contentRange } : {}),
					...(content.acceptRanges ? { "Accept-Ranges": content.acceptRanges } : {}),
				});
			} catch (error) {
				const status = error instanceof PRArtifactDocumentError ? error.status : 500;
				const message = error instanceof Error ? error.message : "Failed to fetch artifact content";
				json(res, { error: message }, status);
			}
		} else if (url.pathname === "/api/pr-action" && req.method === "POST") {
			if (!isPRMode || !prMeta || !prRef) {
				json(res, { error: "Not in PR mode" }, 400);
				return;
			}
			try {
				const body = await parseBody(req);
				if (checkServerSession(body, serverSession) === "mismatch") {
					json(res, serverSessionMismatchBody(), 409);
					return;
				}
				const action = parsePRReviewAction(body.action);
				if (!action) {
					json(res, { error: "action must be one of approve, comment, request_changes" }, 400);
					return;
				}
				const fileComments = (body.fileComments as PRReviewFileComment[]) || [];
				const fileLevelComments = parseFileLevelComments(body.fileLevelComments);
				const targetPrUrl = body.targetPrUrl as string | undefined;

				let targetRef = prRef;
				let targetHeadSha = prMeta.headSha;
				let targetUrl = prMeta.url;

				if (targetPrUrl) {
					const cached = prSwitchCache.get(targetPrUrl);
					if (!cached) {
						json(res, { error: "Target PR not found in session" }, 400);
						return;
					}
					targetRef = prRefFromMetadata(cached.metadata);
					targetHeadSha = cached.metadata.headSha;
					targetUrl = cached.metadata.url;
				} else if (currentPRDiffScope !== "layer") {
					json(res, { error: "Switch to Layer diff before posting a platform review" }, 400);
					return;
				}

				console.error(`[pr-action] ${action} with ${fileComments.length} line comment(s) and ${fileLevelComments.length} file-level comment(s), target=${targetUrl}, headSha=${targetHeadSha}`);
				const submission = await submitPlatformReview(
					targetRef,
					targetHeadSha,
					action,
					body.body as string,
					fileComments,
					fileLevelComments,
				);
				console.error(`[pr-action] ${submission.status === "complete" ? "Success" : "Partial success"}`);
				prContextLive.refreshAfterWrite(targetUrl, targetRef);
				json(res, { ok: true, prUrl: targetUrl, submission });
			} catch (err) {
				const message = err instanceof Error ? err.message : "Failed to submit PR review";
				console.error(`[pr-action] Failed: ${message}`);
				json(res, { error: message }, 500);
			}
		} else if (url.pathname === "/api/pr-viewed" && req.method === "POST") {
			if (!isPRMode || !prMeta || !prRef) {
				json(res, { error: "Not in PR mode" }, 400);
				return;
			}
			if (prMeta.platform !== "github") {
				json(res, { error: "Viewed sync only supported for GitHub" }, 400);
				return;
			}
			const prNodeId = prMeta.prNodeId;
			if (!prNodeId) {
				json(res, { error: "PR node ID not available" }, 400);
				return;
			}
			try {
				const body = await parseBody(req);
				await markPRFilesViewed(
					prRef,
					prNodeId,
					body.filePaths as string[],
					body.viewed as boolean,
				);
				json(res, { ok: true });
			} catch (err) {
				const message = err instanceof Error ? err.message : "Failed to update viewed state";
				console.error("[plannotator] /api/pr-viewed error:", message);
				json(res, { error: message }, 500);
			}
		} else if (url.pathname === REVIEW_MARKDOWN_IMAGE_ENDPOINT && req.method === "GET") {
			const requestAbort = new AbortController();
			res.on("close", () => {
				if (!res.writableEnded) requestAbort.abort();
			});
			const result = await handleReviewMarkdownImageRequest({
				params: url.searchParams,
				ifNoneMatch: typeof req.headers["if-none-match"] === "string" ? req.headers["if-none-match"] : null,
				available: imagePreviewSupported,
				patch: currentPatch,
				markdownExtensions: getExtraMarkdownExtensions(),
				isCurrentSnapshot: (snapshot) => snapshot === currentSnapshotId(),
				signal: requestAbort.signal,
				readSide: (side, filePath, oldPath, maxBytes, signal) =>
					runImageRead(() => readReviewSide(side, filePath, oldPath, maxBytes, signal), signal),
			});
			if (requestAbort.signal.aborted) return;
			res.writeHead(result.status, result.headers);
			res.end(result.body ?? undefined);
		} else if (url.pathname === REVIEW_IMAGE_ENDPOINT && req.method === "GET") {
			const requestAbort = new AbortController();
			res.on("close", () => {
				if (!res.writableEnded) requestAbort.abort();
			});
			const result = await handleReviewImageRequest({
				params: url.searchParams,
				ifNoneMatch: typeof req.headers["if-none-match"] === "string" ? req.headers["if-none-match"] : null,
				available: imagePreviewSupported,
				patch: currentPatch,
				isCurrentSnapshot: (snapshot) => snapshot === currentSnapshotId(),
				signal: requestAbort.signal,
				readSide: (side, filePath, oldPath, maxBytes, signal) =>
					runImageRead(() => readReviewSide(side, filePath, oldPath, maxBytes, signal), signal),
			});
			if (requestAbort.signal.aborted) return;
			res.writeHead(result.status, result.headers);
			res.end(result.body ?? undefined);
		} else if (url.pathname === REPO_FILES_ENDPOINT && req.method === "GET") {
			const result = await handleRepoFilesRequest({
				params: url.searchParams,
				unavailable: repoFilesUnavailable(),
				isCurrentSnapshot: (snapshot) => snapshot === currentSnapshotId(),
				loadListing: loadRepoListing,
				loadOnDisk: (listing) =>
					listing.root
						? findRepoOnDiskChanges(reviewRuntime, listing.root, diffFileStates(currentPatch), snapshotCapturedAt)
						: Promise.resolve(null),
				lazyThreshold: options.repoFilesLazyThreshold,
			});
			json(res, result.body, result.status);
		} else if (url.pathname === REPO_FILES_SEARCH_ENDPOINT && req.method === "GET") {
			const result = await handleRepoFilesSearchRequest({
				params: url.searchParams,
				unavailable: repoFilesUnavailable(),
				isCurrentSnapshot: (snapshot) => snapshot === currentSnapshotId(),
				loadListing: loadRepoListing,
				preferred: new Set(diffFileStates(currentPatch).keys()),
			});
			json(res, result.body, result.status);
		} else if (url.pathname === REPO_FILES_STREAM_ENDPOINT && req.method === "GET") {
			const snapshot = url.searchParams.get("snapshot");
			if (!snapshot) {
				json(res, { error: "Missing snapshot", reason: "bad-request" }, 400);
				return;
			}
			const unavailable = repoFilesUnavailable();
			if (unavailable) {
				json(res, { error: unavailable.message, reason: unavailable.reason }, 400);
				return;
			}
			if (snapshot !== currentSnapshotId()) {
				json(res, { error: "Diff snapshot is stale; refresh first", reason: "stale" }, 409);
				return;
			}
			const listing = await loadRepoListing();
			if (!listing?.live || !listing.root) {
				json(res, { error: "This listing does not change while the review is open", reason: "not-live" }, 400);
				return;
			}
			const root = listing.root;
			const liveWorkspace = workspace;
			await repoWatch.stream(res, root, {
				mode: repoLiveMode(listing, { workspace: !!liveWorkspace, lazyThreshold: options.repoFilesLazyThreshold }),
				signature: liveWorkspace
					? async () => (await liveWorkspace.listFiles())?.paths.join("\n") ?? null
					: () => gitLiveSignature(reviewRuntime, root),
				ignored: liveWorkspace ? undefined : () => gitIgnoredEntries(reviewRuntime, root),
				onChange: () => repoListing.invalidate(),
				pollMs: options.repoLivePollMs,
			});
		} else if (url.pathname === REPO_FILE_ENDPOINT && req.method === "GET") {
			const result = await handleRepoFileRequest({
				params: url.searchParams,
				unavailable: repoFilesUnavailable(),
				isCurrentSnapshot: (snapshot) => snapshot === currentSnapshotId(),
				loadListing: loadRepoListing,
				read: readListedRepoFile,
				readWorkingTree: readRepoWorkingTreeFile,
			});
			json(res, result.body, result.status);
		} else if (url.pathname === "/api/file-content" && req.method === "GET") {
			if (isStaticPatchMode) {
				json(res, { error: "File content is unavailable for a static patch review" }, 400);
				return;
			}
			const filePath = url.searchParams.get("path");
			if (!filePath) {
				json(res, { error: "Missing path" }, 400);
				return;
			}
			try {
				validateFilePath(filePath);
			} catch {
				json(res, { error: "Invalid path" }, 400);
				return;
			}
			const oldPath = url.searchParams.get("oldPath") || undefined;
			if (oldPath) {
				try {
					validateFilePath(oldPath);
				} catch {
					json(res, { error: "Invalid path" }, 400);
					return;
				}
			}

			const requestedSnapshot = url.searchParams.get("snapshot");
			if (requestedSnapshot) {
				if (requestedSnapshot !== currentSnapshotId()) {
					json(res, { error: "Diff snapshot is stale; refresh before expanding context" }, 409);
					return;
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
					json(res, { error: "Diff snapshot is stale; refresh before expanding context" }, 409);
					return;
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
						json(res, { error: "Diff snapshot is stale; refresh before expanding context" }, 409);
						return;
					}
				}
			}

			const result = await readDiffFileContents(filePath, oldPath, url.searchParams.get("base") ?? undefined);
			if ("error" in result) {
				json(res, { error: result.error }, result.status);
				return;
			}
			json(res, result);
		} else if (url.pathname === "/api/package-changes" && req.method === "GET") {
			if (isStaticPatchMode) {
				json(res, { error: "Package changes need the files behind the diff" }, 400);
				return;
			}
			const out = await packageChanges.get({
				snapshot: url.searchParams.get("snapshot"),
				base: url.searchParams.get("base") ?? undefined,
			});
			res.setHeader("Cache-Control", "no-store");
			json(res, out.body, out.status);
		} else if (url.pathname === "/api/package-changes/lookup" && req.method === "POST") {
			if (isStaticPatchMode) {
				json(res, { error: "Package changes need the files behind the diff" }, 400);
				return;
			}
			const out = await packageChanges.lookup(await parseBody(req));
			res.setHeader("Cache-Control", "no-store");
			json(res, out.body, out.status);
		} else if (url.pathname === "/api/code-nav/resolve" && req.method === "POST") {
			if (isGitButlerCommittedView()) {
				json(res, { error: "Code navigation is unavailable for committed GitButler views" }, 400);
				return;
			}
			const hasCodeNavAccess = !!workspace || !!options.gitContext || !!options.agentCwd || !!options.worktreePool;
			if (!hasCodeNavAccess) {
				json(res, { error: "Code navigation requires local access" }, 400);
				return;
			}
			try {
				const body = (await parseBody(req)) as unknown as CodeNavRequest;
				const error = validateCodeNavRequest(body);
				if (error) {
					json(res, { error }, 400);
					return;
				}
				const navCwd = resolveAgentCwd();
				const changedFiles = extractChangedFiles(currentPatch);
				const result = await resolveCodeNav(piCodeNavRuntime, body, navCwd, changedFiles);
				json(res, result);
			} catch (err) {
				json(res, { error: err instanceof Error ? err.message : "Code navigation failed" }, 500);
			}
		} else if (url.pathname === "/api/code-nav/hover" && req.method === "POST") {
			if (isGitButlerCommittedView()) {
				json(res, { error: "Code navigation is unavailable for committed GitButler views" }, 400);
				return;
			}
			const hasCodeNavAccess = !!workspace || !!options.gitContext || !!options.agentCwd || !!options.worktreePool;
			if (!hasCodeNavAccess) {
				json(res, { error: "Code navigation requires local access" }, 400);
				return;
			}
			try {
				const body = (await parseBody(req)) as unknown as CodeNavRequest;
				const error = validateCodeNavRequest(body);
				if (error) {
					json(res, { error }, 400);
					return;
				}
				const navCwd = resolveAgentCwd();
				const changedFiles = extractChangedFiles(currentPatch);
				const result = await resolveCodeNavHover(piCodeNavRuntime, body, navCwd, changedFiles);
				json(res, result);
			} catch (err) {
				json(res, { error: err instanceof Error ? err.message : "Code navigation failed" }, 500);
			}
		} else if (url.pathname === "/api/code-nav/file" && req.method === "GET") {
			if (isGitButlerCommittedView()) {
				json(res, { error: "Code navigation is unavailable for committed GitButler views" }, 400);
				return;
			}
			const hasCodeNavAccess = !!workspace || !!options.gitContext || !!options.agentCwd || !!options.worktreePool;
			if (!hasCodeNavAccess) {
				json(res, { error: "Code navigation requires local access" }, 400);
				return;
			}
			const read = await readRepoFile(resolveAgentCwd(), url.searchParams.get("path"));
			if (!read.ok) {
				json(res, repoFileErrorBody(read), REPO_FILE_ERROR_STATUS[read.reason]);
				return;
			}
			json(res, { content: read.content });
		} else if (url.pathname === "/api/config" && req.method === "POST") {
			if (!isSameOriginOrNoOrigin(req.headers.origin ?? null, req.headers.host ?? "", req.headers["sec-fetch-site"])) {
				json(res, { error: "Cross-origin config writes are not allowed" }, 403);
				return;
			}
			try {
				const body = (await parseBody(req)) as { agentSwitch?: unknown; displayName?: string; diffOptions?: Record<string, unknown>; reviewDefaults?: Record<string, { defaultDiffType?: string }>; theme?: Record<string, unknown>; favicon?: FaviconStyle; autoUpdate?: unknown; updateCheck?: unknown; agentTool?: unknown; reviewAnalysis?: Record<string, unknown>; packageChanges?: unknown; conventionalComments?: boolean };
				const toSave: Record<string, unknown> = {};
				const agentSwitch = agentSwitchConfigToSave(body);
				if (agentSwitch === null) return json(res, { error: "Invalid agentSwitch" }, 400);
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
					if (!reviewAnalysis) return json(res, { error: "Invalid analysis settings" }, 400);
					toSave.reviewAnalysis = reviewAnalysis;
					if (reviewAnalysis.callFlow === false) callFlowService.cancelAll();
				}
				if (body.packageChanges !== undefined) {
					const packageChangesConfig = parsePackageChangesConfig(body.packageChanges);
					if (!packageChangesConfig) return json(res, { error: "Invalid packageChanges" }, 400);
					toSave.packageChanges = packageChangesConfig;
				}
				if (body.conventionalComments !== undefined) toSave.conventionalComments = body.conventionalComments;
				const cookieHostWrite = cookieHostConfigWrite((body as { cookieHost?: unknown }).cookieHost, isRemoteSession());
				if (cookieHostWrite && cookieHostWrite.status !== 200) return json(res, cookieHostWrite.body, cookieHostWrite.status);
				if (Object.keys(toSave).length > 0 && !saveConfig(toSave as Parameters<typeof saveConfig>[0])) return json(res, { error: "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it." }, 500);
				if (agentToolSaveFailed(toSave)) return json(res, { error: "Could not save the setting to config.json." }, 500);
				json(res, cookieHostWrite ? cookieHostWrite.body : { ok: true });
			} catch {
				json(res, { error: "Invalid request" }, 400);
			}
		} else if (url.pathname.startsWith("/api/star-ask/")) {
			if (!(await handleStarAskRequest(req, res, url, "review", isRemoteSession()))) handleApiNotFound(res, url.pathname);
		} else if (url.pathname === "/api/image") {
			handleImageRequest(res, url);
		} else if (url.pathname === "/api/upload" && req.method === "POST") {
			await handleUploadRequest(req, res);
		} else if (url.pathname === "/api/agents" && req.method === "GET") {
			json(res, { agents: [] });
		} else if (!aiEnabled && url.pathname.startsWith("/api/agents/")) {
			if (
				url.pathname.slice("/api/agents/".length) === "capabilities" &&
				req.method === "GET"
			) {
				json(res, { mode: "review", providers: [], available: false });
			} else {
				json(res, { error: "AI features disabled" }, 503);
			}
		} else if (
			url.pathname === "/api/agents/review-profiles" &&
			req.method === "GET"
		) {
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
			json(res, body);
		} else if (url.pathname === "/api/agents/skills" && req.method === "GET") {
			json(res, { skills: listAllSkills() });
		} else if (url.pathname === "/api/agents/review-skills" && req.method === "POST") {
			let name: unknown;
			try {
				const body = await parseBody(req);
				name = body.name;
			} catch {
				json(res, { error: "Invalid JSON" }, 400);
				return;
			}
			if (typeof name !== "string" || name.length === 0) {
				json(res, { error: "`name` is required." }, 400);
				return;
			}
			try {
				json(res, enableReviewSkill(name));
			} catch (err) {
				json(res, { error: err instanceof Error ? err.message : "Could not enable review." }, 400);
			}
		} else if (url.pathname === "/api/agents/guide-instructions" && req.method === "GET") {
			json(res, { instructions: readGuideInstructions() });
		} else if (url.pathname === "/api/agents/guide-instructions" && req.method === "PUT") {
			let instructions: unknown;
			try {
				const body = await parseBody(req);
				instructions = body.instructions;
			} catch {
				json(res, { error: "Invalid JSON" }, 400);
				return;
			}
			if (typeof instructions !== "string") {
				json(res, { error: "`instructions` must be a string." }, 400);
				return;
			}
			json(res, { instructions: writeGuideInstructions(instructions) });
		} else if (url.pathname === "/api/git-add" && req.method === "POST") {
			if (isStaticPatchMode) {
				json(res, { error: "Staging is unavailable for a static patch review" }, 400);
				return;
			}
			try {
				const body = await parseBody(req);
				const filePath = body.filePath as string | undefined;
				if (typeof filePath !== "string" || !filePath) {
					json(res, { error: "Missing filePath" }, 400);
					return;
				}
				try {
					validateFilePath(filePath);
				} catch {
					json(res, { error: "Invalid path" }, 400);
					return;
				}
				const undo = body.undo === true;

				if (workspace) {
					try {
						await workspace.stageFile(filePath, undo);
						json(res, { ok: true });
					} catch (error) {
						json(
							res,
							{ error: error instanceof Error ? error.message : "Failed to stage file" },
							400,
						);
					}
					return;
				}

				const stageCwd = resolveVcsCwd(currentDiffType as DiffType, options.gitContext?.cwd);
				if (
					isPRMode ||
					(sessionVcsType && !vcsOwnsDiffType(sessionVcsType, currentDiffType as string)) ||
					!(await canStageFiles(currentDiffType as DiffType, stageCwd))
				) {
					json(res, { error: "Staging not available" }, 400);
					return;
				}

				if (undo) {
					await unstageFile(currentDiffType as DiffType, filePath, stageCwd);
				} else {
					await stageFile(currentDiffType as DiffType, filePath, stageCwd);
				}
				json(res, { ok: true });
			} catch (err) {
				const message =
					err instanceof Error ? err.message : "Failed to stage file";
				json(res, { error: message }, 500);
			}
		} else if (url.pathname === "/api/open-in/apps" && req.method === "GET") {
			if (isStaticPatchMode) {
				json(res, { available: false, apps: [] });
				return;
			}
			if (isRemote) {
				json(res, { available: false, apps: [] });
				return;
			}
			json(res, { available: true, apps: getAvailableOpenInApps() });
		} else if (url.pathname === "/api/open-in" && req.method === "POST") {
			if (isGitButlerCommittedView()) {
				json(res, { error: "Open in app is unavailable for committed GitButler views" }, 400);
				return;
			}
			if (isStaticPatchMode) {
				json(res, { ok: false, error: "Open in app is unavailable for a static patch review" }, 400);
				return;
			}
			if (isRemote) {
				json(res, { ok: false, error: "Open in app is unavailable in remote sessions" }, 400);
				return;
			}
			await handleOpenInRequest(req, res, { serverSession, resolveRoot: resolveOpenInRoot });
		} else if (url.pathname === "/api/review-progress") {
			if (req.method === "POST" && !callFlowInstallOriginAllowed(req.headers.origin ?? null, req.headers.host ?? "", req.headers["sec-fetch-site"])) {
				json(res, { error: "Cross-origin progress updates are not allowed" }, 403);
				return;
			}
			let body: unknown;
			if (req.method === "POST") {
				try { body = JSON.parse(await readBody(req)); } catch { json(res, { error: "Invalid JSON" }, 400); return; }
			}
			const result = await handleReviewProgress({
				method: req.method ?? "GET", snapshotId: url.searchParams.get("snapshot"),
				currentSnapshotId, progress: progressSnapshot, currentProgress: () => progressSnapshot,
				body, platformViewed: isPRMode ? initialViewedFiles : [],
			});
			json(res, result.body, result.status);
		} else if (url.pathname === "/api/draft") {
			const keys = currentDraftKeys();
			if (url.searchParams.has("target") && url.searchParams.get("target") !== keys.targetKey) {
				json(res, { code: "draft_target_changed", error: "Review draft target changed" }, 409);
				return;
			}
			await handleReviewDraftRequest(req, res, keys, reviewDrafts);
		} else if (url.pathname === "/favicon.png" || url.pathname === "/favicon.ico") {
			handleFavicon(res, url.pathname);
		} else if (isDiagramEngineRequest(url.pathname)) {
			const answer = await answerDiagramEngineRequest(
				diagramEngineAssets,
				url.pathname,
				req.method,
				req.headers["accept-encoding"],
				isRemoteSession(),
			);
			res.writeHead(answer.status, answer.headers);
			res.end(answer.body);
		} else if (
			isGitButlerCommittedView() &&
			url.pathname === "/api/editor-annotations" &&
			req.method === "GET"
		) {
			json(res, { annotations: [] });
		} else if (
			isGitButlerCommittedView() &&
			url.pathname === "/api/editor-annotation" &&
			req.method === "POST"
		) {
			json(res, { error: "Editor annotations are unavailable for committed GitButler views" }, 400);
		} else if (await editorAnnotations.handle(req, res, url)) {
			return;
		} else if (url.pathname === "/api/pr-context/stream" && req.method === "GET") {
			if (!isPRMode || !prRef || !prMeta) {
				json(res, { error: "Not in PR mode" }, 400);
				return;
			}

			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			res.setTimeout(0);

			const activeRef = prRef;
			const activeUrl = prMeta.url;
			const unsubscribe = prContextLive.watch(activeUrl, activeRef, (event) => {
				res.write(serializePRContextSSEEvent(event));
			});
			const heartbeatTimer = setInterval(() => {
				try {
					res.write(PR_CONTEXT_HEARTBEAT_COMMENT);
				} catch {
					clearInterval(heartbeatTimer);
					unsubscribe();
				}
			}, PR_CONTEXT_HEARTBEAT_INTERVAL_MS);

			res.on("close", () => {
				clearInterval(heartbeatTimer);
				unsubscribe();
			});
			return;
		} else if (await externalAnnotations.handle(req, res, url)) {
			return;
		} else if (await agentJobs.handle(req, res, url)) {
			return;
		} else if (url.pathname.startsWith("/api/ai/")) {
			if (aiRuntime && req.method === "POST" && url.pathname === "/api/ai/session" && options.worktreePool && prMeta) {
				try {
					await options.worktreePool.ensure(reviewRuntime, prMeta);
				} catch {
					json(res, { error: "Local PR checkout unavailable — Ask AI can't read the PR files right now. Retry shortly." }, 503);
					return;
				}
			}
			if (await handlePiAIRequest(req, res, url, aiRuntime)) return;
			handleApiNotFound(res, url.pathname);
			return;
		} else if (url.pathname === "/api/exit" && req.method === "POST") {
			if (checkServerSession({ serverSession: url.searchParams.get("serverSession") ?? undefined }, serverSession) === "mismatch") {
				json(res, serverSessionMismatchBody(), 409);
				return;
			}
			if (reviewDecided) {
				reviewAlreadyDecided(res);
				return;
			}
			archiveReviewSubmission("", [], "dismissed");
			reviewDrafts.settle(currentDraftKeys(), readDraftGenerationFromUrl(req), url.searchParams.get("client"));
			resolveDecision({ approved: false, feedback: '', annotations: [], exit: true });
			json(res, { ok: true });
		} else if (url.pathname === "/api/feedback" && req.method === "POST") {
			try {
				const body = await parseBody(req);
				if (checkServerSession(body, serverSession) === "mismatch") {
					json(res, serverSessionMismatchBody(), 409);
					return;
				}
				if (reviewDecided) {
					reviewAlreadyDecided(res);
					return;
				}
				const approved = (body.approved as boolean) ?? false;
				const feedbackText = (body.feedback as string) || "";
				const annotationList = (body.annotations as unknown[]) || [];
				const hasContent =
					(typeof feedbackText === "string" && feedbackText.trim().length > 0) ||
					(Array.isArray(annotationList) && annotationList.length > 0);
				const durable = archiveReviewSubmission(
					feedbackText,
					annotationList,
					approved ? (hasContent ? "approved-with-notes" : "lgtm") : "feedback",
				);
				if (durable) reviewDrafts.settle(currentDraftKeys(), readDraftGenerationFromBody(body), url.searchParams.get("client"));
				resolveDecision({
					approved,
					feedback: feedbackText,
					...(options.includeReviewDirectory && !prMeta && options.diffType !== STATIC_PATCH_DIFF_TYPE
						? { reviewDirectory: resolveAgentCwd() } : {}),
					annotations: annotationList,
					agentSwitch: body.agentSwitch as string | undefined,
					...(body.platform === true && { platform: true as const }),
				});
				json(res, { ok: true });
			} catch (err) {
				const message = err instanceof Error ? err.message : "Failed to process feedback";
				json(res, { error: message }, 500);
			}
		} else if (url.pathname.startsWith("/api/")) {
			handleApiNotFound(res, url.pathname);
		} else {
			await serveApp(app, req, res, url.pathname, isRemoteSession());
		}
	});

	requestHostGuard.attach(server);
	const { port, portSource } = await listenOnPort(server);
	boundPort = port;
	if (isRemoteSession()) prewarmAppHtml(app.html, likelyAppHtmlEncoding(false));
	serverUrl = buildAdvertisedUrl(port);
	agentApiUrl = `http://127.0.0.1:${port}`;
	const exitHandler = () => agentJobs.killAll();
	process.once("exit", exitHandler);

	if (options.onReady) {
		options.onReady(serverUrl, isRemote, port);
	}

	return {
		port,
		portSource,
		url: serverUrl,
		isRemote,
		waitForDecision: () => decisionPromise,
		hostControl,
		stop: () => {
			try {
				process.removeListener("exit", exitHandler);
				agentJobs.killAll();
				callFlowService.cancelAll();
				aiRuntime?.dispose();
				repoWatch.closeAll();
			} finally {
				externalAnnotations.endStreams();
				server.close();
				server.closeAllConnections?.();
				if (options.onCleanup) {
					try {
						const result = options.onCleanup();
						if (result instanceof Promise) result.catch(() => {});
					} catch { }
				}
			}
		},
	};
}
