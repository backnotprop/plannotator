import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DiffType } from "./generated/review-core.js";
import type { VcsSelection } from "./generated/vcs-core.js";
import type { PluginFeature, PluginSessionInfo } from "./generated/plugin-protocol.js";
import {
	ensurePlannotatorBinary,
	findPlannotatorSourceRoot,
	runPluginAnnotate,
	runPluginArchive,
	runPluginPlan,
	runPluginReview,
} from "./binary-client.js";
import { getLastAssistantMessageText } from "./assistant-message.js";

export { getLastAssistantMessageText } from "./assistant-message.js";

export type AnnotateMode = "annotate" | "annotate-folder" | "annotate-last";

export interface PlanReviewDecision {
	approved: boolean;
	feedback?: string;
	savedPath?: string;
	agentSwitch?: string;
	permissionMode?: string;
}

export interface BrowserDecisionSession<T> {
	url: string;
	waitForDecision: () => Promise<T>;
	stop: () => void;
}

export interface PlanReviewBrowserSession extends BrowserDecisionSession<PlanReviewDecision> {
	reviewId: string;
	onDecision: (listener: (result: PlanReviewDecision) => void | Promise<void>) => () => void;
}

export function getStartupErrorMessage(err: unknown): string {
	return err instanceof Error ? err.message : "Unknown error";
}

export function shouldUseLocalPrCheckout(options: { useLocal?: boolean }): boolean {
	return options.useLocal !== false;
}

export function normalizeAnnotationMarkdownForBinary(markdown: string | undefined): string | undefined {
	return markdown !== undefined && markdown.trim().length > 0 ? markdown : undefined;
}

const SOURCE_ROOT = findPlannotatorSourceRoot(dirname(fileURLToPath(import.meta.url)));

function sharingRequest(ctx: ExtensionContext) {
	return {
		cwd: ctx.cwd,
		sharingEnabled: process.env.PLANNOTATOR_SHARE !== "disabled",
		shareBaseUrl: process.env.PLANNOTATOR_SHARE_URL || undefined,
		pasteApiUrl: process.env.PLANNOTATOR_PASTE_URL || undefined,
	};
}

function getBinaryPath(requiredFeatures?: readonly PluginFeature[]): string {
	const binary = ensurePlannotatorBinary({ requiredFeatures, sourceRoot: SOURCE_ROOT });
	if (!binary.ok) {
		throw new Error(binary.message);
	}
	return binary.path;
}

