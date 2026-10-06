/**
 * Plannotator Pi Extension — File-based plan mode with visual browser review.
 *
 * During planning the agent writes any markdown file anywhere inside cwd and
 * calls plannotator_submit_plan with the path. The user reviews in the
 * browser UI and can approve, deny with annotations, or request changes.
 *
 * Features:
 * - /plannotator-plan-mode command or Ctrl+Alt+P to toggle
 * - --plan flag to start in planning mode
 * - Bash unrestricted during planning (prompt-guided)
 * - Writes restricted to markdown files inside cwd during planning
 * - plannotator_submit_plan tool with browser-based visual approval
 * - [DONE:n] markers for execution progress tracking
 * - /plannotator-review command for code review
 * - /plannotator-annotate command for markdown annotation
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { bundledSkillPaths } from "./bundled-skill.ts";
import { buildPromptVariables, formatTodoList, loadPlannotatorConfig, renderTemplate, resolveExecutionMode, resolvePhaseProfile } from "./config.ts";
import {
	type ChecklistItem,
	markCompletedSteps,
	parseChecklist,
	renderCompletedChecklist,
} from "./generated/checklist.ts";
import { loadConfig, resolveAgentTool, resolveUseJina } from "./generated/config.ts";
import { readImprovementHook } from "./generated/improvement-hooks.ts";
import { composeImproveContext } from "./generated/pfm-reminder.ts";
import {
	hasPlanBrowserHtml,
	hasReviewBrowserHtml,
	getStartupErrorMessage,
	startCodeReviewBrowserSession,
	startLastMessageAnnotationSession,
	startMarkdownAnnotationSession,
	startPlanReviewBrowserSession,
	PLANNOTATOR_PLAN_APPROVED_CHANNEL,
	type PlannotatorPlanApprovedEvent,
	registerPlannotatorEventListeners,
} from "./plannotator-events.ts";
import { resolveTodoProvider, type TodoProvider } from "./todo-providers/index.ts";
import {
	findAssistantMessageByEntryId,
	getAssistantMessageText,
	getLastAssistantMessageSnapshot,
	getRecentAssistantMessages,
	hasSessionMovedPastEntry,
	isAssistantEntryForToolCall,
} from "./assistant-message.ts";
import {
	getPiSessionIdentity,
	isCtxAlive,
	isCurrentPiSessionDifferentFrom,
	notifyCurrentPiSession,
	type PiSessionIdentity,
	registerCurrentPiSession,
	sendUserMessageToCurrentPiSession,
	withCurrentPiSessionFallbackHeader,
} from "./current-pi-session.ts";
import {
	applyPhaseTools,
	isPlanWritePathAllowed,
	isPlannotatorSubmitDevicePath,
	PLAN_MARK_DONE_TOOL,
	PLAN_SUBMIT_TOOL,
	releasePhaseTools,
	type Phase,
	stripPlanningOnlyTools,
} from "./tool-scope.ts";
import { getServerPorts, isRemoteSession, isUrlHostOverridden } from "./server/network.ts";
import { isBrowserSessionStoppedError } from "./browser-session-error.ts";
import { classifyAnnotateOutcome } from "./annotate-outcome.ts";
import { classifyReviewOutcome } from "./review-outcome.ts";
import { createPiSessionBridgeHub } from "./pi-session-bridge.ts";
import type { BrowserDecisionSession, PlanReviewBrowserSession, PlanReviewDecision } from "./plannotator-browser.ts";
import type { AnnotateBundleFile } from "./generated/annotate-bundle.ts";
import {
	PLANNOTATOR_OUTCOME_REVIEW_POSTED,
	PLANNOTATOR_TOOL_DESCRIPTION,
	PLANNOTATOR_TOOL_INPUT_SCHEMA,
	PLANNOTATOR_TOOL_NAME,
	parsePlannotatorToolInput,
	plannotatorBundleSubject,
	plannotatorDecisionHeading,
	plannotatorDecisionSubject,
	plannotatorToolArgs,
	plannotatorToolOpenedText,
	type PlannotatorTarget,
} from "./generated/plannotator-tool.ts";
import {
	agentClosedNotice,
	annotateSubject,
	commentCountSuffix,
	fixedPortBusyText,
	getProcessPiReviewRegistry,
	lastMessageSubject,
	lastMessageUserSubject,
	planSubject,
	reviewSubject,
	type PiOpenReview,
	type PiReviewKind,
} from "./plannotator-tool-host.ts";

// ── Types ──────────────────────────────────────────────────────────────

type PlannotatorPromptsModule = typeof import("./generated/prompts.ts");

let promptsModulePromise: Promise<PlannotatorPromptsModule> | undefined;

function loadPlannotatorPrompts(): Promise<PlannotatorPromptsModule> {
	if (!promptsModulePromise) {
		promptsModulePromise = import("./generated/prompts.ts").catch((error: unknown) => {
			promptsModulePromise = undefined;
			throw error;
		});
	}
	return promptsModulePromise;
}

async function loadAnnotateCommandModules() {
	const [annotateArgs, annotateTarget, annotateBundle, atReference, resolveFile, referenceCommon] = await Promise.all([
		import("./generated/annotate-args.ts"),
		import("./generated/annotate-target.ts"),
		import("./generated/annotate-bundle.ts"),
		import("./generated/at-reference.ts"),
		import("./generated/resolve-file.ts"),
		import("./generated/reference-common.ts"),
	]);
	return {
		parseAnnotateArgs: annotateArgs.parseAnnotateArgs,
		annotateInputNamesExistingTarget: annotateTarget.annotateInputNamesExistingTarget,
		buildAmbiguousAnnotateArgsMessage: annotateTarget.buildAmbiguousAnnotateArgsMessage,
		buildUnresolvedAnnotateArgsMessage: annotateTarget.buildUnresolvedAnnotateArgsMessage,
		buildMissingAnnotateFilesMessage: annotateTarget.buildMissingAnnotateFilesMessage,
		probeAnnotateToken: annotateTarget.probeAnnotateToken,
		probeAnnotateBundlePath: annotateTarget.probeAnnotateBundlePath,
		annotatePathExists: annotateTarget.annotatePathExists,
		resolveAnnotateBundleFiles: annotateTarget.resolveAnnotateBundleFiles,
		annotateBundleRoot: annotateBundle.annotateBundleRoot,
		annotateBundleTargetText: annotateBundle.annotateBundleTargetText,
		selectAnnotateTokenTarget: annotateTarget.selectAnnotateTokenTarget,
		resolveAtReference: atReference.resolveAtReference,
		hasMarkdownFiles: resolveFile.hasMarkdownFiles,
		resolveUserPath: resolveFile.resolveUserPath,
		isAnnotatableTextPath: resolveFile.isAnnotatableTextPath,
		getAnnotatableDocRegex: resolveFile.getAnnotatableDocRegex,
		getAnnotatableExtensionsHint: resolveFile.getAnnotatableExtensionsHint,
		MAX_ANNOTATABLE_FILE_BYTES: resolveFile.MAX_ANNOTATABLE_FILE_BYTES,
		FILE_BROWSER_EXCLUDED: referenceCommon.FILE_BROWSER_EXCLUDED,
	};
}


type SavedPhaseState = {
	model?: { provider: string; id: string };
	thinkingLevel: ThinkingLevel;
};

type PersistedPlannotatorState = {
	phase: Phase;
	lastSubmittedPath?: string;
	savedState?: SavedPhaseState;
	phaseAddedTools?: string[];
	/** Whether the current phase's entry framing message was already delivered. */
	framingDelivered?: boolean;
	/**
	 * Whether a "plan mode off" notice is still owed to the model after a
	 * planning/executing → idle transition (#1320). Set on every return to
	 * idle from a phase, cleared when the notice is delivered or when a new
	 * phase entry supersedes it. Never set on fresh sessions, so an idle
	 * session that never entered plan mode still injects nothing (#1269).
	 */
	idleNoticePending?: boolean;
};

/**
 * One-shot countermand delivered on the first prompt after a planning or
 * executing phase returns to idle (#1320). It is the SOLE mechanism ending
 * plan mode in the conversation: delivered framing stays in history untouched
 * (#1380 — removing it from mid-history shifted every later message and
 * invalidated the provider's cached prefix), so the model's plan-mode steering
 * — its own turns, blocked-write tool results, and the framing itself — is
 * neutralized by this explicit notice, never by silent removal.
 */
const PLAN_MODE_OFF_NOTICE = `[PLANNOTATOR - PLAN MODE OFF]
Plannotator plan mode has ended. Disregard all earlier Plannotator planning or execution instructions from this session: the planning restrictions (markdown-only writes, plan submission for review) and the execution checklist protocol ([DONE:n] markers) no longer apply, and the plan-submission tool is no longer available. Full tool access is restored — respond and use tools normally. If the user wants planning again, they will re-enable plan mode.`;

function getPlanReviewAvailabilityWarning(options: { hasUI: boolean; hasPlanHtml: boolean }): string | null {
	const { hasUI, hasPlanHtml } = options;
	if (hasUI && hasPlanHtml) return null;
	if (!hasUI && !hasPlanHtml) {
		return "Plannotator: interactive plan review is unavailable in this session (no UI support and missing built assets). Plans will auto-approve on exit_plan_mode.";
	}
	if (!hasUI) {
		return "Plannotator: interactive plan review is unavailable in this session (no UI support). Plans will auto-approve on exit_plan_mode.";
	}
	return "Plannotator: interactive plan review assets are missing. Rebuild the extension to restore the browser UI. Plans will auto-approve on exit_plan_mode.";
}

