/**
 * "Ask this session": an Ask AI provider answered by the agent session that
 * opened Plannotator, instead of a separate SDK agent.
 *
 * The host (Pi today; OpenCode and Claude Code mods later) implements the
 * small, host-neutral `SessionBridge` interface below. `SessionBridgeProvider`
 * wraps it as an ordinary `AIProvider`, so it rides the existing
 * `/api/ai/session` + `/api/ai/query` endpoints unchanged.
 *
 * Rules the provider enforces (not the host):
 * - one question at a time across every Ask AI thread of the server;
 * - a busy agent is never interrupted implicitly: the first attempt answers
 *   `agent_busy`, and the client re-asks with an explicit `busyPolicy`
 *   ("wait" holds the question until the session is idle, "interrupt" asks the
 *   host to stop the session's current work first);
 * - abort cancels only our own question (the host decides how).
 */

import { BaseSession } from "./base-session.ts";
import type {
	AIContext,
	AIMessage,
	AIProvider,
	AIProviderCapabilities,
	AIQueryOptions,
	AISession,
	CreateSessionOptions,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Host interface
// ---------------------------------------------------------------------------

/**
 * - `ready`: idle, a question can run now.
 * - `busy`: the agent is mid-turn on something else; a question waits or interrupts.
 * - `blocked`: the session is waiting on THIS Plannotator decision, so a real
 *   turn can never run (only a transient answer could).
 * - `gone`: the session ended or was replaced.
 */
export type SessionBridgeStatus = "ready" | "busy" | "blocked" | "gone";

export type SessionBridgeHost = "pi" | "opencode" | "claude-code";

export type SessionBridgeAskMode = "turn" | "transient";

/**
 * `taken_over`: someone else's prompt (the person typing into the session, a
 * peer, another plugin) entered the turn that was answering our question, so
 * the rest of that turn answers them. The host stops streaming at once, keeps
 * what it already sent, and settles with this code; the client shows the
 * partial answer with a note, not an error.
 */
export type SessionBridgeErrorCode = "busy" | "blocked" | "gone" | "aborted" | "failed" | "taken_over";

export interface SessionBridgeSink {
	delta(text: string): void;
	tool?(name: string): void;
	done(answer: string): void;
	error(code: SessionBridgeErrorCode, message?: string): void;
}

export interface SessionBridgeAskRequest {
	askId: string;
	/** The full message to put in the session, header included. */
	text: string;
	mode: SessionBridgeAskMode;
}

export interface SessionBridge {
	host: SessionBridgeHost;
	status(): SessionBridgeStatus;
	/** `turn` = a real message with tools, kept in the transcript; `transient` = an answer from context, no tools, no transcript. */
	modes: { turn: boolean; transient: boolean };
	/**
	 * Send one question. The host reports through `sink` exactly once with
	 * `done` or `error`. Aborting `signal` cancels OUR question only: drop it if
	 * it was not delivered yet, stop the turn only if the running turn is ours.
	 *
	 * Take-over rule (every host): once a prompt we did not send enters the
	 * turn that is answering the question, that turn is no longer ours. The
	 * host stops streaming, settles with `error("taken_over")`, and from then
	 * on neither an abort of this question nor `interrupt()` stops that turn.
	 * When the answer had already finished (the turn's last model response
	 * called no tools) before the other message entered, it settles `done`.
	 */
	ask(req: SessionBridgeAskRequest, sink: SessionBridgeSink, signal: AbortSignal): void;
	/**
	 * Stop the session's current work so a question can run now ("Interrupt
	 * and ask now"). Hosts that cannot interrupt omit it; the provider then
	 * refuses an interrupt request.
	 */
	interrupt?(): void | Promise<void>;
	/**
	 * The server is about to deliver the reviewer's decision (or shut down):
	 * drop any question that has not reached the session yet, and leave a turn
	 * that is already running alone. Optional; in-process hosts deliver at once.
	 */
	detach?(): void;
}

// ---------------------------------------------------------------------------
// Wire constants shared with the client
// ---------------------------------------------------------------------------

export const SESSION_BRIDGE_PROVIDER_NAME = "session-bridge";

/** Error codes the client turns into actions (busy choice, fallback). */
export const SESSION_BRIDGE_ERROR = {
	agentBusy: "agent_busy",
	blocked: "session_blocked",
	gone: "session_gone",
	inFlight: "ask_in_flight",
	failed: "session_ask_failed",
	takenOver: "session_taken_over",
} as const;

/**
 * The note shown under a partial answer whose turn another message took over.
 * Neutral: most hosts cannot tell the person typing from another extension's
 * steer or a peer session's message.
 */
export const SESSION_ASK_TAKEN_OVER_TEXT =
	"Another message entered this session while it was answering, so the rest of the reply went to that message.";

/** The same note when the host knows the person typed it (Claude Code: the prompt box, Remote Control). */
export const SESSION_ASK_TAKEN_OVER_BY_PERSON_TEXT =
	"You typed into this session while it was answering, so the rest of the reply went to your prompt.";

/** Why "Interrupt and ask now" refuses a turn another message took over. */
export const SESSION_ASK_TAKEN_OVER_INTERRUPT_TEXT =
	"The session is now answering another message, so Plannotator will not stop it. Ask when it finishes instead.";

const HOST_LABELS: Record<SessionBridgeHost, string> = {
	pi: "Pi",
	opencode: "OpenCode",
	"claude-code": "Claude Code",
};

export function sessionBridgeLabel(
	host: SessionBridgeHost,
	modes: { turn: boolean; transient: boolean } = { turn: true, transient: false },
): string {
	const name = HOST_LABELS[host] ?? host;
	// A transient-only bridge (e.g. OpenCode plan review) answers from context,
	// with no tools and nothing written to the transcript: say so.
	return !modes.turn && modes.transient ? `Quick answer from this session · ${name}` : `Ask this session · ${name}`;
}

// ---------------------------------------------------------------------------
// Message shape
// ---------------------------------------------------------------------------

export const SESSION_ASK_HEADER =
	"[Plannotator Ask AI] A question from the reviewer in Plannotator. Answer it briefly, here in the session. Do not edit files or start new work unless the question asks you to.";

/**
 * Added to a transient (quick-answer) question. The host answers from the
 * session's context in one completion: a tool call there yields no answer at
 * all, and a tool call the session is waiting on may still look unfinished.
 */
export const SESSION_ASK_TRANSIENT_NOTE =
	"Answer in plain text only. Tools are not available for this reply, so do not call any. If a tool call of yours looks unfinished, it is still waiting on this review.";

function describeSurface(context: AIContext): string | null {
	switch (context.mode) {
		case "code-review":
			return "Surface: code review";
		case "plan-review":
			return "Surface: plan review";
		case "annotate": {
			const { filePath, sourceInfo, bundlePosition } = context.annotate;
			if (filePath === "last-message") return "Surface: annotating your last message";
			const where = sourceInfo && /^https?:\/\//i.test(sourceInfo) ? sourceInfo : filePath;
			// A review of several files names the open file's place in it.
			const position = bundlePosition ? `, file ${bundlePosition.index} of ${bundlePosition.total}` : "";
			return where ? `Surface: annotating ${where}${position}` : "Surface: annotating a document";
		}
		default:
			return null;
	}
}

/**
 * Opens the reviewer's unsubmitted annotations (#1748). The session that
 * receives an Ask is the agent the review is for, with its tools, so drafts
 * are framed as read-only context and never in the submitted-feedback format:
 * the reviewer sends them, as feedback, when ready.
 */
export const SESSION_ASK_DRAFTS_LABEL =
	"[Draft annotations the reviewer has not submitted yet. They are context for the question only. Do not act on them; the reviewer will send them when ready. This list replaces any draft list sent earlier.]";

/** Closes the draft list, so the question after it reads as the question. */
export const SESSION_ASK_DRAFTS_END = "[End of draft annotations]";

/** Sent once when every draft the session saw earlier was removed. */
export const SESSION_ASK_DRAFTS_CLEARED =
	"[The reviewer has no draft annotations now. Disregard any draft list sent earlier.]";

/** Upper bound on the draft list in one question; a longer one is cut. */
export const MAX_SESSION_ASK_DRAFTS_CHARS = 16_000;

/** Text inside a draft list that reads like the end marker. */
const DRAFTS_END_LOOKALIKE = /\[\s*end\s+of\s+(?:the\s+)?draft\s+annotations?\b[^\]\n]*\]/gi;

