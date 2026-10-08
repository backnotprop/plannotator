/**
 * "Ask this session" for OpenCode 2: answers Plannotator's Ask AI from the
 * OpenCode session that opened the review, annotation or plan review.
 *
 * Implements the host-neutral `SessionBridge` (packages/ai/session-bridge.ts)
 * over the plugin's own `ctx.session` and `ctx.event` domains. Two kinds of
 * question:
 *
 * - `turn`: a real prompt in the session (`session.prompt`, delivery "steer"),
 *   streamed back from the event stream and kept in the transcript. Used by
 *   /plannotator-review, -annotate and -last, whose CLI server runs as a
 *   separate process and reaches this object through the pull bridge.
 * - `transient`: `session.generate`, one completion over the session's
 *   context with nothing written to the transcript. Used while the session is
 *   waiting on a plan review (`submit_plan` is a pending tool call, so a real
 *   turn cannot run until the reviewer decides): checked live against OpenCode
 *   2.0.22, `generate` answers during a pending tool call, and @opencode/ai
 *   fills the missing tool result before the request goes out. It still
 *   offers the model its tools, and a tool call yields an empty answer, which
 *   is reported as a failure rather than shown as blank.
 *
 * OpenCode API notes (checked against anomalyco/opencode `v2` 40679546d4 and
 * the installed @opencode/cli 2.0.22):
 * - `session.prompt({ id })` admits an inbox row under our id; the event
 *   `session.inbox.delivered { inboxID }` says it entered the model context.
 *   Message ids are time-ordered (`msg_` + 12 hex time chars + 14 base62), so
 *   ours is generated the same way to sort where it belongs in the transcript.
 * - `session.execution.started|succeeded|failed|interrupted` bracket a run;
 *   text arrives as `session.text.delta` (live only) and `session.text.ended`
 *   (full text, replayable), tool names on `session.tool.input.started`.
 * - The plugin session domain has no "is this session busy" call. Busy is
 *   tracked from the execution events, cross-checked by `session.wait`, which
 *   resolves at once when the session is idle (and is the whole signal when
 *   the event stream is unavailable, upstream #44788).
 * - `session.interrupt` stops the WHOLE execution. It is only called for a
 *   turn that is ours, or when the reviewer chose "Interrupt and ask now", and
 *   never while the session waits on a plan review (status `blocked`).
 * - Take-over: once our question is delivered and the model has started
 *   answering it (`session.step.started`, or any answer output), a
 *   `session.inbox.delivered` for another USER row is a prompt we did not send
 *   (the person steering, a queued prompt promoted mid-run) entering the run,
 *   so the rest of the run answers it. The delivered event carries only the
 *   row id, so each row's kind is read from `session.inbox.enqueued`
 *   (`item.type`: user | synthetic | compaction | move); a synthetic notice,
 *   a compaction, a move, or a row whose kind this bridge never saw takes
 *   nothing over. Rows promoted in the same batch as ours (a command's
 *   session-URL notice) are delivered before the model starts and take
 *   nothing over either. On a take-over the question settles at once: `done`
 *   when the last model step had finished the answer (`finish: "stop"` AND no
 *   `session.tool.input.started` in that step, since some OpenAI-compatible
 *   providers report "stop" on a tool-calling step), else `taken_over` (deltas already sent stand). Neither a Stop
 *   nor "Interrupt and ask now" interrupts that execution afterwards.
 */

import type {
	SessionBridge,
	SessionBridgeSink,
	SessionBridgeStatus,
} from "@plannotator/ai/session-bridge";
import type { V2ContextLike } from "./v2-client";

export const PLANNOTATOR_ASK_SOURCE = "plannotator-ask";

/** How long a turn question may sit undelivered on an idle session before it is reported failed. */
const DELIVERY_WATCHDOG_MS = 15_000;
/** Idle re-check cadence while no execution event says otherwise. */
const IDLE_PROBE_MS = 1_000;
/** A `session.wait` still pending after this means the session is running. */
const BUSY_PROBE_MS = 300;
/** Without an event stream: how many times an answer that is not in the context yet is re-checked. */
const FALLBACK_ATTEMPTS = 40;

