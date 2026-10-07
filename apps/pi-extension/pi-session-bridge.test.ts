/**
 * "Ask this session" on Pi: the bridge that turns an Ask AI question into a
 * real turn of the Pi session that opened the browser, driven here by a fake
 * Pi host that emits the same extension events a live session does.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createPiSessionBridgeHub, PLANNOTATOR_ASK_CUSTOM_TYPE } from "./pi-session-bridge.ts";
import {
	SESSION_ASK_HEADER,
	SESSION_ASK_TAKEN_OVER_INTERRUPT_TEXT,
	SESSION_ASK_TAKEN_OVER_TEXT,
	SessionBridgeProvider,
} from "./generated/ai/session-bridge.ts";
import type { AIMessage } from "./generated/ai/types.ts";
import { startAnnotateServer } from "./server/serverAnnotate.ts";

type Handler = (event: any, ctx?: unknown) => unknown;

interface SentMessage {
	message: { customType: string; content: unknown; display: boolean; details?: { askId?: string } };
	options?: { triggerTurn?: boolean; deliverAs?: string };
}

/** A Pi host: one listener table, one session that is idle or streaming. */
function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const sent: SentMessage[] = [];
	let idle = true;
	let alive = true;
	let pending = false;
	const aborts: number[] = [];
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		sendMessage(message: SentMessage["message"], options?: SentMessage["options"]) {
			sent.push({ message, options });
		},
	};
	const ctx = {
		get mode() {
			if (!alive) throw new Error("This extension ctx is stale after session replacement or reload.");
			return "tui";
		},
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		abort: () => {
			aborts.push(Date.now());
		},
	};
	const emit = (event: string, payload: unknown) => {
		for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
	};
	return {
		pi,
		ctx,
		sent,
		aborts,
		emit,
		setIdle: (next: boolean) => { idle = next; },
		setPending: (next: boolean) => { pending = next; },
		kill: () => { alive = false; },
		/** Play the turn Pi runs for a delivered question. */
		startTurn(askId: string) {
			idle = false;
			emit("agent_start", { type: "agent_start" });
			emit("turn_start", { type: "turn_start" });
			emit("message_start", {
				type: "message_start",
				message: { role: "custom", customType: PLANNOTATOR_ASK_CUSTOM_TYPE, details: { askId } },
			});
		},
		assistantText(...deltas: string[]) {
			emit("message_start", { type: "message_start", message: { role: "assistant", content: [] } });
			for (const delta of deltas) {
				emit("message_update", {
					type: "message_update",
					message: { role: "assistant" },
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
				});
			}
		},
		/** The loop finishes one assistant turn (tool results in) and starts the next. */
		nextTurn() {
			emit("turn_end", { type: "turn_end" });
			emit("turn_start", { type: "turn_start" });
		},
		/** One agent run ends; Pi may still retry it before the prompt settles. */
		endRun(stopReason = "stop", errorMessage?: string) {
			emit("agent_end", { type: "agent_end", messages: [{ role: "assistant", stopReason, errorMessage, content: [] }] });
		},
		settle() {
			idle = true;
			emit("agent_settled", { type: "agent_settled" });
		},
		endTurn(stopReason = "stop", errorMessage?: string) {
			this.endRun(stopReason, errorMessage);
			this.settle();
		},
	};
}

function sink() {
	const calls: Array<[string, ...unknown[]]> = [];
	return {
		calls,
		sink: {
			delta: (text: string) => calls.push(["delta", text]),
			tool: (name: string) => calls.push(["tool", name]),
			done: (answer: string) => calls.push(["done", answer]),
			error: (code: string, message?: string) => calls.push(["error", code, message]),
		},
	};
}

