import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import { basename } from "node:path";

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
	type PRReviewFileComment,
	prRefFromMetadata,
} from "../generated/pr-types.js";
import {
	type DiffType,
	type GitContext,
	getFileContentsForDiff as getFileContentsForDiffCore,
	parseWorktreeDiffType,
	resolveBaseBranch,
	validateFilePath,
} from "../generated/review-core.js";
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

import type { WorktreePool } from "../generated/worktree-pool.js";

import { createEditorAnnotationHandler } from "./annotations.js";
import { createAgentJobHandler } from "./agent-jobs.js";
import type { AgentJobInfo } from "../generated/agent-jobs.js";
import { createExternalAnnotationHandler } from "./external-annotations.js";
import {
	handleDraftRequest,
	handleFavicon,
	handleImageRequest,
	handleUploadRequest,
} from "./handlers.js";
import { html, json, parseBody, requestUrl } from "./helpers.js";
import { createPiAIRuntime, handlePiAIRequest } from "./ai-runtime.js";

import { isRemoteSession, listenOnPort } from "./network.js";
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
	submitPRReview,
} from "./pr.js";
import { getRepoInfo } from "./project.js";
import {
	CODEX_REVIEW_SYSTEM_PROMPT,
	buildCodexCommand,
	generateOutputPath,
	parseCodexOutput,
	transformReviewFindings,
} from "../generated/codex-review.js";
import { buildAgentReviewUserMessage, buildAgentReviewUserMessageForTarget, type WorkspaceReviewPromptContext } from "../generated/agent-review-message.js";
import {
	CLAUDE_REVIEW_PROMPT,
	buildClaudeCommand,
	parseClaudeStreamOutput,
	transformClaudeFindings,
} from "../generated/claude-review.js";
import { createTourSession, TOUR_EMPTY_OUTPUT_ERROR } from "../generated/tour-review.js";
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

	// Fetch full stack tree (best-effort — always try in PR mode so root PRs
	// that target the default branch can still discover descendant PRs)
	let prStackTree: import("../generated/pr-types.js").PRStackTree | null = null;
	if (prRef && prMeta) {
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
	// Tracks the base branch the user picked from the UI. Agent review prompts
	// read this (not gitContext.defaultBranch) so they analyze the same diff
	// the reviewer is currently looking at. Honors an explicit initialBase from
	// the caller — e.g. programmatic Pi callers can request a non-detected base.
	const detectedCompareTarget = (): string =>
		options.gitContext?.defaultBranch || options.gitContext?.compareTarget?.fallback || "main";
	let currentBase = options.initialBase || detectedCompareTarget();
	let baseEverSwitched = false;

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

	// Fire-and-forget: query the remote for its actual default branch.
	if (options.gitContext && !options.initialBase && !isPRMode) {
		detectRemoteDefaultCompareTarget(options.gitContext.cwd, sessionVcsType).then((remote) => {
			if (remote && !baseEverSwitched) currentBase = remote;
		});
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
	function getWorkspacePromptContext(): WorkspaceReviewPromptContext | undefined {
		if (!workspace) return undefined;
		return workspace.getPromptContext();
	}
	const tour = createTourSession();
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
				return built ? { ...built, prUrl: launchPrUrl, diffScope: launchDiffScope, diffContext } : built;
			}

			const userMessage = workspacePrompt
				? buildAgentReviewUserMessageForTarget({
						kind: "workspace",
						patch: currentPatch,
						workspace: workspacePrompt,
					})
				: buildAgentReviewUserMessage(currentPatch, currentDiffType as DiffType, userMessageOptions, prMeta);
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

			if (job.provider === "codex" && meta.outputPath) {
				const output = await parseCodexOutput(meta.outputPath);
				if (!output) return;

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

		if (url.pathname === "/api/diff" && req.method === "GET") {
			json(res, {
				rawPatch: currentPatch,
				gitRef: currentGitRef,
				origin: options.origin ?? "pi",
				mode: isWorkspaceMode ? "workspace" : undefined,
				diffType: hasLocalAccess || isWorkspaceMode ? currentDiffType : undefined,
				// Echo the active base so page refresh/reconnect rehydrates the
				// picker to what the server is actually using, not the detected default.
				base: hasLocalAccess ? currentBase : undefined,
				hideWhitespace: currentHideWhitespace,
				...(workspace && { diffOptions: workspace.diffOptions }),
				gitContext: hasLocalAccess ? options.gitContext : undefined,
				sharingEnabled,
				shareBaseUrl,
				pasteApiUrl,
				repoInfo,
				isWSL: wslFlag,
				...(options.agentCwd && { agentCwd: options.agentCwd }),
				...(workspace && { agentCwd: workspace.root }),
				...(isPRMode && {
					prMetadata: prMeta,
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
		} else if (url.pathname === "/api/diff/fresh" && req.method === "GET") {
			// Cheap staleness probe — has the underlying VCS state changed since
			// the current diff snapshot was computed? Best-effort: anything that
			// cannot be fingerprinted reports fresh (no banner).
			const baseline = currentFingerprint;
			if (baseline == null) {
				json(res, { fresh: true });
				return;
			}
			const probe = await computeDiffFingerprint();
			// A diff switch landing mid-probe replaces the snapshot (and its
			// fingerprint); report fresh and let the next poll compare against
			// the new baseline.
			if (currentFingerprint !== baseline) {
				json(res, { fresh: true });
				return;
			}
			const fresh = probe == null || probe === baseline;
			// The probe fingerprint lets the client distinguish "still the same
			// staleness I dismissed" from "ANOTHER change landed since".
			json(res, { fresh, ...(fresh ? {} : { fingerprint: probe }) });
		} else if (url.pathname === "/api/semantic-diff" && req.method === "GET") {
			json(res, await getSemanticDiff(url));
		} else if (url.pathname === "/api/diff/switch" && req.method === "POST") {
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
				if (typeof body.hideWhitespace === "boolean") {
					currentHideWhitespace = body.hideWhitespace;
				}
				if (workspace) {
					const snapshot = await workspace.rebuild({
						diffType: newType,
						hideWhitespace: currentHideWhitespace,
					});
					currentPatch = snapshot.rawPatch;
					currentGitRef = snapshot.gitRef;
					currentDiffType = workspace.diffType;
					currentError = snapshot.error;
					draftKey = contentHash(currentPatch);
					captureDiffFingerprint();

					json(res, {
						rawPatch: currentPatch,
						gitRef: currentGitRef,
						diffType: currentDiffType,
						diffOptions: workspace.diffOptions,
						hideWhitespace: currentHideWhitespace,
						...(currentError ? { error: currentError } : {}),
						semanticDiff: await getSemanticDiffAdvert(),
					});
					return;
				}
				const detectedBase = detectedCompareTarget();
				const base = resolveBaseBranch(
					typeof body.base === "string" ? body.base : undefined,
					detectedBase,
				);
				const defaultCwd = options.gitContext?.cwd;
				const result = await runVcsDiff(newType as DiffType, base, defaultCwd, {
					hideWhitespace: currentHideWhitespace,
				});
				currentPatch = result.patch;
				currentGitRef = result.label;
				currentDiffType = newType;
				currentBase = base;
				baseEverSwitched = true;
				currentError = result.error;
				captureDiffFingerprint();

				// Recompute gitContext for the effective cwd so the client's
				// sidebar reflects the worktree we're now reviewing.
				// Best-effort: on failure the client keeps its existing context.
				let updatedContext: GitContext | undefined;
				if (options.gitContext) {
					try {
						const effectiveCwd = resolveVcsCwd(newType as DiffType, options.gitContext.cwd);
						updatedContext = await getVcsContext(effectiveCwd, sessionVcsType);
					} catch {
						/* best-effort */
					}
				}

				json(res, {
					rawPatch: currentPatch,
					gitRef: currentGitRef,
					diffType: currentDiffType,
					// Echo the base the server actually used. resolveBaseBranch
					// trusts the caller verbatim; this echo lets the client
					// confirm the request landed (and pick it up when the client
					// didn't supply one and we fell back to detected default).
					base: currentBase,
					hideWhitespace: currentHideWhitespace,
					...(updatedContext ? { gitContext: updatedContext } : {}),
					...(currentError ? { error: currentError } : {}),
					semanticDiff: await getSemanticDiffAdvert(),
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
						gitRef: currentGitRef,
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
					// The upgrade changed the patch this session serves; drafts must
					// key off it so a pr-switch round-trip (which rehashes from the
					// cache) resolves to the same key.
					if (!layerPatchIncomplete) draftKey = contentHash(currentPatch);
					captureDiffFingerprint();
					json(res, {
						rawPatch: currentPatch,
						gitRef: currentGitRef,
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
				captureDiffFingerprint();
				json(res, {
					rawPatch: currentPatch,
					gitRef: currentGitRef,
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
					gitRef: currentGitRef,
					prMetadata: pr.metadata,
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
			if (!isPRMode || !prRef) {
				json(res, { error: "Not in PR mode" }, 400);
				return;
			}
			try {
				const context = await fetchPRContext(prRef);
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
				const detectedBase = detectedCompareTarget();
				const base = resolveBaseBranch(
					url.searchParams.get("base") ?? undefined,
					detectedBase,
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
		} else if (url.pathname === "/api/draft") {
			await handleDraftRequest(req, res, draftKey);
		} else if (url.pathname === "/favicon.svg") {
			handleFavicon(res);
		} else if (await editorAnnotations.handle(req, res, url)) {
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
			// Unmatched /api/ai/* paths fall through to the app shell, same as
			// the original dispatch chain.
			html(res, options.htmlContent);
		} else if (url.pathname === "/api/exit" && req.method === "POST") {
			deleteDraft(draftKey);
			resolveDecision({ approved: false, feedback: '', annotations: [], exit: true });
			json(res, { ok: true });
		} else if (url.pathname === "/api/feedback" && req.method === "POST") {
			try {
				const body = await parseBody(req);
				deleteDraft(draftKey);
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
