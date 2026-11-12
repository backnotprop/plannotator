import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionBridge, SessionBridgeSink, SessionBridgeStatus } from "./generated/ai/session-bridge.ts";
import {
	isCtxAlive,
	isCurrentPiSessionDifferentFrom,
	type PiSessionIdentity,
} from "./current-pi-session.ts";

export const PLANNOTATOR_ASK_CUSTOM_TYPE = "plannotator-ask";

export const PI_INBOX_REMINDER_CUSTOM_TYPE = "plannotator-inbox-reminder";
export const PI_INBOX_BRIEFING_CUSTOM_TYPE = "plannotator-inbox-briefing";

const START_WATCHDOG_MS = 15_000;

type BridgeCtx = Pick<ExtensionContext, "mode" | "isIdle" | "hasPendingMessages" | "abort">;

type HubPi = {
	on(event: string, handler: (event: any, ctx?: unknown) => unknown): unknown;
	sendMessage: ExtensionAPI["sendMessage"];
};

interface ActiveAsk {
	askId: string;
	sink: SessionBridgeSink;
	started: boolean;
	cancelled: boolean;
	answer: string;
	needsSeparator: boolean;
	watchdog: ReturnType<typeof setTimeout> | null;
	pendingError: string | null;
	settlePoll: ReturnType<typeof setInterval> | null;
	isIdle: () => boolean;
}

export interface PiSessionBridgeHub {
	createBridge(ctx: BridgeCtx, origin: PiSessionIdentity): SessionBridge;
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
	let turnPrelude = false;
	let takenOverRun = false;
	let takenOverPoll: ReturnType<typeof setInterval> | null = null;
	let takenOverIsIdle: (() => boolean) | null = null;
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
								finish(ask);
								return;
							}
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
						throw new Error("The session is now answering another message, so Plannotator will not stop it. Ask when it finishes instead.");
					}
					ctx.abort();
				},
			};
		},
	};
}
