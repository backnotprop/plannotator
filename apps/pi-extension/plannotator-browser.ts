import { existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createWorktreePool, type WorktreePool } from "./generated/worktree-pool.js";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	getGitContext,
	reviewRuntime,
	runGitDiff,
	startAnnotateServer,
	startPlanReviewServer,
	startReviewServer,
	type DiffType,
} from "./server.js";
import { openBrowser } from "./server/network.js";
import { parsePRUrl, checkPRAuth, fetchPR } from "./server/pr.js";
import {
	getMRLabel,
	getMRNumberLabel,
	getDisplayRepo,
	getCliName,
	getCliInstallUrl,
} from "./generated/pr-provider.js";
import { parseRemoteUrl } from "./generated/repo.js";
import { fetchRef, createWorktree, removeWorktree, ensureObjectAvailable } from "./generated/worktree.js";
import { loadConfig, resolveDefaultDiffType } from "./generated/config.js";

export type AnnotateMode = "annotate" | "annotate-folder" | "annotate-last";
export interface PlanReviewDecision {
	approved: boolean;
	feedback?: string;
	savedPath?: string;
	agentSwitch?: string;
	permissionMode?: string;
}

export interface PlanReviewBrowserSession {
	reviewId: string;
	url: string;
	waitForDecision: () => Promise<PlanReviewDecision>;
	onDecision: (listener: (result: PlanReviewDecision) => void | Promise<void>) => () => void;
	stop: () => void;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
let planHtmlContent = "";
let reviewHtmlContent = "";

try {
	planHtmlContent = readFileSync(resolve(__dirname, "plannotator.html"), "utf-8");
} catch {
	// built assets unavailable
}

try {
	reviewHtmlContent = readFileSync(resolve(__dirname, "review-editor.html"), "utf-8");
} catch {
	// built assets unavailable
}

function delay(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function hasPlanBrowserHtml(): boolean {
	return Boolean(planHtmlContent);
}

export function hasReviewBrowserHtml(): boolean {
	return Boolean(reviewHtmlContent);
}

export function getStartupErrorMessage(err: unknown): string {
	return err instanceof Error ? err.message : "Unknown error";
}

type AssistantTextBlock = { type?: string; text?: string };

type AssistantMessageLike = { role?: unknown; content?: unknown };

function isAssistantMessage(message: AssistantMessageLike): message is { role: "assistant"; content: AssistantTextBlock[] } {
	return message.role === "assistant" && Array.isArray(message.content);
}

function getTextContent(message: { content: AssistantTextBlock[] }): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export async function getLastAssistantMessageText(ctx: ExtensionContext): Promise<string | null> {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type: string; message?: AssistantMessageLike };
		if (entry.type === "message" && entry.message && isAssistantMessage(entry.message)) {
			const text = getTextContent(entry.message);
			if (text.trim()) return text;
		}
	}
	return null;
}

function openBrowserForServer(serverUrl: string, ctx: ExtensionContext): void {
	const browserResult = openBrowser(serverUrl);
	if (browserResult.isRemote) {
		ctx.ui.notify(`Remote session. Open manually: ${browserResult.url}`, "info");
	} else if (!browserResult.opened) {
		ctx.ui.notify(`Open this URL to review: ${serverUrl}`, "info");
	}
}

async function openBrowserAndWait<T>(
	server: { url: string; stop: () => void },
	ctx: ExtensionContext,
	waitForResult: () => Promise<T>,
): Promise<T> {
	openBrowserForServer(server.url, ctx);

	const result = await waitForResult();
	await delay(1500);
	server.stop();
	return result;
}

export async function startPlanReviewBrowserSession(
	ctx: ExtensionContext,
	planContent: string,
): Promise<PlanReviewBrowserSession> {
	if (!ctx.hasUI || !planHtmlContent) {
		throw new Error("Plannotator browser review is unavailable in this session.");
	}

	const server = await startPlanReviewServer({
		plan: planContent,
		htmlContent: planHtmlContent,
		origin: "pi",
		sharingEnabled: process.env.PLANNOTATOR_SHARE !== "disabled",
		shareBaseUrl: process.env.PLANNOTATOR_SHARE_URL || undefined,
		pasteApiUrl: process.env.PLANNOTATOR_PASTE_URL || undefined,
	});

	openBrowserForServer(server.url, ctx);
	server.onDecision(() => {
		setTimeout(() => server.stop(), 1500);
	});

	return {
		reviewId: server.reviewId,
		url: server.url,
		waitForDecision: server.waitForDecision,
		onDecision: server.onDecision,
		stop: server.stop,
	};
}

