/**
 * "Ask this session" pull bridge, host half: drives an in-process
 * `SessionBridge` against a Plannotator server running in ANOTHER process.
 *
 * The host (e.g. the OpenCode plugin) implements `SessionBridge` over its own
 * session API exactly as an in-process host would, starts the server process
 * with the bridge token in its environment (`SESSION_BRIDGE_TOKEN_ENV`), and
 * once the server is listening calls `runPullSessionBridgeClient`. The client
 * long-polls `/api/ai/bridge/poll`, runs the commands it receives through the
 * bridge, and posts progress to `/api/ai/bridge/event`. Protocol:
 * session-bridge-pull.ts.
 *
 * It stops when the signal aborts, when the server says it is closing, on an
 * auth or not-found answer, or after the server stops answering at all. It
 * never stops a question already running in the session when it stops: the
 * reviewer's decision goes to that same session next.
 */

import type { SessionBridge, SessionBridgeErrorCode, SessionBridgeStatus } from "./session-bridge.ts";
import type { BridgeCommand, BridgeHostEvent } from "./session-bridge-pull.ts";
import { SESSION_BRIDGE_EVENT_PATH, SESSION_BRIDGE_POLL_PATH } from "./session-bridge-pull.ts";

export interface PullSessionBridgeClientOptions {
	/** Server origin, e.g. `http://127.0.0.1:4321`. Always a loopback URL. */
	baseUrl: string;
	token: string;
	bridge: SessionBridge;
	signal: AbortSignal;
	/** How long each poll may wait on the server. Default 25s. */
	pollWaitMs?: number;
	/** How often status changes are pushed between polls. Default 500ms. */
	statusIntervalMs?: number;
	/** Deltas are batched for this long before posting. Default 40ms. */
	deltaFlushMs?: number;
	/** Consecutive failed polls before giving up. Default 6 (backoff 0.5s..4s). */
	maxFailures?: number;
	fetch?: typeof fetch;
	log?: (message: string) => void;
}

interface HostAsk {
	controller: AbortController;
	finished: boolean;
	/** What streamed so far: the answer a `taken_over` fallback settles with. */
	text: string;
}

/** Used when a host sends `taken_over` without a message (in-process hosts rely on the provider's). */
const TAKEN_OVER_FALLBACK_NOTE = "Another message entered this session while it was answering, so the rest of the reply went to that message.";

/**
 * A server that does not advertise `taken_over` reads it as `failed`, and its
 * UI then replaces the partial answer with the error. Settle as an answer
 * instead: what streamed, plus the note as its last paragraph.
 */
export function takenOverFallback(streamed: string, message: string | undefined): { delta: string; answer: string } {
	const note = `_${(message || TAKEN_OVER_FALLBACK_NOTE).trim()}_`;
	const delta = streamed ? `\n\n${note}` : note;
	return { delta, answer: `${streamed}${delta}` };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}

function readStatus(bridge: SessionBridge): SessionBridgeStatus {
	try {
		return bridge.status();
	} catch {
		return "gone";
	}
}

