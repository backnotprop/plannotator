import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { DiffType } from "./server.js";
import {
	getLastAssistantMessageText,
	getStartupErrorMessage,
	openArchiveBrowserAction,
	openCodeReview,
	openLastMessageAnnotation,
	openMarkdownAnnotation,
	startPlanReviewBrowserSession,
} from "./plannotator-browser.js";

export const PLANNOTATOR_REQUEST_CHANNEL = "plannotator:request" as const;
export const PLANNOTATOR_REVIEW_RESULT_CHANNEL = "plannotator:review-result" as const;
export const PLANNOTATOR_TIMEOUT_MS = 5_000;

export type PlannotatorAction =
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
	cwd?: string;
	prUrl?: string;
}

export interface PlannotatorCodeReviewResult {
	approved: boolean;
	feedback?: string;
	annotations?: unknown[];
	agentSwitch?: string;
}

export interface PlannotatorAnnotatePayload {
	filePath: string;
	markdown?: string;
	mode?: "annotate" | "annotate-folder" | "annotate-last";
	folderPath?: string;
	/** Enable review-gate UX (Approve / Annotate / Close), #570 */
	gate?: boolean;
}

export interface PlannotatorAnnotationResult {
	feedback: string;
	/** True when the reviewer closed the session without providing feedback. */
	exit?: boolean;
	/** True when the reviewer clicked Approve in review-gate mode, #570 */
	approved?: boolean;
}

export interface PlannotatorArchivePayload {
	customPlanPath?: string;
}

export interface PlannotatorArchiveResult {
	opened: boolean;
}

export type PlannotatorRequestMap = {
	"plan-review": PlannotatorRequestBase<"plan-review", PlannotatorPlanReviewPayload, PlannotatorPlanReviewStartResult>;
	"review-status": PlannotatorRequestBase<"review-status", PlannotatorReviewStatusPayload, PlannotatorReviewStatusResult>;
	"code-review": PlannotatorRequestBase<"code-review", PlannotatorCodeReviewPayload, PlannotatorCodeReviewResult>;
	annotate: PlannotatorRequestBase<"annotate", PlannotatorAnnotatePayload, PlannotatorAnnotationResult>;
	"annotate-last": PlannotatorRequestBase<"annotate-last", PlannotatorAnnotatePayload, PlannotatorAnnotationResult>;
	archive: PlannotatorRequestBase<"archive", PlannotatorArchivePayload, PlannotatorArchiveResult>;
};
export type PlannotatorRequest = PlannotatorRequestMap[PlannotatorAction];
export type PlannotatorResponseMap = {
	"plan-review": PlannotatorResponse<PlannotatorPlanReviewStartResult>;
	"review-status": PlannotatorResponse<PlannotatorReviewStatusResult>;
	"code-review": PlannotatorResponse<PlannotatorCodeReviewResult>;
	annotate: PlannotatorResponse<PlannotatorAnnotationResult>;
	"annotate-last": PlannotatorResponse<PlannotatorAnnotationResult>;
	archive: PlannotatorResponse<PlannotatorArchiveResult>;
};
function isPlannotatorAction(value: unknown): value is PlannotatorAction {
	return (
		value === "plan-review" ||
		value === "review-status" ||
		value === "code-review" ||
		value === "annotate" ||
		value === "annotate-last" ||
		value === "archive"
	);
}

const REVIEW_STATUS_PATH = join(homedir(), ".pi", "plannotator-review-status.json");

type StoredReviewStatus = Record<string, PlannotatorReviewStatusResult>;

