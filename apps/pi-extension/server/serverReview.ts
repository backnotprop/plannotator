import { execSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

import { Readable } from "node:stream";

import { contentHash, deleteDraft } from "../generated/draft.js";

export type {
	DiffOption,
	DiffType,
	GitContext,
} from "../generated/review-core.js";

import {
	getDisplayRepo,
	getMRLabel,
	getMRNumberLabel,
	type PRMetadata,
	type PRReviewFileComment,
	prRefFromMetadata,
} from "../generated/pr-provider.js";
import {
	type DiffType,
	type GitCommandResult,
	type GitContext,
	getFileContentsForDiff as getFileContentsForDiffCore,
	getGitContext as getGitContextCore,
	gitAddFile as gitAddFileCore,
	gitResetFile as gitResetFileCore,
	parseWorktreeDiffType,
	type ReviewGitRuntime,
	runGitDiff as runGitDiffCore,
	validateFilePath,
} from "../generated/review-core.js";

import { createEditorAnnotationHandler } from "./annotations.js";
import {
	handleDraftRequest,
	handleFavicon,
	handleImageRequest,
	handleUploadRequest,
} from "./handlers.js";
import { html, json, parseBody, requestUrl, toWebRequest } from "./helpers.js";

import { listenOnPort } from "./network.js";
import {
	fetchPRContext,
	fetchPRFileContent,
	fetchPRViewedFiles,
	getPRUser,
	markPRFilesViewed,
	submitPRReview,
} from "./pr.js";
import { getRepoInfo } from "./project.js";

export interface ReviewServerResult {
	port: number;
	portSource: "env" | "remote-default" | "random";
	url: string;
	waitForDecision: () => Promise<{
		approved: boolean;
		feedback: string;
		annotations: unknown[];
		agentSwitch?: string;
	}>;
	stop: () => void;
}

const reviewRuntime: ReviewGitRuntime = {
	async runGit(
		args: string[],
		options?: { cwd?: string },
	): Promise<GitCommandResult> {
		const result = spawnSync("git", args, {
			cwd: options?.cwd,
			encoding: "utf-8",
		});
		return {
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			exitCode: result.status ?? (result.error ? 1 : 0),
		};
	},

	async readTextFile(path: string): Promise<string | null> {
		try {
			return readFileSync(path, "utf-8");
		} catch {
			return null;
		}
	},
};

export function getGitContext(): Promise<GitContext> {
	return getGitContextCore(reviewRuntime);
}

export function runGitDiff(
	diffType: DiffType,
	defaultBranch = "main",
	cwd?: string,
): Promise<{ patch: string; label: string; error?: string }> {
	return runGitDiffCore(reviewRuntime, diffType, defaultBranch, cwd);
}

export async function startReviewServer(options: {
	rawPatch: string;
	gitRef: string;
	htmlContent: string;
	origin?: string;
	diffType?: DiffType;
	gitContext?: GitContext;
	error?: string;
	sharingEnabled?: boolean;
	shareBaseUrl?: string;
	prMetadata?: PRMetadata;
}): Promise<ReviewServerResult> {
	const draftKey = contentHash(options.rawPatch);
	const prMeta = options.prMetadata;
	const isPRMode = !!prMeta;
	const prRef = prMeta ? prRefFromMetadata(prMeta) : null;
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
	const repoInfo = prMeta
		? {
				display: getDisplayRepo(prMeta),
				branch: `${getMRLabel(prMeta)} ${getMRNumberLabel(prMeta)}`,
			}
		: getRepoInfo();
	const editorAnnotations = createEditorAnnotationHandler();
	let currentPatch = options.rawPatch;
	let currentGitRef = options.gitRef;
	let currentDiffType: DiffType = options.diffType || "uncommitted";
	let currentError = options.error;
	const sharingEnabled =
		options.sharingEnabled ?? process.env.PLANNOTATOR_SHARE !== "disabled";
	const shareBaseUrl =
		(options.shareBaseUrl ?? process.env.PLANNOTATOR_SHARE_URL) || undefined;
	let resolveDecision!: (result: {
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
				getCwd: () => {
					if (currentDiffType.startsWith("worktree:")) {
						const parsed = parseWorktreeDiffType(currentDiffType);
						if (parsed) return parsed.path;
					}
					return options.gitContext?.cwd ?? process.cwd();
				},
			});
			aiSessionManager = sessionManager;
			aiRegistry = registry;
		}
	} catch {
		/* AI backbone not available */
	}

	const server = createServer(async (req, res) => {
		const url = requestUrl(req);

		if (url.pathname === "/api/diff" && req.method === "GET") {
			json(res, {
				rawPatch: currentPatch,
				gitRef: currentGitRef,
				origin: options.origin ?? "pi",
				diffType: isPRMode ? undefined : currentDiffType,
				gitContext: isPRMode ? undefined : options.gitContext,
				sharingEnabled,
				shareBaseUrl,
				repoInfo,
				...(isPRMode && { prMetadata: prMeta, platformUser }),
				...(isPRMode && initialViewedFiles.length > 0 && { viewedFiles: initialViewedFiles }),
				...(currentError ? { error: currentError } : {}),
			});
		} else if (url.pathname === "/api/diff/switch" && req.method === "POST") {
			if (isPRMode) {
				json(res, { error: "Not available for PR reviews" }, 400);
				return;
			}
			try {
				const body = await parseBody(req);
				const newType = body.diffType as DiffType;
				if (!newType) {
					json(res, { error: "Missing diffType" }, 400);
					return;
				}
				const defaultBranch = options.gitContext?.defaultBranch || "main";
				const defaultCwd = options.gitContext?.cwd;
				const result = await runGitDiff(newType, defaultBranch, defaultCwd);
				currentPatch = result.patch;
				currentGitRef = result.label;
				currentDiffType = newType;
				currentError = result.error;
				json(res, {
					rawPatch: currentPatch,
					gitRef: currentGitRef,
					diffType: currentDiffType,
					...(currentError ? { error: currentError } : {}),
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : "Failed to switch diff";
				json(res, { error: message }, 500);
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
				await submitPRReview(
					prRef,
					prMeta.headSha,
					body.action as "approve" | "comment",
					body.body as string,
					(body.fileComments as PRReviewFileComment[]) || [],
				);
				json(res, { ok: true, prUrl: prMeta.url });
			} catch (err) {
				json(
					res,
					{
						error:
							err instanceof Error ? err.message : "Failed to submit PR review",
					},
					500,
				);
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
				json(
					res,
					{
						error:
							err instanceof Error ? err.message : "Failed to update viewed state",
					},
					500,
				);
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

			if (isPRMode && prRef && prMeta) {
				try {
					const [oldContent, newContent] = await Promise.all([
						fetchPRFileContent(prRef, prMeta.baseSha, oldPath || filePath),
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

			const defaultBranch = options.gitContext?.defaultBranch || "main";
			const defaultCwd = options.gitContext?.cwd;
			const result = await getFileContentsForDiffCore(
				reviewRuntime,
				currentDiffType,
				defaultBranch,
				filePath,
				oldPath,
				defaultCwd,
			);
			json(res, result);
		} else if (url.pathname === "/api/image") {
			handleImageRequest(res, url);
		} else if (url.pathname === "/api/upload" && req.method === "POST") {
			await handleUploadRequest(req, res);
		} else if (url.pathname === "/api/agents" && req.method === "GET") {
			json(res, { agents: [] });
		} else if (url.pathname === "/api/git-add" && req.method === "POST") {
			if (isPRMode) {
				json(res, { error: "Not available for PR reviews" }, 400);
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
					err instanceof Error ? err.message : "Failed to git add";
				json(res, { error: message }, 500);
			}
		} else if (url.pathname === "/api/draft") {
			await handleDraftRequest(req, res, draftKey);
		} else if (url.pathname === "/favicon.svg") {
			handleFavicon(res);
		} else if (await editorAnnotations.handle(req, res, url)) {
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

	return {
		port,
		portSource,
		url: `http://localhost:${port}`,
		waitForDecision: () => decisionPromise,
		stop: () => {
			aiSessionManager?.disposeAll();
			aiRegistry?.disposeAll();
			server.close();
		},
	};
}