function formatDraftBlock(draftAnnotations: string | undefined): string | null {
	if (draftAnnotations === undefined) return null;
	// The list's own text cannot close the frame early, in any spelling a
	// reader would take for the end marker (case, spacing, a suffix).
	let list = draftAnnotations.replace(DRAFTS_END_LOOKALIKE, "(quoted: end of draft annotations)").trim();
	if (!list) return SESSION_ASK_DRAFTS_CLEARED;
	if (list.length > MAX_SESSION_ASK_DRAFTS_CHARS) {
		list = `${list.slice(0, MAX_SESSION_ASK_DRAFTS_CHARS)}\n… (the rest of the draft list was cut)`;
	}
	return [SESSION_ASK_DRAFTS_LABEL, list, SESSION_ASK_DRAFTS_END].join("\n");
}

/**
 * The message the session receives. There is no system prompt: the host's own
 * prompt is in effect, so the header carries the framing. `draftAnnotations`
 * (the reviewer's unsubmitted annotations, when they changed since the session
 * last saw them) rides in its read-only frame between the surface and the
 * question, so the question stays the last thing the session reads.
 */
export function formatSessionAskText(
	context: AIContext,
	prompt: string,
	mode: SessionBridgeAskMode = "turn",
	draftAnnotations?: string,
	surfaceOverride?: string,
): string {
	const surface = surfaceOverride ?? describeSurface(context);
	const note = mode === "transient" ? SESSION_ASK_TRANSIENT_NOTE : null;
	const drafts = formatDraftBlock(draftAnnotations);
	return [SESSION_ASK_HEADER, note, surface, "", drafts, drafts === null ? null : "", prompt.trim()]
		.filter((line) => line !== null)
		.join("\n");
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface SessionBridgeProviderOptions {
	/** How often to re-check `status()` while a question waits. Default 250ms. */
	pollIntervalMs?: number;
	/**
	 * The "Surface: …" line for a surface the context modes do not describe
	 * (Plannotator Snapshots asks from its HUD, outside any review).
	 */
	surface?: string;
}

export interface SessionBridgeInfo {
	host: SessionBridgeHost;
	status: SessionBridgeStatus;
	modes: { turn: boolean; transient: boolean };
}

export class SessionBridgeProvider implements AIProvider {
	readonly name = SESSION_BRIDGE_PROVIDER_NAME;
	readonly models = [] as const;
	readonly capabilities: AIProviderCapabilities;
	readonly label: string;
	readonly pollIntervalMs: number;
	readonly surface: string | undefined;

	private inFlight: SessionBridgeSession | null = null;
	private closing = false;

	// Explicit fields, not parameter properties: Pi's AI runtime (which
	// imports this through endpoints.ts) must also load under Node's
	// strip-only TypeScript.
	readonly bridge: SessionBridge;

	constructor(bridge: SessionBridge, options: SessionBridgeProviderOptions = {}) {
		this.bridge = bridge;
		this.capabilities = { fork: false, resume: false, streaming: true, tools: bridge.modes.turn };
		this.label = sessionBridgeLabel(bridge.host, bridge.modes);
		this.pollIntervalMs = options.pollIntervalMs ?? 250;
		this.surface = options.surface;
	}

	/** Live status for `/api/ai/capabilities`. */
	get sessionBridge(): SessionBridgeInfo {
		let status: SessionBridgeStatus;
		try {
			status = this.bridge.status();
		} catch {
			status = "gone";
		}
		return { host: this.bridge.host, status, modes: { ...this.bridge.modes } };
	}

	/** @internal one question at a time across every session of this provider. */
	claim(session: SessionBridgeSession): boolean {
		if (this.inFlight && this.inFlight !== session) return false;
		this.inFlight = session;
		return true;
	}

	/** @internal */
	release(session: SessionBridgeSession): void {
		if (this.inFlight === session) this.inFlight = null;
	}

	/** @internal */
	get isClosing(): boolean {
		return this.closing;
	}

	/**
	 * Called by the server runtime before its sessions are torn down (decision,
	 * exit, shutdown). From here on an abort still drops a question that has
	 * not reached the session, but never stops a turn already running: the
	 * reviewer's decision is about to be delivered to that same session.
	 */
	detach(): void {
		this.closing = true;
		try {
			this.bridge.detach?.();
		} catch {
			// Best effort: the decision must go out regardless.
		}
	}

	async createSession(options: CreateSessionOptions): Promise<AISession> {
		return new SessionBridgeSession(this, options.context);
	}

	async forkSession(): Promise<AISession> {
		throw new Error("Ask this session does not fork; it already is the session.");
	}

	async resumeSession(): Promise<AISession> {
		throw new Error("Ask this session does not resume threads.");
	}

	dispose(): void {
		this.closing = true;
		this.inFlight = null;
	}
}

type WaitOutcome = "ready" | "gone" | "blocked" | "aborted";

function readStatus(bridge: SessionBridge): SessionBridgeStatus {
	try {
		return bridge.status();
	} catch {
		return "gone";
	}
}

function waitUntilReady(bridge: SessionBridge, signal: AbortSignal, pollMs: number): Promise<WaitOutcome> {
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setInterval> | null = null;
		const finish = (outcome: WaitOutcome) => {
			if (timer) clearInterval(timer);
			signal.removeEventListener("abort", onAbort);
			resolve(outcome);
		};
		const onAbort = () => finish("aborted");
		const check = (): boolean => {
			if (signal.aborted) {
				finish("aborted");
				return true;
			}
			const status = readStatus(bridge);
			if (status === "busy") return false;
			finish(status);
			return true;
		};
		if (check()) return;
		signal.addEventListener("abort", onAbort, { once: true });
		timer = setInterval(check, pollMs);
	});
}

