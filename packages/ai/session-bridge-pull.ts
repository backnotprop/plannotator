/**
 * "Ask this session" over HTTP: the pull bridge.
 *
 * The in-process `SessionBridge` (session-bridge.ts) needs the host to live in
 * the same process as the Plannotator server (Pi, OpenCode's embedded plan
 * server). A host that runs the server as a SEPARATE process (the OpenCode
 * plugin spawning the `plannotator` CLI, the Claude Code mod) cannot be called
 * directly, and should not have to open a listener of its own. It pulls
 * instead: it long-polls this server for work and posts the answer back.
 *
 * This file is the server half. It builds a `SessionBridge` that the ordinary
 * `SessionBridgeProvider` wraps, plus the two HTTP handlers the host talks to.
 * Host-neutral: nothing here knows which agent is on the other end.
 *
 * Protocol (both endpoints are POST + JSON):
 *
 *   POST /api/ai/bridge/poll   body { status?, modes?, waitMs? }
 *     Long-poll for commands. Answers as soon as there is something to do, or
 *     with an empty list after `waitMs` (clamped to 0..25s, default 25s).
 *     -> 200 { commands: BridgeCommand[], features: string[], closing?: true, superseded?: true }
 *     `features` lists optional protocol features (SESSION_BRIDGE_POLL_FEATURES).
 *     Each poll is also the host's heartbeat and status report.
 *
 *   POST /api/ai/bridge/event  body BridgeHostEvent | { events: BridgeHostEvent[] }
 *     The host reports progress: `started`, `delta`, `tool`, `done`, `error`
 *     (per question), `status`, and `interrupted` (per interrupt command).
 *     -> 200 { ok: true }, or 409 { ok: false, code: "ask_not_active" } when a
 *        question event names a question that is no longer running.
 *
 *   Commands: { type: "ask", askId, text, mode } | { type: "cancel", askId }
 *             | { type: "interrupt", interruptId }.
 *   A command is re-sent on a later poll until the host acknowledges it (any
 *   event for that question; `interrupted` for an interrupt), so the host must
 *   treat ids as idempotent.
 *
 * Auth: `Authorization: Bearer <token>`, where the token is a per-launch secret
 * the host generated and handed to the server process (env
 * `PLANNOTATOR_SESSION_BRIDGE_TOKEN`). It is never sent to the browser. The
 * runtime additionally requires a loopback Host header with the server's own
 * port, and these handlers refuse any request carrying an `Origin` header: a
 * browser page is never the host.
 *
 * Liveness: before the host's first request the bridge reports `ready` (a
 * question waits for the host to pick it up); if the host never connects
 * within `connectTimeoutMs`, or stops polling for `goneAfterMs`, the bridge is
 * `gone` and a running question fails with `gone`.
 *
 * Runtime-agnostic (vendored to Pi): web `Request`/`Response` only, no
 * parameter properties, so it loads under Node's strip-only TypeScript.
 */

import type {
	SessionBridge,
	SessionBridgeAskMode,
	SessionBridgeErrorCode,
	SessionBridgeHost,
	SessionBridgeSink,
	SessionBridgeStatus,
} from "./session-bridge.ts";

export const SESSION_BRIDGE_POLL_PATH = "/api/ai/bridge/poll";
export const SESSION_BRIDGE_EVENT_PATH = "/api/ai/bridge/event";

/** Env vars a host sets on the server process it launches. */
export const SESSION_BRIDGE_TOKEN_ENV = "PLANNOTATOR_SESSION_BRIDGE_TOKEN";
export const SESSION_BRIDGE_HOST_ENV = "PLANNOTATOR_SESSION_BRIDGE_HOST";
/** Comma-separated subset of `turn,transient`. Default `turn`. */
export const SESSION_BRIDGE_MODES_ENV = "PLANNOTATOR_SESSION_BRIDGE_MODES";

export const SESSION_BRIDGE_MAX_POLL_MS = 25_000;

/**
 * Optional protocol features this server understands, sent as `features` on
 * every poll answer. A host checks them before relying on one; a server that
 * predates the list sends none.
 * - `taken_over`: the `taken_over` error code (the session's turn was taken
 *   over by another message). Without it a host settles such a question as
 *   `done` with the partial answer and the note appended, because an older
 *   server reads the unknown code as `failed` and its UI then replaces the
 *   partial answer with the error.
 */