function createReviewId(): string {
	return `plannotator-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function notifySessionReady(ctx: ExtensionContext, session: PluginSessionInfo): void {
	try {
		ctx.ui.notify(`Plannotator: ${session.url}`, "info");
	} catch {
		// Pi may be running headless or between UI sessions; the binary runner still writes stderr.
	}
}

export async function startBinarySession<T>(
	run: (onSession: (session: PluginSessionInfo) => void, signal: AbortSignal) => T | Promise<T>,
	onReady?: (session: PluginSessionInfo) => void,
	options: { readyTimeoutMs?: number; waitForReady?: boolean } = {},
): Promise<BrowserDecisionSession<T>> {
	let stopped = false;
	let sessionInfo: PluginSessionInfo | undefined;
	let stopReject: ((err: Error) => void) | undefined;
	let resolveReady: (() => void) | undefined;
	let rejectReady: ((err: Error) => void) | undefined;
	const controller = new AbortController();

	const createStoppedError = () => new Error("Plannotator browser session was stopped.");
	const readyPromise = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	const settleReady = () => {
		if (!resolveReady) return;
		resolveReady();
		resolveReady = undefined;
		rejectReady = undefined;
	};
	const failReady = (err: Error) => {
		if (!rejectReady) return;
		rejectReady(err);
		resolveReady = undefined;
		rejectReady = undefined;
	};
	const onSession = (session: PluginSessionInfo) => {
		sessionInfo = session;
		onReady?.(session);
		settleReady();
	};
	const decisionPromise = new Promise<T>((resolve, reject) => {
		stopReject = reject;
		void (async () => {
			try {
				const result = await run(onSession, controller.signal);
				if (!sessionInfo) {
					const err = new Error("Plannotator exited before reporting a browser session URL.");
					reject(err);
					failReady(err);
					return;
				}
				resolve(result);
			} catch (err) {
				reject(err);
				if (!sessionInfo) {
					failReady(err instanceof Error ? err : new Error(String(err)));
				}
			} finally {
				stopReject = undefined;
				if (sessionInfo) settleReady();
			}
		})();
	});

	const session = {
		get url() {
			return sessionInfo?.url ?? "plannotator://pending";
		},
		waitForDecision: () => decisionPromise,
		stop: () => {
			if (stopped) return;
			stopped = true;
			controller.abort();
			const err = createStoppedError();
			stopReject?.(err);
			stopReject = undefined;
			failReady(err);
		},
	};

	try {
		if (options.waitForReady === false) {
			// The caller will observe startup failures through waitForDecision().
			void readyPromise.catch(() => {});
			void decisionPromise.catch(() => {});
		} else if (options.readyTimeoutMs === undefined) {
			await readyPromise;
		} else {
			let readyTimer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				readyPromise,
				new Promise<void>((_, reject) => {
					readyTimer = setTimeout(
						() => reject(new Error("Timed out waiting for Plannotator session URL.")),
						options.readyTimeoutMs,
					);
				}),
			]).finally(() => {
				if (readyTimer) clearTimeout(readyTimer);
			});
		}
	} catch (err) {
		session.stop();
		void decisionPromise.catch(() => {});
		throw err;
	}

	return session;
}

export async function startPlanReviewBrowserSession(
	ctx: ExtensionContext,
	planContent: string,
	options: { waitForReady?: boolean } = {},
): Promise<PlanReviewBrowserSession> {
	if (!ctx.hasUI) {
		throw new Error("Plannotator browser review is unavailable in this session.");
	}

	const reviewId = createReviewId();
	const listeners = new Set<(result: PlanReviewDecision) => void | Promise<void>>();
	const session = await startBinarySession<PlanReviewDecision>(async (onSession, signal) => {
		const binaryPath = getBinaryPath(["plan-review"]);
		const response = await runPluginPlan(binaryPath, {
			origin: "pi",
			plan: planContent,
			...sharingRequest(ctx),
		}, undefined, { onSession, signal });
		if (!response.ok) throw new Error(response.error.message);
		return response.result;
	}, (sessionInfo) => notifySessionReady(ctx, sessionInfo), {
		waitForReady: options.waitForReady,
	});

	const originalWait = session.waitForDecision;
	let notified = false;
	let completedResult: PlanReviewDecision | undefined;
	const waitForDecision = async () => {
		const result = await originalWait();
		if (!notified) {
			notified = true;
			completedResult = result;
			for (const listener of listeners) {
				try {
					await listener(result);
				} catch {
					// Listener failures should not turn the browser decision into a failed review.
				}
			}
		}
		return result;
	};

	void waitForDecision().catch(() => {});

	return {
		get url() {
			return session.url === "plannotator://pending" ? `plannotator://pending/${reviewId}` : session.url;
		},
		reviewId,
		waitForDecision,
		stop: session.stop,
		onDecision: (listener) => {
			listeners.add(listener);
			if (completedResult) void Promise.resolve(listener(completedResult)).catch(() => {});
			return () => listeners.delete(listener);
		},
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
	options: { cwd?: string; defaultBranch?: string; diffType?: DiffType; prUrl?: string; vcsType?: VcsSelection; useLocal?: boolean } = {},
): Promise<{ approved: boolean; feedback?: string; annotations?: unknown[]; agentSwitch?: string; exit?: boolean }> {
	const session = await startCodeReviewBrowserSession(ctx, options);
	return session.waitForDecision();
}