export async function openPlanReviewBrowser(
	ctx: ExtensionContext,
	planContent: string,
): Promise<PlanReviewDecision> {
	const session = await startPlanReviewBrowserSession(ctx, planContent);
	return session.waitForDecision();
}

export async function openCodeReview(
	ctx: ExtensionContext,
	options: { cwd?: string; defaultBranch?: string; diffType?: DiffType; prUrl?: string } = {},
): Promise<{ approved: boolean; feedback?: string; annotations?: unknown[]; agentSwitch?: string; exit?: boolean }> {
	if (!ctx.hasUI || !reviewHtmlContent) {
		throw new Error("Plannotator code review browser is unavailable in this session.");
	}

	const urlArg = options.prUrl;
	const isPRMode = urlArg?.startsWith("http://") || urlArg?.startsWith("https://");

	let rawPatch: string;
	let gitRef: string;
	let diffError: string | undefined;
	let gitCtx: Awaited<ReturnType<typeof getGitContext>> | undefined;
	let prMetadata: Awaited<ReturnType<typeof fetchPR>>["metadata"] | undefined;
	let diffType: DiffType | undefined;
	let agentCwd: string | undefined;
	let initialBase: string | undefined;
	let worktreeCleanup: (() => void | Promise<void>) | undefined;
	let worktreePool: WorktreePool | undefined;
	let exitHandler: (() => void) | undefined;

	if (isPRMode && urlArg) {
		// --- PR Review Mode ---
		const prRef = parsePRUrl(urlArg);
		if (!prRef) {
			throw new Error(
				`Invalid PR/MR URL: ${urlArg}\n` +
				"Supported formats:\n" +
				"  GitHub: https://github.com/owner/repo/pull/123\n" +
				"  GitLab: https://gitlab.com/group/project/-/merge_requests/42",
			);
		}

		const cliName = getCliName(prRef);
		const cliUrl = getCliInstallUrl(prRef);

		try {
			await checkPRAuth(prRef);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("not found") || msg.includes("ENOENT")) {
				throw new Error(`${cliName === "gh" ? "GitHub" : "GitLab"} CLI (${cliName}) is not installed. Install it from ${cliUrl}`);
			}
			throw err;
		}

		console.error(`Fetching ${getMRLabel(prRef)} ${getMRNumberLabel(prRef)} from ${getDisplayRepo(prRef)}...`);
		const pr = await fetchPR(prRef);
		rawPatch = pr.rawPatch;
		gitRef = `${getMRLabel(prRef)} ${getMRNumberLabel(prRef)}`;
		prMetadata = pr.metadata;

		// Create local worktree for agent file access (--local is the default for PR reviews)
		let localPath: string | undefined;
		let sessionDir: string | undefined;
		try {
			const repoDir = options.cwd ?? ctx.cwd;
			const identifier = prMetadata.platform === "github"
				? `${prMetadata.owner}-${prMetadata.repo}-${prMetadata.number}`
				: `${prMetadata.projectPath.replace(/\//g, "-")}-${prMetadata.iid}`;
			const suffix = Math.random().toString(36).slice(2, 8);
			const prNumber = prMetadata.platform === "github" ? prMetadata.number : prMetadata.iid;
			sessionDir = join(realpathSync(tmpdir()), `plannotator-pr-${identifier}-${suffix}`);
			localPath = join(sessionDir, "pool", `pr-${prNumber}`);
			const fetchRefStr = prMetadata.platform === "github"
				? `refs/pull/${prMetadata.number}/head`
				: `refs/merge-requests/${prMetadata.iid}/head`;

			// Validate inputs from platform API to prevent git flag/path injection
			if (prMetadata.baseBranch.includes('..') || prMetadata.baseBranch.startsWith('-')) throw new Error(`Invalid base branch: ${prMetadata.baseBranch}`);
			if (!/^[0-9a-f]{40,64}$/i.test(prMetadata.baseSha)) throw new Error(`Invalid base SHA: ${prMetadata.baseSha}`);

			// Detect same-repo vs cross-repo (must match both owner/repo AND host)
			let isSameRepo = false;
			try {
				const remoteResult = await reviewRuntime.runGit(["remote", "get-url", "origin"], { cwd: repoDir });
				if (remoteResult.exitCode === 0) {
					const remoteUrl = remoteResult.stdout.trim();
					const currentRepo = parseRemoteUrl(remoteUrl);
					const prRepo = prMetadata.platform === "github"
						? `${prMetadata.owner}/${prMetadata.repo}`
						: prMetadata.projectPath;
					const repoMatches = !!currentRepo && currentRepo.toLowerCase() === prRepo.toLowerCase();
					const sshHost = remoteUrl.match(/^[^@]+@([^:]+):/)?.[1];
					const httpsHost = (() => { try { return new URL(remoteUrl).hostname; } catch { return null; } })();
					const remoteHost = (sshHost || httpsHost || "").toLowerCase();
					const prHost = prMetadata.host.toLowerCase();
					isSameRepo = repoMatches && remoteHost === prHost;
				}
			} catch { /* not in a git repo — cross-repo path */ }

			if (isSameRepo) {
				// ── Same-repo: fast worktree path ──
				console.error("Fetching PR branch and creating local worktree...");
				await fetchRef(reviewRuntime, prMetadata.baseBranch, { cwd: repoDir });
				await ensureObjectAvailable(reviewRuntime, prMetadata.baseSha, { cwd: repoDir });
				await fetchRef(reviewRuntime, fetchRefStr, { cwd: repoDir });

				await createWorktree(reviewRuntime, {
					ref: "FETCH_HEAD",
					path: localPath,
					detach: true,
					cwd: repoDir,
				});

				const wtRepoDir = repoDir;
				exitHandler = () => {
					try {
						for (const entry of worktreePool?.entries() ?? []) {
							spawnSync("git", ["worktree", "remove", "--force", entry.path], { cwd: wtRepoDir });
						}
					} catch {}
					if (sessionDir) try { rmSync(sessionDir, { recursive: true, force: true }); } catch {}
				};
				worktreeCleanup = async () => {
					if (exitHandler) { process.removeListener("exit", exitHandler); exitHandler = undefined; }
					if (worktreePool) await worktreePool.cleanup(reviewRuntime);
					if (sessionDir) try { rmSync(sessionDir, { recursive: true, force: true }); } catch {}
				};
				process.once("exit", exitHandler);
			} else {
				// ── Cross-repo: shallow clone + fetch PR head ──
				const prRepo = prMetadata.platform === "github"
					? `${prMetadata.owner}/${prMetadata.repo}`
					: prMetadata.projectPath;
				if (/^-/.test(prRepo)) throw new Error(`Invalid repository identifier: ${prRepo}`);
				const cli = prMetadata.platform === "github" ? "gh" : "glab";
				const host = prMetadata.host;
				// gh/glab repo clone doesn't accept --hostname; set GH_HOST/GITLAB_HOST env instead
				const isDefaultHost = host === "github.com" || host === "gitlab.com";
				const cloneEnv = isDefaultHost ? undefined : {
					...process.env,
					...(prMetadata.platform === "github" ? { GH_HOST: host } : { GITLAB_HOST: host }),
				};

				console.error(`Cloning ${prRepo} (shallow)...`);
				const cloneResult = spawnSync(cli, ["repo", "clone", prRepo, localPath, "--", "--depth=1", "--no-checkout"], { encoding: "utf-8", env: cloneEnv });
				if ((cloneResult.status ?? 1) !== 0) {
					throw new Error(`${cli} repo clone failed: ${(cloneResult.stderr ?? "").trim()}`);
				}

				console.error("Fetching PR branch...");
				const fetchResult = await reviewRuntime.runGit(["fetch", "--depth=200", "origin", fetchRefStr], { cwd: localPath });
				if (fetchResult.exitCode !== 0) throw new Error(`Failed to fetch PR head ref: ${fetchResult.stderr.trim()}`);

				const checkoutResult = await reviewRuntime.runGit(["checkout", "FETCH_HEAD"], { cwd: localPath });
				if (checkoutResult.exitCode !== 0) {
					throw new Error(`git checkout FETCH_HEAD failed: ${checkoutResult.stderr.trim()}`);
				}

				// Best-effort: create base refs so agent diffs work
				const baseFetch = await reviewRuntime.runGit(["fetch", "--depth=200", "origin", prMetadata.baseSha], { cwd: localPath });
				if (baseFetch.exitCode !== 0) console.error("Warning: failed to fetch baseSha, agent diffs may be inaccurate");
				await reviewRuntime.runGit(["branch", "--", prMetadata.baseBranch, prMetadata.baseSha], { cwd: localPath });
				await reviewRuntime.runGit(["update-ref", `refs/remotes/origin/${prMetadata.baseBranch}`, prMetadata.baseSha], { cwd: localPath });

				exitHandler = () => {
					if (sessionDir) try { rmSync(sessionDir, { recursive: true, force: true }); } catch {}
				};
				worktreeCleanup = () => {
					if (exitHandler) { process.removeListener("exit", exitHandler); exitHandler = undefined; }
					if (sessionDir) try { rmSync(sessionDir, { recursive: true, force: true }); } catch {}
				};
				process.once("exit", exitHandler);
			}

			agentCwd = localPath;
			worktreePool = createWorktreePool(
				{ sessionDir: sessionDir!, repoDir, isSameRepo },
				{ path: localPath, prUrl: prMetadata.url, number: prNumber, ready: true },
			);
			console.error(`Local checkout ready at ${localPath}`);
		} catch (err) {
			console.error("Warning: local worktree creation failed, falling back to remote diff");
			console.error(err instanceof Error ? err.message : String(err));
			if (exitHandler) { process.removeListener("exit", exitHandler); exitHandler = undefined; }
			if (sessionDir) try { rmSync(sessionDir, { recursive: true, force: true }); } catch {}
			agentCwd = undefined;
			worktreePool = undefined;
			worktreeCleanup = undefined;
		}
	} else {
		// --- Local Review Mode ---
		const cwd = options.cwd ?? ctx.cwd;
		gitCtx = await getGitContext(cwd);
		const defaultBranch = options.defaultBranch ?? gitCtx.defaultBranch;
		diffType = options.diffType ?? resolveDefaultDiffType(loadConfig());
		const result = await runGitDiff(diffType, defaultBranch, cwd);
		rawPatch = result.patch;
		gitRef = result.label;
		diffError = result.error;
		// Remember which base the initial diff was computed against so it can
		// be forwarded to the server below. Only matters when the caller
		// overrode the detected default; otherwise it matches gitCtx already.
		initialBase = defaultBranch;
	}

	const server = await startReviewServer({
		rawPatch,
		gitRef,
		error: diffError,
		origin: "pi",
		diffType,
		gitContext: gitCtx,
		initialBase,
		prMetadata,
		agentCwd,
		worktreePool,
		htmlContent: reviewHtmlContent,
		sharingEnabled: process.env.PLANNOTATOR_SHARE !== "disabled",
		shareBaseUrl: process.env.PLANNOTATOR_SHARE_URL || undefined,
		pasteApiUrl: process.env.PLANNOTATOR_PASTE_URL || undefined,
		onCleanup: worktreeCleanup,
	});

	return openBrowserAndWait(server, ctx, server.waitForDecision);
}

