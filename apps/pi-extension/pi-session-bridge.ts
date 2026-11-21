/**
 * "Ask this session" for Pi: answers Plannotator's Ask AI from the Pi session
 * that opened the review / annotate / last-message / plan review browser, as a real turn in
 * that session (streamed, with tools, kept in the transcript).
 *
 * The question goes in as a custom message (`customType: "plannotator-ask"`)
 * so Pi shows it in its own labelled box and the model receives it as a user
 * message whose first line says it comes from the Plannotator reviewer. The
 * answer is read back from the session's own events.
 *
 * Pi API notes (checked against Pi 0.84 / 0.85 and the 1.0 source):
 * - `pi.on(...)` returns void before 1.0, so listeners cannot be removed. The
 *   hub therefore registers ONE set of listeners at extension load and routes
 *   events to the single active question.
 * - `pi.sendMessage(..., { triggerTurn: true })` starts a turn when the agent
 *   is idle and steers it into the running turn otherwise. The bridge only
 *   sends when idle (the provider holds the question until then), so steering
 *   happens only when the user types into Pi in the same instant.
 * - `pi.sendMessage` returns void and reports async failures to Pi's own error
 *   channel, so a question that never starts is failed by a watchdog.
 * - `agent_end` fires once per agent run, and Pi may run again inside the same
 *   prompt: an auto-retry after a retryable error (overloaded, rate limited) or
 *   a continuation after an overflow compaction. An error end therefore waits
 *   for `agent_settled` (Pi >= 0.80.4), or for the session to go idle on older
 *   Pi, before it is reported; a retry that starts answering clears it.
 * - Take-over: a message we did not send that enters the run answering our
 *   question makes the rest of that run someone else's. Pi emits such a
 *   message's `message_start` from the agent loop right after a `turn_start`,
 *   before the next assistant message: a `user` message (the person steering
 *   or following up, or `sendUserMessage`) or a triggering custom message
 *   (steered). A NON-triggering custom message sent while the run streams
 *   (display-only, e.g. `plannotator-handoff`) is appended at `turn_end`
 *   instead, outside that window, and takes nothing over. On a take-over the
 *   question settles at once: `done` when the turn before it ended the answer
 *   (stop, no tool call; e.g. Plannotator's own decision follow-up arriving
 *   after the answer finished), `taken_over` otherwise (the deltas already
 *   sent stand). From then on until the run settles (`agent_settled`, or idle
 *   on older Pi, so an error retry stays covered), neither a Stop nor
 *   "Interrupt and ask now" aborts that run: it answers someone else.
 *
 * Only type imports here: this module is loaded eagerly by index.ts.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionBridge, SessionBridgeSink, SessionBridgeStatus } from "./generated/ai/session-bridge.ts";
import {
	isCtxAlive,
	isCurrentPiSessionDifferentFrom,
	type PiSessionIdentity,
} from "./current-pi-session.ts";

export const PLANNOTATOR_ASK_CUSTOM_TYPE = "plannotator-ask";

/**
 * The Inbox's session-start reminder (inbox.ts): a hidden custom message
 * `before_agent_start` adds to the first run of a session, which may be the
 * run answering our question. It is no one's prompt, so it never takes the
 * question over.
 */
export const PI_INBOX_REMINDER_CUSTOM_TYPE = "plannotator-inbox-reminder";
/** `/plannotator-inbox`'s hidden Inbox briefing (index.ts), sent with the next prompt: like the reminder, never someone else's prompt. */
export const PI_INBOX_BRIEFING_CUSTOM_TYPE = "plannotator-inbox-briefing";

/** How long a sent question may take to show up in the session before it is reported as failed. */
const START_WATCHDOG_MS = 15_000;

type BridgeCtx = Pick<ExtensionContext, "mode" | "isIdle" | "hasPendingMessages" | "abort">;

type HubPi = {
	on(event: string, handler: (event: any, ctx?: unknown) => unknown): unknown;
	sendMessage: ExtensionAPI["sendMessage"];
};

interface ActiveAsk {
	askId: string;
	sink: SessionBridgeSink;
	/** Our custom message has been delivered into the session. */
	started: boolean;
	/** The reviewer stopped this question. */
	cancelled: boolean;
	answer: string;
	/** A new assistant message began after some answer text: separate with a blank line. */
	needsSeparator: boolean;
	watchdog: ReturnType<typeof setTimeout> | null;
	/** An agent run ended in an error that Pi may still retry: reported once the session settles. */
	pendingError: string | null;
	/** Fallback for Pi without `agent_settled`: polls idleness while an error is pending. */
	settlePoll: ReturnType<typeof setInterval> | null;
	isIdle: () => boolean;
}

export interface PiSessionBridgeHub {
	/** Build a bridge bound to the session that ran a command. */
	createBridge(ctx: BridgeCtx, origin: PiSessionIdentity): SessionBridge;
	/** @internal test hook */
	readonly hasActiveAsk: boolean;
}