/**
 * Sessions currently waiting on a Plannotator plan review (`submit_plan` is a
 * pending tool call). A real turn cannot run there and interrupting would kill
 * the review, so every bridge reports `blocked` for them.
 */
const planReviewPending = new Map<string, number>();

export function markPlanReviewPending(sessionID: string): () => void {
	planReviewPending.set(sessionID, (planReviewPending.get(sessionID) ?? 0) + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const count = (planReviewPending.get(sessionID) ?? 1) - 1;
		if (count <= 0) planReviewPending.delete(sessionID);
		else planReviewPending.set(sessionID, count);
	};
}

export function isPlanReviewPending(sessionID: string): boolean {
	return planReviewPending.has(sessionID);
}

/**
 * One Plannotator question at a time per OpenCode session, across every
 * bridge on it (a review's and Plannotator Snapshots' can be open at once),
 * as Pi's bridge hub does: the turn that holds the session's slot, by session id.
 */
const sessionTurnSlots = new Map<string, object>();

const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastIdTimestamp = 0;
let idCounter = 0;

/** A message id in OpenCode's own ascending format (`Identifier.ascending`). */
export function createOpenCodeMessageId(timestamp = Date.now()): string {
	if (timestamp !== lastIdTimestamp) {
		lastIdTimestamp = timestamp;
		idCounter = 0;
	}
	idCounter++;
	const value = BigInt(timestamp) * 0x1000n + BigInt(idCounter);
	let time = "";
	for (let index = 0; index < 6; index++) {
		time += Number((value >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, "0");
	}
	const bytes = crypto.getRandomValues(new Uint8Array(14));
	let random = "";
	for (const byte of bytes) random += ID_CHARS[byte % 62];
	return `msg_${time}${random}`;
}

export interface OpenCodeSessionBridgeOptions {
	ctx: V2ContextLike;
	sessionID: string;
	/** Default: both. Plan review passes transient only. */
	modes?: { turn: boolean; transient: boolean };
	/** Test seams. */
	deliveryWatchdogMs?: number;
	idleProbeMs?: number;
	busyProbeMs?: number;
	fallbackPollMs?: number;
}

export interface OpenCodeSessionBridge extends SessionBridge {
	/** Stop watching the session. A running turn is left alone. */
	dispose(): void;
}

interface ActiveTurn {
	messageID: string;
	sink: SessionBridgeSink;
	delivered: boolean;
	cancelled: boolean;
	finished: boolean;
	answer: string;
	/** Text blocks (assistantMessageID:ordinal) that streamed at least one delta. */
	streamed: Set<string>;
	needsSeparator: boolean;
	watchdog: ReturnType<typeof setTimeout> | null;
	/** The model began answering after our row was delivered: a later delivery is someone else's prompt. */
	answering: boolean;
	/** How the last model step ended (`stop`: the answer was complete, no tool calls). */
	lastFinish: string | undefined;
	/** The current (or last) model step started a tool call: never a finished answer, whatever `finish` says. */
	stepCalledTools: boolean;
}

/**
 * Sent with `taken_over` (a user row can be the person or another plugin's
 * prompt, so the wording is neutral). Equal to `SESSION_ASK_TAKEN_OVER_TEXT`
 * (packages/ai/session-bridge.ts; a test holds them together), spelled out to
 * keep this module's imports type-only.
 */
export const TAKEN_OVER_TEXT =
	"Another message entered this session while it was answering, so the rest of the reply went to that message.";

/** Why "Interrupt and ask now" refuses a taken-over execution. Equal to `SESSION_ASK_TAKEN_OVER_INTERRUPT_TEXT`. */
export const TAKEN_OVER_INTERRUPT_TEXT =
	"The session is now answering another message, so Plannotator will not stop it. Ask when it finishes instead.";

/** Inbox row kinds remembered per session (`session.inbox.enqueued`), bounded. */
const MAX_REMEMBERED_ROWS = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
	if (!isRecord(error)) return false;
	const tag = Reflect.get(error, "_tag");
	if (typeof tag === "string" && /NotFound/i.test(tag)) return true;
	return /not ?found/i.test(errorText(error));
}