function readStoredReviewStatuses(): StoredReviewStatus {
	try {
		if (!existsSync(REVIEW_STATUS_PATH)) return {};
		const raw = readFileSync(REVIEW_STATUS_PATH, "utf-8");
		const parsed = JSON.parse(raw) as StoredReviewStatus;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function writeStoredReviewStatuses(statuses: StoredReviewStatus): void {
	mkdirSync(dirname(REVIEW_STATUS_PATH), { recursive: true });
	writeFileSync(REVIEW_STATUS_PATH, JSON.stringify(statuses, null, 2));
}

function setStoredReviewStatus(reviewId: string, status: PlannotatorReviewStatusResult): void {
	const statuses = readStoredReviewStatuses();
	statuses[reviewId] = status;
	writeStoredReviewStatuses(statuses);
}

function getStoredReviewStatus(reviewId: string): PlannotatorReviewStatusResult {
	return readStoredReviewStatuses()[reviewId] ?? { status: "missing" };
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

export function registerPlannotatorEventListeners(pi: ExtensionAPI): void {
	const activeSessionContext = createActiveSessionContext();

	// Plannotator event requests are handled against the latest active session.
	// The active context is intentionally session-scoped and replaced on each session_start.
	pi.on("session_start", async (_event, ctx) => {
		activeSessionContext.set(ctx);
	});
	pi.events.on(PLANNOTATOR_REQUEST_CHANNEL, async (data) => {
		const request = data as Partial<PlannotatorRequest> | null;
		const ctx = activeSessionContext.get();

		if (!request || typeof request.respond !== "function" || !isPlannotatorAction(request.action)) {
			return;
		}

		try {
			if (request.action === "review-status") {
				const reviewId = request.payload?.reviewId;
				if (typeof reviewId !== "string" || !reviewId.trim()) {
					request.respond({ status: "error", error: "Missing reviewId for review-status request." });
					return;
				}
				request.respond({ status: "handled", result: getStoredReviewStatus(reviewId) });
				return;
			}

			if (!ctx) {
				request.respond({ status: "unavailable", error: "Plannotator context is not ready yet." });
				return;
			}

			switch (request.action) {
				case "plan-review": {
					const planContent = request.payload?.planContent;
					if (typeof planContent !== "string" || !planContent.trim()) {
						request.respond({ status: "error", error: "Missing planContent for plan-review request." });
						return;
					}
					const session = await startPlanReviewBrowserSession(ctx, planContent);
					setStoredReviewStatus(session.reviewId, { status: "pending" });
					session.onDecision((result) => {
						const reviewResult = {
							reviewId: session.reviewId,
							approved: result.approved,
							feedback: result.feedback,
							savedPath: result.savedPath,
							agentSwitch: result.agentSwitch,
							permissionMode: result.permissionMode,
						} satisfies PlannotatorReviewResultEvent;
						setStoredReviewStatus(session.reviewId, { status: "completed", ...reviewResult });
						pi.events.emit(PLANNOTATOR_REVIEW_RESULT_CHANNEL, reviewResult);
					});
					request.respond({
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
						prUrl: request.payload?.prUrl,
					});
					request.respond({ status: "handled", result });
					return;
				}
				case "annotate": {
					const payload = request.payload;
					if (!payload?.filePath) {
						request.respond({ status: "error", error: "Missing filePath for annotate request." });
						return;
					}
					const result = await openMarkdownAnnotation(
						ctx,
						payload.filePath,
						payload.markdown ?? "",
						payload.mode ?? "annotate",
						payload.folderPath,
						undefined,
						payload.gate,
					);
					request.respond({ status: "handled", result });
					return;
				}
				case "annotate-last": {
					const payload = request.payload;
					const lastText = payload?.markdown?.trim() ? payload.markdown : await getLastAssistantMessageText(ctx);
					if (!lastText) {
						request.respond({ status: "unavailable", error: "No assistant message found in session." });
						return;
					}
					const result = await openLastMessageAnnotation(ctx, lastText, payload?.gate);
					request.respond({ status: "handled", result });
					return;
				}
				case "archive": {
					const result = await openArchiveBrowserAction(ctx, request.payload?.customPlanPath);
					request.respond({ status: "handled", result });
					return;
				}
			}
		} catch (err) {
			const message = getStartupErrorMessage(err);
			if (/unavailable|not available/i.test(message)) {
				request.respond({ status: "unavailable", error: message });
				return;
			}
			request.respond({ status: "error", error: message });
		}
	});
}

export {
	getLastAssistantMessageText,
	hasPlanBrowserHtml,
	hasReviewBrowserHtml,
	getStartupErrorMessage,
	openArchiveBrowserAction,
	openCodeReview,
	openLastMessageAnnotation,
	openMarkdownAnnotation,
	openPlanReviewBrowser,
	startPlanReviewBrowserSession,
} from "./plannotator-browser.js";