function clearWatchdog(ask: ActiveAsk): void {
	if (ask.watchdog) clearTimeout(ask.watchdog);
	ask.watchdog = null;
}

function clearSettlePoll(ask: ActiveAsk): void {
	if (ask.settlePoll) clearInterval(ask.settlePoll);
	ask.settlePoll = null;
}

/** How often an older Pi (no `agent_settled`) is checked for idleness after an error end. */
const SETTLE_POLL_MS = 250;

function lastAssistant(messages: unknown): { stopReason?: string; errorMessage?: string } | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string } | null;
		if (message?.role === "assistant") return message as { stopReason?: string; errorMessage?: string };
	}
	return undefined;
}

export function createPiSessionBridgeHub(
	pi: HubPi,
	options: { startWatchdogMs?: number } = {},
): PiSessionBridgeHub {
	const startWatchdogMs = options.startWatchdogMs ?? START_WATCHDOG_MS;
	let active: ActiveAsk | null = null;
	/** Between a `turn_start` and that turn's assistant message: where the loop delivers queued messages. */
	let turnPrelude = false;
	/** The run that answered our question was taken over: never aborted from Plannotator until it settles. */
	let takenOverRun = false;
	/** Older Pi (no `agent_settled`): polls idleness after the taken-over run ends. */
	let takenOverPoll: ReturnType<typeof setInterval> | null = null;
	let takenOverIsIdle: (() => boolean) | null = null;
	/** The last turn of the run ended the answer: a stop with no tool call. */
	let lastTurnFinal = false;

	const clearTakenOver = () => {
		takenOverRun = false;
		takenOverIsIdle = null;
		if (takenOverPoll) clearInterval(takenOverPoll);
		takenOverPoll = null;
	};

	const finish = (ask: ActiveAsk) => {
		clearWatchdog(ask);
		clearSettlePoll(ask);
		if (active === ask) active = null;
	};

	const reportPendingError = (ask: ActiveAsk) => {
		if (active !== ask || ask.pendingError === null) return;
		const message = ask.pendingError;
		finish(ask);
		ask.sink.error("failed", message);
	};

	pi.on("turn_start", () => {
		turnPrelude = true;
	});

	pi.on("turn_end", (event) => {
		turnPrelude = false;
		const message = event?.message as { stopReason?: string; content?: unknown } | undefined;
		const calledTools =
			(Array.isArray(event?.toolResults) && event.toolResults.length > 0) ||
			(Array.isArray(message?.content) && message.content.some((part: { type?: string } | null) => part?.type === "toolCall"));
		lastTurnFinal = message?.stopReason === "stop" && !calledTools;
	});

	pi.on("message_start", (event) => {
		const message = event?.message as { role?: string; customType?: string; details?: { askId?: unknown } } | undefined;
		const inPrelude = turnPrelude;
		const answerFinished = lastTurnFinal;
		if (message?.role === "assistant") {
			turnPrelude = false;
			lastTurnFinal = false;
		}
		const ask = active;
		if (!ask || !message) return;
		const ours = message.role === "custom" && message.customType === PLANNOTATOR_ASK_CUSTOM_TYPE && message.details?.askId === ask.askId;
		if (ours) {
			ask.started = true;
			clearWatchdog(ask);
			return;
		}
		if (message.role === "custom" && (message.customType === PI_INBOX_REMINDER_CUSTOM_TYPE || message.customType === PI_INBOX_BRIEFING_CUSTOM_TYPE)) return;
		if (ask.started && (message.role === "user" || (message.role === "custom" && inPrelude))) {
			// Someone else's prompt entered the run answering our question: the
			// rest of it answers them. Settle now and leave the run alone.
			clearTakenOver();
			takenOverRun = true;
			takenOverIsIdle = ask.isIdle;
			finish(ask);
			if (answerFinished && ask.answer) ask.sink.done(ask.answer);
			else ask.sink.error("taken_over");
			return;
		}
		if (message.role === "custom" && message.customType === PLANNOTATOR_ASK_CUSTOM_TYPE) return;
		if (ask.started && message.role === "assistant") {
			// Pi retried (or continued after compaction): the run is still answering.
			ask.pendingError = null;
			clearSettlePoll(ask);
			if (ask.answer.length > 0) ask.needsSeparator = true;
		}
	});

	pi.on("message_update", (event) => {
		const ask = active;
		if (!ask?.started || ask.cancelled) return;
		const update = event?.assistantMessageEvent as { type?: string; delta?: unknown } | undefined;
		if (update?.type !== "text_delta" || typeof update.delta !== "string" || !update.delta) return;
		let delta = update.delta;
		if (ask.needsSeparator) {
			delta = `\n\n${delta}`;
			ask.needsSeparator = false;
		}
		ask.answer += delta;
		ask.sink.delta(delta);
	});

	pi.on("tool_execution_start", (event) => {
		const ask = active;
		if (!ask?.started || ask.cancelled) return;
		if (typeof event?.toolName === "string") ask.sink.tool?.(event.toolName);
	});

	pi.on("agent_end", (event) => {
		turnPrelude = false;
		lastTurnFinal = false;
		if (takenOverRun && !takenOverPoll) {
			// Pi may retry this run (agent.continue): the taken-over flag holds
			// until it settles. Without `agent_settled` (older Pi), until idle.
			const isIdle = takenOverIsIdle;
			takenOverPoll = setInterval(() => {
				let idle = true;
				try {
					idle = isIdle ? isIdle() : true;
				} catch {
					idle = true;
				}
				if (idle) clearTakenOver();
			}, SETTLE_POLL_MS);
			(takenOverPoll as { unref?: () => void }).unref?.();
		}
		const ask = active;
		if (!ask?.started) return;
		if (ask.cancelled) {
			finish(ask);
			ask.sink.error("aborted");
			return;
		}
		const last = lastAssistant(event?.messages);
		if (last?.stopReason === "error") {
			// Pi may retry this run: report the error only once the session settles.
			ask.pendingError = last.errorMessage || "The session hit an error while answering.";
			clearSettlePoll(ask);
			ask.settlePoll = setInterval(() => {
				let idle = true;
				try {
					idle = ask.isIdle();
				} catch {
					idle = true;
				}
				if (idle) reportPendingError(ask);
			}, SETTLE_POLL_MS);
			return;
		}
		finish(ask);
		if (last?.stopReason === "aborted") {
			ask.sink.error("failed", "The turn was stopped in the session before it finished answering.");
		} else {
			ask.sink.done(ask.answer);
		}
	});

	pi.on("agent_settled", () => {
		clearTakenOver();
		const ask = active;
		if (ask) reportPendingError(ask);
	});

	pi.on("session_shutdown", () => {
		const ask = active;
		if (!ask) return;
		finish(ask);
		ask.sink.error("gone");
	});

	return {
		get hasActiveAsk() {
			return active !== null;
		},
		createBridge(ctx, origin) {
			const status = (): SessionBridgeStatus => {
				if (!isCtxAlive(ctx) || isCurrentPiSessionDifferentFrom(origin)) return "gone";
				try {
					return ctx.isIdle() && !ctx.hasPendingMessages() ? "ready" : "busy";
				} catch {
					return "gone";
				}
			};

			return {
				host: "pi",
				modes: { turn: true, transient: false },
				status,
				ask(req, sink, signal) {
					if (active) {
						sink.error("busy", "Another Plannotator question is still running in this session.");
						return;
					}
					const ask: ActiveAsk = {
						askId: req.askId,
						sink,
						started: false,
						cancelled: false,
						answer: "",
						needsSeparator: false,
						watchdog: null,
						pendingError: null,
						settlePoll: null,
						isIdle: () => ctx.isIdle(),
					};
					active = ask;

					signal.addEventListener(
						"abort",
						() => {
							if (active !== ask) return;
							ask.cancelled = true;
							if (!ask.started) {
								// Not in the session yet: nothing of ours is running.
								finish(ask);
								return;
							}
							// Our turn is running: stop it. agent_end then clears `active`.
							try {
								if (!ctx.isIdle()) ctx.abort();
								else finish(ask);
							} catch {
								finish(ask);
							}
						},
						{ once: true },
					);

					const watchdog = () => {
						ask.watchdog = null;
						if (active !== ask || ask.started) return;
						let idle = true;
						try {
							idle = ctx.isIdle();
						} catch {
							idle = true;
						}
						// Busy (steered into a running turn, or Pi still preparing the run):
						// check again later, so a question Pi drops without ever starting it
						// (e.g. the user aborts the turn it was steered into) still fails
						// instead of waiting forever.
						if (!idle) {
							ask.watchdog = setTimeout(watchdog, startWatchdogMs);
							return;
						}
						finish(ask);
						sink.error("failed", "The question did not reach the session.");
					};
					ask.watchdog = setTimeout(watchdog, startWatchdogMs);

					try {
						pi.sendMessage(
							{
								customType: PLANNOTATOR_ASK_CUSTOM_TYPE,
								content: req.text,
								display: true,
								details: { askId: req.askId, source: "plannotator" },
							},
							{ triggerTurn: true },
						);
					} catch (err) {
						finish(ask);
						sink.error(status() === "gone" ? "gone" : "failed", err instanceof Error ? err.message : String(err));
					}
				},
				interrupt() {
					if (takenOverRun) {
						// Same text as SESSION_ASK_TAKEN_OVER_INTERRUPT_TEXT (type-only imports here).
						throw new Error("The session is now answering another message, so Plannotator will not stop it. Ask when it finishes instead.");
					}
					ctx.abort();
				},
			};
		},
	};
}
