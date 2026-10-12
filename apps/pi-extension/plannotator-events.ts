import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DiffType, VcsSelection } from "./server.ts";
import {
	getLastAssistantMessageText,
	getRecentAssistantMessages,
} from "./assistant-message.ts";
import {
	getStartupErrorMessage,
	hasPlanBrowserHtml,
	hasReviewBrowserHtml,
	loadPlannotatorBrowser,
} from "./plannotator-browser-runtime.ts";

type PlannotatorBrowserModule = typeof import("./plannotator-browser.ts");

/** Start a plan-review browser session after loading the browser/server graph on demand. */
export function startPlanReviewBrowserSession(
	...args: Parameters<PlannotatorBrowserModule["startPlanReviewBrowserSession"]>
): ReturnType<PlannotatorBrowserModule["startPlanReviewBrowserSession"]> {
	return loadPlannotatorBrowser().then((browser) => browser.startPlanReviewBrowserSession(...args));
}

/** Open a plan review after loading the browser/server graph on demand. */
export function openPlanReviewBrowser(
	...args: Parameters<PlannotatorBrowserModule["openPlanReviewBrowser"]>
): ReturnType<PlannotatorBrowserModule["openPlanReviewBrowser"]> {
	return loadPlannotatorBrowser().then((browser) => browser.openPlanReviewBrowser(...args));
}

/** Start a code-review browser session after loading the browser/server graph on demand. */
export function startCodeReviewBrowserSession(
	...args: Parameters<PlannotatorBrowserModule["startCodeReviewBrowserSession"]>
): ReturnType<PlannotatorBrowserModule["startCodeReviewBrowserSession"]> {
	return loadPlannotatorBrowser().then((browser) => browser.startCodeReviewBrowserSession(...args));
}

/** Open a code review after loading the browser/server graph on demand. */
export function openCodeReview(
	...args: Parameters<PlannotatorBrowserModule["openCodeReview"]>
): ReturnType<PlannotatorBrowserModule["openCodeReview"]> {
	return loadPlannotatorBrowser().then((browser) => browser.openCodeReview(...args));
}

/** Start a markdown-annotation session after loading the browser/server graph on demand. */
export function startMarkdownAnnotationSession(
	...args: Parameters<PlannotatorBrowserModule["startMarkdownAnnotationSession"]>
): ReturnType<PlannotatorBrowserModule["startMarkdownAnnotationSession"]> {
	return loadPlannotatorBrowser().then((browser) => browser.startMarkdownAnnotationSession(...args));
}

/** Open a markdown annotation after loading the browser/server graph on demand. */
export function openMarkdownAnnotation(
	...args: Parameters<PlannotatorBrowserModule["openMarkdownAnnotation"]>
): ReturnType<PlannotatorBrowserModule["openMarkdownAnnotation"]> {
	return loadPlannotatorBrowser().then((browser) => browser.openMarkdownAnnotation(...args));
}

/** Start a last-message annotation session after loading the browser/server graph on demand. */
export function startLastMessageAnnotationSession(
	...args: Parameters<PlannotatorBrowserModule["startLastMessageAnnotationSession"]>
): ReturnType<PlannotatorBrowserModule["startLastMessageAnnotationSession"]> {
	return loadPlannotatorBrowser().then((browser) => browser.startLastMessageAnnotationSession(...args));
}

/** Open a last-message annotation after loading the browser/server graph on demand. */
export function openLastMessageAnnotation(
	...args: Parameters<PlannotatorBrowserModule["openLastMessageAnnotation"]>
): ReturnType<PlannotatorBrowserModule["openLastMessageAnnotation"]> {
	return loadPlannotatorBrowser().then((browser) => browser.openLastMessageAnnotation(...args));
}

/** Open the plan archive after loading the browser/server graph on demand. */
export function openArchiveBrowserAction(
	...args: Parameters<PlannotatorBrowserModule["openArchiveBrowserAction"]>
): ReturnType<PlannotatorBrowserModule["openArchiveBrowserAction"]> {
	return loadPlannotatorBrowser().then((browser) => browser.openArchiveBrowserAction(...args));
}

export const PLANNOTATOR_REQUEST_CHANNEL = "plannotator:request" as const;
export const PLANNOTATOR_REVIEW_RESULT_CHANNEL = "plannotator:review-result" as const;
export const PLANNOTATOR_PLAN_APPROVED_CHANNEL = "plannotator:plan-approved" as const;
export const PLANNOTATOR_TIMEOUT_MS = 5_000;

export type PlannotatorAction =
	| "plan-mode"
	| "plan-review"
	| "review-status"
	| "code-review"
	| "annotate"
	| "annotate-last"
	| "archive";

export interface PlannotatorHandledResponse<T> {
	status: "handled";
	result: T;
}