/** A tiny single-consumer async queue that also closes on abort. */
class MessageQueue {
	private items: AIMessage[] = [];
	private waiter: (() => void) | null = null;
	private closed = false;

	push(message: AIMessage): void {
		if (this.closed) return;
		this.items.push(message);
		this.wake();
	}

	close(): void {
		this.closed = true;
		this.wake();
	}

	private wake(): void {
		const waiter = this.waiter;
		this.waiter = null;
		waiter?.();
	}

	async *drain(): AsyncGenerator<AIMessage> {
		while (true) {
			if (this.items.length > 0) {
				yield this.items.shift()!;
				continue;
			}
			if (this.closed) return;
			await new Promise<void>((resolve) => {
				this.waiter = resolve;
			});
		}
	}
}

function errorMessage(code: string, error: string): AIMessage {
	return { type: "error", code, error };
}

const GONE_TEXT = "This session is no longer available (it was closed, replaced, or resumed elsewhere).";
const BLOCKED_TEXT = "This session is waiting on this Plannotator decision, so it cannot answer right now.";
const BUSY_TEXT = "The session is busy with another turn.";

export class SessionBridgeSession extends BaseSession {
	private readonly provider: SessionBridgeProvider;
	private readonly context: AIContext;

	constructor(provider: SessionBridgeProvider, context: AIContext) {
		super({ parentSessionId: null });
		this.provider = provider;
		this.context = context;
	}