export const SESSION_BRIDGE_POLL_FEATURES: readonly string[] = ["taken_over"];
const MAX_EVENT_BODY_BYTES = 1_000_000;

export type BridgeCommand =
	| { type: "ask"; askId: string; text: string; mode: SessionBridgeAskMode }
	| { type: "cancel"; askId: string }
	| { type: "interrupt"; interruptId: string };

export type BridgeHostEvent =
	| { type: "status"; status: SessionBridgeStatus }
	| { type: "started"; askId: string }
	| { type: "delta"; askId: string; text: string }
	| { type: "tool"; askId: string; name: string }
	| { type: "done"; askId: string; answer: string }
	| { type: "error"; askId: string; code: SessionBridgeErrorCode; message?: string }
	| { type: "interrupted"; interruptId: string; ok: boolean; message?: string };

export interface PullSessionBridgeConfig {
	token: string;
	host: SessionBridgeHost;
	modes: { turn: boolean; transient: boolean };
}

export interface PullSessionBridgeOptions extends PullSessionBridgeConfig {
	/** Default 30s: how long the host may take to make its first request. */
	connectTimeoutMs?: number;
	/** Default 30s: silence (no open poll, no request) after which the host is gone. */
	goneAfterMs?: number;
	/** Default 5s: an unacknowledged command is sent again after this. */
	resendAfterMs?: number;
	/** Default 15s: how long an interrupt may take before it is reported failed. */
	interruptTimeoutMs?: number;
	/** Default 15s: after a cancel, how long to wait for the host to confirm before freeing the slot. */
	cancelGraceMs?: number;
	now?: () => number;
}

export interface PullSessionBridge {
	readonly bridge: SessionBridge;
	/** Handle a request to one of the two bridge paths. `null` for any other path. */
	handle(req: Request): Promise<Response> | null;
	/** Server shutdown: answer open polls with `closing`, fail anything still waiting. */
	dispose(): void;
}