export interface PlannotatorUnavailableResponse {
	status: "unavailable";
	error?: string;
}

export interface PlannotatorErrorResponse {
	status: "error";
	error: string;
}

export type PlannotatorResponse<T> =
	| PlannotatorHandledResponse<T>
	| PlannotatorUnavailableResponse
	| PlannotatorErrorResponse;

export interface PlannotatorRequestBase<A extends PlannotatorAction, P, R> {
	requestId: string;
	action: A;
	payload: P;
	respond: (response: PlannotatorResponse<R>) => void;
}

export interface PlannotatorPlanModePayload {
	mode?: "enter" | "exit" | "toggle" | "status";
}

export interface PlannotatorPlanModeResult {
	phase: "idle" | "planning" | "executing";
}

export interface PlannotatorPlanReviewPayload {
	planFilePath?: string;
	planContent: string;
	origin?: string;
}

export interface PlannotatorPlanReviewStartResult {
	status: "pending";
	reviewId: string;
}

export interface PlannotatorReviewResultEvent {
	reviewId: string;
	approved: boolean;
	feedback?: string;
	savedPath?: string;
	agentSwitch?: string;
	permissionMode?: string;
	/** Not approved, and the reviewer's only feedback was answers to the plan's
	 *  questions: compose the reply with `composePlanDeniedMessage`. */
	answersOnly?: boolean;
}

export interface PlannotatorPlanApprovedEvent {
	cwd: string;
	planFilePath: string;
	planContent: string;
	feedback?: string;
}

export interface PlannotatorReviewStatusPayload {
	reviewId: string;
}

export type PlannotatorReviewStatusResult =
	| { status: "pending" }
	| ({ status: "completed" } & PlannotatorReviewResultEvent)
	| { status: "missing" };

export interface PlannotatorCodeReviewPayload {
	diffType?: DiffType;
	defaultBranch?: string;
	vcsType?: VcsSelection;
	useLocal?: boolean;
	cwd?: string;
	prUrl?: string;
	/** Path to a unified-diff file — static patch mode (no repo required).
	 * Mutually exclusive with `prUrl`. Read by the host at request time,
	 * resolved against payload.cwd (or the session cwd). */
	patchFile?: string;
}

export interface PlannotatorCodeReviewResult {
	approved: boolean;
	feedback?: string;
	annotations?: unknown[];
	agentSwitch?: string;
	/**
	 * Present (true) only when the reviewer posted the review to the PR
	 * platform; `feedback` is then just the status line. Use this, never an
	 * empty `annotations`, to tell it apart: PR description, PR comment and
	 * editor comments ride only in `feedback`.
	 */
	platform?: true;
}

export interface PlannotatorAnnotatePayload {
	filePath: string;
	markdown?: string;
	mode?: "annotate" | "annotate-folder" | "annotate-last";
	folderPath?: string;
	/** Enable review-gate UX (Approve / Annotate / Close). */
	gate?: boolean;
}

export interface PlannotatorAnnotationResult {
	feedback: string;
	/** True when the reviewer closed the session without providing feedback. */
	exit?: boolean;
	/** True when the reviewer clicked Approve in review-gate mode. */
	approved?: boolean;
}

export interface PlannotatorArchivePayload {
	customPlanPath?: string;
}

export interface PlannotatorArchiveResult {
	opened: boolean;
}

export type PlannotatorRequestMap = {
	"plan-mode": PlannotatorRequestBase<"plan-mode", PlannotatorPlanModePayload, PlannotatorPlanModeResult>;
	"plan-review": PlannotatorRequestBase<"plan-review", PlannotatorPlanReviewPayload, PlannotatorPlanReviewStartResult>;
	"review-status": PlannotatorRequestBase<"review-status", PlannotatorReviewStatusPayload, PlannotatorReviewStatusResult>;
	"code-review": PlannotatorRequestBase<"code-review", PlannotatorCodeReviewPayload, PlannotatorCodeReviewResult>;
	annotate: PlannotatorRequestBase<"annotate", PlannotatorAnnotatePayload, PlannotatorAnnotationResult>;
	"annotate-last": PlannotatorRequestBase<"annotate-last", PlannotatorAnnotatePayload, PlannotatorAnnotationResult>;
	archive: PlannotatorRequestBase<"archive", PlannotatorArchivePayload, PlannotatorArchiveResult>;
};
export type PlannotatorRequest = PlannotatorRequestMap[PlannotatorAction];
export type PlannotatorResponseMap = {
	"plan-mode": PlannotatorResponse<PlannotatorPlanModeResult>;
	"plan-review": PlannotatorResponse<PlannotatorPlanReviewStartResult>;
	"review-status": PlannotatorResponse<PlannotatorReviewStatusResult>;
	"code-review": PlannotatorResponse<PlannotatorCodeReviewResult>;
	annotate: PlannotatorResponse<PlannotatorAnnotationResult>;
	"annotate-last": PlannotatorResponse<PlannotatorAnnotationResult>;
	archive: PlannotatorResponse<PlannotatorArchiveResult>;
};
function isPlannotatorAction(value: unknown): value is PlannotatorAction {
	return (
		value === "plan-mode" ||
		value === "plan-review" ||
		value === "review-status" ||
		value === "code-review" ||
		value === "annotate" ||
		value === "annotate-last" ||
		value === "archive"
	);
}