	async *query(prompt: string, options?: AIQueryOptions): AsyncIterable<AIMessage> {
		const started = this.startQuery();
		if (!started) {
			yield BaseSession.BUSY_ERROR;
			return;
		}
		const { gen, signal } = started;
		const { provider } = this;
		const bridge = provider.bridge;

		if (!provider.claim(this)) {
			this.endQuery(gen);
			yield errorMessage(
				SESSION_BRIDGE_ERROR.inFlight,
				"Another question to this session is still running. Wait for it, or stop it first.",
			);
			return;
		}

		try {
			let status = readStatus(bridge);
			if (status === "gone") {
				yield errorMessage(SESSION_BRIDGE_ERROR.gone, GONE_TEXT);
				return;
			}

			let mode: SessionBridgeAskMode;
			if (bridge.modes.turn && status !== "blocked") {
				mode = "turn";
			} else if (bridge.modes.transient) {
				mode = "transient";
			} else {
				yield errorMessage(SESSION_BRIDGE_ERROR.blocked, BLOCKED_TEXT);
				return;
			}

			if (mode === "turn" && status === "busy") {
				const policy = options?.busyPolicy;
				if (!policy || (policy === "interrupt" && !bridge.interrupt)) {
					yield errorMessage(SESSION_BRIDGE_ERROR.agentBusy, BUSY_TEXT);
					return;
				}
				if (policy === "interrupt") {
					yield { type: "status", status: "interrupting" };
					try {
						await bridge.interrupt!();
					} catch (err) {
						yield errorMessage(
							SESSION_BRIDGE_ERROR.failed,
							`Could not interrupt the session: ${err instanceof Error ? err.message : String(err)}`,
						);
						return;
					}
				} else {
					yield { type: "status", status: "waiting" };
				}
				const outcome = await waitUntilReady(bridge, signal, provider.pollIntervalMs);
				if (outcome === "aborted") return;
				if (outcome === "gone") {
					yield errorMessage(SESSION_BRIDGE_ERROR.gone, GONE_TEXT);
					return;
				}
				if (outcome === "blocked") {
					yield errorMessage(SESSION_BRIDGE_ERROR.blocked, BLOCKED_TEXT);
					return;
				}
				yield { type: "status", status: "running" };
				status = "ready";
			}

			if (signal.aborted) return;

			const queue = new MessageQueue();
			let settled = false;
			let toolCount = 0;
			const settle = (message: AIMessage) => {
				if (settled) return;
				settled = true;
				queue.push(message);
				queue.close();
			};
			const sink: SessionBridgeSink = {
				delta: (text) => {
					if (!settled && text) queue.push({ type: "text_delta", delta: text });
				},
				tool: (name) => {
					if (settled) return;
					toolCount += 1;
					queue.push({ type: "tool_use", toolName: name, toolInput: {}, toolUseId: `${this.id}:${gen}-tool-${toolCount}` });
				},
				done: (answer) => settle({ type: "result", sessionId: this.id, success: true, result: answer }),
				error: (code, message) => {
					if (code === "aborted") {
						settled = true;
						queue.close();
						return;
					}
					const mapped =
						code === "gone"
							? errorMessage(SESSION_BRIDGE_ERROR.gone, message || GONE_TEXT)
							: code === "blocked"
								? errorMessage(SESSION_BRIDGE_ERROR.blocked, message || BLOCKED_TEXT)
								: code === "busy"
									? errorMessage(SESSION_BRIDGE_ERROR.agentBusy, message || BUSY_TEXT)
									: code === "taken_over"
										? errorMessage(SESSION_BRIDGE_ERROR.takenOver, message || SESSION_ASK_TAKEN_OVER_TEXT)
										: errorMessage(SESSION_BRIDGE_ERROR.failed, message || "The session could not answer.");
					settle(mapped);
				},
			};
			const onAbort = () => {
				settled = true;
				queue.close();
			};
			signal.addEventListener("abort", onAbort, { once: true });

			// The host sees an abort only when the reviewer stopped THIS question.
			// After the runtime detached (decision / shutdown) a running turn is
			// left alone; only an undelivered question is dropped.
			const hostAbort = new AbortController();
			signal.addEventListener(
				"abort",
				() => {
					if (!provider.isClosing) hostAbort.abort();
				},
				{ once: true },
			);

			try {
				bridge.ask({ askId: `${this.id}:${gen}`, text: formatSessionAskText(this.context, prompt, mode, options?.draftAnnotations, provider.surface), mode }, sink, hostAbort.signal);
			} catch (err) {
				sink.error("failed", err instanceof Error ? err.message : String(err));
			}

			try {
				for await (const message of queue.drain()) yield message;
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
		} finally {
			provider.release(this);
			this.endQuery(gen);
		}
	}
}
