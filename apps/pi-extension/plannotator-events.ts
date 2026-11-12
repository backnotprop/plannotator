import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
import { isBrowserSessionStoppedError } from "./browser-session-error.ts";
import { getProcessPiReviewRegistry } from "./plannotator-tool-host.ts";
import {
	newSessionEventId,
	openSessionEvent,
	sessionEndOf,
	sessionEndOfError,
	type PlannotatorSessionAction,
	type SessionEventHandle,
} from "./session-events.ts";

type PlannotatorBrowserModule = typeof import("./plannotator-browser.ts");

export function startPlanReviewBrowserSession(
	...args: Parameters<PlannotatorBrowserModule["startPlanReviewBrowserSession"]>
): ReturnType<PlannotatorBrowserModule["startPlanReviewBrowserSession"]> {
	return loadPlannotatorBrowser().then((browser) => browser.startPlanReviewBrowserSession(...args));
}

export function openPlanReviewBrowser(
	...args: Parameters<PlannotatorBrowserModule["openPlanReviewBrowser"]>
): ReturnType<PlannotatorBrowserModule["openPlanReviewBrowser"]> {
	return loadPlannotatorBrowser().then((browser) => browser.openPlanReviewBrowser(...args));
}

export function startCodeReviewBrowserSession(
	...args: Parameters<PlannotatorBrowserModule["startCodeReviewBrowserSession"]>
): ReturnType<PlannotatorBrowserModule["startCodeReviewBrowserSession"]> {
	return loadPlannotatorBrowser().then((browser) => browser.startCodeReviewBrowserSession(...args));
}

export function openCodeReview(
	...args: Parameters<PlannotatorBrowserModule["openCodeReview"]>
): ReturnType<PlannotatorBrowserModule["openCodeReview"]> {
	return loadPlannotatorBrowser().then((browser) => browser.openCodeReview(...args));
}

export function startMarkdownAnnotationSession(
	...args: Parameters<PlannotatorBrowserModule["startMarkdownAnnotationSession"]>
): ReturnType<PlannotatorBrowserModule["startMarkdownAnnotationSession"]> {
	return loadPlannotatorBrowser().then((browser) => browser.startMarkdownAnnotationSession(...args));
}

export function openMarkdownAnnotation(
	...args: Parameters<PlannotatorBrowserModule["openMarkdownAnnotation"]>
): ReturnType<PlannotatorBrowserModule["openMarkdownAnnotation"]> {
	return loadPlannotatorBrowser().then((browser) => browser.openMarkdownAnnotation(...args));
}

export function startLastMessageAnnotationSession(
	...args: Parameters<PlannotatorBrowserModule["startLastMessageAnnotationSession"]>
): ReturnType<PlannotatorBrowserModule["startLastMessageAnnotationSession"]> {
	return loadPlannotatorBrowser().then((browser) => browser.startLastMessageAnnotationSession(...args));
}

export function openLastMessageAnnotation(
	...args: Parameters<PlannotatorBrowserModule["openLastMessageAnnotation"]>
): ReturnType<PlannotatorBrowserModule["openLastMessageAnnotation"]> {
	return loadPlannotatorBrowser().then((browser) => browser.openLastMessageAnnotation(...args));
}

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
	patchFile?: string;
}

export interface PlannotatorCodeReviewResult {
	approved: boolean;
	feedback?: string;
	annotations?: unknown[];
	agentSwitch?: string;
	platform?: true;
}

export interface PlannotatorAnnotatePayload {
	filePath: string;
	markdown?: string;
	mode?: "annotate" | "annotate-folder" | "annotate-last";
	folderPath?: string;
	gate?: boolean;
}

export interface PlannotatorAnnotationResult {
	feedback: string;
	exit?: boolean;
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

type StoredReviewStatusRead =
	| { ok: true; statuses: StoredReviewStatus }
	| { ok: false; error: string };

function readStoredReviewStatuses(path: string): StoredReviewStatusRead {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, statuses: {} };
		return { ok: false, error: describeError(err) };
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { ok: false, error: "not a JSON object" };
		}
		return { ok: true, statuses: parsed as StoredReviewStatus };
	} catch (err) {
		return { ok: false, error: describeError(err) };
	}
}

export function writeReviewStatusesAtomically(path: string, statuses: StoredReviewStatus): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		writeFileSync(temp, JSON.stringify(statuses, null, 2));
		renameSync(temp, path);
	} catch (err) {
		rmSync(temp, { force: true });
		throw err;
	}
}