describe("Pi session bridge", () => {
	test("status follows the session: ready, busy while streaming or queued, gone once stale", () => {
		const host = fakePi();
		const bridge = createPiSessionBridgeHub(host.pi).createBridge(host.ctx as never, {});
		expect(bridge.status()).toBe("ready");
		host.setIdle(false);
		expect(bridge.status()).toBe("busy");
		host.setIdle(true);
		host.setPending(true);
		expect(bridge.status()).toBe("busy");
		host.kill();
		expect(bridge.status()).toBe("gone");
	});

	test("a question becomes a labelled custom message that triggers a turn, and the turn's text streams back", () => {
		const host = fakePi();
		const bridge = createPiSessionBridgeHub(host.pi).createBridge(host.ctx as never, {});
		const out = sink();
		bridge.ask({ askId: "ask-1", text: "Question text", mode: "turn" }, out.sink, new AbortController().signal);

		expect(host.sent).toHaveLength(1);
		expect(host.sent[0].message.customType).toBe(PLANNOTATOR_ASK_CUSTOM_TYPE);
		expect(host.sent[0].message.content).toBe("Question text");
		expect(host.sent[0].message.display).toBe(true);
		expect(host.sent[0].message.details?.askId).toBe("ask-1");
		expect(host.sent[0].options).toEqual({ triggerTurn: true });

		// Text from another turn before ours started is not ours.
		host.assistantText("unrelated");
		host.startTurn("ask-1");
		host.assistantText("Because ", "of X.");
		host.emit("tool_execution_start", { type: "tool_execution_start", toolName: "read" });
		host.assistantText("Done.");
		host.endTurn();

		expect(out.calls).toEqual([
			["delta", "Because "],
			["delta", "of X."],
			["tool", "read"],
			["delta", "\n\nDone."],
			["done", "Because of X.\n\nDone."],
		]);
	});

	test("stopping our running turn aborts it; stopping before it started does not touch the session", () => {
		const running = fakePi();
		const bridge = createPiSessionBridgeHub(running.pi).createBridge(running.ctx as never, {});
		const controller = new AbortController();
		bridge.ask({ askId: "a", text: "t", mode: "turn" }, sink().sink, controller.signal);
		running.startTurn("a");
		controller.abort();
		expect(running.aborts).toHaveLength(1);

		const queued = fakePi();
		const hub = createPiSessionBridgeHub(queued.pi);
		const queuedBridge = hub.createBridge(queued.ctx as never, {});
		const early = new AbortController();
		queuedBridge.ask({ askId: "b", text: "t", mode: "turn" }, sink().sink, early.signal);
		early.abort();
		expect(queued.aborts).toHaveLength(0);
		expect(hub.hasActiveAsk).toBe(false);
	});

	test("a turn stopped in Pi itself, or failing, reports an error rather than an answer", () => {
		const host = fakePi();
		const bridge = createPiSessionBridgeHub(host.pi).createBridge(host.ctx as never, {});
		const stopped = sink();
		bridge.ask({ askId: "a", text: "t", mode: "turn" }, stopped.sink, new AbortController().signal);
		host.startTurn("a");
		host.endTurn("aborted");
		expect(stopped.calls.at(-1)?.slice(0, 2)).toEqual(["error", "failed"]);

		const failed = sink();
		bridge.ask({ askId: "b", text: "t", mode: "turn" }, failed.sink, new AbortController().signal);
		host.startTurn("b");
		host.endTurn("error", "rate limited");
		expect(failed.calls.at(-1)).toEqual(["error", "failed", "rate limited"]);
	});

	test("an error that Pi retries is not reported: the retried answer streams", () => {
		const host = fakePi();
		const hub = createPiSessionBridgeHub(host.pi);
		const bridge = hub.createBridge(host.ctx as never, {});
		const out = sink();
		bridge.ask({ askId: "a", text: "t", mode: "turn" }, out.sink, new AbortController().signal);
		host.startTurn("a");
		// The first attempt fails (overloaded) and Pi auto-retries inside the same prompt.
		host.assistantText();
		host.endRun("error", "overloaded");
		expect(out.calls).toEqual([]);
		host.assistantText("Retried answer.");
		host.endTurn();
		expect(out.calls).toEqual([
			["delta", "Retried answer."],
			["done", "Retried answer."],
		]);
		expect(hub.hasActiveAsk).toBe(false);
	});

	test("an error end on a Pi without agent_settled is reported once the session goes idle", async () => {
		const host = fakePi();
		const hub = createPiSessionBridgeHub(host.pi);
		const bridge = hub.createBridge(host.ctx as never, {});
		const out = sink();
		bridge.ask({ askId: "a", text: "t", mode: "turn" }, out.sink, new AbortController().signal);
		host.startTurn("a");
		host.endRun("error", "bad request");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(out.calls).toEqual([]);
		host.setIdle(true);
		for (let i = 0; i < 40 && out.calls.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 25));
		expect(out.calls).toEqual([["error", "failed", "bad request"]]);
		expect(hub.hasActiveAsk).toBe(false);
	});

	test("a question Pi never starts fails once the session is idle, however long it was busy", async () => {
		const host = fakePi();
		const hub = createPiSessionBridgeHub(host.pi, { startWatchdogMs: 20 });
		const bridge = hub.createBridge(host.ctx as never, {});
		const out = sink();
		// Pi is busy (the question was steered into a running turn) past the first check.
		host.setIdle(false);
		bridge.ask({ askId: "a", text: "t", mode: "turn" }, out.sink, new AbortController().signal);
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(out.calls).toEqual([]);
		// The turn ends without ever reading it (e.g. the user aborted it in Pi).
		host.setIdle(true);
		for (let i = 0; i < 40 && out.calls.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
		expect(out.calls.map((call) => call.slice(0, 2))).toEqual([["error", "failed"]]);
		expect(hub.hasActiveAsk).toBe(false);
	});

	test("session shutdown mid-answer reports gone, and a second question while one runs is refused", () => {
		const host = fakePi();
		const bridge = createPiSessionBridgeHub(host.pi).createBridge(host.ctx as never, {});
		const first = sink();
		bridge.ask({ askId: "a", text: "t", mode: "turn" }, first.sink, new AbortController().signal);
		const second = sink();
		bridge.ask({ askId: "b", text: "t", mode: "turn" }, second.sink, new AbortController().signal);
		expect(second.calls[0]?.slice(0, 2)).toEqual(["error", "busy"]);
		expect(host.sent).toHaveLength(1);

		host.startTurn("a");
		host.emit("session_shutdown", { type: "session_shutdown", reason: "new" });
		expect(first.calls.at(-1)?.slice(0, 2)).toEqual(["error", "gone"]);
	});

	// The failure these guard: the person typed into Pi while it answered the
	// reviewer's question, and the reply to THEIR prompt streamed into
	// Plannotator as the answer, and a Plannotator Stop aborted their work.
	test("a message the person steers into our run takes it over: streaming stops, Stop and interrupt leave the run alone", () => {
		const host = fakePi();
		const bridge = createPiSessionBridgeHub(host.pi).createBridge(host.ctx as never, {});
		const out = sink();
		const controller = new AbortController();
		bridge.ask({ askId: "ask-1", text: "Question text", mode: "turn" }, out.sink, controller.signal);
		host.startTurn("ask-1");
		host.assistantText("Because ");
		// The person steers; the loop delivers it right after the next turn_start.
		host.nextTurn();
		host.emit("message_start", { type: "message_start", message: { role: "user", content: "also fix the tests" } });
		host.assistantText("Fixed the tests.");

		expect(out.calls).toEqual([
			["delta", "Because "],
			["error", "taken_over", undefined],
		]);
		controller.abort();
		expect(host.aborts).toHaveLength(0);
		expect(() => bridge.interrupt?.()).toThrow(SESSION_ASK_TAKEN_OVER_INTERRUPT_TEXT);
		expect(host.aborts).toHaveLength(0);

		// Once that run ends, interrupting the session works again.
		host.endTurn();
		host.setIdle(false);
		void bridge.interrupt?.();
		expect(host.aborts).toHaveLength(1);
	});

	test("a triggering custom message from another extension, steered into our run, takes it over", () => {
		const host = fakePi();
		const bridge = createPiSessionBridgeHub(host.pi).createBridge(host.ctx as never, {});
		const out = sink();
		bridge.ask({ askId: "ask-1", text: "Question text", mode: "turn" }, out.sink, new AbortController().signal);
		host.startTurn("ask-1");
		host.assistantText("Because ");
		host.nextTurn();
		host.emit("message_start", { type: "message_start", message: { role: "custom", customType: "other-ext", details: {} } });
		expect(out.calls.at(-1)).toEqual(["error", "taken_over", undefined]);
	});

	// The failure this guards: Plannotator's own decision follow-up (or any
	// follow-up) arriving after the answer had finished turned a complete
	// answer into a "taken over" one.
	test("a follow-up arriving after the answer finished settles the answer as done", () => {
		const host = fakePi();
		const bridge = createPiSessionBridgeHub(host.pi).createBridge(host.ctx as never, {});
		const out = sink();
		bridge.ask({ askId: "ask-1", text: "Question text", mode: "turn" }, out.sink, new AbortController().signal);
		host.startTurn("ask-1");
		host.assistantText("Done.");
		// The answer's last turn: a stop with no tool call. The loop then pulls a follow-up.
		host.emit("turn_end", { type: "turn_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text" }] }, toolResults: [] });
		host.emit("turn_start", { type: "turn_start" });
		host.emit("message_start", { type: "message_start", message: { role: "user", content: "plan approved" } });
		host.assistantText("Implementing.");
		expect(out.calls).toEqual([
			["delta", "Done."],
			["done", "Done."],
		]);
	});

	test("a turn that called tools before the steer is not a finished answer", () => {
		const host = fakePi();
		const bridge = createPiSessionBridgeHub(host.pi).createBridge(host.ctx as never, {});
		const out = sink();
		bridge.ask({ askId: "ask-1", text: "Question text", mode: "turn" }, out.sink, new AbortController().signal);
		host.startTurn("ask-1");
		host.assistantText("Let me look.");
		host.emit("turn_end", { type: "turn_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall" }] }, toolResults: [{}] });
		host.emit("turn_start", { type: "turn_start" });
		host.emit("message_start", { type: "message_start", message: { role: "user", content: "stop" } });
		expect(out.calls.at(-1)).toEqual(["error", "taken_over", undefined]);
	});

	test("the taken-over run stays protected across an error retry until it settles", () => {
		const host = fakePi();
		const bridge = createPiSessionBridgeHub(host.pi).createBridge(host.ctx as never, {});
		bridge.ask({ askId: "ask-1", text: "Question text", mode: "turn" }, sink().sink, new AbortController().signal);
		host.startTurn("ask-1");
		host.assistantText("Because ");
		host.nextTurn();
		host.emit("message_start", { type: "message_start", message: { role: "user", content: "also fix the tests" } });
		// The person's run errors; Pi retries it (agent.continue) before settling.
		host.endRun("error", "overloaded");
		expect(() => bridge.interrupt?.()).toThrow(SESSION_ASK_TAKEN_OVER_INTERRUPT_TEXT);
		host.emit("agent_start", { type: "agent_start" });
		expect(() => bridge.interrupt?.()).toThrow(SESSION_ASK_TAKEN_OVER_INTERRUPT_TEXT);
		host.endRun();
		host.settle();
		host.setIdle(false);
		void bridge.interrupt?.();
		expect(host.aborts).toHaveLength(1);
	});

	test("a display-only custom message appended at turn_end is not a take-over", () => {
		const host = fakePi();
		const bridge = createPiSessionBridgeHub(host.pi).createBridge(host.ctx as never, {});
		const out = sink();
		bridge.ask({ askId: "ask-1", text: "Question text", mode: "turn" }, out.sink, new AbortController().signal);
		host.startTurn("ask-1");
		host.assistantText("Because ");
		// Pi appends a non-triggering custom message (e.g. plannotator-handoff)
		// while handling turn_end, before the next turn_start.
		host.emit("turn_end", { type: "turn_end" });
		host.emit("message_start", { type: "message_start", message: { role: "custom", customType: "plannotator-handoff", details: {} } });
		host.emit("turn_start", { type: "turn_start" });
		host.assistantText("of X.");
		host.endTurn();
		expect(out.calls).toEqual([
			["delta", "Because "],
			["delta", "\n\nof X."],
			["done", "Because \n\nof X."],
		]);
	});

	test("through the provider: a take-over keeps the partial answer and ends with the note", async () => {
		const host = fakePi();
		const bridge = createPiSessionBridgeHub(host.pi).createBridge(host.ctx as never, {});
		const provider = new SessionBridgeProvider(bridge, { pollIntervalMs: 5 });
		const session = await provider.createSession({
			context: { mode: "annotate", annotate: { content: "", filePath: "last-message" } },
		});
		const messages: AIMessage[] = [];
		const done = (async () => {
			for await (const message of session.query("What did you mean?")) messages.push(message);
		})();
		while (host.sent.length === 0) await new Promise((resolve) => setTimeout(resolve, 2));
		host.startTurn(host.sent[0].message.details!.askId!);
		host.assistantText("I meant ");
		host.nextTurn();
		host.emit("message_start", { type: "message_start", message: { role: "user", content: "never mind" } });
		await done;
		expect(messages).toEqual([
			{ type: "text_delta", delta: "I meant " },
			{ type: "error", code: "session_taken_over", error: SESSION_ASK_TAKEN_OVER_TEXT },
		]);
	});

	test("interrupt stops the session's own turn", () => {
		const host = fakePi();
		const bridge = createPiSessionBridgeHub(host.pi).createBridge(host.ctx as never, {});
		host.setIdle(false);
		void bridge.interrupt?.();
		expect(host.aborts).toHaveLength(1);
	});

	test("through the provider: a busy session waits, then the answer streams", async () => {
		const host = fakePi();
		const bridge = createPiSessionBridgeHub(host.pi).createBridge(host.ctx as never, {});
		const provider = new SessionBridgeProvider(bridge, { pollIntervalMs: 5 });
		const session = await provider.createSession({
			context: { mode: "annotate", annotate: { content: "", filePath: "last-message" } },
		});
		host.setIdle(false);
		const messages: AIMessage[] = [];
		const done = (async () => {
			for await (const message of session.query("What did you mean?", { busyPolicy: "wait" })) messages.push(message);
		})();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(host.sent).toHaveLength(0);
		host.setIdle(true);
		while (host.sent.length === 0) await new Promise((resolve) => setTimeout(resolve, 2));
		const text = host.sent[0].message.content as string;
		expect(text.startsWith(SESSION_ASK_HEADER)).toBe(true);
		expect(text).toContain("your last message");
		host.startTurn(host.sent[0].message.details!.askId!);
		host.assistantText("I meant Y.");
		host.endTurn();
		await done;
		expect(messages.map((m) => m.type)).toEqual(["status", "status", "text_delta", "result"]);
	});
});