function defaultReviewStatusPath(): string {
	return join(homedir(), ".pi", "plannotator-review-status.json");
}

type StoredReviewStatus = Record<string, PlannotatorReviewStatusResult>;

function readStoredReviewStatuses(path: string): StoredReviewStatus {
	try {
		if (!existsSync(path)) return {};
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as StoredReviewStatus;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function writeStoredReviewStatuses(path: string, statuses: StoredReviewStatus): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(statuses, null, 2));
}

function setStoredReviewStatus(path: string, reviewId: string, status: PlannotatorReviewStatusResult): void {
	const statuses = readStoredReviewStatuses(path);
	statuses[reviewId] = status;
	writeStoredReviewStatuses(path, statuses);
}

function getStoredReviewStatus(path: string, reviewId: string): PlannotatorReviewStatusResult {
	return readStoredReviewStatuses(path)[reviewId] ?? { status: "missing" };
}

function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function createActiveSessionContext() {
	let currentCtx: ExtensionContext | undefined;

	return {
		set(ctx: ExtensionContext): void {
			currentCtx = ctx;
		},
		clear(): void {
			currentCtx = undefined;
		},
		get(): ExtensionContext | undefined {
			return currentCtx;
		},
	};
}

export interface PlannotatorEventListenerOptions {
	handlePlanMode?: (
		mode: NonNullable<PlannotatorPlanModePayload["mode"]>,
		ctx: ExtensionContext,
	) => Promise<PlannotatorPlanModeResult> | PlannotatorPlanModeResult;
	/** Test seam: where `review-status` is kept (default `~/.pi/plannotator-review-status.json`). */
	reviewStatusPath?: string;
	/** Test seam: starts the `plan-review` browser session (default: the real plan server). */
	startPlanReviewSession?: typeof startPlanReviewBrowserSession;
}

