import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import { basename, resolve as resolvePath } from "node:path";

import { contentHash, deleteDraft } from "../generated/draft.js";
import { loadConfig, saveConfig, detectGitUser, getServerConfig, resolveSharingEnabled } from "../generated/config.js";

export type {
	DiffOption,
	DiffType,
	GitContext,
} from "../generated/review-core.js";

import {
	getDisplayRepo,
	getMRLabel,
	getMRNumberLabel,
	isSameProject,
	type PRMetadata,
	type PRRef,
	type PRReviewFileComment,
	prRefFromMetadata,
} from "../generated/pr-types.js";
import {
	PR_CONTEXT_HEARTBEAT_COMMENT,
	PR_CONTEXT_HEARTBEAT_INTERVAL_MS,
	createPRContextLiveCache,
	serializePRContextSSEEvent,
} from "../generated/pr-context-live.js";
import {
	type DiffType,
	type GitContext,
	type RemoteDefaultInfo,
	type SinceBaseSections,
	detectRemoteDefaultInfo,
	getFileContentsForDiff as getFileContentsForDiffCore,
	getSinceBaseSections,
	isSameCwdCommitSwitch,
	listPatchFiles,
	parseCommitDiffType,
	parseWorktreeDiffType,
	resolveBaseBranch,
	validateFilePath,
} from "../generated/review-core.js";
import {
	getCommitDiffInfo,
	listCommitHistory,
	type CommitDiffInfo,
} from "../generated/commit-history.js";
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
} from "../generated/pr-stack.js";

import { resolvePoolCwd, type WorktreePool } from "../generated/worktree-pool.js";
import { createCommitAvatarResolver } from "../generated/commit-avatars.js";

import { createEditorAnnotationHandler } from "./annotations.js";
import { createAgentJobHandler, whichCmd as commandExists } from "./agent-jobs.js";
import { type AgentJobInfo, REVIEW_OUTPUT_FAILED, markJobReviewFailed } from "../generated/agent-jobs.js";
import { createExternalAnnotationHandler } from "./external-annotations.js";
import {
	handleDraftRequest,
	handleFavicon,
	handleImageRequest,
	readDraftGenerationFromBody,
	readDraftGenerationFromUrl,
	handleUploadRequest,
} from "./handlers.js";
import { handleApiNotFound, html, json, parseBody, requestUrl } from "./helpers.js";
import { createPiAIRuntime, handlePiAIRequest } from "./ai-runtime.js";

import { isRemoteSession, listenOnPort } from "./network.js";
import { getAvailableOpenInApps, openFileInApp } from "./open-in-apps.js";
import { resolveOpenInTarget } from "../generated/html-assets-node.js";
import {
	fetchPR,
	fetchPRContext,
	fetchPRFileContent,
	fetchPRList,
	fetchPRStack,
	fetchPRViewedFiles,
	getPRUser,
	markPRFilesViewed,
	parsePRUrl,
	prCommandRuntime,
	submitPRReview,
} from "./pr.js";
import { getRepoInfo } from "./project.js";
import {
	composeCodexReviewPrompt,
	buildCodexCommand,
	generateOutputPath,
	parseCodexOutput,
	transformReviewFindings,
} from "../generated/codex-review.js";
import { buildAgentReviewUserMessage, buildAgentReviewUserMessageForTarget, type WorkspaceReviewPromptContext } from "../generated/agent-review-message.js";
import {
	composeClaudeReviewPrompt,
	buildClaudeCommand,
	parseClaudeStreamOutput,
	transformClaudeFindings,
} from "../generated/claude-review.js";
import { createTourSession, TOUR_EMPTY_OUTPUT_ERROR } from "../generated/tour-review.js";
import { createGuideSession, GUIDE_EMPTY_OUTPUT_ERROR } from "../generated/guide-review.js";
import {
	MARKER_ENGINES,
	composeMarkerReviewPrompt,
	buildMarkerCommand,
	parseMarkerStreamOutput,
	reduceMarkerStream,
	transformMarkerFindings,
	makeMarkerNonce,
	extractMarkerNonce,
	type MarkerEngineId,
} from "../generated/marker-review.js";
import {
	WorkspaceReviewSession,
	type WorkspaceDiffType,
} from "../generated/review-workspace.js";
import {
	type CodeNavRequest,
	type CodeNavRuntime,
	resolveCodeNav,
	validateCodeNavRequest,
	extractChangedFiles,
} from "../generated/code-nav.js";
import {
	createDefaultSemanticDiffRuntime,
	getSemanticDiffAvailability,
	getSemanticDiffScratchCwd,
	runSemanticDiff,
	semanticDiffCacheKey,
	semanticDiffFileExtsFromSearchParams,
	SemanticDiffResponseCache,
} from "../generated/semantic-diff.js";
import type { SemanticDiffAvailability, SemanticDiffResponse } from "../generated/semantic-diff-types.js";
import { discoverCuratedSkills, resolveRequestedReviewProfile, listAllSkills, enableReviewSkill } from "../generated/review-skill-loader.js";
import {
	BUILTIN_DEFAULT_PROFILE,
	type ReviewProfilesResponse,
} from "../generated/review-profiles.js";
import {
	canStageFiles,
	detectRemoteDefaultCompareTarget,
	getVcsContext,
	getVcsDiffFingerprint,
	getVcsFileContentsForDiff,
	resolveVcsCwd,
	reviewRuntime,
	runVcsDiff,
	stageFile,
	unstageFile,
} from "./vcs.js";