function setStoredReviewStatus(path: string, reviewId: string, status: PlannotatorReviewStatusResult): void {
	const read = readStoredReviewStatuses(path);
	if (!read.ok) {
		console.error(
			`Plannotator: ${path} could not be read (${read.error}); left it as it is and did not record review ${reviewId}.`,
		);
		return;
	}
	read.statuses[reviewId] = status;
	writeReviewStatusesAtomically(path, read.statuses);
}

function getStoredReviewStatus(path: string, reviewId: string): PlannotatorReviewStatusResult {
	const read = readStoredReviewStatuses(path);
	return (read.ok ? read.statuses[reviewId] : undefined) ?? { status: "missing" };
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
	reviewStatusPath?: string;
	startPlanReviewSession?: typeof startPlanReviewBrowserSession;
}

export function registerPlannotatorEventListeners(
	pi: ExtensionAPI,
	options: PlannotatorEventListenerOptions = {},
): void {
	const activeSessionContext = createActiveSessionContext();
	const reviewStatusPath = options.reviewStatusPath ?? defaultReviewStatusPath();
	const startPlanReview = options.startPlanReviewSession ?? startPlanReviewBrowserSession;
	let sessionLive = true;

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
	const announceSessionOpened = (
		ctx: ExtensionContext,
		action: PlannotatorSessionAction,
		url: string,
		ids: { requestId?: string; reviewId?: string },
	): SessionEventHandle => {
		let piSessionId: string | undefined;
		try {
			piSessionId = ctx.sessionManager.getSessionId();
		} catch {
			piSessionId = undefined;
		}
		return openSessionEvent(pi, () => sessionLive, {
			id: newSessionEventId((id) => getProcessPiReviewRegistry().openAll().some((review) => review.id === id)),
			action,
			url,
			...(piSessionId ? { piSessionId } : {}),
			...(typeof ids.requestId === "string" && ids.requestId ? { requestId: ids.requestId } : {}),
			...(ids.reviewId ? { reviewId: ids.reviewId } : {}),
		});
	};
	const awaitAnnounced = async <T extends { approved?: boolean; exit?: boolean; closedBy?: string }>(
		ctx: ExtensionContext,
		action: PlannotatorSessionAction,
		requestId: string | undefined,
		session: { url: string; waitForDecision: () => Promise<T> },
	): Promise<T> => {
		const events = announceSessionOpened(ctx, action, session.url, { requestId });
		try {
			const result = await session.waitForDecision();
			events.close(sessionEndOf(result));
			return result;
		} catch (err) {
			events.close(sessionEndOfError(isBrowserSessionStoppedError(err)));
			throw err;
		}
	};
	const storeReviewStatus = (reviewId: string, status: PlannotatorReviewStatusResult): void => {
		try {
			setStoredReviewStatus(reviewStatusPath, reviewId, status);
		} catch (err) {
			console.error(`Plannotator: could not record the status of review ${reviewId}: ${describeError(err)}`);
		}
	};

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
					const events = announceSessionOpened(ctx, "plan-review", session.url, {
						requestId: request.requestId,
						reviewId: session.reviewId,
					});
					void session.waitForDecision().then(
						(result) => events.close(sessionEndOf(result)),
						(err: unknown) => events.close(sessionEndOfError(isBrowserSessionStoppedError(err))),
					);
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
						storeReviewStatus(session.reviewId, { status: "completed", ...reviewResult });
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
					const session = await startCodeReviewBrowserSession(ctx, {
						cwd: request.payload?.cwd,
						defaultBranch: request.payload?.defaultBranch,
						diffType: request.payload?.diffType,
						vcsType: request.payload?.vcsType,
						useLocal: request.payload?.useLocal,
						prUrl: request.payload?.prUrl,
						patchFile: request.payload?.patchFile,
					});
					const result = await awaitAnnounced(ctx, "code-review", request.requestId, session);
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
					const session = await startMarkdownAnnotationSession(
						ctx,
						payload.filePath,
						payload.markdown ?? "",
						payload.mode ?? "annotate",
						payload.folderPath,
						undefined,
						sourceConverted,
						payload.gate,
					);
					const result = await awaitAnnounced(
						ctx,
						payload.mode === "annotate-last" ? "annotate-last" : "annotate",
						request.requestId,
						session,
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
					const session = await startLastMessageAnnotationSession(ctx, lastText, payload?.gate, pickerMessages);
					const result = await awaitAnnounced(ctx, "annotate-last", request.requestId, session);
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

export {
	PLANNOTATOR_SESSION_CLOSED_CHANNEL,
	PLANNOTATOR_SESSION_OPENED_CHANNEL,
	type PlannotatorSessionAction,
	type PlannotatorSessionClosedBy,
	type PlannotatorSessionClosedEvent,
	type PlannotatorSessionOpenedEvent,
	type PlannotatorSessionOutcome,
} from "./session-events.ts";