/** The text of the assistant messages that follow `messageID` in a `session.context` result. */
export function readAnswerAfter(context: unknown, messageID: string): string | undefined {
	if (!Array.isArray(context)) return undefined;
	const index = context.findIndex((message) => isRecord(message) && message.id === messageID);
	if (index < 0) return undefined;
	const texts: string[] = [];
	for (const message of context.slice(index + 1)) {
		if (!isRecord(message)) continue;
		if (message.type === "user") break;
		if (message.type !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text) texts.push(part.text);
		}
	}
	return texts.join("\n\n");
}

export function createOpenCodeSessionBridge(options: OpenCodeSessionBridgeOptions): OpenCodeSessionBridge {
	const { ctx, sessionID } = options;
	const modes = options.modes ?? { turn: true, transient: true };
	const deliveryWatchdogMs = options.deliveryWatchdogMs ?? DELIVERY_WATCHDOG_MS;
	const idleProbeMs = options.idleProbeMs ?? IDLE_PROBE_MS;
	const busyProbeMs = options.busyProbeMs ?? BUSY_PROBE_MS;
	const fallbackPollMs = options.fallbackPollMs ?? 500;
	const session = ctx.session;

	let gone = false;
	let disposed = false;
	/** Undefined until the first probe answers. */
	let running: boolean | undefined;
	let lastStartedAt = 0;
	let active: ActiveTurn | null = null;
	const controller = new AbortController();
	let probeTimer: ReturnType<typeof setTimeout> | null = null;
	let probing = false;
	/** The execution that answered our question was taken over: never interrupted from Plannotator. */
	let takenOverRun = false;
	/** `item.type` of each inbox row seen enqueued (user | synthetic | compaction | move). */
	const rowKinds = new Map<string, string>();

	const status = (): SessionBridgeStatus => {
		if (gone || disposed) return "gone";
		if (isPlanReviewPending(sessionID)) return "blocked";
		return running ? "busy" : "ready";
	};

	const markGone = () => {
		if (gone) return;
		gone = true;
		const turn = active;
		if (turn && !turn.finished) finishTurn(turn, () => turn.sink.error("gone"));
	};

	// Busy probe: `session.wait` resolves once the session is idle (at once if
	// it already is). One outstanding call at a time; while it hangs the
	// session is running, and it resolving IS the busy -> idle transition.
	const probe = () => {
		probeTimer = null;
		if (disposed || gone || probing || typeof session?.wait !== "function") return;
		probing = true;
		const startedAt = Date.now();
		let settled = false;
		const busyTimer = setTimeout(() => {
			if (!settled) running = true;
		}, busyProbeMs);
		void session.wait({ sessionID }).then(
			() => {
				settled = true;
				clearTimeout(busyTimer);
				probing = false;
				if (lastStartedAt <= startedAt) running = false;
				scheduleProbe(idleProbeMs);
			},
			(error) => {
				settled = true;
				clearTimeout(busyTimer);
				probing = false;
				if (isNotFound(error)) markGone();
				else scheduleProbe(idleProbeMs * 5);
			},
		);
	};

	const scheduleProbe = (ms: number) => {
		if (disposed || gone || probeTimer) return;
		probeTimer = setTimeout(probe, ms);
		(probeTimer as { unref?: () => void }).unref?.();
	};

	const clearWatchdog = (turn: ActiveTurn) => {
		if (turn.watchdog) clearTimeout(turn.watchdog);
		turn.watchdog = null;
	};

	const finishTurn = (turn: ActiveTurn, report: () => void) => {
		if (turn.finished) return;
		turn.finished = true;
		clearWatchdog(turn);
		if (active === turn) active = null;
		if (sessionTurnSlots.get(sessionID) === turn) sessionTurnSlots.delete(sessionID);
		report();
	};

	const appendText = (turn: ActiveTurn, text: string) => {
		if (!text) return;
		let delta = text;
		if (turn.needsSeparator) {
			delta = `\n\n${delta}`;
			turn.needsSeparator = false;
		}
		turn.answer += delta;
		if (!turn.cancelled) turn.sink.delta(delta);
	};

	/** Read the answer from the session itself (event stream missing or silent). */
	const finalizeFromContext = async (turn: ActiveTurn): Promise<void> => {
		try {
			const context = await session?.context?.({ sessionID });
			if (turn.finished) return;
			const answer = readAnswerAfter(context, turn.messageID);
			if (answer === undefined) {
				finishTurn(turn, () => turn.sink.error("failed", "The question did not reach the session."));
				return;
			}
			if (!turn.answer && answer) appendText(turn, answer);
			finishTurn(turn, () => (turn.cancelled ? turn.sink.error("aborted") : turn.sink.done(turn.answer || answer)));
		} catch (error) {
			if (turn.finished) return;
			finishTurn(turn, () => turn.sink.error(isNotFound(error) ? "gone" : "failed", errorText(error)));
		}
	};

	/**
	 * No event stream (#44788): wait until the session is idle and read the
	 * answer from its context. `wait` can resolve before our run even starts,
	 * so an answer that is not there yet is re-checked a bounded number of times.
	 */
	const settleWithoutEvents = async (turn: ActiveTurn): Promise<void> => {
		for (let attempt = 0; !turn.finished; attempt++) {
			try {
				await session?.wait?.({ sessionID });
			} catch {
				// Read the context anyway.
			}
			if (turn.finished) return;
			let context: unknown;
			try {
				context = await session?.context?.({ sessionID });
			} catch (error) {
				finishTurn(turn, () => turn.sink.error(isNotFound(error) ? "gone" : "failed", errorText(error)));
				return;
			}
			if (turn.finished) return;
			const answer = readAnswerAfter(context, turn.messageID);
			if (answer) {
				appendText(turn, answer);
				finishTurn(turn, () => (turn.cancelled ? turn.sink.error("aborted") : turn.sink.done(answer)));
				return;
			}
			if (attempt >= FALLBACK_ATTEMPTS) {
				finishTurn(turn, () => turn.sink.error("failed", "The session did not answer the question."));
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, fallbackPollMs));
		}
	};

	const handleEvent = (event: unknown) => {
		if (!isRecord(event) || typeof event.type !== "string") return;
		const data = isRecord(event.data) ? event.data : undefined;
		if (!data || data.sessionID !== sessionID) return;
		const turn = active;
		switch (event.type) {
			case "session.deleted":
				markGone();
				return;
			case "session.execution.started":
				lastStartedAt = Date.now();
				running = true;
				return;
			case "session.inbox.enqueued": {
				const item = isRecord(data.item) ? data.item : undefined;
				if (typeof data.inboxID === "string" && typeof item?.type === "string") {
					rowKinds.set(data.inboxID, item.type);
					if (rowKinds.size > MAX_REMEMBERED_ROWS) rowKinds.delete(rowKinds.keys().next().value!);
				}
				return;
			}
			case "session.inbox.delivered":
				if (turn && data.inboxID === turn.messageID) {
					turn.delivered = true;
					clearWatchdog(turn);
					// Stopped before it reached the model: stop it now that it is ours.
					if (turn.cancelled) void session?.interrupt?.({ sessionID }).catch(() => {});
				} else if (
					turn?.delivered &&
					turn.answering &&
					!turn.cancelled &&
					typeof data.inboxID === "string" &&
					rowKinds.get(data.inboxID) === "user"
				) {
					// Someone else's prompt entered the run answering our question.
					takenOverRun = true;
					// Some OpenAI-compatible providers report "stop" on a step that
					// called tools, so a tool call in the step rules it out too.
					const complete = turn.lastFinish === "stop" && !turn.stepCalledTools && !!turn.answer;
					finishTurn(turn, () => (complete ? turn.sink.done(turn.answer) : turn.sink.error("taken_over", TAKEN_OVER_TEXT)));
				}
				if (typeof data.inboxID === "string") rowKinds.delete(data.inboxID);
				return;
			case "session.step.started":
				if (turn?.delivered) {
					turn.answering = true;
					turn.lastFinish = undefined;
					turn.stepCalledTools = false;
				}
				return;
			case "session.step.ended":
				if (turn?.delivered && typeof data.finish === "string") turn.lastFinish = data.finish;
				return;
			case "session.reasoning.started":
				if (turn?.delivered) turn.answering = true;
				return;
			case "session.text.started":
				if (turn?.delivered) turn.answering = true;
				if (turn?.delivered && turn.answer) turn.needsSeparator = true;
				return;
			case "session.text.delta":
				if (turn?.delivered) turn.answering = true;
				if (turn?.delivered && typeof data.delta === "string") {
					turn.streamed.add(`${String(data.assistantMessageID)}:${String(data.ordinal)}`);
					appendText(turn, data.delta);
				}
				return;
			case "session.text.ended":
				// Some providers deliver a block whole: replay it when nothing streamed.
				if (turn?.delivered && typeof data.text === "string") {
					const key = `${String(data.assistantMessageID)}:${String(data.ordinal)}`;
					if (!turn.streamed.has(key)) appendText(turn, data.text);
				}
				return;
			case "session.tool.input.started":
				if (turn?.delivered) {
					turn.answering = true;
					turn.stepCalledTools = true;
				}
				if (turn?.delivered && !turn.cancelled && typeof data.name === "string") turn.sink.tool?.(data.name);
				return;
			case "session.execution.succeeded":
			case "session.execution.failed":
			case "session.execution.interrupted": {
				running = false;
				takenOverRun = false;
				if (!turn?.delivered) return;
				if (turn.cancelled) {
					finishTurn(turn, () => turn.sink.error("aborted"));
				} else if (event.type === "session.execution.succeeded") {
					finishTurn(turn, () => turn.sink.done(turn.answer));
				} else if (event.type === "session.execution.failed") {
					const error = isRecord(data.error) && typeof data.error.message === "string" ? data.error.message : undefined;
					finishTurn(turn, () => turn.sink.error("failed", error || "The session hit an error while answering."));
				} else {
					finishTurn(turn, () => turn.sink.error("failed", "The turn was stopped in the session before it finished answering."));
				}
				return;
			}
		}
	};

	let eventsAvailable = false;
	const subscribe = ctx.event?.subscribe;
	if (typeof subscribe === "function") {
		eventsAvailable = true;
		void (async () => {
			try {
				for await (const event of subscribe({ signal: controller.signal })) handleEvent(event);
			} catch {
				// Fall through: the stream is best effort (#44788).
			} finally {
				eventsAvailable = false;
			}
		})();
	}
	probe();

	const askTurn = (text: string, sink: SessionBridgeSink, signal: AbortSignal) => {
		const prompt = session?.prompt;
		if (typeof prompt !== "function") {
			sink.error("failed", "This OpenCode host cannot receive a prompt from a plugin.");
			return;
		}
		const turn: ActiveTurn = {
			messageID: createOpenCodeMessageId(),
			sink,
			delivered: false,
			cancelled: false,
			finished: false,
			answer: "",
			streamed: new Set(),
			needsSeparator: false,
			watchdog: null,
			answering: false,
			lastFinish: undefined,
			stepCalledTools: false,
		};
		active = turn;
		sessionTurnSlots.set(sessionID, turn);

		signal.addEventListener(
			"abort",
			() => {
				if (turn.finished || turn.cancelled) return;
				turn.cancelled = true;
				// Only ever interrupt a run that is answering OUR question. One not
				// delivered yet is interrupted on delivery (see the event handler).
				if (turn.delivered) {
					void session?.interrupt?.({ sessionID }).catch(() => {
						finishTurn(turn, () => turn.sink.error("aborted"));
					});
				}
			},
			{ once: true },
		);

		// A question that never shows up (event stream silent, or dropped by the
		// host): once the session is idle, settle it from the session context.
		const watchdog = () => {
			turn.watchdog = null;
			if (turn.finished) return;
			if (running) {
				turn.watchdog = setTimeout(watchdog, deliveryWatchdogMs);
				return;
			}
			void finalizeFromContext(turn);
		};
		turn.watchdog = setTimeout(watchdog, deliveryWatchdogMs);

		void Promise.resolve()
			.then(() =>
				prompt({
					sessionID,
					id: turn.messageID,
					text,
					// "steer": the provider only asks an idle session, where steer and
					// queue differ in one thing that matters. Every OpenCode 2 command
					// posts its session-URL notice as a pending STEER row (resume:
					// false), and a queued question would wake the session with that
					// notice promoted ALONE ahead of it, as its own model turn (the
					// #1515 promotion rule; seen live on 2.0.22: the model went off to
					// act on the notice while the question waited). Steering promotes
					// the notice and the question as one batch, one turn.
					delivery: "steer",
					metadata: { source: PLANNOTATOR_ASK_SOURCE },
				}),
			)
			.then(
				() => {
					// No event stream: wait for the run to finish, then read the answer.
					if (!eventsAvailable) void settleWithoutEvents(turn);
				},
				(error) => {
					finishTurn(turn, () => sink.error(isNotFound(error) ? "gone" : "failed", errorText(error)));
					if (isNotFound(error)) markGone();
				},
			);
	};

	const askTransient = (text: string, sink: SessionBridgeSink, signal: AbortSignal) => {
		const generate = session?.generate;
		if (typeof generate !== "function") {
			sink.error("blocked", "This OpenCode host cannot answer from the session's context.");
			return;
		}
		// `generate` cannot be cancelled: an abort just drops the answer.
		void Promise.resolve()
			.then(() => generate({ sessionID, prompt: text }))
			.then(
				(result) => {
					if (signal.aborted) return;
					const answer = isRecord(result) && typeof result.text === "string" ? result.text.trim() : "";
					if (!answer) {
						sink.error(
							"failed",
							"The session tried to use a tool instead of answering. Quick answers cannot run tools; ask again, or wait for the plan decision.",
						);
						return;
					}
					sink.delta(answer);
					sink.done(answer);
				},
				(error) => {
					if (signal.aborted) return;
					if (isNotFound(error)) markGone();
					sink.error(isNotFound(error) ? "gone" : "failed", errorText(error));
				},
			);
	};

	return {
		host: "opencode",
		modes,
		status,
		ask(req, sink, signal) {
			if (gone || disposed) {
				sink.error("gone");
				return;
			}
			if (req.mode === "transient") {
				askTransient(req.text, sink, signal);
				return;
			}
			if (active || sessionTurnSlots.has(sessionID)) {
				sink.error("busy", "Another Plannotator question is still running in this session.");
				return;
			}
			if (isPlanReviewPending(sessionID)) {
				sink.error("blocked");
				return;
			}
			// "steer" lands INSIDE a running execution. The server only asks when
			// the host last reported ready, but that report can be up to one status
			// tick old: if the session started a run since (the user typed), our
			// question must not be steered into it (and a later Stop would then
			// interrupt the user's own run). Report busy; the reviewer can wait.
			if (running) {
				sink.error("busy");
				return;
			}
			askTurn(req.text, sink, signal);
		},
		async interrupt() {
			// The provider never asks while blocked, but a plan review may have
			// started since: interrupting now would kill it.
			if (isPlanReviewPending(sessionID)) throw new Error("The session is waiting on a plan review.");
			// The person typed into the run that answered a question: it is theirs.
			if (takenOverRun && running) throw new Error(TAKEN_OVER_INTERRUPT_TEXT);
			const interrupt = session?.interrupt;
			if (typeof interrupt !== "function") throw new Error("This OpenCode host cannot interrupt a session from a plugin.");
			await interrupt({ sessionID });
			// The execution events (or the next probe) report the session idle.
			if (!eventsAvailable) {
				running = false;
				scheduleProbe(0);
			}
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			controller.abort();
			if (probeTimer) clearTimeout(probeTimer);
			probeTimer = null;
			const turn = active;
			if (turn && !turn.delivered) finishTurn(turn, () => turn.sink.error("gone"));
			// A delivered turn is left running, but this bridge no longer watches it: free the slot.
			if (turn && sessionTurnSlots.get(sessionID) === turn) sessionTurnSlots.delete(sessionID);
		},
	};
}