const STATUSES: ReadonlySet<string> = new Set(["ready", "busy", "blocked", "gone"]);
const ERROR_CODES: ReadonlySet<string> = new Set(["busy", "blocked", "gone", "aborted", "failed", "taken_over"]);
const BRIDGE_HOSTS: ReadonlySet<string> = new Set(["pi", "opencode", "claude-code"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A poll answer: always advertises the protocol features this server knows. */
function pollReply(body: Record<string, unknown>): Response {
	return json({ ...body, features: SESSION_BRIDGE_POLL_FEATURES });
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Constant-time string comparison (both sides are short ASCII tokens). */
function tokensEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** Parse `turn,transient` style mode lists. Unknown entries are ignored; empty means turn only. */
export function parseSessionBridgeModes(value: string | undefined | null): { turn: boolean; transient: boolean } {
	const parts = (value ?? "").split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
	const turn = parts.includes("turn");
	const transient = parts.includes("transient");
	if (!turn && !transient) return { turn: true, transient: false };
	return { turn, transient };
}

/**
 * Read (and REMOVE) the pull-bridge config a host put in the environment, so
 * the token is not inherited by anything this process spawns later (agent
 * jobs, the agent terminal). Returns undefined when absent or malformed.
 */
export function takePullSessionBridgeConfig(env: Record<string, string | undefined>): PullSessionBridgeConfig | undefined {
	const token = env[SESSION_BRIDGE_TOKEN_ENV]?.trim();
	const host = env[SESSION_BRIDGE_HOST_ENV]?.trim();
	const modes = env[SESSION_BRIDGE_MODES_ENV];
	delete env[SESSION_BRIDGE_TOKEN_ENV];
	delete env[SESSION_BRIDGE_HOST_ENV];
	delete env[SESSION_BRIDGE_MODES_ENV];
	// 32+ characters: a host-generated random secret, never a guessable word.
	if (!token || token.length < 32 || !host || !BRIDGE_HOSTS.has(host)) return undefined;
	return { token, host: host as SessionBridgeHost, modes: parseSessionBridgeModes(modes) };
}

interface ActiveAsk {
	askId: string;
	text: string;
	mode: SessionBridgeAskMode;
	sink: SessionBridgeSink;
	/** The host acknowledged the question (any event for it). */
	acked: boolean;
	/** Last time the ask command was handed to a poll; 0 = never. */
	sentAt: number;
	cancelled: boolean;
	cancelAcked: boolean;
	cancelSentAt: number;
	cancelTimer: ReturnType<typeof setTimeout> | null;
}

interface PendingInterrupt {
	interruptId: string;
	sentAt: number;
	resolve: () => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface OpenPoll {
	resolve: (response: Response) => void;
	timer: ReturnType<typeof setTimeout>;
}

export function createPullSessionBridge(options: PullSessionBridgeOptions): PullSessionBridge {
	const now = options.now ?? (() => Date.now());
	const connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
	const goneAfterMs = options.goneAfterMs ?? 30_000;
	const resendAfterMs = options.resendAfterMs ?? 5_000;
	const interruptTimeoutMs = options.interruptTimeoutMs ?? 15_000;
	const cancelGraceMs = options.cancelGraceMs ?? 15_000;
	const createdAt = now();
	const modes = { ...options.modes };

	let hostStatus: SessionBridgeStatus = "ready";
	let connected = false;
	let lastSeen = createdAt;
	let openPoll: OpenPoll | null = null;
	let active: ActiveAsk | null = null;
	let pendingInterrupt: PendingInterrupt | null = null;
	let interruptSeq = 0;
	let disposed = false;
	let livenessTimer: ReturnType<typeof setInterval> | null = null;

	const isGone = (): boolean => {
		if (disposed) return true;
		if (openPoll) return false;
		const silence = now() - lastSeen;
		return connected ? silence > goneAfterMs : silence > connectTimeoutMs;
	};

	const status = (): SessionBridgeStatus => (isGone() ? "gone" : hostStatus);

	const stopLivenessTimer = () => {
		if (livenessTimer) clearInterval(livenessTimer);
		livenessTimer = null;
	};

	const finishActive = (ask: ActiveAsk) => {
		if (ask.cancelTimer) clearTimeout(ask.cancelTimer);
		ask.cancelTimer = null;
		if (active === ask) active = null;
		if (!active && !pendingInterrupt) stopLivenessTimer();
	};

	const failForGone = () => {
		const ask = active;
		if (ask) {
			finishActive(ask);
			ask.sink.error("gone");
		}
		const interrupt = pendingInterrupt;
		if (interrupt) {
			pendingInterrupt = null;
			clearTimeout(interrupt.timer);
			interrupt.reject(new Error("The session is no longer available."));
		}
		stopLivenessTimer();
	};

	// While something waits on the host, notice when it disappears.
	const ensureLivenessTimer = () => {
		if (livenessTimer || disposed) return;
		livenessTimer = setInterval(() => {
			if (isGone()) failForGone();
		}, 1_000);
		(livenessTimer as { unref?: () => void }).unref?.();
	};

	/** Commands due for (re)sending right now. Marks them sent. */
	const takeDueCommands = (): BridgeCommand[] => {
		const commands: BridgeCommand[] = [];
		const t = now();
		const due = (sentAt: number) => sentAt === 0 || t - sentAt >= resendAfterMs;
		const ask = active;
		if (ask) {
			if (!ask.cancelled && !ask.acked && due(ask.sentAt)) {
				ask.sentAt = t;
				commands.push({ type: "ask", askId: ask.askId, text: ask.text, mode: ask.mode });
			}
			if (ask.cancelled && ask.acked && !ask.cancelAcked && due(ask.cancelSentAt)) {
				ask.cancelSentAt = t;
				commands.push({ type: "cancel", askId: ask.askId });
			}
		}
		const interrupt = pendingInterrupt;
		if (interrupt && due(interrupt.sentAt)) {
			interrupt.sentAt = t;
			commands.push({ type: "interrupt", interruptId: interrupt.interruptId });
		}
		return commands;
	};

	/** Hand due commands to the open poll, if there is one. */
	const flush = () => {
		const poll = openPoll;
		if (!poll) return;
		const commands = takeDueCommands();
		if (commands.length === 0) return;
		openPoll = null;
		clearTimeout(poll.timer);
		lastSeen = now();
		poll.resolve(pollReply({ commands }));
	};

	const bridge: SessionBridge = {
		host: options.host,
		modes,
		status,
		ask(req, sink, signal) {
			if (disposed || isGone()) {
				sink.error("gone");
				return;
			}
			if (active) {
				sink.error("busy", "Another Plannotator question is still running in this session.");
				return;
			}
			const ask: ActiveAsk = {
				askId: req.askId,
				text: req.text,
				mode: req.mode,
				sink,
				acked: false,
				sentAt: 0,
				cancelled: false,
				cancelAcked: false,
				cancelSentAt: 0,
				cancelTimer: null,
			};
			active = ask;
			ensureLivenessTimer();
			signal.addEventListener(
				"abort",
				() => {
					if (active !== ask || ask.cancelled) return;
					ask.cancelled = true;
					if (!ask.acked) {
						// The host never confirmed it: drop it. If the host does pick it up,
						// its first event is answered 409 `ask_not_active`, which tells the
						// host to stop that question.
						finishActive(ask);
						return;
					}
					// Our question is in the session: ask the host to stop it, and free
					// the slot once it confirms (or after a grace period).
					ask.cancelTimer = setTimeout(() => finishActive(ask), cancelGraceMs);
					(ask.cancelTimer as { unref?: () => void }).unref?.();
					flush();
				},
				{ once: true },
			);
			flush();
		},
		interrupt() {
			if (disposed || isGone()) return Promise.reject(new Error("The session is no longer available."));
			if (pendingInterrupt) return Promise.reject(new Error("An interrupt is already in progress."));
			return new Promise<void>((resolve, reject) => {
				interruptSeq += 1;
				const interrupt: PendingInterrupt = {
					interruptId: `interrupt-${interruptSeq}`,
					sentAt: 0,
					resolve,
					reject,
					timer: setTimeout(() => {
						if (pendingInterrupt !== interrupt) return;
						pendingInterrupt = null;
						reject(new Error("The session did not confirm the interrupt in time."));
					}, interruptTimeoutMs),
				};
				(interrupt.timer as { unref?: () => void }).unref?.();
				pendingInterrupt = interrupt;
				ensureLivenessTimer();
				flush();
			});
		},
		detach() {
			// Decision / shutdown: a question the host never confirmed is dropped;
			// one already running in the session is left alone.
			const ask = active;
			if (ask && !ask.acked) finishActive(ask);
		},
	};

	const authorize = (req: Request): Response | null => {
		if (req.headers.get("origin")) {
			return json({ error: "Browser requests are not accepted here.", code: "session_bridge_forbidden_origin" }, 403);
		}
		const header = req.headers.get("authorization") ?? "";
		const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
		if (!match || !tokensEqual(match[1], options.token)) {
			return json({ error: "Missing or wrong session bridge token.", code: "session_bridge_unauthorized" }, 401);
		}
		return null;
	};

	const readJson = async (req: Request): Promise<unknown> => {
		const text = await req.text();
		if (text.length > MAX_EVENT_BODY_BYTES) throw new Error("Request body too large.");
		return text ? JSON.parse(text) : {};
	};

	const noteContact = () => {
		connected = true;
		lastSeen = now();
	};

	const applyStatus = (value: unknown) => {
		if (typeof value === "string" && STATUSES.has(value)) hostStatus = value as SessionBridgeStatus;
	};

	const handlePoll = async (req: Request): Promise<Response> => {
		let body: unknown;
		try {
			body = await readJson(req);
		} catch {
			return json({ error: "Invalid JSON body." }, 400);
		}
		noteContact();
		if (isRecord(body)) {
			applyStatus(body.status);
			if (isRecord(body.modes)) {
				if (typeof body.modes.turn === "boolean") modes.turn = body.modes.turn;
				if (typeof body.modes.transient === "boolean") modes.transient = body.modes.transient;
			}
		}
		if (disposed) return pollReply({ commands: [], closing: true });
		if (hostStatus === "gone") failForGone();

		const requested = isRecord(body) && typeof body.waitMs === "number" && Number.isFinite(body.waitMs) ? body.waitMs : SESSION_BRIDGE_MAX_POLL_MS;
		const waitMs = Math.max(0, Math.min(SESSION_BRIDGE_MAX_POLL_MS, requested));

		// Whoever polls last is the bridge: an older open poll ends now.
		const previous = openPoll;
		if (previous) {
			openPoll = null;
			clearTimeout(previous.timer);
			previous.resolve(pollReply({ commands: [], superseded: true }));
		}

		const commands = takeDueCommands();
		if (commands.length > 0 || waitMs === 0) return pollReply({ commands });

		return await new Promise<Response>((resolve) => {
			const poll: OpenPoll = {
				resolve,
				timer: setTimeout(() => {
					if (openPoll !== poll) return;
					openPoll = null;
					lastSeen = now();
					resolve(pollReply({ commands: takeDueCommands() }));
				}, waitMs),
			};
			openPoll = poll;
			// A host that drops the connection is not "open" any more.
			req.signal?.addEventListener(
				"abort",
				() => {
					if (openPoll !== poll) return;
					openPoll = null;
					clearTimeout(poll.timer);
					lastSeen = now();
					resolve(pollReply({ commands: [] }));
				},
				{ once: true },
			);
		});
	};

	/** Apply one host event. Returns false when it names a question that is not running. */
	const applyEvent = (event: unknown): boolean => {
		if (!isRecord(event) || typeof event.type !== "string") return true;
		if (event.type === "status") {
			applyStatus(event.status);
			if (hostStatus === "gone") failForGone();
			return true;
		}
		if (event.type === "interrupted") {
			const interrupt = pendingInterrupt;
			if (!interrupt || event.interruptId !== interrupt.interruptId) return true;
			pendingInterrupt = null;
			clearTimeout(interrupt.timer);
			if (event.ok === true) interrupt.resolve();
			else interrupt.reject(new Error(typeof event.message === "string" && event.message ? event.message : "The session could not be interrupted."));
			return true;
		}
		const askId = typeof event.askId === "string" ? event.askId : "";
		const ask = active;
		if (!ask || ask.askId !== askId) return false;
		ask.acked = true;
		switch (event.type) {
			case "started":
				return true;
			case "delta":
				if (typeof event.text === "string" && event.text && !ask.cancelled) ask.sink.delta(event.text);
				return true;
			case "tool":
				if (typeof event.name === "string" && event.name && !ask.cancelled) ask.sink.tool?.(event.name);
				return true;
			case "done":
				finishActive(ask);
				if (ask.cancelled) ask.sink.error("aborted");
				else ask.sink.done(typeof event.answer === "string" ? event.answer : "");
				return true;
			case "error": {
				finishActive(ask);
				const code = typeof event.code === "string" && ERROR_CODES.has(event.code) ? (event.code as SessionBridgeErrorCode) : "failed";
				const message = typeof event.message === "string" && event.message ? event.message : undefined;
				ask.sink.error(ask.cancelled ? "aborted" : code, message);
				return true;
			}
			default:
				return true;
		}
	};

	const handleEvent = async (req: Request): Promise<Response> => {
		let body: unknown;
		try {
			body = await readJson(req);
		} catch {
			return json({ error: "Invalid JSON body." }, 400);
		}
		noteContact();
		const events = isRecord(body) && Array.isArray(body.events) ? body.events : [body];
		let ok = true;
		for (const event of events) {
			if (!applyEvent(event)) ok = false;
		}
		// An acknowledgement may have made a cancel due.
		flush();
		return ok ? json({ ok: true }) : json({ ok: false, code: "ask_not_active" }, 409);
	};

	return {
		bridge,
		handle(req) {
			const path = new URL(req.url).pathname;
			if (path !== SESSION_BRIDGE_POLL_PATH && path !== SESSION_BRIDGE_EVENT_PATH) return null;
			if (req.method !== "POST") return Promise.resolve(json({ error: "Method not allowed." }, 405));
			const refused = authorize(req);
			if (refused) return Promise.resolve(refused);
			return path === SESSION_BRIDGE_POLL_PATH ? handlePoll(req) : handleEvent(req);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			const poll = openPoll;
			openPoll = null;
			if (poll) {
				clearTimeout(poll.timer);
				poll.resolve(pollReply({ commands: [], closing: true }));
			}
			failForGone();
		},
	};
}