export async function startCodeReviewBrowserSession(
	ctx: ExtensionContext,
	options: { cwd?: string; defaultBranch?: string; diffType?: DiffType; prUrl?: string; vcsType?: VcsSelection; useLocal?: boolean } = {},
): Promise<BrowserDecisionSession<{ approved: boolean; feedback?: string; annotations?: unknown[]; agentSwitch?: string; exit?: boolean }>> {
	if (!ctx.hasUI) {
		throw new Error("Plannotator code review browser is unavailable in this session.");
	}

	const binaryPath = getBinaryPath(["code-review"]);
	return await startBinarySession(async (onSession, signal) => {
		const response = await runPluginReview(binaryPath, {
			origin: "pi",
			...sharingRequest(ctx),
			cwd: options.cwd ?? ctx.cwd,
			prUrl: options.prUrl,
			vcsType: options.vcsType,
			useLocal: shouldUseLocalPrCheckout(options),
			diffType: options.diffType,
			defaultBranch: options.defaultBranch,
		}, undefined, { onSession, signal });
		if (!response.ok) throw new Error(response.error.message);
		return response.result;
	}, (sessionInfo) => notifySessionReady(ctx, sessionInfo));
}

export async function openMarkdownAnnotation(
	ctx: ExtensionContext,
	filePath: string,
	markdown: string | undefined,
	mode: AnnotateMode,
	folderPath?: string,
	sourceInfo?: string,
	sourceConverted?: boolean,
	gate?: boolean,
): Promise<{ feedback: string; exit?: boolean; approved?: boolean }> {
	const session = await startMarkdownAnnotationSession(
		ctx,
		filePath,
		markdown,
		mode,
		folderPath,
		sourceInfo,
		sourceConverted,
		gate,
	);
	return session.waitForDecision();
}

export async function startMarkdownAnnotationSession(
	ctx: ExtensionContext,
	filePath: string,
	markdown: string | undefined,
	mode: AnnotateMode,
	folderPath?: string,
	sourceInfo?: string,
	sourceConverted?: boolean,
	gate?: boolean,
	rawHtml?: string,
	renderHtml?: boolean,
): Promise<BrowserDecisionSession<{ feedback: string; exit?: boolean; approved?: boolean }>> {
	if (!ctx.hasUI) {
		throw new Error("Plannotator annotation browser is unavailable in this session.");
	}

	const binaryPath = getBinaryPath([mode === "annotate-last" ? "annotate-last" : "annotate"]);
	const requestMarkdown = normalizeAnnotationMarkdownForBinary(markdown);
	return await startBinarySession(async (onSession, signal) => {
		const response = await runPluginAnnotate(binaryPath, {
			origin: "pi",
			...sharingRequest(ctx),
			filePath,
			...(requestMarkdown !== undefined && { markdown: requestMarkdown }),
			mode,
			folderPath,
			sourceInfo,
			sourceConverted,
			gate,
			rawHtml,
			renderHtml,
		}, undefined, { onSession, signal });
		if (!response.ok) throw new Error(response.error.message);
		return response.result;
	}, (sessionInfo) => notifySessionReady(ctx, sessionInfo));
}

export async function openLastMessageAnnotation(
	ctx: ExtensionContext,
	lastText: string,
	gate?: boolean,
): Promise<{ feedback: string; exit?: boolean; approved?: boolean }> {
	return openMarkdownAnnotation(ctx, "last-message", lastText, "annotate-last", undefined, undefined, undefined, gate);
}

export async function startLastMessageAnnotationSession(
	ctx: ExtensionContext,
	lastText: string,
	gate?: boolean,
): Promise<BrowserDecisionSession<{ feedback: string; exit?: boolean; approved?: boolean }>> {
	return startMarkdownAnnotationSession(
		ctx,
		"last-message",
		lastText,
		"annotate-last",
		undefined,
		undefined,
		undefined,
		gate,
	);
}

export async function openArchiveBrowserAction(
	ctx: ExtensionContext,
	customPlanPath?: string,
): Promise<{ opened: boolean }> {
	if (!ctx.hasUI) {
		throw new Error("Plannotator archive browser is unavailable in this session.");
	}

	const binaryPath = getBinaryPath(["archive"]);
	const session = await startBinarySession(async (onSession, signal) => {
		const response = await runPluginArchive(binaryPath, {
			origin: "pi",
			...sharingRequest(ctx),
			customPlanPath,
		}, undefined, { onSession, signal });
		if (!response.ok) throw new Error(response.error.message);
		return response.result;
	}, (sessionInfo) => notifySessionReady(ctx, sessionInfo));
	return session.waitForDecision();
}
