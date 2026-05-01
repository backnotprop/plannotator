import { execSync, spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";

import { Readable } from "node:stream";

import { contentHash, deleteDraft } from "../generated/draft.js";
import { loadConfig, saveConfig, detectGitUser, getServerConfig } from "../generated/config.js";

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
} from "../generated/pr-provider.js";
import {
	type DiffType,
	type GitCommandResult,
	type GitContext,
	type GitDiffOptions,
	detectRemoteDefaultBranch,
	getFileContentsForDiff as getFileContentsForDiffCore,
	getGitContext as getGitContextCore,
	gitAddFile as gitAddFileCore,
	gitResetFile as gitResetFileCore,
	parseWorktreeDiffType,
	resolveBaseBranch,
	type ReviewGitRuntime,
	runGitDiff as runGitDiffCore,
	validateFilePath,
} from "../generated/review-core.js";
import {
	checkoutPRHead,
	getPRDiffScopeOptions,
	getPRStackInfo,
	resolveStackInfo,
	resolvePRFullStackBaseRef,
	runPRFullStackDiff,
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
import { html, json, parseBody, requestUrl, toWebRequest } from "./helpers.js";

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
	buildCodexReviewUserMessage,
	buildCodexCommand,
	generateOutputPath,
	parseCodexOutput,
	transformReviewFindings,
} from "../generated/codex-review.js";
import {
	CLAUDE_REVIEW_PROMPT,
	buildClaudeCommand,
	parseClaudeStreamOutput,
	transformClaudeFindings,
} from "../generated/claude-review.js";
import { createTourSession, TOUR_EMPTY_OUTPUT_ERROR } from "../generated/tour-review.js";

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