describe("Pi annotate server with Ask this session", () => {
	let dir: string;
	const saved: Record<string, string | undefined> = {};
	const keys = ["PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_ANNOTATE_HISTORY", "PLANNOTATOR_AI", "PLANNOTATOR_DATA_DIR"];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pn-pi-session-ask-"));
		for (const key of keys) saved[key] = process.env[key];
		delete process.env.PLANNOTATOR_PORT;
		delete process.env.PLANNOTATOR_AI;
		process.env.PLANNOTATOR_REMOTE = "0";
		process.env.PLANNOTATOR_ANNOTATE_HISTORY = "0";
		process.env.PLANNOTATOR_DATA_DIR = join(dir, "data");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		for (const key of keys) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	});

	test("serves the bridge on /api/ai/*, streams a real turn, and leaves the turn alone on shutdown", async () => {
		const host = fakePi();
		const bridge = createPiSessionBridgeHub(host.pi).createBridge(host.ctx as never, {});
		const file = join(dir, "notes.md");
		writeFileSync(file, "# Notes\n", "utf-8");
		const server = await startAnnotateServer({
			markdown: "# Notes\n",
			filePath: file,
			htmlContent: "<html></html>",
			sessionBridge: bridge,
		});
		try {
			const caps = await (await fetch(`${server.url}/api/ai/capabilities`)).json() as {
				providers: Array<{ id: string; label?: string; sessionBridge?: { host: string; status: string } }>;
			};
			const offered = caps.providers.find((p) => p.sessionBridge);
			expect(offered?.label).toBe("Ask this session · Pi");
			expect(offered?.sessionBridge).toEqual(expect.objectContaining({ host: "pi", status: "ready" }));

			const { sessionId } = await (await fetch(`${server.url}/api/ai/session`, {
				method: "POST",
				body: JSON.stringify({
					providerId: offered!.id,
					context: { mode: "annotate", annotate: { content: "# Notes\n", filePath: file } },
				}),
			})).json() as { sessionId: string };

			// Same socket, foreign Host header. Refused before the question
			// reaches the session: by the server-wide Host allowlist for a
			// foreign name, and by the bridge's own loopback-and-port check for
			// a loopback name carrying another port.
			const port = Number(new URL(server.url).port);
			const askWithHost = (hostHeader: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
				const req = httpRequest(
					{ host: "127.0.0.1", port, method: "POST", path: "/api/ai/query", headers: { host: hostHeader, "content-type": "application/json" } },
					(res) => {
						let body = "";
						res.on("data", (chunk) => { body += chunk; });
						res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
					},
				);
				req.on("error", reject);
				req.end(JSON.stringify({ sessionId, prompt: "injected" }));
			});
			const rebound = await askWithHost(`evil.example:${port}`);
			expect(rebound.status).toBe(403);
			expect(rebound.body).toContain("PLANNOTATOR_ALLOWED_HOSTS");
			const otherPort = await askWithHost(`localhost:${port + 1}`);
			expect(otherPort.status).toBe(403);
			expect(otherPort.body).toContain("session_bridge_forbidden_host");
			expect(host.sent).toHaveLength(0);

			// Node flushes SSE headers with the first chunk, so drive the turn before awaiting.
			const response = fetch(`${server.url}/api/ai/query`, {
				method: "POST",
				body: JSON.stringify({ sessionId, prompt: "Is the title right?" }),
			});
			while (host.sent.length === 0) await new Promise((resolve) => setTimeout(resolve, 2));
			expect(host.sent[0].message.content).toContain(file);
			host.startTurn(host.sent[0].message.details!.askId!);
			host.assistantText("Yes.");
			host.endTurn();
			const body = await (await response).text();
			expect(body).toContain('"delta":"Yes."');
			expect(body).toContain('"type":"result"');

			// A second question still running when the reviewer decides: the
			// server goes away, but the session's turn is not killed.
			const pending = fetch(`${server.url}/api/ai/query`, {
				method: "POST",
				body: JSON.stringify({ sessionId, prompt: "And the rest?" }),
			}).then((r) => r.text()).catch(() => "");
			while (host.sent.length === 1) await new Promise((resolve) => setTimeout(resolve, 2));
			host.startTurn(host.sent[1].message.details!.askId!);
			server.stop();
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(host.aborts).toHaveLength(0);
			host.endTurn();
			await pending;
		} finally {
			server.stop();
		}
	});
});