export async function runPullSessionBridgeClient(options: PullSessionBridgeClientOptions): Promise<void> {
	const doFetch = options.fetch ?? fetch;
	const base = options.baseUrl.replace(/\/+$/, "");
	const pollWaitMs = options.pollWaitMs ?? 25_000;
	const maxFailures = options.maxFailures ?? 6;
	const deltaFlushMs = options.deltaFlushMs ?? 40;
	const { bridge, signal } = options;
	const log = options.log ?? (() => {});
	const headers = { "content-type": "application/json", authorization: `Bearer ${options.token}` };

	/** Questions this host has seen (commands are re-sent until acknowledged). */
	const asks = new Map<string, HostAsk>();
	const interrupts = new Set<string>();
	let stopped = false;
	/** From the latest poll answer's `features` (SESSION_BRIDGE_POLL_FEATURES). */
	let serverTakesTakenOver = false;

	// One ordered outbox: events reach the server in the order they happened.
	let outbox: BridgeHostEvent[] = [];
	let sending: Promise<void> = Promise.resolve();
	let flushTimer: ReturnType<typeof setTimeout> | null = null;

	const post = async (events: BridgeHostEvent[]): Promise<void> => {
		if (events.length === 0) return;
		try {
			const res = await doFetch(`${base}${SESSION_BRIDGE_EVENT_PATH}`, {
				method: "POST",
				headers,
				body: JSON.stringify(events.length === 1 ? events[0] : { events }),
			});
			if (res.status === 409) {
				// The server no longer runs a question we are answering (the reviewer
				// stopped it before we confirmed it): stop ours.
				for (const event of events) {
					if ("askId" in event) stopAsk(event.askId);
				}
			}
			await res.body?.cancel().catch(() => {});
		} catch (error) {
			log(`[Plannotator] Session bridge event failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const flushOutbox = (): Promise<void> => {
		if (flushTimer) clearTimeout(flushTimer);
		flushTimer = null;
		const batch = outbox;
		outbox = [];
		sending = sending.then(() => post(batch));
		return sending;
	};

	const emit = (event: BridgeHostEvent, immediate = true) => {
		// Coalesce consecutive deltas of the same question.
		const last = outbox[outbox.length - 1];
		if (event.type === "delta" && last?.type === "delta" && last.askId === event.askId) {
			last.text += event.text;
		} else {
			outbox.push(event.type === "delta" ? { ...event } : event);
		}
		if (immediate) void flushOutbox();
		else if (!flushTimer) flushTimer = setTimeout(() => void flushOutbox(), deltaFlushMs);
	};

	const stopAsk = (askId: string) => {
		const ask = asks.get(askId);
		if (ask && !ask.finished) ask.controller.abort();
	};

	const runAsk = (command: Extract<BridgeCommand, { type: "ask" }>) => {
		if (asks.has(command.askId)) return;
		const controller = new AbortController();
		const ask: HostAsk = { controller, finished: false, text: "" };
		asks.set(command.askId, ask);
		emit({ type: "started", askId: command.askId });
		const finish = (event: BridgeHostEvent) => {
			if (ask.finished) return;
			ask.finished = true;
			emit(event);
		};
		try {
			bridge.ask(
				{ askId: command.askId, text: command.text, mode: command.mode },
				{
					delta: (text) => {
						if (ask.finished || !text) return;
						ask.text += text;
						emit({ type: "delta", askId: command.askId, text }, false);
					},
					tool: (name) => {
						if (!ask.finished && name) emit({ type: "tool", askId: command.askId, name });
					},
					done: (answer) => finish({ type: "done", askId: command.askId, answer }),
					error: (code: SessionBridgeErrorCode, message?: string) => {
						if (code === "taken_over" && !serverTakesTakenOver) {
							if (ask.finished) return;
							const fallback = takenOverFallback(ask.text, message);
							emit({ type: "delta", askId: command.askId, text: fallback.delta }, false);
							finish({ type: "done", askId: command.askId, answer: fallback.answer });
							return;
						}
						finish({ type: "error", askId: command.askId, code, ...(message ? { message } : {}) });
					},
				},
				controller.signal,
			);
		} catch (error) {
			finish({ type: "error", askId: command.askId, code: "failed", message: error instanceof Error ? error.message : String(error) });
		}
	};

	const runInterrupt = async (interruptId: string) => {
		if (interrupts.has(interruptId)) return;
		interrupts.add(interruptId);
		if (!bridge.interrupt) {
			emit({ type: "interrupted", interruptId, ok: false, message: "This session cannot be interrupted." });
			return;
		}
		try {
			await bridge.interrupt();
			emit({ type: "interrupted", interruptId, ok: true });
		} catch (error) {
			emit({ type: "interrupted", interruptId, ok: false, message: error instanceof Error ? error.message : String(error) });
		}
	};

	const handleCommand = (command: BridgeCommand) => {
		switch (command.type) {
			case "ask":
				runAsk(command);
				break;
			case "cancel": {
				const ask = asks.get(command.askId);
				if (!ask) {
					// Never started here: confirm so the server frees the slot.
					emit({ type: "error", askId: command.askId, code: "aborted" });
				} else if (ask.finished) {
					// Already answered: the server only needs to hear it again.
					emit({ type: "error", askId: command.askId, code: "aborted" });
				} else {
					ask.controller.abort();
				}
				break;
			}
			case "interrupt":
				void runInterrupt(command.interruptId);
				break;
		}
	};

	// Push status changes between polls so a busy -> ready transition is seen
	// within a fraction of a second, not at the next poll.
	let lastStatus = readStatus(bridge);
	const statusTimer = setInterval(() => {
		const status = readStatus(bridge);
		if (status === lastStatus) return;
		lastStatus = status;
		emit({ type: "status", status });
	}, options.statusIntervalMs ?? 500);
	(statusTimer as { unref?: () => void }).unref?.();

	let failures = 0;
	try {
		while (!signal.aborted && !stopped) {
			let res: Response;
			try {
				lastStatus = readStatus(bridge);
				res = await doFetch(`${base}${SESSION_BRIDGE_POLL_PATH}`, {
					method: "POST",
					headers,
					body: JSON.stringify({ status: lastStatus, modes: bridge.modes, waitMs: pollWaitMs }),
					signal,
				});
			} catch (error) {
				if (signal.aborted) break;
				failures += 1;
				if (failures >= maxFailures) {
					log(`[Plannotator] Session bridge stopped: the Plannotator server is not answering (${error instanceof Error ? error.message : String(error)}).`);
					break;
				}
				await sleep(Math.min(4_000, 500 * 2 ** (failures - 1)), signal);
				continue;
			}
			if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 405 || res.status === 503) {
				// Wrong token, not loopback, an older binary with no bridge, or AI disabled.
				await res.body?.cancel().catch(() => {});
				if (res.status !== 404 && res.status !== 503) log(`[Plannotator] Session bridge refused (HTTP ${res.status}).`);
				break;
			}
			if (!res.ok) {
				await res.body?.cancel().catch(() => {});
				failures += 1;
				if (failures >= maxFailures) break;
				await sleep(Math.min(4_000, 500 * 2 ** (failures - 1)), signal);
				continue;
			}
			failures = 0;
			let body: { commands?: BridgeCommand[]; closing?: boolean; features?: unknown } = {};
			try {
				body = (await res.json()) as typeof body;
			} catch {
				// Treat as an empty answer.
			}
			serverTakesTakenOver = Array.isArray(body.features) && body.features.includes("taken_over");
			for (const command of Array.isArray(body.commands) ? body.commands : []) {
				if (command && typeof command === "object" && typeof command.type === "string") handleCommand(command);
			}
			if (body.closing) stopped = true;
		}
	} finally {
		clearInterval(statusTimer);
		await flushOutbox().catch(() => {});
	}
}