export const reviewRuntime: ReviewGitRuntime = {
	runGit(
		args: string[],
		options?: { cwd?: string; timeoutMs?: number },
	): Promise<GitCommandResult> {
		return new Promise((resolve) => {
			const proc = spawn("git", ["-c", "core.quotePath=false", ...args], {
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

			proc.on("close", (code) => {
				if (timer) clearTimeout(timer);
				resolve({
					stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
					stderr: Buffer.concat(stderrChunks).toString("utf-8"),
					exitCode: code ?? 1,
				});
			});

			proc.on("error", () => {
				if (timer) clearTimeout(timer);
				resolve({ stdout: "", stderr: "git not found", exitCode: 1 });
			});
		});
	},

	async readTextFile(path: string): Promise<string | null> {
		try {
			return readFileSync(path, "utf-8");
		} catch {
			return null;
		}
	},
};

export function getGitContext(cwd?: string): Promise<GitContext> {
	return getGitContextCore(reviewRuntime, cwd);
}

export function runGitDiff(
	diffType: DiffType,
	defaultBranch = "main",
	cwd?: string,
	options?: GitDiffOptions,
): Promise<{ patch: string; label: string; error?: string }> {
	return runGitDiffCore(reviewRuntime, diffType, defaultBranch, cwd, options);
}

export async function startReviewServer(options: {
	rawPatch: string;
	gitRef: string;
	htmlContent: string;
	origin?: string;
	diffType?: DiffType;
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
	/** Working directory for agent processes (e.g., --local worktree). Independent of diff pipeline. */
	agentCwd?: string;
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
	const hasLocalAccess = !!options.gitContext;
	const isRemote = isRemoteSession();
	const wslFlag = detectWSL();
	let prRef = prMeta ? prRefFromMetadata(prMeta) : null;
	const platformUser = prRef ? await getPRUser(prRef) : null;
	let prStackInfo = isPRMode ? getPRStackInfo(prMeta) : null;
	let prDiffScopeOptions = isPRMode
		? getPRDiffScopeOptions(prMeta, !!(options.worktreePool || options.agentCwd))
		: [];

	let prListCache: import("../generated/pr-provider.js").PRListItem[] | null = null;
	let prListCacheTime = 0;
	const prSwitchCache = new Map<string, { metadata: PRMetadata; rawPatch: string }>();
	if (isPRMode && prMeta) prSwitchCache.set(prMeta.url, { metadata: prMeta, rawPatch: options.rawPatch });
	const prStackTreeCache = new Map<string, import("../generated/pr-provider.js").PRStackTree | null>();

	// Fetch full stack tree (best-effort — always try in PR mode so root PRs
	// that target the default branch can still discover descendant PRs)
	let prStackTree: import("../generated/pr-provider.js").PRStackTree | null = null;
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
		: getRepoInfo();
	const editorAnnotations = createEditorAnnotationHandler();
	const externalAnnotations = createExternalAnnotationHandler("review");

	let currentPatch = options.rawPatch;
	let currentGitRef = options.gitRef;
	let currentDiffType: DiffType = options.diffType || "uncommitted";
	let currentError = options.error;
	let currentHideWhitespace = loadConfig().diffOptions?.hideWhitespace ?? false;
	let originalPRPatch = options.rawPatch;
	let originalPRGitRef = options.gitRef;
	let originalPRError = options.error;
	let currentPRDiffScope: PRDiffScope = "layer";
	// Tracks the base branch the user picked from the UI. Agent review prompts
	// read this (not gitContext.defaultBranch) so they analyze the same diff
	// the reviewer is currently looking at. Honors an explicit initialBase from
	// the caller — e.g. programmatic Pi callers can request a non-detected base.
	let currentBase = options.initialBase || options.gitContext?.defaultBranch || "main";
	let baseEverSwitched = false;

	// Fire-and-forget: query the remote for its actual default branch.
	if (options.gitContext && !options.initialBase && !isPRMode) {
		detectRemoteDefaultBranch(reviewRuntime, options.gitContext.cwd).then((remote) => {
			if (remote && !baseEverSwitched) currentBase = remote;
		});
	}

	// Agent jobs — background process manager (late-binds serverUrl via getter)
	let serverUrl = "";
	function resolveAgentCwd(): string {
		if (options.worktreePool && prMeta) {
			const poolPath = options.worktreePool.resolve(prMeta.url);
			if (poolPath) return poolPath;
		}
		if (options.agentCwd) return options.agentCwd;
		if (currentDiffType.startsWith("worktree:")) {
			const parsed = parseWorktreeDiffType(currentDiffType);
			if (parsed) return parsed.path;
		}
		return options.gitContext?.cwd ?? process.cwd();
	}
	const tour = createTourSession();

	const agentJobs = createAgentJobHandler({
		mode: "review",
		getServerUrl: () => serverUrl,
		getCwd: resolveAgentCwd,

		async buildCommand(provider, config) {
			const cwd = resolveAgentCwd();
			const hasAgentLocalAccess = !!options.worktreePool || !!options.agentCwd || !!options.gitContext;
			const userMessageOptions = { defaultBranch: currentBase, hasLocalAccess: hasAgentLocalAccess, prDiffScope: currentPRDiffScope };

			// Snapshot the diff context at launch (see review.ts buildCommand
			// for the rationale — keeps downstream "Copy All" honest across
			// subsequent context switches).
			const worktreeParts = currentDiffType.startsWith("worktree:")
				? parseWorktreeDiffType(currentDiffType)
				: null;
			const launchPrUrl = prMeta?.url;
			const launchDiffScope = isPRMode ? currentPRDiffScope : undefined;
			const diffContext: AgentJobInfo["diffContext"] | undefined = prMeta
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
					prMetadata: prMeta,
					config,
				});
				return built ? { ...built, prUrl: launchPrUrl, diffScope: launchDiffScope, diffContext } : built;
			}

			const userMessage = buildCodexReviewUserMessage(currentPatch, currentDiffType, userMessageOptions, prMeta);

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
					const annotations = transformReviewFindings(output.findings, job.source, cwd, "Codex")
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
					const annotations = transformClaudeFindings(output.findings, job.source, cwd)
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
		options.sharingEnabled ?? process.env.PLANNOTATOR_SHARE !== "disabled";
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

	// AI provider setup (graceful — AI features degrade if SDK unavailable)
	// Types are `any` because @plannotator/ai is a dynamic import
	let aiEndpoints: Record<string, (req: Request) => Promise<Response>> | null =
		null;
	let aiSessionManager: { disposeAll: () => void } | null = null;
	let aiRegistry: { disposeAll: () => void } | null = null;
	try {
		const ai = await import("../generated/ai/index.js");
		const registry = new ai.ProviderRegistry();
		const sessionManager = new ai.SessionManager();

		// which() helper for Node.js
		const whichCmd = (cmd: string): string | null => {
			try {
				return (
					execSync(`which ${cmd}`, {
						encoding: "utf-8",
						stdio: ["pipe", "pipe", "pipe"],
					}).trim() || null
				);
			} catch {
				return null;
			}
		};

		// Claude Agent SDK
		try {
			// @ts-ignore — dynamic import; Bun-only types resolved at runtime
			await import("../generated/ai/providers/claude-agent-sdk.js");
			const claudePath = whichCmd("claude");
			const provider = await ai.createProvider({
				type: "claude-agent-sdk",
				cwd: process.cwd(),
				...(claudePath && { claudeExecutablePath: claudePath }),
			});
			registry.register(provider);
		} catch {
			/* Claude SDK not available */
		}

		// Codex SDK
		try {
			// @ts-ignore — dynamic import; Bun-only types resolved at runtime
			await import("../generated/ai/providers/codex-sdk.js");
			await import("@openai/codex-sdk");
			const codexPath = whichCmd("codex");
			const provider = await ai.createProvider({
				type: "codex-sdk",
				cwd: process.cwd(),
				...(codexPath && { codexExecutablePath: codexPath }),
			});
			registry.register(provider);
		} catch {
			/* Codex SDK not available */
		}

		// Pi SDK (Node.js variant)
		try {
			await import("../generated/ai/providers/pi-sdk-node.js");
			const piPath = whichCmd("pi");
			if (piPath) {
				const provider = await ai.createProvider({
					type: "pi-sdk",
					cwd: process.cwd(),
					piExecutablePath: piPath,
				} as any);
				if (provider && "fetchModels" in provider) {
					await (
						provider as { fetchModels: () => Promise<void> }
					).fetchModels();
				}
				registry.register(provider);
			}
		} catch {
			/* Pi not available */
		}

		// OpenCode SDK
		try {
			// @ts-ignore — dynamic import; Bun-only types resolved at runtime
			await import("../generated/ai/providers/opencode-sdk.js");
			const opencodePath = whichCmd("opencode");
			if (opencodePath) {
				const provider = await ai.createProvider({
					type: "opencode-sdk",
					cwd: process.cwd(),
				});
				if (provider && "fetchModels" in provider) {
					await (
						provider as { fetchModels: () => Promise<void> }
					).fetchModels();
				}
				registry.register(provider);
			}
		} catch {
			/* OpenCode not available */
		}

		if (registry.size > 0) {
			aiEndpoints = ai.createAIEndpoints({
				registry,
				sessionManager,
				getCwd: resolveAgentCwd,
			});
			aiSessionManager = sessionManager;
			aiRegistry = registry;
		}
	} catch {
		/* AI backbone not available */
	}

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
				diffType: hasLocalAccess ? currentDiffType : undefined,
				// Echo the active base so page refresh/reconnect rehydrates the
				// picker to what the server is actually using, not the detected default.
				base: hasLocalAccess ? currentBase : undefined,
				hideWhitespace: currentHideWhitespace,
				gitContext: hasLocalAccess ? options.gitContext : undefined,
				sharingEnabled,
				shareBaseUrl,
				pasteApiUrl,
				repoInfo,
				isWSL: wslFlag,
				...(options.agentCwd && { agentCwd: options.agentCwd }),
				...(isPRMode && {
					prMetadata: prMeta,
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
		} else if (url.pathname === "/api/diff/switch" && req.method === "POST") {
			if (!hasLocalAccess) {
				json(res, { error: "Not available without local file access" }, 400);
				return;
			}
			try {
				const body = await parseBody(req);
				const newType = body.diffType as DiffType;
				if (!newType) {
					json(res, { error: "Missing diffType" }, 400);
					return;
				}
				if (typeof body.hideWhitespace === "boolean") {
					currentHideWhitespace = body.hideWhitespace;
				}
				const detectedBase = options.gitContext?.defaultBranch || "main";
				const base = resolveBaseBranch(
					typeof body.base === "string" ? body.base : undefined,
					detectedBase,
				);
				const defaultCwd = options.gitContext?.cwd;
				const result = await runGitDiff(newType, base, defaultCwd, {
					hideWhitespace: currentHideWhitespace,
				});
				currentPatch = result.patch;
				currentGitRef = result.label;
				currentDiffType = newType;
				currentBase = base;
				baseEverSwitched = true;
				currentError = result.error;

				// Recompute gitContext for the effective cwd so the client's
				// sidebar reflects the worktree we're now reviewing.
				// Best-effort: on failure the client keeps its existing context.
				let updatedContext: GitContext | undefined;
				if (options.gitContext) {
					try {
						const worktreeParsed = parseWorktreeDiffType(newType);
						const effectiveCwd = worktreeParsed?.path ?? options.gitContext.cwd;
						updatedContext = await getGitContextCore(reviewRuntime, effectiveCwd);
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

				if (body.scope === "layer") {
					currentPatch = originalPRPatch;
					currentGitRef = originalPRGitRef;
					currentError = originalPRError;
					currentPRDiffScope = "layer";
					json(res, {
						rawPatch: currentPatch,
						gitRef: currentGitRef,
						prDiffScope: currentPRDiffScope,
						...(currentError ? { error: currentError } : {}),
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

				currentPatch = result.patch;
				currentGitRef = result.label;
				currentError = undefined;
				currentPRDiffScope = "full-stack";
				json(res, {
					rawPatch: currentPatch,
					gitRef: currentGitRef,
					prDiffScope: currentPRDiffScope,
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
				prMeta = pr.metadata;
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
					repoInfo,
					...(switchedViewedFiles.length > 0 && { viewedFiles: switchedViewedFiles }),
					...(currentError ? { error: currentError } : {}),
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
				const detectedBase = options.gitContext?.defaultBranch || "main";
				const base = resolveBaseBranch(
					url.searchParams.get("base") ?? undefined,
					detectedBase,
				);
				const defaultCwd = options.gitContext?.cwd;
				const result = await getFileContentsForDiffCore(
					reviewRuntime,
					currentDiffType,
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
			// Staging only available for local diff types that support it (not PR mode, not branch diffs).
			// Worktree diff types use composite format "worktree:/path:uncommitted" — extract the base type.
			const baseDiffType = currentDiffType.startsWith("worktree:")
				? (parseWorktreeDiffType(currentDiffType)?.subType ?? currentDiffType)
				: currentDiffType;
			const canStage = baseDiffType === "uncommitted" || baseDiffType === "unstaged";
			if (isPRMode || !canStage) {
				json(res, { error: "Staging not available" }, 400);
				return;
			}
			try {
				const body = await parseBody(req);
				const filePath = body.filePath as string | undefined;
				if (!filePath) {
					json(res, { error: "Missing filePath" }, 400);
					return;
				}
				let cwd: string | undefined;
				if (currentDiffType.startsWith("worktree:")) {
					const parsed = parseWorktreeDiffType(currentDiffType);
					if (parsed) cwd = parsed.path;
				}
				if (!cwd) {
					cwd = options.gitContext?.cwd;
				}
				if (body.undo) {
					await gitResetFileCore(reviewRuntime, filePath, cwd);
				} else {
					await gitAddFileCore(reviewRuntime, filePath, cwd);
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
		} else if (aiEndpoints && url.pathname.startsWith("/api/ai/")) {
			const handler = aiEndpoints[url.pathname];
			if (handler) {
				try {
					const webReq = toWebRequest(req);
					const webRes = await handler(webReq);
					// Pipe Web Response → node:http response
					const headers: Record<string, string> = {};
					webRes.headers.forEach((v, k) => {
						headers[k] = v;
					});
					res.writeHead(webRes.status, headers);
					if (webRes.body) {
						const nodeStream = Readable.fromWeb(webRes.body as any);
						nodeStream.pipe(res);
					} else {
						res.end();
					}
				} catch (err) {
					json(
						res,
						{ error: err instanceof Error ? err.message : "AI endpoint error" },
						500,
					);
				}
				return;
			}
			json(res, { error: "Not found" }, 404);
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
			aiSessionManager?.disposeAll();
			aiRegistry?.disposeAll();
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