function safeNotify(
	ctx: ExtensionContext,
	message: string,
	type: "info" | "warning" | "error" = "info",
	origin?: PiSessionIdentity,
): void {
	try {
		ctx.ui.notify(message, type);
	} catch (err) {
		if (notifyCurrentPiSession(message, type, origin)) return;
		console.error(`Plannotator notification failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * Foreground "session opened" notice. For a remote session the auto-opened
 * browser is unreachable, so the URL must ride in THIS in-turn message — the
 * after-turn notify inside openBrowserForServer fires too late to render.
 */
function sessionOpenedMessage(label: string, url: string): string {
	if (!isRemoteSession()) return `${label}. You can keep chatting while it runs.`;
	// With an advertised-URL host override the link is directly reachable
	// (e.g. over a tailnet), so the port-forwarding advice would be wrong.
	return isUrlHostOverridden()
		? `${label} — open ${url} on your device. You can keep chatting while it runs.`
		: `${label} — open ${url} on your local machine (forward the port if needed). You can keep chatting while it runs.`;
}

function reportBackgroundError(ctx: ExtensionContext, message: string, err: unknown, origin?: PiSessionIdentity): void {
	const detail = getStartupErrorMessage(err);
	console.error(`${message}: ${detail}`);
	// A stopped session is not a failure: it is how supersession ends a stale
	// undecided session (port self-preemption, #1159) and how cancel paths
	// settle a pending waitForDecision.
	if (isBrowserSessionStoppedError(err)) {
		safeNotify(ctx, "A Plannotator browser session was closed.", "info", origin);
		return;
	}
	safeNotify(ctx, `${message}: ${detail}`, "error", origin);
}

function excerptText(text: string, maxChars = 1000): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxChars) return trimmed;
	return `${trimmed.slice(0, maxChars).trimEnd()}...`;
}

function blockquote(text: string): string {
	return text
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
}

function anchorMessageFeedback(feedback: string, originalMessage: string): string {
	return `This feedback applies to the earlier assistant response excerpted below:

${blockquote(excerptText(originalMessage))}

User feedback:
${feedback}`;
}

function shouldAnchorLastMessageFeedback(ctx: ExtensionContext, entryId: string, origin: PiSessionIdentity): boolean {
	if (isCurrentPiSessionDifferentFrom(origin)) return true;
	try {
		return hasSessionMovedPastEntry(ctx, entryId);
	} catch {
		return true;
	}
}

function reportCurrentSessionSendFailure(errorMessage: string, err: unknown, origin: PiSessionIdentity): void {
	const detail = getStartupErrorMessage(err);
	console.error(`${errorMessage}: ${detail}`);
	notifyCurrentPiSession(`${errorMessage}: ${detail}`, "error", origin);
}

function trySendUserMessageToDifferentCurrentSession(
	content: Parameters<ExtensionAPI["sendUserMessage"]>[0],
	options: Parameters<ExtensionAPI["sendUserMessage"]>[1],
	errorMessage: string,
	origin: PiSessionIdentity,
): boolean {
	const result = sendUserMessageToCurrentPiSession(
		withCurrentPiSessionFallbackHeader(content),
		options,
		origin,
	);
	if (result.ok) return true;
	if (result.reason === "send-failed") {
		reportCurrentSessionSendFailure(errorMessage, result.error, origin);
		return true;
	}
	return false;
}

function sendUserMessageWithCurrentSessionFallback(
	pi: ExtensionAPI,
	content: Parameters<ExtensionAPI["sendUserMessage"]>[0],
	options: Parameters<ExtensionAPI["sendUserMessage"]>[1],
	errorMessage: string,
	origin: PiSessionIdentity,
): void {
	if (trySendUserMessageToDifferentCurrentSession(content, options, errorMessage, origin)) return;

	try {
		pi.sendUserMessage(content, options);
		return;
	} catch (err) {
		if (trySendUserMessageToDifferentCurrentSession(content, options, errorMessage, origin)) return;
		throw err;
	}
}

/**
 * Warning for hosts whose extension context lacks `ctx.isProjectTrusted`
 * (#1353). Two audiences reach this path: real Pi older than 0.79.1 (the
 * release that added the capability) and forks like oh-my-pi that have not
 * adopted it. Neither Pi's nor oh-my-pi's extension context exposes a host
 * name or version, so the two are not reliably distinguishable at runtime —
 * the message states the capability gap without guessing which host it is,
 * and must stay true for both. "Bundled and global config still load" is a
 * fact of loadPlannotatorConfig: only project-local config is trust-gated.
 */
export const PROJECT_TRUST_CAPABILITY_WARNING =
	"This host does not expose project trust (ctx.isProjectTrusted, Pi 0.79.1+). Project-local config (.pi/plannotator.json) is disabled; bundled and global config still load.";

/**
 * A plan review the agent submitted and is waiting on. Plan review does not
 * hold the tool call open: `plannotator_submit_plan` returns once the review
 * server is up and the decision arrives later as a message in the session.
 */
interface PendingPlanReview {
	session: PlanReviewBrowserSession;
	/** The plan file the open review shows (a revision may name another file). */
	filePath: string;
	/** The plan text the open review shows. */
	planContent: string;
	/** Set once a decision or a stop has been observed: no further pushes. */
	settled: boolean;
	/** Its entry in the open-review registry (the `plannotator` tool's list). */
	tracked?: PiOpenReview;
}

/**
 * `defaultActive: false` for `pi.registerTool`, spread in rather than written
 * as a literal key because the Pi floor's types (0.79.1) do not declare it.
 * Pi 0.99+ then leaves the tool inactive until the extension activates it;
 * older Pi ignores the key and activates every registered tool.
 */
const NOT_ACTIVE_ON_REGISTRATION = { defaultActive: false } as const;

/** Host seams for tests. Production passes nothing. */
export interface PlannotatorExtensionDeps {
	startPlanReview?: typeof startPlanReviewBrowserSession;
	hasPlanBrowserHtml?: () => boolean;
	hasReviewBrowserHtml?: () => boolean;
	startCodeReview?: typeof startCodeReviewBrowserSession;
	startAnnotation?: typeof startMarkdownAnnotationSession;
	startLastMessageAnnotation?: typeof startLastMessageAnnotationSession;
}

/** The tool result while a plan waits for the reviewer. Kept in one place so the wording cannot drift. */
function planSubmittedForReviewText(filePath: string, version: number | undefined, revised: boolean): string {
	const label = version && version > 0 ? ` as version ${version}` : "";
	const opening = revised
		? `Revised plan ${filePath} pushed into the open Plannotator review${label}.`
		: `Plan ${filePath} submitted for review in Plannotator${label}.`;
	return `${opening} The reviewer's decision will arrive later as a new message in this session. Do not start implementing: end your turn now and wait for that message. If you revise the plan before then, call ${PLAN_SUBMIT_TOOL} again with the same path and the open review updates.`;
}

/** Same steps in the same order (checkmarks aside): the file still holds the approved checklist. */
function sameChecklistSteps(a: ReturnType<typeof parseChecklist>, b: ReturnType<typeof parseChecklist>): boolean {
	return a.length === b.length && a.every((item, index) => item.text === b[index]!.text);
}

/**
 * The approved plan text appended to the approval message. Execution works
 * from this snapshot; when the file changed after the reviewer's version was
 * submitted, the message says those edits were not reviewed.
 */
export function approvedPlanSection(filePath: string, approvedPlan: string, fileDiffers: boolean): string {
	const longestRun = Math.max(2, ...[...approvedPlan.matchAll(/`+/g)].map((match) => match[0].length));
	const fence = "`".repeat(longestRun + 1);
	const drift = fileDiffers
		? `\n\n**${filePath} has changed since the reviewer saw it.** Those edits were NOT reviewed: do not execute them, and do not re-read ${filePath} for the plan. If you still want those changes, stop and tell the user so they can return to plan mode and you can resubmit the plan for review.`
		: "";
	return `## Approved plan\n\nThis is the exact plan text the reviewer approved. Execute it as written here, not from the file.${drift}\n\n${fence}markdown\n${approvedPlan.replace(/\n$/, "")}\n${fence}`;
}

export default function plannotator(pi: ExtensionAPI, deps: PlannotatorExtensionDeps = {}): void {
	const startPlanReview = deps.startPlanReview ?? startPlanReviewBrowserSession;
	const planBrowserHtmlAvailable = deps.hasPlanBrowserHtml ?? hasPlanBrowserHtml;
	const reviewBrowserHtmlAvailable = deps.hasReviewBrowserHtml ?? hasReviewBrowserHtml;
	const startCodeReview = deps.startCodeReview ?? startCodeReviewBrowserSession;
	const startAnnotation = deps.startAnnotation ?? startMarkdownAnnotationSession;
	const startLastMessageAnnotation = deps.startLastMessageAnnotation ?? startLastMessageAnnotationSession;
	// The `plannotator` tool switch (off by default on Pi), read once per
	// extension instance (one per session and per /reload): see the tool's
	// registration below.
	const agentToolEnabled = resolveAgentTool(loadConfig(), process.env, "pi");
	const currentPiSession = registerCurrentPiSession(pi);
	// "Ask this session": Ask AI answered by this Pi session (review, annotate,
	// last, plan review). Listeners register once here; each command binds a bridge to its ctx.
	const sessionBridgeHub = createPiSessionBridgeHub(pi);
	// Off in remote mode: anyone who can reach the session URL could otherwise
	// type into this agent session (same reasoning as the agent terminal).
	const sessionBridgeFor = (ctx: ExtensionContext, origin: PiSessionIdentity) =>
		isRemoteSession() ? undefined : sessionBridgeHub.createBridge(ctx, origin);
	/**
	 * The open reviews (tool, slash commands, plan review), each with a `pn-`
	 * session id and the Pi session that opened it: what the `plannotator`
	 * tool's list and close see. Process-wide, so a replacement instance for
	 * the same Pi session (/resume, /reload) still sees its reviews.
	 */
	const openReviews = getProcessPiReviewRegistry();
	let phase: Phase = "idle";
	void registerPlannotatorEventListeners(pi, {
		handlePlanMode: async (mode, ctx) => {
			if (mode === "status") return { phase };
			if (mode === "enter") {
				if (phase === "idle") await enterPlanning(ctx);
				return { phase };
			}
			if (mode === "exit") {
				if (phase !== "idle") await exitToIdle(ctx);
				return { phase };
			}
			await togglePlanMode(ctx);
			return { phase };
		},
	});
	let lastSubmittedPath: string | null = null;
	/**
	 * The exact plan text the reviewer approved, when execution started from a
	 * browser approval. Execution works from this snapshot, never re-reading
	 * the plan file (which may hold edits the reviewer never saw). Null for
	 * auto-approved plans, which keep the file as their source.
	 */
	let approvedPlanContent: string | null = null;
	let checklistItems: ChecklistItem[] = [];
	let savedState: SavedPhaseState | null = null;
	let phaseAddedTools: string[] = [];
	let plannotatorConfig = {};
	let justApprovedPlan = false;
	// One-shot latch per phase entry: the phase framing message is delivered on
	// the first prompt of a phase and then lives in conversation history, so it
	// must never be re-sent on later prompts of the same phase. Reset at every
	// phase transition; persisted so session resume does not re-deliver.
	let framingDelivered = false;
	// One-shot latch for the plan-mode-off countermand (#1320): armed only by
	// returnToIdle (a genuine planning/executing → idle transition), never on
	// fresh sessions, so the #1269 inject-nothing-while-idle promise holds
	// until plan mode has actually been used. Persisted like framingDelivered
	// so resume/branch switches neither drop nor duplicate the notice.
	let idleNoticePending = false;
	/**
	 * Cleared when this extension instance's session is torn down or replaced.
	 * Pi builds a fresh instance for the replacement session, so this latch only
	 * ever describes the session this closure was created for. It is the cheap
	 * front half of the staleness check; `isCtxAlive` covers teardown paths that
	 * never reach our `session_shutdown` handler.
	 */
	let sessionAlive = true;
	/** The plan review waiting on the reviewer, if any (see PendingPlanReview). */
	let pendingPlanReview: PendingPlanReview | null = null;
	/** Resolved once per execution phase; undefined means widget-only. */
	let todoProvider: TodoProvider | undefined;
	/** Latch: no provider found, or one sync failed. Cleared on return to idle. */
	let todoProviderDisabled = false;

	pi.on("session_start", (_event, ctx) => {
		sessionAlive = true;
		currentPiSession.update(ctx);
		settleAgentToolActivation(ctx);
	});

	/**
	 * Whether this session's model sees the `plannotator` tool, decided ONCE,
	 * at the session's start and before its first request: active with an
	 * interactive UI, inactive in print/JSON mode (Pi before 0.99 activates
	 * every registered tool, so it is taken back out there). Never revisited
	 * for the session, so the tool list (part of the prompt prefix) stays put.
	 */
	let agentToolActivationSettled = false;
	function settleAgentToolActivation(ctx: ExtensionContext): void {
		if (!agentToolEnabled || agentToolActivationSettled) return;
		agentToolActivationSettled = true;
		const active = pi.getActiveTools();
		const isActive = active.includes(PLANNOTATOR_TOOL_NAME);
		if (ctx.hasUI && !isActive) pi.setActiveTools([...active, PLANNOTATOR_TOOL_NAME]);
		else if (!ctx.hasUI && isActive) pi.setActiveTools(active.filter((tool) => tool !== PLANNOTATOR_TOOL_NAME));
	}

	// The plannotator knowledge skill is offered here rather than through a
	// static `pi.skills` manifest entry, so it can yield to the copy the CLI
	// installer puts in ~/.agents/skills instead of colliding with it (#1642).
	pi.on("resources_discover", () => {
		const skillPaths = bundledSkillPaths(pi.getCommands());
		return skillPaths.length > 0 ? { skillPaths } : undefined;
	});

	pi.on("session_shutdown", () => {
		sessionAlive = false;
		currentPiSession.clear();
		// A plan decision belongs to the session that is planning: unlike review
		// and annotate feedback it is not re-targeted to a replacement session,
		// so an open plan review closes with its session.
		stopPendingPlanReview();
		// Browser sessions deliberately outlive in-process session replacement so
		// a tab opened before /new can still deliver feedback to the replacement
		// session (withCurrentPiSessionFallbackHeader). On real process teardown
		// the OS frees the ports, and port self-preemption reclaims any stale
		// fixed-port session on the next command.
	});

	// ── Flags ────────────────────────────────────────────────────────────

	pi.registerFlag("plan", {
		description: "Start in plan mode (restricted exploration and planning)",
		type: "boolean",
		default: false,
	});

	// ── Helpers ──────────────────────────────────────────────────────────

	function getPhaseProfile(): ReturnType<typeof resolvePhaseProfile> | undefined {
		if (phase === "planning" || phase === "executing") {
			return resolvePhaseProfile(plannotatorConfig, phase);
		}
		return undefined;
	}

	function updateStatus(ctx: ExtensionContext): void {
		const profile = getPhaseProfile();
		if (phase === "executing" && checklistItems.length > 0) {
			const completed = checklistItems.filter((t) => t.completed).length;
			ctx.ui.setStatus(
				"plannotator",
				ctx.ui.theme.fg("accent", `📋 ${completed}/${checklistItems.length}`),
			);
		} else if (phase === "planning" && profile?.statusLabel) {
			ctx.ui.setStatus("plannotator", ctx.ui.theme.fg("warning", profile.statusLabel));
		} else if (phase === "executing" && profile?.statusLabel) {
			ctx.ui.setStatus("plannotator", ctx.ui.theme.fg("accent", profile.statusLabel));
		} else {
			ctx.ui.setStatus("plannotator", undefined);
		}
	}

	function updateWidget(ctx: ExtensionContext): void {
		if (phase === "executing" && checklistItems.length > 0) {
			const lines = checklistItems.map((item) => {
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "☑ ") +
						ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					);
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
			});
			ctx.ui.setWidget("plannotator-progress", lines);
		} else {
			ctx.ui.setWidget("plannotator-progress", undefined);
		}
	}

	/**
	 * Mirror the checklist into an editable todo provider, when one is present.
	 *
	 * Additive by design: the progress widget above stays exactly as it was.
	 * pi-todos renders its list on demand in `/todos` and has no live surface,
	 * so replacing the widget with it would trade a visible tracker for files
	 * behind a keystroke. Failures are swallowed after one notification —
	 * a todo mirror must never break plan execution. Runs even when the
	 * checklist is empty so a resubmitted-empty plan still reconciles
	 * (closing todos it used to own) instead of leaving them orphaned.
	 */
	async function syncTodoProvider(ctx: ExtensionContext): Promise<void> {
		if (todoProviderDisabled) return;
		if (phase !== "executing" || !lastSubmittedPath) return;
		if (!todoProvider) {
			todoProvider = resolveTodoProvider(loadConfig(), {
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
			});
			if (!todoProvider) {
				todoProviderDisabled = true;
				return;
			}
		}
		// Tag on the cwd-relative path: it is stable across machines and reads
		// cleanly in the /todos detail view, which renders raw tags.
		const planId = relative(ctx.cwd, resolve(ctx.cwd, lastSubmittedPath)) || lastSubmittedPath;
		try {
			await todoProvider.sync(checklistItems, planId);
		} catch (error) {
			todoProviderDisabled = true;
			ctx.ui.notify(
				`Plannotator: ${todoProvider.name} sync failed, continuing with the progress widget only. ${
					error instanceof Error ? error.message : String(error)
				}`,
				"warning",
			);
		}
	}

	function persistCompletedChecklist(fullPath: string): void {
		try {
			const content = readFileSync(fullPath, "utf-8");
			// Executing an approved snapshot: write progress into the file only
			// while its checklist is still the approved one, so steps never land
			// on boxes of an unreviewed edit.
			if (approvedPlanContent !== null && !sameChecklistSteps(parseChecklist(content), checklistItems)) return;
			// One-turn ordinal-desync window: checklistItems were parsed at turn
			// start, so an agent that edits the plan's checkboxes mid-turn can land
			// a step number on a neighboring box until the next turn re-parses from
			// disk. Bounded by upgrade-only writes plus that per-turn re-parse.
			const updated = renderCompletedChecklist(content, checklistItems);
			if (updated !== content) writeFileSync(fullPath, updated, "utf-8");
		} catch {
			// Progress persistence must not stop plan execution.
		}
	}

	async function markStepDone(step: number, ctx: ExtensionContext): Promise<boolean> {
		if (phase !== "executing") return false;
		const item = checklistItems.find((candidate) => candidate.step === step);
		if (!item) return false;

		item.completed = true;
		if (lastSubmittedPath) persistCompletedChecklist(resolve(ctx.cwd, lastSubmittedPath));
		updateStatus(ctx);
		updateWidget(ctx);
		await syncTodoProvider(ctx);
		persistState();
		return true;
	}

	function captureSavedState(ctx: ExtensionContext): void {
		savedState = {
			model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
			thinkingLevel: pi.getThinkingLevel(),
		};
	}

	function persistState(): void {
		pi.appendEntry("plannotator", {
			phase,
			lastSubmittedPath,
			savedState,
			phaseAddedTools,
			framingDelivered,
			idleNoticePending,
		});
	}

	async function applyModelRef(
		ref: { provider: string; id: string },
		ctx: ExtensionContext,
		reason: string,
	): Promise<void> {
		const model = ctx.modelRegistry.find(ref.provider, ref.id);
		if (!model) {
			ctx.ui.notify(`Plannotator: ${reason} model ${ref.provider}/${ref.id} not found.`, "warning");
			return;
		}

		const success = await pi.setModel(model);
		if (!success) {
			ctx.ui.notify(`Plannotator: no API key for ${ref.provider}/${ref.id}.`, "warning");
		}
	}

	async function restoreSavedState(ctx: ExtensionContext): Promise<void> {
		if (!savedState) return;

		if (savedState.model) {
			await applyModelRef(savedState.model, ctx, "restore");
		}
		pi.setThinkingLevel(savedState.thinkingLevel);
	}

	function releaseAddedPhaseTools(): void {
		const activeTools = pi.getActiveTools();
		const nextTools = releasePhaseTools(activeTools, phaseAddedTools);
		phaseAddedTools = [];
		if (nextTools.length !== activeTools.length) pi.setActiveTools(nextTools);
	}

	/**
	 * Apply the current phase's tools, model and thinking level. With
	 * `applyModelSettings: false` only the tools are re-applied: the model and
	 * thinking level stay as they are and the saved pre-phase state is not
	 * restored (the same-phase /tree resync, #1722).
	 */
	async function applyPhaseConfig(
		ctx: ExtensionContext,
		opts: { restoreSavedState?: boolean; applyModelSettings?: boolean } = {},
	): Promise<void> {
		const profile = getPhaseProfile();
		const applyModelSettings = opts.applyModelSettings !== false;
		if (applyModelSettings && opts.restoreSavedState !== false && savedState) {
			await restoreSavedState(ctx);
		}

		if (phase === "planning" || phase === "executing") {
			const activeTools = pi.getActiveTools();
			const configuredTools = profile?.activeTools ?? [];
			// A user-supplied phases.planning.activeTools replaces the built-in list
			// wholesale, so union the submit tool back in: the planning system prompt
			// instructs the model to call it, and without it the phase is a dead end.
			// It still flows through phaseAddedTools, so it is released on phase exit
			// like any other addition (and is skipped if already active).
			const phaseTools =
				phase === "planning" && !configuredTools.includes(PLAN_SUBMIT_TOOL)
					? [...configuredTools, PLAN_SUBMIT_TOOL]
					: phase === "executing" && !configuredTools.includes(PLAN_MARK_DONE_TOOL)
						? [...configuredTools, PLAN_MARK_DONE_TOOL]
						: configuredTools;
			const selection = applyPhaseTools(
				activeTools,
				phaseAddedTools,
				phaseTools,
			);
			phaseAddedTools = selection.addedTools;
			if (
				selection.activeTools.length !== activeTools.length ||
				selection.activeTools.some((tool, index) => tool !== activeTools[index])
			) {
				pi.setActiveTools(selection.activeTools);
			}
		}

		if (applyModelSettings && profile?.model) {
			await applyModelRef(profile.model, ctx, phase);
		}

		if (applyModelSettings && profile?.thinking) {
			// The config accepts every level current Pi knows, which is a superset
			// of the `ThinkingLevel` union of the pinned Pi floor (#1304). Pi clamps
			// a level the running model does not support, so handing it one this
			// build's types have not heard of yet is safe.
			pi.setThinkingLevel(profile.thinking as ThinkingLevel);
		}

		updateStatus(ctx);
		updateWidget(ctx);
		await syncTodoProvider(ctx);
	}

	async function enterPlanning(ctx: ExtensionContext): Promise<void> {
		phase = "planning";
		framingDelivered = false;
		// An undelivered plan-mode-off notice is superseded by the planning
		// framing this entry will deliver; dropping it avoids a stale "plan
		// mode is off" landing after plan mode came back on.
		idleNoticePending = false;
		checklistItems = [];
		captureSavedState(ctx);
		await applyPhaseConfig(ctx, { restoreSavedState: false });
		persistState();
		ctx.ui.notify(
			"Plannotator: planning mode enabled.",
		);
		const warning = getPlanReviewAvailabilityWarning({ hasUI: ctx.hasUI, hasPlanHtml: planBrowserHtmlAvailable() });
		if (warning) {
			ctx.ui.notify(warning, "warning");
		}
	}

	/**
	 * The single exit sequence every idle transition shares: drop phase state,
	 * hand back the tools the phase added, restore the pre-phase model/thinking
	 * level, then refresh the UI and persist. Callers add their own messaging,
	 * session entries, and events around it.
	 */
	/**
	 * Close the open plan review, if any, without delivering anything. Its
	 * decision handler sees `settled` and stays silent.
	 */
	function stopPendingPlanReview(): void {
		const review = pendingPlanReview;
		if (!review) return;
		pendingPlanReview = null;
		review.settled = true;
		if (review.tracked) openReviews.remove(review.tracked);
		try {
			review.session.stop();
		} catch (err) {
			console.error(`Plannotator: failed to close the plan review: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async function returnToIdle(ctx: ExtensionContext): Promise<void> {
		// Leaving plan mode abandons a plan still in review: its decision would
		// arrive in a session that is no longer planning.
		stopPendingPlanReview();
		phase = "idle";
		framingDelivered = false;
		// Every caller reaches here FROM planning or executing, so this is the
		// one place the plan-mode-off notice may be armed (#1320). Fresh idle
		// sessions never pass through returnToIdle and stay injection-free.
		idleNoticePending = true;
		checklistItems = [];
		lastSubmittedPath = null;
		approvedPlanContent = null;
		// Re-detect for the next plan: a provider that appeared (or a transient
		// write failure) should not be decided once for the whole session.
		todoProvider = undefined;
		todoProviderDisabled = false;

		releaseAddedPhaseTools();
		await restoreSavedState(ctx);
		savedState = null;
		updateStatus(ctx);
		updateWidget(ctx);
		persistState();
	}

	async function exitToIdle(ctx: ExtensionContext): Promise<void> {
		await returnToIdle(ctx);
		ctx.ui.notify("Plannotator: disabled. Full access restored.");
	}

	async function togglePlanMode(ctx: ExtensionContext): Promise<void> {
		if (phase === "idle") {
			await enterPlanning(ctx);
		} else {
			await exitToIdle(ctx);
		}
	}

	async function handoffApprovedPlan(
		ctx: ExtensionContext,
		planFilePath: string,
		planContent: string,
		feedback?: string,
	): Promise<void> {
		pi.appendEntry("plannotator-handoff", { planFilePath });
		await returnToIdle(ctx);
		pi.events.emit(PLANNOTATOR_PLAN_APPROVED_CHANNEL, {
			cwd: ctx.cwd,
			planFilePath,
			planContent,
			...(feedback ? { feedback } : {}),
		} satisfies PlannotatorPlanApprovedEvent);
		ctx.ui.notify("Plannotator: approved plan handed off for external execution.");
	}

	// ── Commands & Shortcuts ─────────────────────────────────────────────

	pi.registerCommand("plannotator-plan-mode", {
		description: "Toggle plannotator planning mode",
		handler: async (_args, ctx) => {
			await togglePlanMode(ctx);
		},
	});

	// ── Review sessions: one launch path for the slash commands and the tool ──
	//
	// /plannotator-review, /plannotator-annotate, /plannotator-last and the
	// `plannotator` tool all go through the launch functions below: in-process
	// server, "Ask this session" bridge, decision delivered later as a followUp
	// message. Every review is recorded in `openReviews` with a `pn-` session
	// id until its decision settles, which is what the tool's list and close
	// read (only this Pi session's reviews).

	type LaunchResult = { ok: true; review: PiOpenReview } | { ok: false; error: string };

	interface LaunchOptions {
		/**
		 * Opened by the `plannotator` tool: the agent was told to wait for the
		 * decision, so a gated session's bare approval is delivered as a message
		 * too (a slash command's bare approval only notifies, as before).
		 */
		deliverApproval?: boolean;
		/**
		 * Probe each word when the whole argument string names nothing (the
		 * slash commands' tolerant tier, #1182). The tool passes its target as
		 * ONE argument, like the CLI's argv, so it never splits it.
		 */
		tolerant?: boolean;
		/** `last` from the tool: skip the assistant message holding this tool call. */
		skipToolCallId?: string;
	}

	/** The id of the Pi session that owns a review; list/close only see their own. */
	function ownerOf(ctx: ExtensionContext): string | undefined {
		try {
			return ctx.sessionManager.getSessionId();
		} catch {
			return undefined;
		}
	}

	/** A decision message for the agent: the heading naming subject, id and outcome, then the prompt. */
	function withDecisionHeading(review: PiOpenReview, outcome: string, body: string): string {
		return `${plannotatorDecisionHeading(review.subject, review.id, outcome, review.target)}\n\n${body}`;
	}

	/**
	 * Record a review that just opened and deliver its decision when it
	 * settles. A review the agent closed itself (host control) delivers
	 * nothing: one notification says what was kept.
	 */
	function trackReview<T extends { closedBy?: "agent"; unsentAnnotations?: number }>(
		ctx: ExtensionContext,
		origin: PiSessionIdentity,
		kind: Exclude<PiReviewKind, "plan">,
		names: { subject: string; userSubject?: string; target?: PlannotatorTarget },
		session: BrowserDecisionSession<T>,
		errors: { send: string; session: string },
		deliver: (result: T, review: PiOpenReview) => Promise<void>,
	): PiOpenReview {
		const review = openReviews.add({ kind, ...names, url: session.url, owner: ownerOf(ctx), hostControl: session.hostControl });
		void session
			.waitForDecision()
			.then(async (result) => {
				openReviews.remove(review);
				try {
					if (result.closedBy === "agent") {
						safeNotify(ctx, agentClosedNotice(review, result.unsentAnnotations), "info", origin);
						return;
					}
					await deliver(result, review);
				} catch (err) {
					reportBackgroundError(ctx, errors.send, err, origin);
				}
			})
			.catch((err) => {
				openReviews.remove(review);
				reportBackgroundError(ctx, errors.session, err, origin);
			});
		return review;
	}

	async function launchCodeReview(ctx: ExtensionContext, args: string | string[]): Promise<LaunchResult> {
		if (!reviewBrowserHtmlAvailable()) {
			return { ok: false, error: "Code review UI not available. Run 'bun run build' in the pi-extension directory." };
		}

		currentPiSession.update(ctx);
		const origin = getPiSessionIdentity(ctx);

		try {
			const { formatIgnoredReviewWords, parseReviewArgs, resolveReviewTarget, withReviewDirectory } = await import("./generated/review-args.ts");
			const reviewArgs = parseReviewArgs(args);
			// Argument-shape failures refuse to start a session (same contract
			// as the CLI's exit 1), surfaced through Pi's notifier.
			if (reviewArgs.errors.length > 0) {
				return { ok: false, error: `Plannotator: ${reviewArgs.errors.join("; ")}` };
			}
			const reviewTarget = resolveReviewTarget(reviewArgs, ctx.cwd);
			const ignoredNotice = formatIgnoredReviewWords(reviewTarget);
			if (ignoredNotice) ctx.ui.notify(`Plannotator: ${ignoredNotice}`, "info");
			const session = await startCodeReview(ctx, {
				sessionBridge: sessionBridgeFor(ctx, origin),
				cwd: reviewTarget.directory,
				includeReviewDirectory: !!reviewTarget.directory,
				prUrl: reviewArgs.prUrl,
				patchFile: reviewArgs.patchFile,
				vcsType: reviewArgs.vcsType,
				useLocal: reviewArgs.useLocal,
				// --base / --diff-type: session-only open state from user flags.
				// openStateFromFlags turns on strict validation (provider
				// matrix, base probe) and the explicit/pinned server bits;
				// programmatic callers omit it and keep the legacy
				// forward-and-let-it-upgrade behavior.
				defaultBranch: reviewArgs.base,
				diffType: reviewArgs.diffType,
				openStateFromFlags: reviewArgs.base !== undefined || reviewArgs.diffType !== undefined,
				// `--no-git-remote-check` (#1553): session-only, and only ever a
				// disable — undefined leaves the env var / config deciding.
				gitRemoteCheck: reviewArgs.gitRemoteCheck,
			});
			ctx.ui.notify(sessionOpenedMessage("Code review opened", session.url), "info");
			const subject = reviewArgs.patchFile
				? `patch ${basename(reviewArgs.patchFile)}`
				: reviewSubject(reviewArgs.prUrl, reviewTarget.directory);
			// What was reviewed, in full: the PR URL, the patch file or the directory.
			const target = reviewArgs.prUrl
				?? (reviewArgs.patchFile && reviewArgs.patchFile !== "-" ? resolve(ctx.cwd, reviewArgs.patchFile) : undefined)
				?? (reviewArgs.patchFile ? undefined : resolve(reviewTarget.directory ?? ctx.cwd));
			const errors = {
				send: "Plannotator code review feedback could not be sent",
				session: "Plannotator code review session failed",
			};
			const review = trackReview(ctx, origin, "review", { subject, ...(target ? { target } : {}) }, session, errors, async (result, tracked) => {
				// The server names what the decision is about NOW: an in-place PR
				// switch or a worktree diff moves it from what was opened.
				if (result.target) {
					tracked.subject = plannotatorDecisionSubject(tracked.subject, tracked.target, result.target);
					tracked.target = result.target;
				}
				if (result.feedback) result.feedback = withReviewDirectory(result.feedback, result.reviewDirectory);
				const outcome = classifyReviewOutcome(result);
				if (outcome.kind === "closed") {
					safeNotify(ctx, "Code review session closed.", "info", origin);
					return;
				}
				if (outcome.kind === "approved") {
					// PR5 delivery (spec §6.4, consumer #4): bare approvals send
					// the approved prompt alone; approvals carrying reviewer notes
					// send the approved-with-notes framing (non-blocking guidance).
					const { composeReviewApprovedMessage } = await loadPlannotatorPrompts();
					const label = result.feedback ? `Approved with notes${commentCountSuffix(result.annotations)}` : "Approved";
					sendUserMessageWithCurrentSessionFallback(
						pi,
						withDecisionHeading(tracked, label, composeReviewApprovedMessage("pi", result.feedback, loadConfig())),
						{ deliverAs: "followUp" },
						errors.send,
						origin,
					);
					return;
				}
				if (outcome.kind === "no-feedback") {
					safeNotify(ctx, "Code review closed (no feedback).", "info", origin);
					return;
				}
				// The verification-only suffix goes on everything the reviewer
				// sent; only the platform status post, which the review server
				// marks, goes through verbatim (see classifyReviewOutcome).
				let reviewFeedback = result.feedback ?? "";
				if (outcome.appendDeniedSuffix) {
					const { getReviewDeniedSuffix } = await loadPlannotatorPrompts();
					reviewFeedback += getReviewDeniedSuffix("pi", loadConfig());
				}
				const label = result.platform === true
					? PLANNOTATOR_OUTCOME_REVIEW_POSTED
					: `Changes requested${commentCountSuffix(result.annotations)}`;
				sendUserMessageWithCurrentSessionFallback(
					pi,
					withDecisionHeading(tracked, label, reviewFeedback),
					{ deliverAs: "followUp" },
					errors.send,
					origin,
				);
			});
			return { ok: true, review };
		} catch (err) {
			return { ok: false, error: `Failed to start code review UI: ${getStartupErrorMessage(err)}` };
		}
	}

	/** Annotate arguments, from `parseAnnotateArgs` (slash command) or the tool's call. */
	interface AnnotateRequest {
		filePath: string;
		rawFilePath: string;
		gate: boolean;
		renderHtml: boolean;
		renderMarkdown: boolean;
		noJina: boolean;
		app: boolean;
		static: boolean;
		/**
		 * The tool's list target: several files as ONE review (a bundle), in
		 * this order. Every entry must be an existing file named by its path.
		 */
		targets?: string[];
	}

	async function launchAnnotate(ctx: ExtensionContext, request: AnnotateRequest, options: LaunchOptions = {}): Promise<LaunchResult> {
		const {
			FILE_BROWSER_EXCLUDED,
			hasMarkdownFiles,
			annotateInputNamesExistingTarget,
			buildAmbiguousAnnotateArgsMessage,
			buildUnresolvedAnnotateArgsMessage,
			probeAnnotateToken,
			buildMissingAnnotateFilesMessage,
			probeAnnotateBundlePath,
			annotatePathExists,
			resolveAnnotateBundleFiles,
			annotateBundleRoot,
			annotateBundleTargetText,
			selectAnnotateTokenTarget,
			resolveAtReference,
			resolveUserPath,
			isAnnotatableTextPath,
			getAnnotatableDocRegex,
			getAnnotatableExtensionsHint,
			MAX_ANNOTATABLE_FILE_BYTES,
		} = await loadAnnotateCommandModules();
		let { filePath, rawFilePath } = request;
		const probeToken = (token: string) => probeAnnotateToken(token, ctx.cwd, { bareDirectories: false });
		const bundleProbes = {
			bundlePath: (token: string) => probeAnnotateBundlePath(token, ctx.cwd),
			pathExists: (token: string) => annotatePathExists(token, ctx.cwd),
		};
		const { gate, renderHtml: renderHtmlFlag, renderMarkdown: renderMarkdownFlag, noJina, app: appFlag, static: staticFlag } = request;
		// Same flag-conflict-first ordering as the Bun CLI.
		if (appFlag && staticFlag) {
			return { ok: false, error: "--app and --static are mutually exclusive" };
		}
		if (!filePath) {
			return { ok: false, error: "Usage: /plannotator-annotate <file.md | file.txt | file.html | https://... | folder/> [--markdown] [--no-jina] [--app] [--static] [--gate] [--json]" };
		}

		// Tolerant fallback (#1182): when the whole argument string names
		// nothing, probe each token; exactly one existing target proceeds,
		// several is an error, several unresolvable words get an actionable
		// message instead of "File not found: the". Bare directory names
		// only count in the sole-arg pre-pass, and unrecognized
		// dash-prefixed tokens disable tolerance so a typo'd flag errors
		// the way it always did.
		// Several existing file paths (every word one) open as one review,
		// in the typed order: the shared bundle rule, same as the CLI.
		let bundleFiles: AnnotateBundleFile[] | undefined;
		const openBundle = (paths: string[]): string | null => {
			const checked = resolveAnnotateBundleFiles(paths, { convertHtml: renderMarkdownFlag });
			if (!checked.ok) return checked.message;
			bundleFiles = checked.files;
			return null;
		};
		if (request.targets) {
			// The tool's list: the same shared selection, but only a bundle may
			// open from it (never fewer files than the agent named).
			const selection = selectAnnotateTokenTarget(request.targets, probeToken, bundleProbes);
			if (selection.kind === "missing") return { ok: false, error: buildMissingAnnotateFilesMessage(selection.missing) };
			if (selection.kind !== "bundle") {
				return {
					ok: false,
					error: `A list target opens several files as one review, so every entry must be an existing file named by its path (no folders, URLs or bare names): ${request.targets.join(", ")}`,
				};
			}
			const problem = openBundle(selection.files.map((file) => file.value));
			if (problem) return { ok: false, error: problem };
		} else if (options.tolerant !== false && !annotateInputNamesExistingTarget(rawFilePath, ctx.cwd)) {
			const selection = selectAnnotateTokenTarget(rawFilePath, probeToken, bundleProbes);
			if (selection.kind === "missing") {
				// A list of files with a typo: never review fewer than named.
				return { ok: false, error: buildMissingAnnotateFilesMessage(selection.missing) };
			} else if (selection.kind === "bundle") {
				const problem = openBundle(selection.files.map((file) => file.value));
				if (problem) return { ok: false, error: problem };
			} else if (selection.kind === "single") {
				filePath = selection.candidate.value;
				rawFilePath = selection.candidate.value;
			} else if (selection.kind === "multiple") {
				return { ok: false, error: buildAmbiguousAnnotateArgsMessage(selection.candidates, { bundleHint: true }) };
			} else if (selection.kind === "none" && selection.words.length > 1) {
				// Content flags only; --gate is transport for this
				// invocation, not a property of the target.
				const tolerantFlags = [
					...(renderMarkdownFlag ? ["--markdown"] : []),
					...(noJina ? ["--no-jina"] : []),
					...(renderHtmlFlag ? ["--render-html"] : []),
				];
				return { ok: false, error: buildUnresolvedAnnotateArgsMessage({ words: selection.words, flags: tolerantFlags }) };
			}
			// "flagged" (unrecognized dash tokens) or a single unresolvable
			// word falls through to the existing pipeline so its specific
			// errors stay verbatim.
		}
		if (!planBrowserHtmlAvailable()) {
			return { ok: false, error: "Annotation UI not available. Run 'bun run build' in the pi-extension directory." };
		}

		let markdown: string;
		let rawHtml: string | undefined;
		let absolutePath: string;
		let folderPath: string | undefined;
		let mode: "annotate" | "annotate-folder" | "annotate-app" | "annotate-bundle" | undefined;
		let sourceInfo: string | undefined;
		let sourceConverted = false;
		let isFolder = false;
		let liveTargetUrl: string | undefined;

		// --- URL annotation ---
		const isUrl = !bundleFiles && /^https?:\/\//i.test(filePath);

		// --app is contracted to fail loudly whenever it cannot apply; a
		// file or folder target silently swallowing it would hide the
		// flag's typo'd use (same contract as the Bun CLI).
		if (!isUrl && appFlag) {
			const { LIVE_APP_REQUIRES_URL_MESSAGE } = await import("./generated/live-probe.ts");
			return { ok: false, error: LIVE_APP_REQUIRES_URL_MESSAGE };
		}

		if (bundleFiles) {
			// The deepest directory holding every file stands in for the
			// session's path; the files ride the server's `bundleFiles`.
			markdown = "";
			absolutePath = annotateBundleRoot(bundleFiles.map((file) => file.path));
			mode = "annotate-bundle";
			ctx.ui.notify(`Opening annotation UI for ${bundleFiles.length} files...`, "info");
		} else if (isUrl) {
			// --- Live app detection (shared probe: same 3s timeout, same
			// "< 500 + HTML + same loopback origin" gate as the Bun CLI) ---
			const {
				LIVE_APP_REMOTE_MESSAGE,
				LIVE_APP_REQUIRES_HTTP_MESSAGE,
				LIVE_APP_REQUIRES_LOOPBACK_MESSAGE,
				buildForceAppFailureMessage,
				buildLiveProbeFallbackNotice,
				classifyLiveAppCandidate,
				probeLiveAppTarget,
			} = await import("./generated/live-probe.ts");
			const { parsed: parsedUrl, loopback } = classifyLiveAppCandidate(filePath);

			if (appFlag && !loopback) {
				return { ok: false, error: LIVE_APP_REQUIRES_LOOPBACK_MESSAGE };
			}
			if (appFlag && parsedUrl?.protocol === "https:") {
				// The live proxy is http-only.
				return { ok: false, error: LIVE_APP_REQUIRES_HTTP_MESSAGE };
			}

			if (loopback && parsedUrl?.protocol === "http:" && !staticFlag) {
				const probe = await probeLiveAppTarget(filePath, parsedUrl);
				if (probe.liveEligible) {
					// Remote hard-off (layer 1 of 2; the server throw in
					// serverAnnotate.ts backstops it): a live proxy relays
					// the user's authenticated dev app, and a remote Pi
					// session is reachable beyond loopback.
					if (isRemoteSession()) {
						return { ok: false, error: LIVE_APP_REMOTE_MESSAGE };
					}
					liveTargetUrl = filePath;
					mode = "annotate-app";
					ctx.ui.notify(`Live app: ${filePath}`, "info");
				} else if (appFlag) {
					return { ok: false, error: buildForceAppFailureMessage(filePath, probe) };
				} else if (probe.probeError !== null) {
					// A dev server still starting up probes as unreachable;
					// say so instead of silently downgrading to static.
					ctx.ui.notify(buildLiveProbeFallbackNotice(filePath, probe.probeError), "info");
				}
			}

			if (liveTargetUrl) {
				markdown = "";
				absolutePath = filePath;
				sourceInfo = filePath;
			} else {
				const useJina = resolveUseJina(noJina, loadConfig());
				ctx.ui.notify(`Fetching: ${filePath}${useJina ? " (via Jina Reader)" : " (via fetch+Turndown)"}...`, "info");
				try {
					const { isConvertedSource, urlToMarkdown } = await import("./generated/url-to-markdown.ts");
					const result = await urlToMarkdown(filePath, { useJina });
					markdown = result.markdown;
					sourceConverted = isConvertedSource(result.source);
				} catch (err) {
					return { ok: false, error: `Failed to fetch URL: ${err instanceof Error ? err.message : String(err)}` };
				}
				absolutePath = filePath;
				sourceInfo = filePath;
			}
		} else {
			// Pick the interpretation of the user input that actually exists:
			// stripped form first (reference-mode primary), literal as fallback
			// for scoped-package-style names. Falls back to the stripped form
			// for the error message if neither exists.
			const resolvedCandidate = resolveAtReference(rawFilePath, (c) => {
				const abs = resolveUserPath(c, ctx.cwd);
				return existsSync(abs);
			});
			if (resolvedCandidate === null) {
				return { ok: false, error: `File not found: ${resolveUserPath(filePath, ctx.cwd)}` };
			}
			absolutePath = resolveUserPath(resolvedCandidate, ctx.cwd);

			try {
				isFolder = statSync(absolutePath).isDirectory();
			} catch {
				return { ok: false, error: `Cannot access: ${absolutePath}` };
			}

			if (isFolder) {
				if (!hasMarkdownFiles(absolutePath, FILE_BROWSER_EXCLUDED, getAnnotatableDocRegex())) {
					return { ok: false, error: `No annotatable files (markdown, plain-text, config, or HTML) found in ${absolutePath}` };
				}
				markdown = "";
				folderPath = absolutePath;
				mode = "annotate-folder";
				ctx.ui.notify(`Opening annotation UI for folder ${filePath}...`, "info");
			} else if (/\.html?$/i.test(absolutePath)) {
				const html = readFileSync(absolutePath, "utf-8");
				const renderHtmlForFile = !renderMarkdownFlag;
				if (renderHtmlForFile) {
					rawHtml = html;
					markdown = "";
				} else {
					const { htmlToMarkdown } = await import("./generated/html-to-markdown.ts");
					markdown = htmlToMarkdown(html);
					sourceConverted = true;
				}
				sourceInfo = basename(absolutePath);
				ctx.ui.notify(`Opening annotation UI for ${filePath}...`, "info");
			} else {
				if (!isAnnotatableTextPath(absolutePath)) {
					return { ok: false, error: `File type not supported. Supported types: ${getAnnotatableExtensionsHint()}` };
				}
				if (statSync(absolutePath).size > MAX_ANNOTATABLE_FILE_BYTES) {
					return { ok: false, error: `File too large to annotate (max 2MB): ${absolutePath}` };
				}
				markdown = readFileSync(absolutePath, "utf-8");
				ctx.ui.notify(`Opening annotation UI for ${filePath}...`, "info");
			}
		}

		currentPiSession.update(ctx);
		const origin = getPiSessionIdentity(ctx);

		try {
			const session = await startAnnotation(
				ctx,
				absolutePath,
				markdown,
				mode ?? "annotate",
				folderPath,
				sourceInfo,
				sourceConverted,
				gate,
				rawHtml,
				!!rawHtml,
				renderMarkdownFlag,
				undefined,
				liveTargetUrl,
				sessionBridgeFor(ctx, origin),
				bundleFiles,
			);
			ctx.ui.notify(sessionOpenedMessage("Annotation opened", session.url), "info");
			const errors = {
				send: "Plannotator annotation feedback could not be sent",
				session: "Plannotator annotation session failed",
			};
			const bundlePaths = bundleFiles?.map((file) => file.path);
			const subject = bundlePaths ? plannotatorBundleSubject(bundlePaths) : annotateSubject(absolutePath);
			// What is annotated, in full: the bundle's files, the folder, the file or the URL.
			const target = bundlePaths ?? folderPath ?? absolutePath;
			const review = trackReview(ctx, origin, "annotate", { subject, target }, session, errors, async (result, tracked) => {
				const outcome = classifyAnnotateOutcome(result);
				if (outcome.notification === "closed") {
					safeNotify(ctx, "Annotation session closed.", "info", origin);
					return;
				}
				if (!outcome.feedback) {
					if (outcome.notification === "approved") {
						if (options.deliverApproval) {
							const { getAnnotateApprovedPrompt } = await loadPlannotatorPrompts();
							sendUserMessageWithCurrentSessionFallback(
								pi,
								withDecisionHeading(tracked, "Approved", getAnnotateApprovedPrompt("pi", loadConfig())),
								{ deliverAs: "followUp" },
								errors.send,
								origin,
							);
						}
						safeNotify(ctx, "Annotation approved.", "info", origin);
						return;
					}
					safeNotify(ctx, "Annotation closed (no feedback).", "info", origin);
					return;
				}
				const {
					getAnnotateApprovedWithNotesPrompt,
					getAnnotateFileFeedbackPrompt,
				} = await loadPlannotatorPrompts();
				// A bundle names every file of the review, in order.
				const fileHeader = bundlePaths ? "Files" : isFolder ? "Folder" : "File";
				const targetText = bundlePaths ? annotateBundleTargetText(bundlePaths) : absolutePath;
				const context = `${fileHeader}: ${targetText}`;
				const prompt = outcome.promptKind === "approved-with-notes"
					? getAnnotateApprovedWithNotesPrompt("pi", loadConfig(), {
							context,
							feedback: outcome.feedback,
						})
					: getAnnotateFileFeedbackPrompt("pi", loadConfig(), {
							fileHeader,
							filePath: targetText,
							feedback: outcome.feedback,
						});
				const label = `${outcome.promptKind === "approved-with-notes" ? "Approved with notes" : "Feedback"}${commentCountSuffix(result.annotations)}`;
				sendUserMessageWithCurrentSessionFallback(
					pi,
					withDecisionHeading(tracked, label, prompt),
					{ deliverAs: "followUp" },
					errors.send,
					origin,
				);
				if (outcome.notification === "approved") {
					safeNotify(ctx, "Annotation approved.", "info", origin);
				}
			});
			return { ok: true, review };
		} catch (err) {
			return { ok: false, error: `Failed to start annotation UI: ${getStartupErrorMessage(err)}` };
		}
	}

	async function launchLastMessage(ctx: ExtensionContext, gate: boolean, options: LaunchOptions = {}): Promise<LaunchResult> {
		if (!planBrowserHtmlAvailable()) {
			return { ok: false, error: "Annotation UI not available. Run 'bun run build' in the pi-extension directory." };
		}

		currentPiSession.update(ctx);
		const origin = getPiSessionIdentity(ctx);

		// From the tool: the assistant message calling it is already saved and
		// is the newest; it is not the answer the user wants to annotate.
		const skipToolCallId = options.skipToolCallId;
		const skip = skipToolCallId
			? (entry: { message?: unknown }) => isAssistantEntryForToolCall(entry, skipToolCallId)
			: undefined;
		const snapshot = getLastAssistantMessageSnapshot(ctx, skip);
		if (!snapshot) {
			return { ok: false, error: "No assistant message found in session." };
		}

		const recent = getRecentAssistantMessages(ctx, 25, skip);
		const pickerMessages = recent.length > 1 ? recent : undefined;

		ctx.ui.notify("Opening annotation UI for last message...", "info");

		try {
			const session = await startLastMessageAnnotation(
				ctx,
				snapshot.text,
				gate,
				pickerMessages,
				sessionBridgeFor(ctx, origin),
			);
			ctx.ui.notify(sessionOpenedMessage("Last-message annotation opened", session.url), "info");
			const errors = {
				send: "Plannotator message annotation feedback could not be sent",
				session: "Plannotator message annotation session failed",
			};
			const names = { subject: lastMessageSubject(recent.length), userSubject: lastMessageUserSubject(recent.length) };
			const review = trackReview(ctx, origin, "last", names, session, errors, async (result, tracked) => {
				const outcome = classifyAnnotateOutcome(result);
				if (outcome.notification === "closed") {
					safeNotify(ctx, "Annotation session closed.", "info", origin);
					return;
				}
				if (!outcome.feedback) {
					if (outcome.notification === "approved") {
						if (options.deliverApproval) {
							const { getAnnotateApprovedPrompt } = await loadPlannotatorPrompts();
							sendUserMessageWithCurrentSessionFallback(
								pi,
								withDecisionHeading(tracked, "Approved", getAnnotateApprovedPrompt("pi", loadConfig())),
								{ deliverAs: "followUp" },
								errors.send,
								origin,
							);
						}
						safeNotify(ctx, "Message approved.", "info", origin);
						return;
					}
					safeNotify(ctx, "Annotation closed (no feedback).", "info", origin);
					return;
				}
				// Picker may have changed which message the feedback targets; if so,
				// look that one up in the current branch so the anchor quote matches.
				const target = result.selectedMessageId && result.selectedMessageId !== snapshot.entryId
					? findAssistantMessageByEntryId(ctx, result.selectedMessageId) ?? snapshot
					: snapshot;
				const feedback = result.feedbackScope !== "messages" && shouldAnchorLastMessageFeedback(ctx, target.entryId, origin)
						? anchorMessageFeedback(outcome.feedback, target.text)
						: outcome.feedback;
				const {
					getAnnotateApprovedWithNotesPrompt,
					getAnnotateMessageFeedbackPrompt,
				} = await loadPlannotatorPrompts();
				const prompt = outcome.promptKind === "approved-with-notes"
					? getAnnotateApprovedWithNotesPrompt("pi", loadConfig(), {
							feedback,
						})
					: getAnnotateMessageFeedbackPrompt("pi", loadConfig(), {
							feedback,
						});
				const label = `${outcome.promptKind === "approved-with-notes" ? "Approved with notes" : "Feedback"}${commentCountSuffix(result.annotations)}`;
				sendUserMessageWithCurrentSessionFallback(
					pi,
					withDecisionHeading(tracked, label, prompt),
					{ deliverAs: "followUp" },
					errors.send,
					origin,
				);
				if (outcome.notification === "approved") {
					safeNotify(ctx, "Message approved.", "info", origin);
				}
			});
			return { ok: true, review };
		} catch (err) {
			return { ok: false, error: `Failed to start annotation UI: ${getStartupErrorMessage(err)}` };
		}
	}

	pi.registerCommand("plannotator-review", {
		description: "Open interactive code review for current changes, a directory, or a PR URL; pass --git or --gitbutler to force that provider, --base <ref> / --diff-type <type> to pin the session's opening diff",
		handler: async (args, ctx) => {
			const launched = await launchCodeReview(ctx, args ?? "");
			if (!launched.ok) ctx.ui.notify(launched.error, "error");
		},
	});

	pi.registerCommand("plannotator-annotate", {
		description: "Open a file, several files, a URL or a folder in the annotation UI",
		handler: async (args, ctx) => {
			const { parseAnnotateArgs } = await import("./generated/annotate-args.ts");
			// Split known annotate flags from the path. --json is silently
			// accepted (Pi writes back via sendUserMessage, not stdout).
			// `rawFilePath` keeps any leading `@` for the literal-@ fallback
			// (scoped-package-style names). liveFlags: Pi supports live app
			// sessions, so --app / --static are recognized here.
			const parsed = parseAnnotateArgs(args ?? "", { liveFlags: true });
			const launched = await launchAnnotate(ctx, parsed);
			if (!launched.ok) ctx.ui.notify(launched.error, "error");
		},
	});

	pi.registerCommand("plannotator-last", {
		description: "Annotate the last assistant message",
		handler: async (args, ctx) => {
			// Support --gate on /plannotator-last for the Stop-hook review gate.
			const { parseAnnotateArgs } = await import("./generated/annotate-args.ts");
			const { gate } = parseAnnotateArgs(args ?? "");
			const launched = await launchLastMessage(ctx, gate);
			if (!launched.ok) ctx.ui.notify(launched.error, "error");
		},
	});

	// ── The `plannotator` agent tool ─────────────────────────────────────
	//
	// The shared contract (packages/shared/plannotator-tool.ts): name,
	// description, schema, validation, argument mapping and result text all
	// come from it, never a copy. Opening returns at once (terminate: the
	// turn ends) and the decision arrives later as a followUp message, the
	// same launch the slash commands use.
	//
	// Registered only when the switch is on (PLANNOTATOR_AGENT_TOOL /
	// `agentTool`, read once here: Pi builds a new extension instance for every
	// session and /reload, so a change applies to the next one and never moves
	// the tool list of a running session). It does not activate itself on
	// registration (`defaultActive: false`, honored by Pi 0.99+); session_start
	// activates it once, and only when the session has an interactive UI,
	// since a print/JSON run cannot receive the decision later.

	if (agentToolEnabled) pi.registerTool({
		name: PLANNOTATOR_TOOL_NAME,
		label: "Plannotator",
		description: PLANNOTATOR_TOOL_DESCRIPTION,
		// The shared JSON Schema as is: Pi validates plain JSON Schema tool
		// parameters (no TypeBox Kind needed) since 0.79.1, the peer floor.
		parameters: PLANNOTATOR_TOOL_INPUT_SCHEMA as any,
		// "Edit the file, then open it" in one assistant message must open the
		// edited file: sequential makes Pi run the batch in order (#1622).
		executionMode: "sequential",
		// Not a literal key: Pi before 0.99 does not declare it (and ignores it).
		...NOT_ACTIVE_ON_REGISTRATION,

		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const text = await runPlannotatorTool(params, ctx, signal, toolCallId);
			return { content: [{ type: "text", text: text.text }], details: text.details, ...(text.terminate ? { terminate: true } : {}) };
		},
	});

	/**
	 * One `plannotator` tool call. Throws (an error result for the model) for a
	 * bad call, a review that could not open, or a close that did not happen.
	 */
	async function runPlannotatorTool(
		params: unknown,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		toolCallId: string,
	): Promise<{ text: string; details: Record<string, unknown>; terminate?: boolean }> {
		const parsed = parsePlannotatorToolInput(params);
		if (!parsed.ok) throw new Error(parsed.error);
		const call = parsed.input;
		const owner = ownerOf(ctx);
		switch (call.action) {
			case "list":
				return { text: openReviews.listText(owner), details: { action: "list" } };
			case "close": {
				const closed = openReviews.close(owner, call.session as string);
				if (!closed.ok) throw new Error(closed.text);
				return { text: closed.text, details: { action: "close" } };
			}
			case "annotate":
			case "review":
			case "last":
				break;
		}
		if (!ctx.hasUI) {
			throw new Error(
				"Plannotator did not open: this Pi session has no interactive UI (print or JSON mode), so nothing could deliver the reviewer's decision later. Ask the user to run it from an interactive Pi session.",
			);
		}
		if (signal?.aborted) throw new Error("Plannotator did not open: the call was cancelled.");
		// One fixed port (remote mode, or a single PLANNOTATOR_PORT): a second
		// server would silently stop the open review to take its port. Refuse
		// and name the open one instead.
		const { ports } = getServerPorts();
		if (ports.length === 1 && ports[0] !== 0) {
			const open = openReviews.openAll();
			const busy = open.find((review) => review.owner === owner) ?? open[0];
			if (busy) throw new Error(fixedPortBusyText(busy, busy.owner === owner));
		}

		const gate = call.gate === true;
		let launched: LaunchResult;
		if (call.action === "review") {
			launched = await launchCodeReview(ctx, plannotatorToolArgs(call));
		} else if (call.action === "last") {
			launched = await launchLastMessage(ctx, false, { skipToolCallId: toolCallId });
		} else {
			// A list of files is ONE review of all of them (a bundle), in order.
			const targets = Array.isArray(call.target) ? call.target : undefined;
			const target = targets ? targets[0]! : (call.target as string);
			const { stripAtPrefix } = await import("./generated/at-reference.ts");
			launched = await launchAnnotate(
				ctx,
				{
					...(targets ? { targets } : {}),
					filePath: stripAtPrefix(target),
					rawFilePath: target,
					gate,
					renderHtml: false,
					renderMarkdown: call.options?.markdown === true,
					noJina: false,
					app: false,
					static: false,
				},
				{ deliverApproval: gate, tolerant: false },
			);
		}
		if (!launched.ok) throw new Error(`Plannotator did not open: ${launched.error}`);
		const { review } = launched;
		return {
			text: plannotatorToolOpenedText(review.subject, review.url, gate, review.id, review.target),
			details: { action: call.action, session: review.id, url: review.url },
			terminate: true,
		};
	}

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plannotator",
		handler: async (ctx) => {
			await togglePlanMode(ctx);
		},
	});

	// ── Plan execution tools ────────────────────────────────────────────

	pi.registerTool({
		name: PLAN_MARK_DONE_TOOL,
		label: "Mark Plan Step Done",
		description:
			"Mark one approved-plan checklist step complete. Call this immediately after finishing each step and before starting the next one.",
		parameters: Type.Object({
			step: Type.Number({
				description: "One-based number of the completed plan checklist step.",
				multipleOf: 1,
			}),
		}) as any,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (phase !== "executing") {
				return {
					content: [{ type: "text", text: "Error: No approved plan is executing." }],
					details: { completed: false },
				};
			}

			const step = (params as { step?: unknown })?.step;
			if (
				typeof step !== "number" ||
				!Number.isInteger(step) ||
				!(await markStepDone(step, ctx))
			) {
				return {
					content: [{ type: "text", text: `Error: Plan checklist step ${String(step)} does not exist.` }],
					details: { completed: false },
				};
			}

			return {
				content: [{ type: "text", text: `Plan checklist step ${step} marked complete.` }],
				details: { completed: true, step },
			};
		},
	});

	// ── plannotator_submit_plan Tool ────────────────────────────────────

	pi.registerTool({
		name: PLAN_SUBMIT_TOOL,
		label: "Submit Plan",
		// Pi runs one assistant message's tool calls in parallel by default, and
		// its write/edit tools apply changes through an async per-file mutation
		// queue, while this tool reads the plan file synchronously as soon as it
		// starts. An "edit plan + submit plan" batch could therefore review (and
		// save to history) the pre-edit plan. A sequential tool makes pi run the
		// WHOLE batch one call at a time, in order, so the edit lands first
		// (#1622). Supported by every pi in our peer range (>= 0.79.1).
		executionMode: "sequential",
		description:
			"Submit your Plannotator plan for user review. " +
			"Call this only while Plannotator planning mode is active, after writing your plan as a markdown file anywhere inside the working directory. " +
			"Pass the path to the plan file (e.g. PLAN.md or plans/auth.md). " +
			"The user reviews the plan in a visual browser UI and can approve, deny with feedback, or annotate it. " +
			"This tool returns as soon as the review is open; the decision arrives later as a new message, so end your turn and wait for it, and do not implement before approval. " +
			"If you revise the plan while the review is open, call this again with the same path to update the open review. " +
			"If denied, edit the same file in place, then call this again with the same path.",
		parameters: Type.Object({
			filePath: Type.String({
				description:
					"Path to the markdown plan file, relative to the working directory. Must end in .md or .mdx and resolve inside cwd.",
			}),
		}) as any,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Guard: must be in planning phase
			if (phase !== "planning") {
				return {
					content: [
						{
							type: "text",
							text: "Error: Not in plan mode. Use /plannotator-plan-mode to enter planning mode first.",
						},
					],
					details: { approved: false },
				};
			}

			const inputPath = (params as { filePath?: string })?.filePath?.trim();
			if (!inputPath) {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${PLAN_SUBMIT_TOOL} requires a filePath argument pointing to your markdown plan file (e.g. "PLAN.md" or "plans/auth.md").`,
						},
					],
					details: { approved: false },
				};
			}

			if (!isPlanWritePathAllowed(inputPath, ctx.cwd)) {
				return {
					content: [
						{
							type: "text",
							text: `Error: plan file must be a markdown file (.md or .mdx) inside the working directory. Rejected: ${inputPath}`,
						},
					],
					details: { approved: false },
				};
			}

			const fullPath = resolve(ctx.cwd, inputPath);

			try {
				if (!statSync(fullPath).isFile()) {
					return {
						content: [
							{
								type: "text",
								text: `Error: ${inputPath} is not a regular file. Write your plan to a markdown file first, then call ${PLAN_SUBMIT_TOOL} with its path.`,
							},
						],
						details: { approved: false },
					};
				}
			} catch {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${inputPath} does not exist. Write your plan using the write tool first, then call ${PLAN_SUBMIT_TOOL} again.`,
						},
					],
					details: { approved: false },
				};
			}

			let planContent: string;
			try {
				planContent = readFileSync(fullPath, "utf-8");
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Error: failed to read ${inputPath}: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: { approved: false },
				};
			}

			if (planContent.trim().length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${inputPath} is empty. Write your plan first, then call ${PLAN_SUBMIT_TOOL} again.`,
						},
					],
					details: { approved: false },
				};
			}

			lastSubmittedPath = inputPath;
			checklistItems = parseChecklist(planContent);

			// Non-interactive or no HTML: auto-approve
			if (!ctx.hasUI || !planBrowserHtmlAvailable()) {
				if (resolveExecutionMode(plannotatorConfig) === "external") {
					await handoffApprovedPlan(ctx, inputPath, planContent);
					return {
						content: [{ type: "text", text: "Plan approved and handed off for external execution." }],
						details: { approved: true, handedOff: true },
						terminate: true,
					};
				}

				approvedPlanContent = null;
				phase = "executing";
				framingDelivered = false;
				await applyPhaseConfig(ctx, { restoreSavedState: true });
				pi.appendEntry("plannotator-execute", { lastSubmittedPath });
				persistState();
				justApprovedPlan = true;
				const { getPlanAutoApprovedPrompt } = await loadPlannotatorPrompts();
				return {
					content: [
						{
							type: "text",
							text: getPlanAutoApprovedPrompt("pi", loadConfig()),
						},
					],
					details: { approved: true },
					terminate: true,
				};
			}

			// A plan already in review: push the revision into the open tab
			// instead of opening a second one. The tab keeps the reviewer's
			// comments and shows the version diff.
			const open = pendingPlanReview;
			if (open && !open.settled) {
				let revision: ReturnType<PlanReviewBrowserSession["updatePlan"]> = null;
				let updateFailed = false;
				try {
					revision = open.session.updatePlan(planContent);
				} catch (err) {
					updateFailed = true;
					console.error(`Plannotator: could not update the open plan review: ${err instanceof Error ? err.message : String(err)}`);
				}
				if (revision) {
					open.filePath = inputPath;
					open.planContent = planContent;
					if (open.tracked && !revision.unchanged) open.tracked.subject = planSubject(revision.version);
					if (revision.unchanged) {
						return {
							content: [
								{
									type: "text",
									text: `${inputPath} is unchanged from the plan already open for review. Do not start implementing: end your turn now and wait for the reviewer's decision, which arrives as a new message in this session.`,
								},
							],
							details: { approved: false, pending: true, unchanged: true },
							terminate: true,
						};
					}
					safeNotify(ctx, `Plannotator: revised plan sent to the open review (version ${revision.version}).`);
					return {
						content: [{ type: "text", text: planSubmittedForReviewText(inputPath, revision.version, true) }],
						details: { approved: false, pending: true, revised: true, version: revision.version },
						terminate: true,
					};
				}
				// The reviewer decided on the version on screen while this revision
				// was being written: that decision is being recorded and is on its
				// way. Opening a fresh review here would stop the old one and drop
				// the decision (a deny's feedback would be lost), so wait for it.
				if (!updateFailed && !open.settled) {
					return {
						content: [
							{
								type: "text",
								text: `The reviewer has just decided on the version of the plan that was open for review, so this revision was not sent. Do not start implementing: end your turn now and wait for the reviewer's decision, which arrives as a new message in this session. If it asks for changes, call ${PLAN_SUBMIT_TOOL} again afterwards.`,
							},
						],
						details: { approved: false, pending: true, decisionInFlight: true },
						terminate: true,
					};
				}
			}

			currentPiSession.update(ctx);
			const origin = getPiSessionIdentity(ctx);
			let session: PlanReviewBrowserSession;
			try {
				session = await startPlanReview(ctx, planContent, undefined, {
					sessionBridge: sessionBridgeFor(ctx, origin),
					planRevisions: true,
				});
			} catch (err) {
				const message = `Failed to start plan review UI: ${getStartupErrorMessage(err)}`;
				ctx.ui.notify(message, "error");
				return {
					content: [{ type: "text", text: message }],
					details: { approved: false },
				};
			}

			// Planning ended while this review was starting (an earlier review's
			// approval settling during the await, or plan mode turned off): this
			// review would be an orphan whose decision nobody delivers.
			if (phase !== "planning") {
				try {
					session.stop();
				} catch {
					// Best effort: nothing was delivered through it.
				}
				return {
					content: [
						{
							type: "text",
							text: "Planning ended while this review was opening (the plan was approved, or plan mode was turned off), so no review was opened. Follow the latest message in this session.",
						},
					],
					details: { approved: false },
					terminate: true,
				};
			}

			const review: PendingPlanReview = { session, filePath: inputPath, planContent, settled: false };
			// A previous review that is somehow still tracked loses to the new one.
			if (pendingPlanReview && pendingPlanReview !== review) stopPendingPlanReview();
			pendingPlanReview = review;
			// The history version the server saved this plan as: pushing the SAME
			// text is a no-op that reports it (updatePlan's unchanged branch).
			let planVersion: number | undefined;
			try {
				planVersion = session.updatePlan?.(planContent)?.version;
			} catch {
				planVersion = undefined;
			}
			review.tracked = openReviews.add({
				kind: "plan",
				subject: planSubject(planVersion),
				target: resolve(ctx.cwd, inputPath),
				url: session.url,
				owner: ownerOf(ctx),
				hostControl: session.hostControl,
			});
			persistState();

			void session
				.waitForDecision()
				.then(async (result) => {
					if (review.tracked) openReviews.remove(review.tracked);
					if (review.settled) return;
					review.settled = true;
					if (pendingPlanReview === review) pendingPlanReview = null;
					await deliverPlanDecision(ctx, review, result);
				})
				.catch((err: unknown) => {
					if (review.tracked) openReviews.remove(review.tracked);
					const wasSettled = review.settled;
					review.settled = true;
					if (pendingPlanReview === review) pendingPlanReview = null;
					// Stopped on purpose (plan mode left, session replaced): silent.
					if (wasSettled) return;
					if (isBrowserSessionStoppedError(err)) {
						safeNotify(ctx, "Plan review session was closed before a decision. Ask the agent to resubmit the plan to reopen it.", "info", origin);
						return;
					}
					reportBackgroundError(ctx, "Plannotator plan review failed", err, origin);
				});

			safeNotify(ctx, sessionOpenedMessage("Plannotator: plan review opened", session.url), "info", origin);
			return {
				content: [{ type: "text", text: planSubmittedForReviewText(inputPath, undefined, false) }],
				details: { approved: false, pending: true, reviewId: session.reviewId },
				terminate: true,
			};
		},
	});

	/**
	 * Deliver a plan decision that arrived after `plannotator_submit_plan`
	 * returned. The message starts a turn when the agent is idle and waits
	 * behind the current turn otherwise, the same delivery review and annotate
	 * feedback use. Approval switches to the executing phase first, so the
	 * turn it starts gets the executing framing and tools.
	 */
	async function deliverPlanDecision(
		ctx: ExtensionContext,
		review: PendingPlanReview,
		result: PlanReviewDecision,
	): Promise<void> {
		// The decision belongs to this session's planning phase. A replaced or
		// torn-down session, or one that left plan mode, gets nothing.
		if (!sessionAlive || !isCtxAlive(ctx) || phase !== "planning") return;
		const inputPath = review.filePath;
		// The text the reviewer decided on: the server names it, the open
		// review's own copy is the fallback (the same text after any push).
		const planContent = result.plan ?? review.planContent;

		const send = (text: string) => {
			try {
				pi.sendUserMessage(text, { deliverAs: "followUp" });
			} catch (err) {
				reportBackgroundError(ctx, "Plannotator could not deliver the plan decision", err);
			}
		};

		if (result.approved) {
			if (resolveExecutionMode(plannotatorConfig) === "external") {
				await handoffApprovedPlan(ctx, inputPath, planContent, result.feedback);
				// Recorded in the transcript without starting a turn: the plan runs elsewhere.
				pi.sendMessage(
					{
						customType: "plannotator-handoff",
						content: "Plan approved and handed off for external execution.",
						display: true,
						details: { planFilePath: inputPath },
					},
					{ triggerTurn: false },
				);
				return;
			}

			lastSubmittedPath = inputPath;
			approvedPlanContent = planContent;
			checklistItems = parseChecklist(planContent);
			// Edits made to the file after the reviewer's version was submitted
			// were never reviewed; the message says so and execution ignores them.
			let fileDiffers = true;
			try {
				fileDiffers = readFileSync(resolve(ctx.cwd, inputPath), "utf-8") !== planContent;
			} catch {
				fileDiffers = true;
			}
			phase = "executing";
			framingDelivered = false;
			await applyPhaseConfig(ctx, { restoreSavedState: true });
			pi.appendEntry("plannotator-execute", { lastSubmittedPath, approvedPlan: planContent });
			persistState();

			// Keep this aligned with the executing-phase framing delivered on the
			// same turn: the tool is the primary mechanism, markers the fallback.
			const doneMsg =
				checklistItems.length > 0
					? `Call ${PLAN_MARK_DONE_TOOL} immediately after each completed step and before the next step. [DONE:n] markers remain a fallback for interrupted executions.`
					: "";
			const { getPlanApprovedPrompt, getPlanApprovedWithNotesPrompt } = await loadPlannotatorPrompts();
			const approvedPrompt = result.feedback
				? getPlanApprovedWithNotesPrompt("pi", loadConfig(), { planFilePath: inputPath, doneMsg, feedback: result.feedback })
				: getPlanApprovedPrompt("pi", loadConfig(), { planFilePath: inputPath, doneMsg });
			send(`${approvedPrompt}\n\n${approvedPlanSection(inputPath, planContent, fileDiffers)}`);
			safeNotify(ctx, "Plannotator: plan approved.");
			return;
		}

		// Denied, or only questions answered: stay in planning and ask for a revision.
		persistState();
		const feedbackText = result.feedback || "Plan rejected. Please revise.";
		const { buildPlanFileRule, composePlanDeniedMessage, getPlanToolName } = await loadPlannotatorPrompts();
		send(
			composePlanDeniedMessage("pi", loadConfig(), {
				toolName: getPlanToolName("pi"),
				planFileRule: buildPlanFileRule(getPlanToolName("pi"), inputPath),
				feedback: feedbackText,
			}, { answersOnly: result.answersOnly }),
		);
	}

	// ── Event Handlers ───────────────────────────────────────────────────

	// Gate writes during planning — only markdown files inside cwd.
	pi.on("tool_call", async (event, ctx) => {
		if (phase !== "planning") return;
		if (event.toolName !== "write" && event.toolName !== "edit") return;

		const inputPath = event.input.path as string;
		if (isPlannotatorSubmitDevicePath(inputPath)) return;
		if (!isPlanWritePathAllowed(inputPath, ctx.cwd)) {
			const verb = event.toolName === "write" ? "writes" : "edits";
			return {
				block: true,
				reason: `Plannotator: during planning, ${verb} are limited to markdown files (.md, .mdx) inside the working directory. Blocked: ${inputPath}`,
			};
		}
	});

	// Deliver phase framing once per phase entry, plus per-turn todo status.
	// Plannotator never returns or modifies systemPrompt: Pi's base prompt
	// (AGENTS.md context, skills catalog, tools guidance, user append text) is
	// left untouched, and cache-busting reduces to conversation-suffix appends
	// (#922, approach suggested by Karrq).
	pi.on("before_agent_start", async (_event, ctx) => {
		if (phase !== "planning" && phase !== "executing") {
			// Idle injects nothing (#1269) — with one exception: the first
			// prompt after a planning/executing → idle transition delivers a
			// one-shot plan-mode-off countermand (#1320). Delivered framing
			// stays in history (#1380), so this notice is what ends plan mode:
			// the model's plan-mode turns, blocked-write tool results, and the
			// framing itself keep steering it until the end is said out loud.
			// Cache-wise the notice is free unconditionally — a pure
			// conversation-suffix append on a prefix nothing else perturbs.
			// Fresh idle sessions never arm the latch and inject nothing.
			if (phase !== "idle" || !idleNoticePending) return;
			idleNoticePending = false;
			persistState();
			return {
				message: {
					customType: "plannotator-framing",
					content: PLAN_MODE_OFF_NOTICE,
					display: false,
					details: { phase },
				},
			};
		}

		const profile = getPhaseProfile();
		// An approved snapshot is the plan: point at it, not at the file, which
		// may hold edits the reviewer never saw.
		const planRef = lastSubmittedPath && approvedPlanContent !== null
			? `the approved plan in the approval message (${lastSubmittedPath} as the reviewer approved it)`
			: lastSubmittedPath ?? "your plan file";

		if (phase === "executing" && lastSubmittedPath && approvedPlanContent === null) {
			// Re-read from disk each turn to stay current (auto-approved plans
			// only: an approved snapshot is the plan, the file is not re-read)
			const fullPath = resolve(ctx.cwd, lastSubmittedPath);
			try {
				const planContent = readFileSync(fullPath, "utf-8");
				checklistItems = parseChecklist(planContent);
			} catch {
				// File deleted during execution — degrade gracefully
			}
		}

		const todoStats = phase === "executing" ? formatTodoList(checklistItems) : formatTodoList([]);
		// The closing line restates the completion-marker convention so the
		// protocol survives even when compaction has swallowed the framing and
		// re-delivery has not happened yet.
		const todoStatus =
			phase === "executing" && todoStats.remainingCount > 0
				? `[PLANNOTATOR - EXECUTING PLAN]
Todo status for ${planRef}: ${todoStats.completedCount}/${todoStats.totalCount} steps complete.

Remaining steps:
${todoStats.todoList}

Call ${PLAN_MARK_DONE_TOOL} immediately after each completed step and before the next step. [DONE:n] markers remain a fallback for interrupted executions.`
				: null;

		if (framingDelivered) {
			// Same phase, later prompt: the framing already sits in conversation
			// history, so inject nothing beyond the small todo snapshot during
			// execution.
			if (!todoStatus) return;
			return {
				message: {
					customType: "plannotator-context",
					content: todoStatus,
					display: false,
				},
			};
		}

		framingDelivered = true;
		persistState();

		if (!profile?.instructions) {
			// Framing explicitly disabled (instructions null/empty): deliver only
			// the todo snapshot during execution, nothing during planning.
			if (!todoStatus) return;
			return {
				message: {
					customType: "plannotator-context",
					content: todoStatus,
					display: false,
				},
			};
		}

		const rendered = renderTemplate(
			profile.instructions,
			buildPromptVariables({
				planFilePath: planRef,
				phase,
				todoList: todoStats.todoList,
				completedCount: todoStats.completedCount,
				totalCount: todoStats.totalCount,
				remainingCount: todoStats.remainingCount,
			}),
		);
		if (rendered.unknownVariables.length > 0) {
			ctx.ui.notify(
				"Plannotator: unknown template variables in " + phase + " instructions: " + rendered.unknownVariables.join(", "),
				"warning",
			);
		}

		let content = rendered.text;
		if (phase === "planning") {
			const hook = readImprovementHook("enterplanmode-improve");
			const pfmEnabled = loadConfig().pfmReminder === true;
			const improveContext = composeImproveContext({
				pfmEnabled,
				improvementHookContent: hook?.content ?? null,
			});
			if (improveContext) content += "\n\n---\n\n" + improveContext;
		}
		// Instructions render an entry-time todo snapshot when they reference
		// ${todoList}; otherwise append the snapshot so the first executing
		// prompt still carries the checklist.
		if (todoStatus && !profile.instructions.includes("${todoList}")) {
			content += "\n\n" + todoStatus;
		}

		return {
			message: {
				customType: "plannotator-framing",
				content,
				display: false,
				details: { phase },
			},
		};
	});

	// There is deliberately NO "context" handler (#1380). One existed here and
	// stripped plannotator-injected messages at phase transitions; Pi applies a
	// context handler's result only to the outgoing LLM request (the runner
	// structuredClones history and transformContext shapes the request in
	// streamAssistantResponse), but the provider's prompt cache keys on the
	// exact request prefix, so removing an already-sent mid-history message
	// shifted every later message and re-billed the whole tail as uncached
	// input (the reporter measured 88 of 119 messages invalidated on one plan
	// completion). The conversation is append-only instead: delivered framing
	// and todo snapshots stay in history for the life of the session, and
	// stale instructions are neutralized by countermands — the executing
	// framing supersedes planning, and PLAN_MODE_OFF_NOTICE supersedes both —
	// which models follow by recency. Compaction remains the one boundary that
	// rewrites history, and it invalidates the provider cache by itself.

	// Track execution progress
	pi.on("turn_end", async (event, ctx) => {
		if (phase !== "executing" || checklistItems.length === 0) return;

		const text = getAssistantMessageText(event.message);
		if (!text) return;
		if (markCompletedSteps(text, checklistItems) > 0) {
			if (lastSubmittedPath) persistCompletedChecklist(resolve(ctx.cwd, lastSubmittedPath));
			updateStatus(ctx);
			updateWidget(ctx);
			await syncTodoProvider(ctx);
		}
		persistState();
	});

	// Detect execution completion
	pi.on("agent_end", async (_event, ctx) => {
		if (phase === "executing" && justApprovedPlan) {
			justApprovedPlan = false;
			let attempts = 0;
			const continueWhenIdle = (): void => {
				// This poll outlives the turn that scheduled it, so the session can be
				// replaced or disposed underneath it — print-mode teardown, /new,
				// /reload. Both `ctx` and `pi` are invalidated at that moment and every
				// call on them throws; an uncaught throw inside a timer callback takes
				// the entire pi process down (issue #1140).
				//
				// Cancel rather than retarget: the continuation belongs to the session
				// that approved this plan. A replacement session is a different
				// conversation with no approved plan in it, so nudging it to "continue"
				// would be wrong even though `pi` there is perfectly live.
				if (!sessionAlive || !isCtxAlive(ctx)) return;
				try {
					if (!ctx.isIdle()) {
						attempts += 1;
						if (attempts <= 200) setTimeout(continueWhenIdle, 50);
						return;
					}
					pi.sendUserMessage("Continue with the approved plan.");
				} catch (err) {
					// Lost the race between the liveness probe and the call, or the host
					// failed the send for some other reason. Report, never rethrow.
					if (isCtxAlive(ctx)) {
						console.error(
							`Plannotator: could not continue the approved plan: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
			};
			setTimeout(continueWhenIdle, 0);
			return;
		}

		if (phase !== "executing" || checklistItems.length === 0) return;

		if (checklistItems.every((t) => t.completed)) {
			const completedList = checklistItems
				.map((t) => `- [x] ~~${t.text}~~`)
				.join("\n");
			pi.sendMessage(
				{
					customType: "plannotator-complete",
					content: `**Plan Complete!** ✓\n\n${completedList}`,
					display: true,
				},
				{ triggerTurn: false },
			);
			await returnToIdle(ctx);
		}
	});

	// Restore state on session start/resume
	/**
	 * Re-derive phase, framing latch, and checklist state from the ACTIVE
	 * session path (root to current leaf). Shared by session_start (resume) and
	 * session_tree (branch navigation): a branch switch can land on a path
	 * whose plannotator state differs from memory, or where the delivered
	 * framing message is absent because it lives on another branch.
	 */
	async function resyncPhaseFromSession(
		ctx: ExtensionContext,
		options: { phaseWhenUnrecorded: Phase; warnOnPlanning: boolean; keepModelWhenPhaseUnchanged?: boolean },
	): Promise<void> {
		const phaseBefore = phase;
		const entries = ctx.sessionManager.getBranch();
		const stateEntry = entries
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === "plannotator",
			)
			.pop() as { data?: PersistedPlannotatorState } | undefined;

		if (stateEntry?.data) {
			phase = stateEntry.data.phase ?? options.phaseWhenUnrecorded;
			lastSubmittedPath = stateEntry.data.lastSubmittedPath ?? lastSubmittedPath;
			savedState = stateEntry.data.savedState ?? savedState;
			phaseAddedTools = stateEntry.data.phaseAddedTools ?? phaseAddedTools;
			// The framing message persists in the restored conversation history,
			// so a resumed phase must not deliver it again. A path recorded
			// before delivery restores the latch open and re-delivers.
			framingDelivered = stateEntry.data.framingDelivered ?? false;
			// Same contract for the plan-mode-off notice: a path that recorded
			// the transition but not yet the delivery still owes it; a path
			// that recorded the delivery must not repeat it.
			idleNoticePending = stateEntry.data.idleNoticePending ?? false;
		} else {
			// No plannotator activity on this path. Memory savedState and
			// phaseAddedTools are kept so the idle branch below can hand back
			// tools and settings a now-abandoned branch's phase had taken.
			phase = options.phaseWhenUnrecorded;
			framingDelivered = false;
			// A path with no plannotator state never had plan mode, so no
			// countermand is owed — and injecting one here would break the
			// #1269 fresh-session inject-nothing promise.
			idleNoticePending = false;
		}

		if (phase === "planning" && !savedState) {
			captureSavedState(ctx);
		}

		// Rebuild execution state from disk + session messages
		if (phase === "executing") {
			// An approval from the browser recorded the exact text it approved on
			// its plannotator-execute entry: that snapshot is the plan, and the
			// file only contributes checkmarks while its checklist still matches.
			const executeEntry = entries
				.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plannotator-execute")
				.pop() as { data?: { approvedPlan?: unknown } } | undefined;
			const snapshot = typeof executeEntry?.data?.approvedPlan === "string" ? executeEntry.data.approvedPlan : null;
			approvedPlanContent = snapshot;
			if (snapshot !== null && lastSubmittedPath) {
				checklistItems = parseChecklist(snapshot);
				const fullPath = resolve(ctx.cwd, lastSubmittedPath);
				try {
					const fileItems = parseChecklist(readFileSync(fullPath, "utf-8"));
					if (sameChecklistSteps(fileItems, checklistItems)) {
						fileItems.forEach((item, index) => {
							if (item.completed) checklistItems[index]!.completed = true;
						});
					}
				} catch {
					// The snapshot does not need the file.
				}
				let executeIndex = -1;
				for (let i = entries.length - 1; i >= 0; i--) {
					if ((entries[i] as { customType?: string }).customType === "plannotator-execute") {
						executeIndex = i;
						break;
					}
				}
				for (let i = executeIndex + 1; i < entries.length; i++) {
					const entry = entries[i];
					if (entry.type !== "message" || !("message" in entry)) continue;
					const text = getAssistantMessageText(entry.message);
					if (text) markCompletedSteps(text, checklistItems);
					const message = entry.message as { role?: string; toolName?: string; details?: { completed?: unknown; step?: unknown } };
					if (message.role === "toolResult" && message.toolName === PLAN_MARK_DONE_TOOL && message.details?.completed === true) {
						const item = checklistItems.find((candidate) => candidate.step === message.details?.step);
						if (item) item.completed = true;
					}
				}
				persistCompletedChecklist(fullPath);
			} else if (lastSubmittedPath) {
				const fullPath = resolve(ctx.cwd, lastSubmittedPath);
				if (existsSync(fullPath)) {
					const content = readFileSync(fullPath, "utf-8");
					checklistItems = parseChecklist(content);

					// Find last execution marker and scan messages after it for [DONE:n]
					let executeIndex = -1;
					for (let i = entries.length - 1; i >= 0; i--) {
						const entry = entries[i] as { type: string; customType?: string };
						if (entry.customType === "plannotator-execute") {
							executeIndex = i;
							break;
						}
					}

					for (let i = executeIndex + 1; i < entries.length; i++) {
						const entry = entries[i];
						if (entry.type === "message" && "message" in entry) {
							const text = getAssistantMessageText(entry.message);
							if (text) markCompletedSteps(text, checklistItems);
						}
					}
					persistCompletedChecklist(fullPath);
				} else {
					// Plan file gone — fall back to idle. This demotes a RECORDED
					// executing phase, so the session provably used plan mode and
					// its framing residue is still in history: owe the countermand.
					// Arming here cannot break the #1269 fresh-session promise —
					// only a persisted executing entry reaches this branch.
					phase = "idle";
					lastSubmittedPath = null;
					idleNoticePending = true;
				}
			} else {
				// No path recorded — can't rebuild, fall back to idle. Same
				// recorded-executing demotion as above: the countermand is owed.
				phase = "idle";
				idleNoticePending = true;
			}
		}

		if (phase === "planning") {
			checklistItems = [];
			if (options.warnOnPlanning) {
				const warning = getPlanReviewAvailabilityWarning({ hasUI: ctx.hasUI, hasPlanHtml: planBrowserHtmlAvailable() });
				if (warning) {
					ctx.ui.notify(warning, "warning");
				}
			}
		}

		// A branch whose path is not planning has no plan waiting on review.
		if (phase !== "planning") stopPendingPlanReview();

		if (phase === "idle") {
			releaseAddedPhaseTools();
			if (savedState) {
				await restoreSavedState(ctx);
				savedState = null;
			}
			const activeTools = pi.getActiveTools();
			const idleTools = stripPlanningOnlyTools(activeTools);
			if (idleTools.length !== activeTools.length) pi.setActiveTools(idleTools);
		} else if (phase === "planning" || phase === "executing") {
			// A /tree navigation that stays in the same phase must not undo a
			// model or thinking level the user picked during that phase (#1722):
			// restoring the pre-plan model and re-applying the phase profile
			// belong to an actual phase change. Pi and oh-my-pi leave the model
			// alone on /tree, so keeping it keeps the user's choice. Tools are
			// still re-derived from the new path.
			await applyPhaseConfig(ctx, {
				restoreSavedState: true,
				applyModelSettings: !(options.keepModelWhenPhaseUnchanged && phase === phaseBefore),
			});
		}

		updateStatus(ctx);
		updateWidget(ctx);
		persistState();
	}

	pi.on("session_start", async (_event, ctx) => {
		// Project trust gate (#1291). Capability absent = fail closed: the
		// project-local config is skipped and the honest capability warning
		// fires (see PROJECT_TRUST_CAPABILITY_WARNING). A host that provides
		// the function is honored verbatim — including one that hardcodes
		// `true` because it has no project-trust gate by policy (oh-my-pi's
		// planned shim). A throwing trustFn (real Pi throws on a stale
		// context) propagates deliberately: config loading never runs, so
		// project-local config still cannot load.
		const trustFn = ctx.isProjectTrusted as (() => boolean) | undefined;
		const projectTrusted = typeof trustFn === "function" ? trustFn.call(ctx) : false;
		if (typeof trustFn !== "function") {
			ctx.ui.notify(PROJECT_TRUST_CAPABILITY_WARNING, "warning");
		}
		const loadedConfig = loadPlannotatorConfig(ctx.cwd, {
			projectTrusted,
		});
		plannotatorConfig = loadedConfig.config;
		for (const warning of loadedConfig.warnings) {
			ctx.ui.notify(`Plannotator config: ${warning}`, "warning");
		}

		// Check --plan flag
		if (pi.getFlag("plan") === true) {
			phase = "planning";
		}

		await resyncPhaseFromSession(ctx, { phaseWhenUnrecorded: phase, warnOnPlanning: true });
	});

	// Compaction summarizes conversation history and can swallow the delivered
	// framing message (custom messages are ordinary compactable messages), so
	// reopen the latch: the next prompt re-delivers the phase framing. If the
	// framing survived in the kept tail, re-delivery duplicates it — accepted
	// (#1380): the copies are identical instructions, the newest governs, and
	// compaction already invalidated the cached prefix, so appending a fresh
	// copy costs nothing while removing the survivor would cost the cache.
	pi.on("session_compact", async () => {
		if (phase !== "planning" && phase !== "executing") return;
		framingDelivered = false;
		persistState();
	});

	// A /tree branch switch changes the active path out from under the latch:
	// the new path can carry different phase state, or lack the framing message
	// that was delivered on the abandoned branch. Re-derive everything from the
	// new path; a path with no plannotator state at all means idle.
	pi.on("session_tree", async (_event, ctx) => {
		await resyncPhaseFromSession(ctx, {
			phaseWhenUnrecorded: "idle",
			warnOnPlanning: false,
			keepModelWhenPhaseUnchanged: true,
		});
	});
}