const piCodeNavRuntime: CodeNavRuntime = {
	runCommand(command, args, options) {
		return new Promise((resolve) => {
			const proc = spawn(command, args, {
				cwd: options?.cwd,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let timer: ReturnType<typeof setTimeout> | undefined;
			if (options?.timeoutMs) {
				timer = setTimeout(() => proc.kill(), options.timeoutMs);
			}
			const stdoutChunks: Buffer[] = [];
			const stderrChunks: Buffer[] = [];
			proc.stdout!.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
			proc.stderr!.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
			proc.on("close", (code: number | null) => {
				if (timer) clearTimeout(timer);
				resolve({
					stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
					stderr: Buffer.concat(stderrChunks).toString("utf-8"),
					exitCode: code ?? 1,
				});
			});
			proc.on("error", () => {
				if (timer) clearTimeout(timer);
				resolve({ stdout: "", stderr: "command not found", exitCode: 1 });
			});
		});
	},
};

// Review ingestion completion semantics (REVIEW_OUTPUT_FAILED,
// markJobReviewFailed) now live in the shared agent-jobs module.

// Node equivalent of Bun.which(cmd) — used to pick a guide repair engine
// (prefer whichever schema-enforced CLI is on PATH). Imported as
// `commandExists` from agent-jobs.ts's `whichCmd` (single source of truth;
// the other pre-existing copies in ai-runtime.ts / agent-terminal are left
// alone — out of scope here).

/** Detect if running inside WSL (Windows Subsystem for Linux) */
function detectWSL(): boolean {
	if (process.platform !== "linux") return false;
	if (os.release().toLowerCase().includes("microsoft")) return true;
	try {
		if (existsSync("/proc/version")) {
			const content = readFileSync("/proc/version", "utf-8").toLowerCase();
			return content.includes("wsl") || content.includes("microsoft");
		}
	} catch { /* ignore */ }
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
		annotations: unknown[];
		agentSwitch?: string;
		exit?: boolean;
	}>;
	stop: () => void;
}

export async function startReviewServer(options: {
	rawPatch: string;
	gitRef: string;
	htmlContent: string;
	origin?: string;
	diffType?: DiffType | WorkspaceDiffType;
	gitContext?: GitContext;
	/**
	 * Initial base branch the caller used to compute `rawPatch`. When a caller
	 * overrides the detected default (e.g. `openCodeReview({ defaultBranch })`),
	 * this must be forwarded so the server's internal `currentBase` state, the
	 * `/api/diff` response, and downstream agent prompts stay consistent with
	 * the patch that's already on screen.
	 */
	initialBase?: string;
	error?: string;
	sharingEnabled?: boolean;
	shareBaseUrl?: string;
	pasteApiUrl?: string;
	prMetadata?: PRMetadata;
	/**
	 * The initial layer patch is missing per-file content (platform APIs
	 * withhold patches on very large PRs). Enables the local recompute upgrade
	 * once a pool checkout is ready.
	 */
	prPatchIncomplete?: boolean;
	/** Working directory for agent processes (e.g., --local worktree). Independent of diff pipeline. */
	agentCwd?: string;
	/** Local parent directory containing multiple child VCS repositories. */
	workspace?: WorkspaceReviewSession;
	/** Per-PR worktree pool. When set, pr-switch creates worktrees instead of checking out. */
	worktreePool?: WorktreePool;
	/** Cleanup callback invoked when server stops (e.g., remove temp worktree) */
	onCleanup?: () => void | Promise<void>;
	/** Called when server starts with the URL, remote status, and port */
	onReady?: (url: string, isRemote: boolean, port: number) => void;
}): Promise<ReviewServerResult> {
	const gitUser = detectGitUser();
	let draftKey = contentHash(options.rawPatch);
	let prMeta = options.prMetadata;
	const isPRMode = !!prMeta;
	const workspace = options.workspace;
	const isWorkspaceMode = !!workspace;
	const hasLocalAccess = !!options.gitContext;
	const sessionVcsType = options.gitContext?.vcsType;
	const isRemote = isRemoteSession();
	const wslFlag = detectWSL();
	let prRef = prMeta ? prRefFromMetadata(prMeta) : null;
	const platformUser = prRef ? await getPRUser(prRef) : null;
	let prStackInfo = isPRMode ? getPRStackInfo(prMeta) : null;
	let prDiffScopeOptions = isPRMode
		? getPRDiffScopeOptions(prMeta, !!(options.worktreePool || options.agentCwd))
		: [];

	let prListCache: import("../generated/pr-types.js").PRListItem[] | null = null;
	let prListCacheTime = 0;
	// Platform APIs withhold per-file patches on very large PRs. When the layer
	// patch is incomplete, a local recompute (exact merge-base diff, no size
	// limits) becomes available once a pool checkout exists — the layer
	// fingerprint flips to drive the refresh notice, and the pr-diff-scope
	// "layer" branch performs the upgrade. Tracked per-PR across pr-switch.
	// Partiality is INFORMATION (the platform withheld content) and is always
	// reported; whether a local recompute can be OFFERED is a separate
	// capability, gated on the pool below (layerUpgradeAvailable).
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
	const prStackTreeCache = new Map<string, import("../generated/pr-types.js").PRStackTree | null>();
	const prContextLive = createPRContextLiveCache({ fetchContext: fetchPRContext });
	const warmPRContext = (url: string, ref: PRRef): void => {
		prContextLive.warm(url, ref);
	};

	// Fetch full stack tree (best-effort — always try in PR mode so root PRs
	// that target the default branch can still discover descendant PRs)
	let prStackTree: import("../generated/pr-types.js").PRStackTree | null = null;
	if (prRef && prMeta) {
		warmPRContext(prMeta.url, prRef);
		try {
			prStackTree = await fetchPRStack(prRef, prMeta);
		} catch {
			// Non-fatal: client falls back to buildMinimalStackTree()
		}
		prStackTreeCache.set(prMeta.url, prStackTree);
		const resolved = resolveStackInfo(prMeta, prStackTree, prStackInfo);
		if (resolved && !prStackInfo) {
			prStackInfo = resolved;
			prDiffScopeOptions = getPRDiffScopeOptions(prMeta, !!(options.worktreePool || options.agentCwd));
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
	let repoInfo = prMeta
		? {
				display: getDisplayRepo(prMeta),
				branch: `${getMRLabel(prMeta)} ${getMRNumberLabel(prMeta)}`,
			}
		: workspace
			? { display: basename(workspace.root), branch: "Workspace" }
		: getRepoInfo();
	const editorAnnotations = createEditorAnnotationHandler();
	const externalAnnotations = createExternalAnnotationHandler("review");

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
	// Monotonic guard for /api/diff/switch (mirrors Bun review.ts) — concurrent
	// switches would otherwise clobber each other's snapshot across awaits.
	let diffSwitchEpoch = 0;
	// Tracks the base branch the user picked from the UI. Agent review prompts
	// read this (not gitContext.defaultBranch) so they analyze the same diff
	// the reviewer is currently looking at. Honors an explicit initialBase from
	// the caller — e.g. programmatic Pi callers can request a non-detected base.
	const detectedCompareTarget = (): string =>
		options.gitContext?.defaultBranch || options.gitContext?.compareTarget?.fallback || "main";
	let currentBase = options.initialBase || detectedCompareTarget();
	let baseEverSwitched = false;
	// True once the user picks a base from the picker (explicitBase on the
	// switch body). Disables the bare-local-name → origin/* canonicalization:
	// the picker offers local and remote refs as distinct choices, so an
	// explicit local pick must be honored even when the two point at
	// different commits.
	let baseExplicitlyChosen = false;
	const resolveReviewBase = (requestedBase?: string): string => {
		const resolved = resolveBaseBranch(requestedBase, detectedCompareTarget());
		// Canonicalize a bare local default name ("main") to its tracking ref
		// ("origin/main") — the startup upgrade races the first /api/diff, so a
		// client that loaded early re-sends "main" on the next switch/refresh and
		// would revert the server to the stale local branch. Only when the remote
		// default is known, the requested base is exactly its local name, AND the
		// user has never explicitly picked a base — an explicit local pick (and
		// every echo after it) is honored verbatim.
		const remoteBranch = remoteDefaultInfo?.branch;
		if (
			!baseExplicitlyChosen &&
			remoteBranch &&
			remoteBranch.startsWith("origin/") &&
			resolved === remoteBranch.replace(/^origin\//, "")
		) {
			return remoteBranch;
		}
		// Second rule, independent of remoteDefaultInfo: if the SESSION is
		// already on the upgraded tracking ref and a non-explicit request echoes
		// its bare local name, stay on the tracking ref. remoteDefaultInfo comes
		// from a SECOND probe that can lag the startup upgrade by seconds — in
		// that window the rule above is blind, and a diff-type/whitespace switch
		// echoing "main" would commit the session back onto the stale local
		// branch (and set baseEverSwitched, permanently blocking the upgrade).
		if (!baseExplicitlyChosen && currentBase === `origin/${resolved}`) {
			return currentBase;
		}
		return resolved;
	};

	// --- Diff staleness fingerprint (mirrors packages/server/review.ts) -------
	// Captured beside every patch snapshot; GET /api/diff/fresh recomputes and
	// compares so the client can show a "diff out of date — refresh" notice when
	// files change mid-review. Best-effort: null = "cannot fingerprint" and is
	// reported fresh, never stale.
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
					// Recaptured on pr-switch.
					const suffix = layerPatchIncomplete ? ":incomplete" : "";
					return `pr-layer:${prMeta?.url ?? ""}${suffix}`;
				}
				// Full-stack: three-dot diff against the local checkout — fingerprint
				// (merge-base, HEAD), which changes exactly when the patch can.
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

	// --- Base staleness vs the remote (mirrors Bun review.ts) -----------------
	// `origin/<default>` is GitHub's state as of the last fetch. The startup
	// ls-remote also carries the remote tip SHA; comparing it to the local
	// tracking ref tells us whether the baseline is behind. Refreshed lazily at
	// most once a minute (network call, unlike the 5s fingerprint probe).
	let remoteDefaultInfo: RemoteDefaultInfo | null = null;
	let baseBehindRemote = false;
	let lastRemoteBaseCheck = 0;
	const REMOTE_BASE_CHECK_INTERVAL_MS = 60_000;
	const remoteBaseCheckApplies = (): boolean =>
		!!options.gitContext && !isPRMode && (!sessionVcsType || sessionVcsType === "git");

	// Only base-relative diff types (since-base / branch / merge-base) care
	// about the base being behind the remote; the banner must not show under
	// uncommitted/staged/etc.
	const baseRelevantDiffType = (): boolean => {
		const t = parseWorktreeDiffType(currentDiffType as string)?.subType ?? currentDiffType;
		return t === "since-base" || t === "branch" || t === "merge-base";
	};

	// Local-only recompute from the cached remote tip — no network.
	async function recomputeBaseBehindRemote(): Promise<void> {
		// Capture once: a concurrent refreshRemoteBaseInfo can null
		// remoteDefaultInfo (transient ls-remote failure) during the rev-parse
		// await below — reading the global after it would throw.
		const remoteInfo = remoteDefaultInfo;
		if (!remoteBaseCheckApplies() || !baseRelevantDiffType() || !remoteInfo?.remoteHeadSha) {
			baseBehindRemote = false;
			return;
		}
		// Match the remote default branch as either its local name ("main") or
		// the tracking ref ("origin/main"), and compare by RESOLVED SHA — this is
		// what makes the check work when currentBase is the bare local name (the
		// case whenever origin/HEAD's local symref isn't set; Pi forwards that
		// local name as initialBase).
		//
		// A local name the user EXPLICITLY picked is exempt: they chose the local
		// ref over origin/* on purpose, and Fetch advances origin/* — the banner
		// would be un-clearable nagging about a deliberate choice (same treatment
		// as any non-default base).
		const remoteBranch = remoteInfo.branch;
		const localName = remoteBranch.replace(/^origin\//, "");
		const matchesDefault =
			currentBase === remoteBranch ||
			(currentBase === localName && !baseExplicitlyChosen);
		if (!matchesDefault) {
			baseBehindRemote = false;
			return;
		}
		// --verify: without it, `rev-parse --end-of-options <ref>` echoes the flag
		// as a literal first output line, so .trim() never equals the SHA and the
		// banner was stuck true on every repo with a remote.
		const local = await reviewRuntime.runGit(
			["--no-optional-locks", "rev-parse", "--verify", "--end-of-options", currentBase],
			{ cwd: options.gitContext?.cwd },
		);
		baseBehindRemote = local.exitCode === 0 && local.stdout.trim() !== remoteInfo.remoteHeadSha;
	}

	async function refreshRemoteBaseInfo(): Promise<void> {
		if (!remoteBaseCheckApplies()) return;
		lastRemoteBaseCheck = Date.now();
		remoteDefaultInfo = await detectRemoteDefaultInfo(reviewRuntime, options.gitContext?.cwd);
		await recomputeBaseBehindRemote();
	}

	function maybeRefreshRemoteBaseInfo(): void {
		if (!remoteBaseCheckApplies()) return;
		if (Date.now() - lastRemoteBaseCheck < REMOTE_BASE_CHECK_INTERVAL_MS) return;
		lastRemoteBaseCheck = Date.now();
		void refreshRemoteBaseInfo().catch(() => {});
	}

	// Commit-author avatar resolution for /api/commits — session-scoped so the
	// forge lookups (gh/glab) and their failures are paid at most once.
	const commitAvatars = createCommitAvatarResolver(prCommandRuntime);

	// --- Since-base sections sidecar (mirrors Bun review.ts) ------------------
	function isSinceBaseActive(diffType: string = currentDiffType as string): boolean {
		if (isPRMode || workspace || !options.gitContext) return false;
		const effective = parseWorktreeDiffType(diffType)?.subType ?? diffType;
		return effective === "since-base";
	}
	// --- Commit metadata sidecar (mirrors Bun review.ts) -----------------------
	// When a commit:<sha> diff is active, the full commit message (rendered as
	// markdown client-side) heads the all-files view. Avatar enrichment reuses
	// the session cache. diffType parameterized for the same pin-before-await
	// discipline as buildSectionsSidecar.
	async function buildCommitInfoSidecar(diffType: string = currentDiffType as string): Promise<CommitDiffInfo | undefined> {
		if (isPRMode || workspace || !options.gitContext) return undefined;
		const effective = parseWorktreeDiffType(diffType)?.subType ?? diffType;
		const sha = parseCommitDiffType(effective as string)?.sha;
		if (!sha) return undefined;
		const cwd = resolveVcsCwd(diffType as DiffType, options.gitContext.cwd);
		const info = await getCommitDiffInfo(reviewRuntime, sha, cwd);
		if (!info) return undefined;
		const avatars = await commitAvatars.resolve(cwd, [info.authorEmail]);
		const avatarUrl = avatars.get(info.authorEmail);
		return avatarUrl ? { ...info, avatarUrl } : info;
	}

	// Base AND diff type are parameterized so callers can pin them to a
	// snapshot taken before an await — reading the globals inside would race
	// the startup base upgrade and concurrent diff-type switches.
	async function buildSectionsSidecar(
		base: string = currentBase,
		diffType: string = currentDiffType as string,
	): Promise<SinceBaseSections | undefined> {
		if (!isSinceBaseActive(diffType)) return undefined;
		const cwd = resolveVcsCwd(diffType as DiffType, options.gitContext?.cwd);
		return (await getSinceBaseSections(reviewRuntime, base, cwd)) ?? undefined;
	}

	// Decoupled startup probes (a forwarded initialBase must NOT suppress the
	// staleness check — the Pi divergence): always probe remote staleness, and
	// only upgrade currentBase to the upstream ref when no explicit base given.
	// Upgrade currentBase to the upstream tracking ref ("origin/main") when no
	// explicit base was requested, OR when the forwarded base is just the bare
	// LOCAL name of that same default ("main"). Only origin/* is fetchable, so
	// leaving currentBase as bare "main" makes the "behind GitHub" banner
	// un-clearable (Fetch advances origin/main, not local main). Canonicalizing
	// "main" -> "origin/main" never overrides a deliberately-chosen feature base.
	if (options.gitContext && !isPRMode) {
		const gitCwd = options.gitContext.cwd;
		detectRemoteDefaultCompareTarget(gitCwd, sessionVcsType).then(
			async (remote) => {
				if (remote && !baseEverSwitched && currentBase !== remote) {
					const localName = remote.replace(/^origin\//, "");
					if (!options.initialBase || currentBase === localName) {
						// Rebuild the diff for the upgraded base BEFORE swapping it in, and
						// commit base+patch+ref+fingerprint together — otherwise the initial
						// patch (built against the old base) would be served under the new
						// base label: a mixed-base review. Skip if the user switched meanwhile.
						try {
							const rebuilt = await runVcsDiff(
								currentDiffType as DiffType,
								remote,
								gitCwd,
								{ hideWhitespace: currentHideWhitespace },
							);
							if (!baseEverSwitched) {
								currentBase = remote;
								currentPatch = rebuilt.patch;
								currentGitRef = rebuilt.label;
								currentError = rebuilt.error;
								// draftKey doubles as the snapshot id the freshness probe
								// compares against each client's echoed ?snapshot= — a client
								// that loaded the pre-upgrade patch mismatches and gets the
								// "Diff out of date · Refresh" banner; later loads carry the
								// new id and stay fresh. That per-client signal is what lets
								// the fingerprint re-baseline unconditionally here.
								draftKey = contentHash(currentPatch);
								captureDiffFingerprint();
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

	// Agent jobs — background process manager (late-binds serverUrl via getter)
	let serverUrl = "";
	function resolveAgentCwd(): string {
		if (workspace) return workspace.root;
		if (options.worktreePool && prMeta) {
			const poolPath = options.worktreePool.resolve(prMeta.url);
			if (poolPath) return poolPath;
		}
		if (options.agentCwd) return options.agentCwd;
		return resolveVcsCwd(currentDiffType as DiffType, options.gitContext?.cwd) ?? process.cwd();
	}
	// The current PR's local checkout if one is usable, else null. Mirrors the
	// Bun review server's resolvePRLocalCwd: a pool entry that exists but isn't
	// ready yet yields null (no usable checkout), distinct from resolveAgentCwd
	// which always falls back to a cwd for agent/launch resolution. Used to
	// advertise the Open-in root to the client without a page reload.
	function resolvePRLocalCwd(): string | null {
		const pool = options.worktreePool;
		if (pool && prMeta) {
			const r = resolvePoolCwd(pool, prMeta.url);
			if (r.kind === "ready") return r.path;
			if (r.kind === "pending") return null; // warming up — don't fall back
		}
		return options.agentCwd && existsSync(options.agentCwd) ? options.agentCwd : null;
	}
	// Strict launch root for /api/open-in: in PR pool mode only the PR's own
	// checkout is acceptable — never the launch-repo fallback resolveAgentCwd
	// uses. Returns [] until ready so resolveOpenInTarget rejects (the button is
	// gated off then anyway); non-PR resolves to the working tree as usual.
	function resolveOpenInRoot(): string | string[] {
		if (workspace) return workspace.root;
		if (options.worktreePool && prMeta) return resolvePRLocalCwd() ?? [];
		return options.agentCwd ?? resolveVcsCwd(currentDiffType as DiffType, options.gitContext?.cwd) ?? process.cwd();
	}
	function getWorkspacePromptContext(): WorkspaceReviewPromptContext | undefined {
		if (!workspace) return undefined;
		return workspace.getPromptContext();
	}

	// Ask AI "changes under review" context for the CURRENT view, built by the
	// SAME machine the review jobs use (contextOnly=true). Returned in the diff
	// payloads so the chat latches it onto user messages; recomputed wherever the
	// view changes. Mirrors packages/server/review.ts buildCurrentAiReviewContext.
	// Parameterized so response handlers that SNAPSHOT the served state before
	// an await can build the AI context from that same snapshot — reading the
	// live globals here would let the startup base upgrade hand Ask AI a
	// context for a different changeset than the rendered patch.
	// Snapshot identity clients echo on freshness probes: the content hash
	// PLUS the view mode. Mode is included so a cross-tab mode switch with a
	// byte-identical patch (layer vs full-stack on a single-PR stack) still
	// flags old tabs; the BASE is deliberately excluded so a same-commit base
	// canonicalization (main -> origin/main) stays banner-silent. draftKey
	// itself stays a pure content hash — drafts survive content-identical
	// mode round-trips.
	function currentSnapshotId(): string {
		return `${draftKey}:${currentDiffType}${isPRMode ? `:${currentPRDiffScope}` : ""}`;
	}

	function buildCurrentAiReviewContext(
		patch: string = currentPatch,
		base: string = currentBase,
		diffType: DiffType = currentDiffType as DiffType,
	): string {
		const workspacePrompt = getWorkspacePromptContext();
		if (workspacePrompt) {
			return buildAgentReviewUserMessageForTarget(
				{ kind: "workspace", patch, workspace: workspacePrompt },
				true,
			);
		}
		// Ready-checked (matches Bun): a warming PR checkout must NOT claim local
		// access, or the agent would be told to diff a checkout that isn't there.
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
	const semanticDiffScratchCwd = getSemanticDiffScratchCwd();
	function resolveSemanticDiffCwd(): string {
		if (workspace) return workspace.root;
		if (options.worktreePool && prMeta) {
			const poolPath = options.worktreePool.resolve(prMeta.url);
			if (poolPath) return poolPath;
		}
		if (options.agentCwd) return options.agentCwd;
		if (options.gitContext) {
			const vcsCwd = resolveVcsCwd(currentDiffType as DiffType, options.gitContext.cwd);
			if (vcsCwd) return vcsCwd;
			if (options.gitContext.cwd) return options.gitContext.cwd;
		}
		return semanticDiffScratchCwd;
	}
	const semanticDiffCache = new SemanticDiffResponseCache();
	const semanticDiffAvailabilityCache = new Map<string, Promise<SemanticDiffAvailability>>();

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

	async function getSemanticDiffAdvert() {
		const availability = await getSemanticDiffAvailabilityForCwd(resolveSemanticDiffCwd());
		return {
			available: availability.available,
			...(availability.semVersion ? { semVersion: availability.semVersion } : {}),
			...(availability.semSource ? { semSource: availability.semSource } : {}),
		};
	}

	async function getSemanticDiff(url: URL): Promise<SemanticDiffResponse> {
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
	}

	const agentJobs = createAgentJobHandler({
		mode: "review",
		getServerUrl: () => serverUrl,
		getCwd: resolveAgentCwd,

		async buildCommand(provider, config) {
			// Fail fast in PR-pool mode when this PR's checkout doesn't exist
			// (e.g. a pr-switch whose worktree creation failed): falling back
			// would run the agent against the wrong revision or directory.
			if (options.worktreePool && prMeta && !options.worktreePool.resolve(prMeta.url)) {
				throw new Error(
					"Local PR checkout unavailable — the agent can't run against the PR files. Retry shortly (the checkout may still be recovering).",
				);
			}
			const cwd = resolveAgentCwd();
			const workspacePrompt = getWorkspacePromptContext();
			const hasAgentLocalAccess = !!workspacePrompt || !!options.worktreePool || !!options.agentCwd || !!options.gitContext;
			const userMessageOptions = {
				defaultBranch: currentBase,
				hasLocalAccess: hasAgentLocalAccess,
				prDiffScope: currentPRDiffScope,
				...(workspacePrompt && { workspace: workspacePrompt }),
			};

			// Snapshot the diff context at launch (see review.ts buildCommand
			// for the rationale — keeps downstream "Copy All" honest across
			// subsequent context switches).
			const worktreeParts = String(currentDiffType).startsWith("worktree:")
				? parseWorktreeDiffType(currentDiffType as DiffType)
				: null;
			const launchPrUrl = prMeta?.url;
			const launchDiffScope = isPRMode ? currentPRDiffScope : undefined;

			const requestedProfileId =
				typeof config?.reviewProfileId === "string" ? config.reviewProfileId : undefined;
			// Resolve the requested review, or throw a clear error. An unresolvable
			// non-default id (renamed/removed skill, stale cookie, malformed request)
			// never silently downgrades to the default — explicit selection is
			// authoritative at this boundary.
			const reviewProfile = resolveRequestedReviewProfile(requestedProfileId);

			const diffContext: AgentJobInfo["diffContext"] | undefined = workspacePrompt
				? { mode: String(currentDiffType), worktreePath: null }
				: prMeta
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
					diffType: currentDiffType as DiffType,
					options: userMessageOptions,
					prMetadata: prMeta,
					config,
				});
				return built ? { ...built, prUrl: launchPrUrl, diffScope: launchDiffScope, diffContext, reviewProfileId: reviewProfile.id, reviewProfileLabel: reviewProfile.label } : built;
			}

			if (provider === "guide") {
				// Snapshot ALL launch-relevant mutable closure state into locals
				// before any await below — currentPatch/currentDiffType/prMeta can
				// all be reassigned by a concurrent request (diff/base/PR switch)
				// while this async branch is suspended, and every read below must
				// describe the same launch, not whatever the reviewer has since
				// switched to (mirrors review.ts buildCommand's top-of-function
				// snapshot).
				const launchPatch = currentPatch;
				const launchDiffType = currentDiffType;
				const launchPrMeta = prMeta;
				// Snapshotted WITH the patch it describes — see the Bun server's
				// launchLayerPatchIncomplete comment (mirrors review.ts).
				const launchLayerPatchIncomplete = layerPatchIncomplete;
				const launchPRDiffScope = currentPRDiffScope;

				// The changed-file list is derived from the same launch-time patch
				// snapshot as the rest of this branch — it's what the model plans
				// section placement against at generation time. The SAME list is
				// snapshotted onto the job (changedFilesSnapshot, below) and reused
				// by onJobComplete to validate refs, rather than re-deriving from
				// whatever patch/diff/base the reviewer has switched to by the time
				// the job finishes — a mid-generation diff/base switch would
				// otherwise invalidate every ref in an otherwise-valid guide.
				let changedFiles = listPatchFiles(launchPatch);
				// Very large PRs: the platform API withholds per-file patches
				// (layerPatchIncomplete) — but the PR-mode prompt tells the agent to
				// read the FULL local diff (git diff origin/<base>...HEAD in the
				// checkout). The changed-files block and the validation snapshot must
				// describe that SAME diff: derived from the partial API patch they
				// under-list files to the model and then validation drops its valid
				// refs (or fails the guide closed when no section survives).
				// Recompute names+counts locally when the checkout is ready; on any
				// failure fall back to the partial list — no worse than before.
				// Mirrors packages/server/review.ts's guide branch.
				// Layer scope only — full-stack launchPatch is already a local full
				// recompute; the layer diff would drop earlier stack layers' files.
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
										// numstat rename forms: "src/{old => new}/f" or "old => new"
										// — refs use post-image paths, matching what the agent sees.
										const brace = raw.match(/^(.*)\{.* => (.*)\}(.*)$/);
										const path = brace
											? `${brace[1]}${brace[2]}${brace[3]}`.replace(/\/\//g, "/")
											: raw.includes(" => ")
												? raw.split(" => ").pop()!
												: raw;
										// Binary files report "-\t-\tpath" — count as 0/0.
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
					// Prefer the failed job's OWN engine, marker or not, when its
					// binary is present on this machine: the failed job got far
					// enough to produce capturable output, so that engine is
					// PROVABLY runnable here — a fact no other candidate can claim.
					// claude/codex are only a FALLBACK (in that order) when the
					// failed engine's binary is missing, because binary presence
					// alone means installed, not authenticated/usable — a broken
					// claude repair would itself become the newest failed job and
					// hijack the recovery panel next render, a doom loop. Marker
					// engines' binary name can differ from the engine id (Cursor's
					// CLI binary is `agent`, not `cursor`), so resolve via
					// MARKER_ENGINES[...].binary before falling back to the engine
					// id itself for claude/codex.
					const failedEngine = typeof config?.engine === "string" && config.engine ? config.engine : undefined;
					const failedEngineBinary = failedEngine
						? MARKER_ENGINES[failedEngine as MarkerEngineId]?.binary ?? failedEngine
						: undefined;
					const repairEngine =
						failedEngine && commandExists(failedEngineBinary!)
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
				// A repair job's payload is the FAILED job's previously-captured
				// output, not this launch's diff — its file refs were validated
				// (and, for onJobComplete, must be re-validated) against the failed
				// job's own recorded changed-file set. Falling back to this launch's
				// freshly-derived `changedFiles` here would validate a repair against
				// whatever diff/base happens to be on screen right now, reintroducing
				// the destroy-on-switch bug this snapshot exists to prevent — just
				// for repairs instead of the original launch. Fall back only if the
				// failed job's set was never recorded (defensive; shouldn't happen
				// since onJobComplete always records it before returning).
				const changedFilesSnapshot = repairOf
					? guide.getLaunchChangedFiles(repairOf) ?? changedFiles.map((f) => f.path)
					: changedFiles.map((f) => f.path);
				return {
					...built,
					prUrl: launchPrUrl,
					diffScope: launchDiffScope,
					diffContext,
					reviewProfileId: reviewProfile.id,
					reviewProfileLabel: reviewProfile.label,
					changedFilesSnapshot,
				};
			}

			// A custom review skill carries its own instructions and becomes the whole
			// prompt; strip the default framing prose from the user message so only the
			// git/PR context remains. The default review keeps today's message verbatim.
			const isCustomReview = reviewProfile.source === "user";
			const userMessage = workspacePrompt
				? buildAgentReviewUserMessageForTarget({
						kind: "workspace",
						patch: currentPatch,
						workspace: workspacePrompt,
					}, isCustomReview)
				: buildAgentReviewUserMessage(currentPatch, currentDiffType as DiffType, userMessageOptions, prMeta, isCustomReview);
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
				const { command, stdinPrompt } = buildClaudeCommand(prompt, model, effort);
				return { command, stdinPrompt, prompt, cwd, label: jobLabel, captureStdout: true, model, effort, prUrl: launchPrUrl, diffScope: launchDiffScope, diffContext, reviewProfileId: reviewProfile.id, reviewProfileLabel: reviewProfile.label };
			}

			// Marker engines (Cursor, OpenCode, Pi) — one branch, same shape as Claude.
			// None of the three has a schema flag, so composeMarkerReviewPrompt ALWAYS
			// appends the marker-block output contract (even for a custom profile —
			// it's the only thing that makes their prose output parseable). The
			// engine's buildArgv passes the prompt as the trailing positional arg and
			// threads the spawn cwd (--workspace for Cursor, --dir for OpenCode; Pi has
			// no cwd flag — it always uses the process's actual cwd, which spawnJob
			// already sets from this same cwd).
			// captureStdout is required: the marker block comes back on stdout NDJSON.
			const markerEngine = MARKER_ENGINES[provider as MarkerEngineId];
			if (markerEngine) {
				const model = typeof config?.model === "string" && config.model ? config.model : undefined;
				const thinking = typeof config?.thinking === "string" && config.thinking ? config.thinking : undefined;
				// Per-job nonce embedded in the marker contract; recovered from job.prompt
				// at parse time so echoed/quoted bare tags can't be mistaken for the payload.
				const nonce = makeMarkerNonce();
				const prompt = composeMarkerReviewPrompt(reviewProfile, userMessage, nonce);
				const { command } = buildMarkerCommand(markerEngine, prompt, model, cwd, { thinking });
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
				prNumber: jobPrMeta.platform === "github" ? jobPrMeta.number : jobPrMeta.iid,
				prTitle: jobPrMeta.title,
				prRepo: getDisplayRepo(jobPrMeta),
			} : jobPrUrl ? { prUrl: jobPrUrl } : {};

			// Only tag annotations with a *custom* profile — the default review needs no tag.
			const profileLabel =
				job.reviewProfileId && job.reviewProfileId !== BUILTIN_DEFAULT_PROFILE.id
					? job.reviewProfileLabel
					: undefined;

			// Map findings onto annotations and ingest. Shared by both engine branches;
			// no-ops on an empty set so a clean (zero-finding) review stays "done".
			const ingest = <T extends object>(transformed: readonly T[], logTag: string) => {
				if (transformed.length === 0) return undefined;
				const annotations = transformed.map((a) => ({
					...a,
					...jobPrContext,
					...(jobDiffScope && { diffScope: jobDiffScope }),
					...(profileLabel && { reviewProfileLabel: profileLabel }),
				}));
				const result = externalAnnotations.addAnnotations({ annotations });
				if ("error" in result) console.error(`[${logTag}] addAnnotations error:`, result.error);
				return result;
			};

			if (job.provider === "codex") {
				const output = meta.outputPath ? await parseCodexOutput(meta.outputPath) : null;
				if (!output) {
					// Process exited 0 but output is missing/unparseable — not a green run.
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

				// Recompute the verdict from the findings we actually render. Nothing is
				// dropped now (un-pinnable findings become file/general comments), so the
				// count reflects reality and the card can never claim more than it shows.
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

			// --- Marker path (Cursor, OpenCode, Pi) ---
			// FAIL-CLOSED: marker output is prompt-enforced (no schema flag), so any
			// missing/malformed/schema/transform/insertion failure must MUTATE the job
			// to failed — NEVER throw (agent-jobs.ts swallows throws, silently leaving
			// an exit-0 job marked done). Mirrors the Tour fail-closed pattern below.
			// Findings carry nullable file/line, classified into line/whole-file/
			// general by transformMarkerFindings — nothing is dropped (same as Claude).
			const markerEngine = MARKER_ENGINES[job.provider as MarkerEngineId];
			if (markerEngine) {
				// Recover the per-job nonce embedded in the prompt; without it no block
				// can be trusted, so parse fails closed below.
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

				// Derive the verdict from finding severities (like Claude) rather than
				// trusting the model's free-form `correctness` string. Marker engines
				// have no schema flag, so a model value like "not correct" would be
				// stored verbatim and the detail panel (any string containing "correct"
				// except "incorrect" → green) would invert the displayed result.
				const hasImportant = output.findings.some((f) => f.severity === "important");
				job.summary = {
					correctness: hasImportant ? "Issues Found" : "Correct",
					explanation: output.summary.explanation,
					confidence: output.summary.confidence,
				};

				// Reuse the shared ingest() decoration; add a fail-closed check on result.
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
					// The process exited 0 but the model returned empty or malformed output
					// and nothing was stored. Flip status so the client doesn't auto-open
					// a successful-looking card that 404s on /api/tour/:id.
					job.status = "failed";
					job.error = TOUR_EMPTY_OUTPUT_ERROR;
				}
				return;
			}

			if (job.provider === "guide") {
				// Validate refs against the LAUNCH-time changed-file set (snapshotted
				// on the job at buildCommand time), not the current patch — the model
				// planned section placement against that exact file set, and the
				// client already degrades stale refs per-file if the reviewer has
				// since switched diff/base/PR. Re-deriving from the current patch
				// here would spuriously invalidate every ref in an otherwise-valid
				// guide the moment the view changes mid-generation. Falls back to the
				// current patch only if the snapshot is missing (defensive; should
				// not happen in practice — see agent-jobs.ts's changedFilesSnapshot).
				const changedFiles = meta.changedFilesSnapshot ?? listPatchFiles(currentPatch).map((f) => f.path);
				const { summary, error } = await guide.onJobComplete({ job, meta, changedFiles });
				if (summary) {
					job.summary = summary;
				} else {
					// Same fail-closed precedent as Tour: an exit-0 job with empty,
					// malformed, or fully-invalidated output must not look like a
					// successful card that 404s on /api/guide/:id.
					job.status = "failed";
					job.error = error ?? GUIDE_EMPTY_OUTPUT_ERROR;
				}
				return;
			}
		},
	});
	const sharingEnabled =
		options.sharingEnabled ?? resolveSharingEnabled(loadConfig());
	const shareBaseUrl =
		(options.shareBaseUrl ?? process.env.PLANNOTATOR_SHARE_URL) || undefined;
	const pasteApiUrl =
		(options.pasteApiUrl ?? process.env.PLANNOTATOR_PASTE_URL) || undefined;
	let resolveDecision!: (result: {
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
	}>((r) => {
		resolveDecision = r;
	});

	const aiRuntime = await createPiAIRuntime({ getCwd: resolveAgentCwd });

	const server = createServer(async (req, res) => {
		const url = requestUrl(req);

		// API: Get tour result
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

		// API: Save tour checklist state
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

		// API: Get guide result
		if (url.pathname.match(/^\/api\/guide\/[^/]+$/) && req.method === "GET") {
			const jobId = url.pathname.slice("/api/guide/".length);
			const result = guide.getGuide(jobId);
			if (!result) {
				json(res, { error: "Guide not found" }, 404);
				return;
			}
			json(res, result);
			return;
		}

		// API: Save guide reviewed state
		const reviewedMatch = url.pathname.match(/^\/api\/guide\/([^/]+)\/reviewed$/);
		if (reviewedMatch && req.method === "PUT") {
			const jobId = reviewedMatch[1];
			try {
				const body = await parseBody(req) as { reviewed: boolean[] };
				if (Array.isArray(body.reviewed)) guide.saveReviewed(jobId, body.reviewed);
				json(res, { ok: true });
			} catch {
				json(res, { error: "Invalid JSON" }, 400);
			}
			return;
		}

		// API: Get a failed guide job's captured raw output for manual repair
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

		// API: Manually submit corrected guide JSON for a failed job
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
				// Fallback only — submitManualOutput prefers the job's own
				// launch-time changed-file set (guide.launchChangedFiles,
				// recorded by onJobComplete) over this current-patch derivation.
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
				json(res, { ok: true, sections, files });
			} catch {
				json(res, { error: "Invalid JSON" }, 400);
			}
			return;
		}

		if (url.pathname === "/api/diff" && req.method === "GET") {
			maybeRefreshRemoteBaseInfo();
			// Snapshot the served state BEFORE the sidecar await: the startup
			// base upgrade can land mid-await, and reading the globals after
			// it would pair a rebuilt patch with sections computed from the
			// old base — a misgrouped panel. snapshotId travels with the
			// patch it identifies: a mid-await upgrade bumps draftKey, and
			// this client's next freshness probe (echoing the OLD id) raises
			// the Refresh banner for the consistent old snapshot served here.
			const servedPatch = currentPatch;
			const servedBase = currentBase;
			const servedGitRef = currentGitRef;
			const servedError = currentError;
			const servedDiffType = currentDiffType;
			const servedHideWhitespace = currentHideWhitespace;
			const servedPRDiffScope = currentPRDiffScope;
			const servedSnapshotId = currentSnapshotId();
			const sections = await buildSectionsSidecar(servedBase, servedDiffType as string);
			const commitInfo = await buildCommitInfoSidecar(servedDiffType as string);
			json(res, {
				rawPatch: servedPatch,
				aiReviewContext: buildCurrentAiReviewContext(servedPatch, servedBase, servedDiffType as DiffType),
				gitRef: servedGitRef,
				snapshotId: servedSnapshotId,
				origin: options.origin ?? "pi",
				mode: isWorkspaceMode ? "workspace" : undefined,
				diffType: hasLocalAccess || isWorkspaceMode ? servedDiffType : undefined,
				// Echo the active base so page refresh/reconnect rehydrates the
				// picker to what the server is actually using, not the detected default.
				base: hasLocalAccess ? servedBase : undefined,
				hideWhitespace: servedHideWhitespace,
				...(workspace && { diffOptions: workspace.diffOptions }),
				gitContext: hasLocalAccess ? options.gitContext : undefined,
				sharingEnabled,
				shareBaseUrl,
				pasteApiUrl,
				repoInfo,
				isWSL: wslFlag,
				// PR mode advertises the ready PR checkout (null while warming), so
				// the Open-in button gates correctly from the initial load — not the
				// launch repo. Non-PR keeps the workspace/local cwd.
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
				...(baseBehindRemote && { baseBehindRemote: true }),
				...(servedError && { error: servedError }),
				semanticDiff: await getSemanticDiffAdvert(),
				serverConfig: getServerConfig(gitUser),
			});
		} else if (url.pathname === "/api/fetch-base" && req.method === "POST") {
			// Fetch the remote default branch so the local baseline catches up
			// with GitHub. Client re-runs /api/diff/switch afterwards.
			if (!remoteBaseCheckApplies()) {
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
			// Re-query the remote (fresh ls-remote) and recompute rather than
			// trusting a cached tip: a narrow fetch refspec can exit 0 without
			// advancing refs/remotes/origin/<branch>, so we must observe the
			// actual post-fetch state instead of silently clearing the banner.
			await refreshRemoteBaseInfo();
			json(res, { ok: true, baseBehindRemote });
		} else if (url.pathname === "/api/diff/fresh" && req.method === "GET") {
			// Cheap staleness probe — has the underlying VCS state changed since
			// the current diff snapshot was computed? Best-effort: anything that
			// cannot be fingerprinted reports fresh (no banner).
			// In PR review the local checkout can appear (pool warmup) or change
			// (in-place PR switch) after the initial /api/diff, so re-advertise it
			// on every probe — the Open-in control tracks the current checkout
			// without a page reload. Null until a usable checkout exists (the pool
			// resolves a path only once ready). Non-PR sessions omit this field.
			const prCwdAdvert = isPRMode ? { agentCwd: resolvePRLocalCwd() } : {};
			const baseline = currentFingerprint;
			// Carry baseBehindRemote on EVERY response — the client sets the flag
			// unconditionally each probe, so omitting it clears the 'behind GitHub'
			// banner for that poll (a flicker) until the next one.
			const behind = baseBehindRemote ? { baseBehindRemote: true } : {};
			// Per-CLIENT staleness: the client echoes the snapshotId it is
			// rendering; a mismatch means the SERVER's snapshot moved under it
			// (startup base upgrade, a switch from another tab, an in-place PR
			// switch) regardless of what the VCS fingerprint says. This is what
			// lets one server serve multiple tabs holding different snapshots
			// without lying to any of them. The "snapshot:" fingerprint keys
			// the client's dismissal to the server snapshot that made it stale.
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
			// A diff switch landing mid-probe replaces the snapshot (and its
			// fingerprint); report fresh and let the next poll compare against
			// the new baseline.
			if (currentFingerprint !== baseline) {
				json(res, { fresh: true, ...behind, ...prCwdAdvert });
				return;
			}
			const fresh = probe == null || probe === baseline;
			maybeRefreshRemoteBaseInfo();
			// The probe fingerprint lets the client distinguish "still the same
			// staleness I dismissed" from "ANOTHER change landed since".
			json(res, {
				fresh,
				...(fresh ? {} : { fingerprint: probe }),
				...(baseBehindRemote && { baseBehindRemote: true }),
				...prCwdAdvert,
			});
		} else if (url.pathname === "/api/semantic-diff" && req.method === "GET") {
			json(res, await getSemanticDiff(url));
		} else if (url.pathname === "/api/commits" && req.method === "GET") {
			// Linear commit history for the Commits panel (mirrors Bun review.ts).
			// Git-local sessions only — PR/workspace/jj/p4 don't offer the view.
			// Computed against the active diff's cwd (worktree-aware) and the
			// active base so the divider matches the review baseline.
			if (!options.gitContext || isPRMode || workspace || (sessionVcsType && sessionVcsType !== "git")) {
				json(res, { error: "Commit history is only available for local git reviews" }, 400);
				return;
			}
			const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
			const before = url.searchParams.get("before") ?? undefined;
			const commitsCwd = resolveVcsCwd(currentDiffType as DiffType, options.gitContext.cwd);
			const page = await listCommitHistory(reviewRuntime, currentBase, commitsCwd, {
				...(Number.isFinite(limitParam) && { limit: limitParam }),
				...(before !== undefined && { before }),
			});
			if (!page) {
				json(res, { error: "Could not read commit history" }, 500);
				return;
			}
			// Best-effort author avatars from the origin forge (memoized per
			// session; misses just render the initials fallback client-side).
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
			// Capture the ordering token BEFORE any await — body delivery can
			// finish out of arrival order under network jitter, so capturing after
			// parseBody let a slow-body OLDER request overwrite a newer one.
			const switchEpoch = ++diffSwitchEpoch;
			if (!hasLocalAccess && !workspace) {
				json(res, { error: "Not available without local file access" }, 400);
				return;
			}
			try {
				const body = await parseBody(req);
				const newType = body.diffType as DiffType | WorkspaceDiffType;
				if (!newType) {
					json(res, { error: "Missing diffType" }, 400);
					return;
				}
				// Don't commit hideWhitespace to shared state until we win the
				// epoch check — a superseded request must not leave its value.
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
					currentGitRef = snapshot.gitRef;
					currentDiffType = workspace.diffType;
					currentError = snapshot.error;
					draftKey = contentHash(currentPatch);
					captureDiffFingerprint();

					json(res, {
						rawPatch: currentPatch,
						// Snapshot arg: robust against a future await sneaking in
						// between the epoch check and this response.
						aiReviewContext: buildCurrentAiReviewContext(snapshot.rawPatch),
						gitRef: currentGitRef,
						snapshotId: currentSnapshotId(),
						diffType: currentDiffType,
						diffOptions: workspace.diffOptions,
						hideWhitespace: currentHideWhitespace,
						...(currentError ? { error: currentError } : {}),
						semanticDiff: await getSemanticDiffAdvert(),
					});
					return;
				}
				// An explicit pick from the base picker is honored verbatim —
				// the local/remote groups are distinct choices, so "main" must
				// not be canonicalized to "origin/main" when the user chose the
				// local ref on purpose. Sticky: later echoes of that choice
				// (diff-type switches, refreshes) must not re-canonicalize it.
				if (body.explicitBase === true && typeof body.base === "string" && body.base) {
					baseExplicitlyChosen = true;
				}
				const base = resolveReviewBase(
					typeof body.base === "string" ? body.base : undefined,
				);
				const defaultCwd = options.gitContext?.cwd;
				const result = await runVcsDiff(newType as DiffType, base, defaultCwd, {
					hideWhitespace: effectiveHideWhitespace,
				});
				// A newer switch superseded us — don't touch shared state.
				if (switchEpoch !== diffSwitchEpoch) {
					json(res, { superseded: true });
					return;
				}
				const previousDiffType = currentDiffType;
				currentHideWhitespace = effectiveHideWhitespace;
				currentPatch = result.patch;
				currentGitRef = result.label;
				currentDiffType = newType;
				currentBase = base;
				baseEverSwitched = true;
				currentError = result.error;
				draftKey = contentHash(currentPatch);
				captureDiffFingerprint();

				// Recompute gitContext for the effective cwd so the client's
				// sidebar reflects the worktree we're now reviewing.
				// Best-effort: on failure the client keeps its existing context.
				// Skipped for same-cwd commit:<sha> switches (the commit-rail hot
				// path — mirrors Bun review.ts): the recompute dominated click
				// latency and a historical commit's diff can't change any of it.
				let updatedContext: GitContext | undefined;
				if (options.gitContext && !isSameCwdCommitSwitch(previousDiffType as string, newType as string)) {
					try {
						const effectiveCwd = resolveVcsCwd(newType as DiffType, options.gitContext.cwd);
						updatedContext = await getVcsContext(effectiveCwd, sessionVcsType);
					} catch {
						/* best-effort */
					}
				}

				// Base may have changed — re-evaluate behind-ness from the cached
				// remote tip (cheap, local-only).
				// Await (not fire-and-forget) so the switch response carries the
				// freshly-recomputed baseBehindRemote — otherwise the banner lags a
				// poll cycle switching INTO a base-relative mode, or lingers stale
				// switching AWAY from one. Local rev-parse only; cheap.
				await recomputeBaseBehindRemote().catch(() => {});
				const sections = await buildSectionsSidecar();
				const commitInfo = await buildCommitInfoSidecar();
				const switchSemanticDiff = await getSemanticDiffAdvert();
				// Final guard: a newer switch during trailing awaits wins.
				if (switchEpoch !== diffSwitchEpoch) {
					json(res, { superseded: true });
					return;
				}
				json(res, {
					rawPatch: currentPatch,
					// Snapshot args: robust against a future await sneaking in
					// between the epoch check and this response.
					aiReviewContext: buildCurrentAiReviewContext(result.patch, base),
					gitRef: currentGitRef,
					snapshotId: currentSnapshotId(),
					diffType: currentDiffType,
					// Echo the base the server actually used. resolveBaseBranch
					// trusts the caller verbatim; this echo lets the client
					// confirm the request landed (and pick it up when the client
					// didn't supply one and we fell back to detected default).
					base: currentBase,
					hideWhitespace: currentHideWhitespace,
					...(sections ? { sections } : {}),
					...(commitInfo ? { commitInfo } : {}),
					...(baseBehindRemote ? { baseBehindRemote: true } : {}),
					...(updatedContext ? { gitContext: updatedContext } : {}),
					...(currentError ? { error: currentError } : {}),
					semanticDiff: switchSemanticDiff,
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
				// A newer scope select or pr-switch landed while this request was
				// parked on an await: drop this request's writes and return the
				// newest state so the client converges on it.
				const respondSuperseded = async () => {
					const semanticDiff = await getSemanticDiffAdvert();
					json(res, {
						rawPatch: currentPatch,
						aiReviewContext: buildCurrentAiReviewContext(),
						gitRef: currentGitRef,
						snapshotId: currentSnapshotId(),
						prDiffScope: currentPRDiffScope,
						...(layerPatchIncomplete ? { prPatchIncomplete: true, prPatchUpgradeAvailable: layerUpgradeAvailable } : {}),
						...(currentError ? { error: currentError } : {}),
						semanticDiff,
					});
				};

				if (body.scope === "layer") {
					// Upgrade path: the platform withheld per-file content for this
					// PR (too large). Once a pool checkout exists, recompute the
					// exact layer diff locally and replace the truncated API
					// reconstruction. Snapshot the PR before the await — a pr-switch
					// landing mid-recompute must not have its patch overwritten with
					// the previous PR's diff.
					const upgradeMeta = prMeta;
					let upgradeError: string | undefined;
					if (layerPatchIncomplete && options.worktreePool && upgradeMeta) {
						let upgradeCwd: string | undefined;
						try {
							upgradeCwd = (await options.worktreePool.ensure(reviewRuntime, upgradeMeta)).path;
						} catch {
							// Pool can't make a worktree (e.g. cross-repo pool after a
							// pr-switch). The initial clone is still the right repo —
							// pr-switch enforces same-project — and the recompute diffs
							// explicit SHAs (fetching missing ones), so fall back to it.
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
					currentGitRef = originalPRGitRef;
					currentError = originalPRError;
					currentPRDiffScope = "layer";
					// INVARIANT: every commit point re-keys — draftKey doubles as
					// the snapshotId clients echo on freshness probes AND the
					// draft-storage key, so it must always identify currentPatch.
					// (This was previously conditional on !layerPatchIncomplete,
					// which only stayed consistent because the full-stack branch
					// never re-keyed at all.)
					draftKey = contentHash(currentPatch);
					captureDiffFingerprint();
					json(res, {
						rawPatch: currentPatch,
						aiReviewContext: buildCurrentAiReviewContext(),
						gitRef: currentGitRef,
						snapshotId: currentSnapshotId(),
						prDiffScope: currentPRDiffScope,
						...(layerPatchIncomplete ? { prPatchIncomplete: true, prPatchUpgradeAvailable: layerUpgradeAvailable } : {}),
						...((currentError ?? upgradeError) ? { error: currentError ?? upgradeError } : {}),
						semanticDiff: await getSemanticDiffAdvert(),
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
				currentGitRef = result.label;
				currentError = undefined;
				currentPRDiffScope = "full-stack";
				// INVARIANT: every commit point re-keys (see the layer branch).
				// Skipping this advertised the LAYER snapshot id for the
				// full-stack patch — stale layer tabs never got the banner and
				// full-stack drafts collided with layer drafts.
				draftKey = contentHash(currentPatch);
				captureDiffFingerprint();
				json(res, {
					rawPatch: currentPatch,
					aiReviewContext: buildCurrentAiReviewContext(),
					gitRef: currentGitRef,
					snapshotId: currentSnapshotId(),
					prDiffScope: currentPRDiffScope,
					semanticDiff: await getSemanticDiffAdvert(),
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
				const pr = cached ?? await fetchPR(newRef);
				if (!cached) prSwitchCache.set(body.url, pr);
				// Bump the scope epoch so a scope request parked on a long await
				// cannot overwrite this switch.
				prScopeEpoch++;
				prMeta = pr.metadata;
				prRef = prRefFromMetadata(pr.metadata);
				warmPRContext(pr.metadata.url, prRef);
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
					prMetadata: pr.metadata,
					// The new PR's checkout (null while warming) so Open-in re-roots
					// immediately on switch instead of waiting for the 5s probe.
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
		} else if (url.pathname === "/api/pr-action" && req.method === "POST") {
			if (!isPRMode || !prMeta || !prRef) {
				json(res, { error: "Not in PR mode" }, 400);
				return;
			}
			try {
				const body = await parseBody(req);
				const fileComments = (body.fileComments as PRReviewFileComment[]) || [];
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

				console.error(`[pr-action] ${body.action} with ${fileComments.length} file comment(s), target=${targetUrl}, headSha=${targetHeadSha}`);
				await submitPRReview(
					targetRef,
					targetHeadSha,
					body.action as "approve" | "comment",
					body.body as string,
					fileComments,
				);
				console.error(`[pr-action] Success`);
				prContextLive.refreshAfterWrite(targetUrl, targetRef);
				json(res, { ok: true, prUrl: targetUrl });
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
		} else if (url.pathname === "/api/file-content" && req.method === "GET") {
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

			if (workspace) {
				try {
					const result = await workspace.getFileContents(filePath, oldPath);
					json(res, result);
				} catch (error) {
					json(
						res,
						{ error: error instanceof Error ? error.message : "No file access available" },
						400,
					);
				}
				return;
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
				if (!baseRef) {
					json(res, { oldContent: null, newContent: null });
					return;
				}
				const result = await getFileContentsForDiffCore(
					reviewRuntime,
					"merge-base",
					baseRef,
					filePath,
					oldPath,
					fileContentCwd,
				);
				json(res, result);
				return;
			}

			// Local mode first (matches Bun server priority)
			if (hasLocalAccess && !isPRMode) {
				const base = resolveReviewBase(
					url.searchParams.get("base") ?? undefined,
				);
				const defaultCwd = options.gitContext?.cwd;
				const result = await getVcsFileContentsForDiff(
					currentDiffType as DiffType,
					base,
					filePath,
					oldPath,
					defaultCwd,
				);
				json(res, result);
				return;
			}

			// PR mode: fetch from platform API using merge-base/head SHAs
			if (isPRMode && prRef && prMeta) {
				try {
					const oldSha = prMeta.mergeBaseSha ?? prMeta.baseSha;
					const [oldContent, newContent] = await Promise.all([
						fetchPRFileContent(prRef, oldSha, oldPath || filePath),
						fetchPRFileContent(prRef, prMeta.headSha, filePath),
					]);
					json(res, { oldContent, newContent });
				} catch (err) {
					json(
						res,
						{
							error:
								err instanceof Error
									? err.message
									: "Failed to fetch file content",
						},
						500,
					);
				}
				return;
			}

			json(res, { error: "No file access available" }, 400);
		} else if (url.pathname === "/api/code-nav/resolve" && req.method === "POST") {
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
		} else if (url.pathname === "/api/code-nav/file" && req.method === "GET") {
			const hasCodeNavAccess = !!workspace || !!options.gitContext || !!options.agentCwd || !!options.worktreePool;
			if (!hasCodeNavAccess) {
				json(res, { error: "Code navigation requires local access" }, 400);
				return;
			}
			const filePath = url.searchParams.get("path");
			if (!filePath) {
				json(res, { error: "Missing path" }, 400);
				return;
			}
			try { validateFilePath(filePath); } catch {
				json(res, { error: "Invalid path" }, 400);
				return;
			}
			try {
				const navCwd = resolveAgentCwd();
				const content = readFileSync(`${navCwd}/${filePath}`, "utf-8");
				json(res, { content });
			} catch {
				json(res, { error: "File not found" }, 404);
			}
		} else if (url.pathname === "/api/config" && req.method === "POST") {
			try {
				const body = (await parseBody(req)) as { displayName?: string; diffOptions?: Record<string, unknown>; conventionalComments?: boolean };
				const toSave: Record<string, unknown> = {};
				if (body.displayName !== undefined) toSave.displayName = body.displayName;
				if (body.diffOptions !== undefined) toSave.diffOptions = body.diffOptions;
				if (body.conventionalComments !== undefined) toSave.conventionalComments = body.conventionalComments;
				if (Object.keys(toSave).length > 0) saveConfig(toSave as Parameters<typeof saveConfig>[0]);
				json(res, { ok: true });
			} catch {
				json(res, { error: "Invalid request" }, 400);
			}
		} else if (url.pathname === "/api/image") {
			handleImageRequest(res, url);
		} else if (url.pathname === "/api/upload" && req.method === "POST") {
			await handleUploadRequest(req, res);
		} else if (url.pathname === "/api/agents" && req.method === "GET") {
			json(res, { agents: [] });
		} else if (
			url.pathname === "/api/agents/review-profiles" &&
			req.method === "GET"
		) {
			// Custom reviews discovery. Reloaded per request, no file watching.
			// Catalog only — directory listing, no SKILL.md bodies read here.
			// Bodies are read at launch, for the one selected skill.
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
			// All discovered skills for the "add a review" picker, each flagged
			// with whether it is already enabled.
			json(res, { skills: listAllSkills() });
		} else if (url.pathname === "/api/agents/review-skills" && req.method === "POST") {
			// Enable a skill as a review (curation write to review-skills.json).
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
		} else if (url.pathname === "/api/git-add" && req.method === "POST") {
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
				if (isPRMode || !(await canStageFiles(currentDiffType as DiffType, stageCwd))) {
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
			// Remote/headless sessions can't open apps on the user's machine —
			// report unavailable so the UI hides the control entirely.
			if (isRemote) {
				json(res, { available: false, apps: [] });
				return;
			}
			json(res, { available: true, apps: getAvailableOpenInApps() });
		} else if (url.pathname === "/api/open-in" && req.method === "POST") {
			if (isRemote) {
				json(res, { ok: false, error: "Open in app is unavailable in remote sessions" }, 400);
				return;
			}
			try {
				const body = await parseBody(req);
				const filePath = body.filePath;
				if (typeof filePath !== "string" || !filePath) {
					json(res, { ok: false, error: "Missing filePath" }, 400);
					return;
				}
				const appId = typeof body.appId === "string" ? body.appId : undefined;
				// Resolve repo-relative `git diff` paths against the VCS root
				// server-side (resolveAgentCwd folds in workspace.root, the PR
				// local checkout, resolveVcsCwd(gitContext.cwd), and process.cwd())
				// — not the client `base`, which is wrong when review runs from a
				// subdirectory — then containment-check.
				const abs = resolveOpenInTarget(filePath, null, resolveOpenInRoot);
				if (abs == null) {
					json(res, { ok: false, error: "Path is outside the allowed directory" }, 403);
					return;
				}
				const result = await openFileInApp(abs, appId);
				json(res, result, 200);
			} catch (err) {
				json(
					res,
					{ ok: false, error: err instanceof Error ? err.message : "Failed to open file" },
					500,
				);
			}
		} else if (url.pathname === "/api/draft") {
			await handleDraftRequest(req, res, draftKey);
		} else if (url.pathname === "/favicon.png") {
			handleFavicon(res);
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
			// AI sessions pin their cwd at creation — make sure the PR checkout
			// exists first so sessions never root in a transient fallback
			// (mirrors the Bun server; no-op while the pool entry is ready).
			if (req.method === "POST" && url.pathname === "/api/ai/session" && options.worktreePool && prMeta) {
				// If the checkout can't be produced, refuse instead of starting a
				// session rooted in the wrong directory.
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
			deleteDraft(draftKey, readDraftGenerationFromUrl(req));
			resolveDecision({ approved: false, feedback: '', annotations: [], exit: true });
			json(res, { ok: true });
		} else if (url.pathname === "/api/feedback" && req.method === "POST") {
			try {
				const body = await parseBody(req);
				deleteDraft(draftKey, readDraftGenerationFromBody(body));
				resolveDecision({
					approved: (body.approved as boolean) ?? false,
					feedback: (body.feedback as string) || "",
					annotations: (body.annotations as unknown[]) || [],
					agentSwitch: body.agentSwitch as string | undefined,
				});
				json(res, { ok: true });
			} catch (err) {
				const message = err instanceof Error ? err.message : "Failed to process feedback";
				json(res, { error: message }, 500);
			}
		} else if (url.pathname.startsWith("/api/")) {
			handleApiNotFound(res, url.pathname);
		} else {
			html(res, options.htmlContent);
		}
	});

	const { port, portSource } = await listenOnPort(server);
	serverUrl = `http://localhost:${port}`;
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
		stop: () => {
			process.removeListener("exit", exitHandler);
			agentJobs.killAll();
			aiRuntime?.dispose();
			server.close();
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