export function registerPlannotatorEventListeners(
	pi: ExtensionAPI,
	options: PlannotatorEventListenerOptions = {},
): void {
	const activeSessionContext = createActiveSessionContext();
	const reviewStatusPath = options.reviewStatusPath ?? defaultReviewStatusPath();
	const startPlanReview = options.startPlanReviewSession ?? startPlanReviewBrowserSession;
	/**
	 * Cleared when this extension instance's session ends. Pi builds a new
	 * instance (with its own listeners) for the replacement session, and this
	 * instance's `pi` and `ctx` go stale: every use throws. Event-API reviews
	 * deliberately outlive it: a decision made in a tab left open across
	 * /reload is still recorded, and the replacement asks `review-status`.
	 */
	let sessionLive = true;

	// Results go to whoever asked, through Pi's event bus or the request's own
	// callback. Both run code another extension instance owns, which throws
	// once that instance was replaced (/reload, a session switch: Pi's
	// stale-ctx guard). Nothing here may let that escape: these run from HTTP
	// handlers and timers, where an uncaught throw ends the Pi process (#1864).
	const emitReviewResult = (result: PlannotatorReviewResultEvent): void => {
		try {
			pi.events.emit(PLANNOTATOR_REVIEW_RESULT_CHANNEL, result);
		} catch (err) {
			console.error(`Plannotator: could not emit the review result for ${result.reviewId}: ${describeError(err)}`);
		}
	};
	const respond = (request: { respond: (response: never) => void }, response: unknown): void => {
		try {
			request.respond(response as never);
		} catch (err) {
			console.error(`Plannotator: could not answer a ${PLANNOTATOR_REQUEST_CHANNEL} request: ${describeError(err)}`);
		}
	};
	const storeReviewStatus = (reviewId: string, status: PlannotatorReviewStatusResult): void => {
		try {
			setStoredReviewStatus(reviewStatusPath, reviewId, status);
		} catch (err) {
			console.error(`Plannotator: could not record the status of review ${reviewId}: ${describeError(err)}`);
		}
	};

	// Plannotator event requests are handled against the latest active session.
	// The active context is intentionally session-scoped and replaced on each session_start.
	pi.on("session_start", async (_event, ctx) => {
		sessionLive = true;
		activeSessionContext.set(ctx);
	});
	pi.on("session_shutdown", () => {
		sessionLive = false;
	});
	pi.events.on(PLANNOTATOR_REQUEST_CHANNEL, async (data) => {
		const request = data as Partial<PlannotatorRequest> | null;
		const ctx = activeSessionContext.get();

		if (!request || typeof request.respond !== "function" || !isPlannotatorAction(request.action)) {
			return;
		}
		const answer = (response: unknown) => respond(request as { respond: (response: never) => void }, response);

		try {
			if (request.action === "review-status") {
				const reviewId = request.payload?.reviewId;
				if (typeof reviewId !== "string" || !reviewId.trim()) {
					answer({ status: "error", error: "Missing reviewId for review-status request." });
					return;
				}
				answer({ status: "handled", result: getStoredReviewStatus(reviewStatusPath, reviewId) });
				return;
			}

			if (!ctx) {
				answer({ status: "unavailable", error: "Plannotator context is not ready yet." });
				return;
			}

			switch (request.action) {
				case "plan-mode": {
					if (!options.handlePlanMode) {
						answer({ status: "unavailable", error: "Plan mode control is not available in this session." });
						return;
					}
					const mode = request.payload?.mode ?? "toggle";
					if (mode !== "enter" && mode !== "exit" && mode !== "toggle" && mode !== "status") {
						answer({ status: "error", error: "Invalid plan-mode payload.mode." });
						return;
					}
					const result = await options.handlePlanMode(mode, ctx);
					answer({ status: "handled", result });
					return;
				}
				case "plan-review": {
					const planContent = request.payload?.planContent;
					if (typeof planContent !== "string" || !planContent.trim()) {
						answer({ status: "error", error: "Missing planContent for plan-review request." });
						return;
					}
					const session = await startPlanReview(ctx, planContent);
					storeReviewStatus(session.reviewId, { status: "pending" });
					session.onDecision((result) => {
						const reviewResult = {
							reviewId: session.reviewId,
							approved: result.approved,
							feedback: result.feedback,
							savedPath: result.savedPath,
							agentSwitch: result.agentSwitch,
							permissionMode: result.permissionMode,
							...(result.answersOnly ? { answersOnly: true } : {}),
						} satisfies PlannotatorReviewResultEvent;
						// Recorded first, so `review-status` reports it whatever happens next.
						storeReviewStatus(session.reviewId, { status: "completed", ...reviewResult });
						// A replaced session's bus is gone; its replacement asks `review-status`.
						if (!sessionLive) return;
						emitReviewResult(reviewResult);
					});
					answer({
						status: "handled",
						result: {
							status: "pending",
							reviewId: session.reviewId,
						},
					});
					return;
				}
				case "code-review": {
					const result = await openCodeReview(ctx, {
						cwd: request.payload?.cwd,
						defaultBranch: request.payload?.defaultBranch,
						diffType: request.payload?.diffType,
						vcsType: request.payload?.vcsType,
						useLocal: request.payload?.useLocal,
						prUrl: request.payload?.prUrl,
						patchFile: request.payload?.patchFile,
					});
					answer({ status: "handled", result });
					return;
				}
				case "annotate": {
					const payload = request.payload;
					if (!payload?.filePath) {
						answer({ status: "error", error: "Missing filePath for annotate request." });
						return;
					}
					const sourceConverted = /\.html?$/i.test(payload.filePath) || /^https?:\/\//i.test(payload.filePath);
					const result = await openMarkdownAnnotation(
						ctx,
						payload.filePath,
						payload.markdown ?? "",
						payload.mode ?? "annotate",
						payload.folderPath,
						undefined,
						sourceConverted,
						payload.gate,
					);
					answer({ status: "handled", result });
					return;
				}
				case "annotate-last": {
					const payload = request.payload;
					const usePayloadText = !!payload?.markdown?.trim();
					const lastText = usePayloadText ? payload!.markdown! : getLastAssistantMessageText(ctx);
					if (!lastText) {
						answer({ status: "unavailable", error: "No assistant message found in session." });
						return;
					}
					const recent = usePayloadText ? [] : getRecentAssistantMessages(ctx, 25);
					const pickerMessages = recent.length > 1 ? recent : undefined;
					const result = await openLastMessageAnnotation(ctx, lastText, payload?.gate, pickerMessages);
					answer({ status: "handled", result });
					return;
				}
				case "archive": {
					const result = await openArchiveBrowserAction(ctx, request.payload?.customPlanPath);
					answer({ status: "handled", result });
					return;
				}
			}
		} catch (err) {
			const message = getStartupErrorMessage(err);
			if (/unavailable|not available/i.test(message)) {
				answer({ status: "unavailable", error: message });
				return;
			}
			answer({ status: "error", error: message });
		}
	});
}

export {
	getLastAssistantMessageText,
	hasPlanBrowserHtml,
	hasReviewBrowserHtml,
	getStartupErrorMessage,
};