export async function openMarkdownAnnotation(
	ctx: ExtensionContext,
	filePath: string,
	markdown: string,
	mode: AnnotateMode,
	folderPath?: string,
	sourceInfo?: string,
	gate?: boolean,
): Promise<{ feedback: string; exit?: boolean; approved?: boolean }> {
	if (!ctx.hasUI || !planHtmlContent) {
		throw new Error("Plannotator annotation browser is unavailable in this session.");
	}

	let resolvedMarkdown = markdown;
	if (!resolvedMarkdown.trim() && existsSync(filePath)) {
		try {
			const fileStat = statSync(filePath);
			if (!fileStat.isDirectory()) {
				resolvedMarkdown = readFileSync(filePath, "utf-8");
			}
		} catch {
			// fall back to provided markdown
		}
	}

	const server = await startAnnotateServer({
		markdown: resolvedMarkdown,
		filePath,
		origin: "pi",
		mode,
		folderPath,
		sourceInfo,
		gate,
		htmlContent: planHtmlContent,
		sharingEnabled: process.env.PLANNOTATOR_SHARE !== "disabled",
		shareBaseUrl: process.env.PLANNOTATOR_SHARE_URL || undefined,
		pasteApiUrl: process.env.PLANNOTATOR_PASTE_URL || undefined,
	});

	return openBrowserAndWait(server, ctx, server.waitForDecision);
}

export async function openLastMessageAnnotation(
	ctx: ExtensionContext,
	lastText: string,
	gate?: boolean,
): Promise<{ feedback: string; exit?: boolean; approved?: boolean }> {
	return openMarkdownAnnotation(ctx, "last-message", lastText, "annotate-last", undefined, undefined, gate);
}

export async function openArchiveBrowserAction(
	ctx: ExtensionContext,
	customPlanPath?: string,
): Promise<{ opened: boolean }> {
	if (!ctx.hasUI || !planHtmlContent) {
		throw new Error("Plannotator archive browser is unavailable in this session.");
	}

	const server = await startPlanReviewServer({
		plan: "",
		htmlContent: planHtmlContent,
		origin: "pi",
		mode: "archive",
		customPlanPath,
		sharingEnabled: process.env.PLANNOTATOR_SHARE !== "disabled",
		shareBaseUrl: process.env.PLANNOTATOR_SHARE_URL || undefined,
		pasteApiUrl: process.env.PLANNOTATOR_PASTE_URL || undefined,
	});

	return openBrowserAndWait(server, ctx, async () => {
		if (server.waitForDone) {
			await server.waitForDone();
		}
		return { opened: true };
	});
}
