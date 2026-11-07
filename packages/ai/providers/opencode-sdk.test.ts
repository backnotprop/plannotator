/**
 * Guards for the opencode-serve orphan leak:
 *
 * 1. The provider must spawn its OWN server on an OS-assigned port (port 0),
 *    never share a fixed default port. A shared port made every Plannotator
 *    process attach to the first server spawned; interrupted sessions orphaned
 *    it and later sessions piled unevictable per-directory instances into it.
 * 2. A process "exit" handler must close the spawned server (the CLI routes
 *    SIGINT/SIGTERM through process.exit, so this is what covers Ctrl-C), and
 *    dispose must both close the server and remove that handler.
 * 3. A failure AFTER the spawn (client construction) must reap the child and
 *    remove the handler so a retry cannot strand the first server.
 * 4. dispose() during an in-flight spawn must not resurrect the provider: the
 *    completing spawn reaps its own server and the start rejects.
 * 5. Neither runtime's AI setup may call the provider's fetchModels eagerly at
 *    startup — it spawns `opencode serve`, so it must stay behind the deferred
 *    provider initializer (?activate= / first session), like Codex.
 *
 * The SDK is mocked before the provider import so no real `opencode serve` is
 * ever spawned. bun runs all test files in one process, so the module mock
 * leaks process-wide; that is safe (and desirable) here because this provider
 * is the only consumer of @opencode-ai/sdk and no test may spawn a real
 * server.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface FakeSpawn {
	hostname?: string;
	port?: number;
	timeout?: number;
	closed: boolean;
	/** The switches process.env held when the SDK was called (it copies process.env into the spawn there). */
	env: Record<string, string | undefined>;
}

let spawned: FakeSpawn[] = [];
let clientFactory: () => unknown = () => ({});
let spawnGate: Promise<void> | null = null;
let serverError: Error | null = null;

mock.module("@opencode-ai/sdk", () => ({
	createOpencodeServer: async (opts: {
		hostname?: string;
		port?: number;
		timeout?: number;
	}) => {
		if (serverError) throw serverError;
		const record: FakeSpawn = {
			...opts,
			closed: false,
			env: {
				PLANNOTATOR_ASK_AI_CHILD: process.env.PLANNOTATOR_ASK_AI_CHILD,
				PLANNOTATOR_INBOX_TOOL: process.env.PLANNOTATOR_INBOX_TOOL,
				PLANNOTATOR_AGENT_TOOL: process.env.PLANNOTATOR_AGENT_TOOL,
			},
		};
		spawned.push(record);
		if (spawnGate) await spawnGate;
		return {
			url: "http://127.0.0.1:54321",
			close: () => {
				record.closed = true;
			},
		};
	},
	createOpencodeClient: () => clientFactory(),
}));

const { OpenCodeProvider } = await import("./opencode-sdk.ts");

function makeProvider(port?: number) {
	return new OpenCodeProvider({
		type: "opencode-sdk",
		...(port != null && { port }),
	});
}

beforeEach(() => {
	spawned = [];
	clientFactory = () => ({});
	spawnGate = null;
	serverError = null;
});

describe("OpenCodeProvider server lifecycle", () => {
	test("spawns on an OS-assigned port and cleans up on dispose", async () => {
		const provider = makeProvider();
		const listenersBefore = process.listeners("exit").length;

		await provider.ensureServer();

		expect(spawned.length).toBe(1);
		// port 0 = OS-assigned free port. A fixed default here reintroduces the
		// shared-server pile-up.
		expect(spawned[0]!.port).toBe(0);
		expect(process.listeners("exit").length).toBe(listenersBefore + 1);

		provider.dispose();
		expect(spawned[0]!.closed).toBe(true);
		expect(process.listeners("exit").length).toBe(listenersBefore);
	});

	test("the exit handler closes the spawned server", async () => {
		const provider = makeProvider();
		const before = new Set(process.listeners("exit"));
		await provider.ensureServer();
		const added = process.listeners("exit").filter((l) => !before.has(l));
		expect(added.length).toBe(1);

		// Simulate the process exiting without a clean dispose (Ctrl-C routes
		// through process.exit, which runs "exit" listeners).
		(added[0] as () => void)();
		expect(spawned[0]!.closed).toBe(true);

		provider.dispose();
	});

	test("`opencode serve` starts with Plannotator's integration off, and the host's own env is untouched", async () => {
		const saved = process.env.PLANNOTATOR_INBOX_TOOL;
		// The person turned the Inbox tool on for their own sessions.
		process.env.PLANNOTATOR_INBOX_TOOL = "1";
		try {
			const provider = makeProvider();
			await provider.ensureServer();
			expect(spawned[0]!.env).toEqual({ PLANNOTATOR_ASK_AI_CHILD: "1", PLANNOTATOR_INBOX_TOOL: "0", PLANNOTATOR_AGENT_TOOL: "0" });
			expect(process.env.PLANNOTATOR_INBOX_TOOL).toBe("1");
			expect(process.env.PLANNOTATOR_ASK_AI_CHILD).toBeUndefined();
			provider.dispose();
		} finally {
			if (saved === undefined) delete process.env.PLANNOTATOR_INBOX_TOOL;
			else process.env.PLANNOTATOR_INBOX_TOOL = saved;
		}
	});

	test("honors an explicitly configured port verbatim", async () => {
		const provider = makeProvider(5555);
		await provider.ensureServer();
		expect(spawned[0]!.port).toBe(5555);
		provider.dispose();
	});

	test("a post-spawn failure reaps the child; a retry cannot strand it", async () => {
		const provider = makeProvider();
		const listenersBefore = process.listeners("exit").length;
		let calls = 0;
		clientFactory = () => {
			calls++;
			if (calls === 1) throw new Error("client construction failed");
			return {};
		};

		await expect(provider.ensureServer()).rejects.toThrow(
			"client construction failed",
		);
		// The first spawn must be closed and its exit handler removed — a
		// leaked handler here would keep a dead server's closure registered
		// forever, and a leaked server is the orphan class this fix exists
		// to kill.
		expect(spawned.length).toBe(1);
		expect(spawned[0]!.closed).toBe(true);
		expect(process.listeners("exit").length).toBe(listenersBefore);

		// The retry starts clean: one fresh spawn, one handler.
		await provider.ensureServer();
		expect(spawned.length).toBe(2);
		expect(spawned[1]!.closed).toBe(false);
		expect(process.listeners("exit").length).toBe(listenersBefore + 1);

		provider.dispose();
		expect(spawned[1]!.closed).toBe(true);
		expect(process.listeners("exit").length).toBe(listenersBefore);
	});

	test("dispose during an in-flight spawn reaps instead of resurrecting", async () => {
		const provider = makeProvider();
		const listenersBefore = process.listeners("exit").length;
		let openGate: () => void = () => {};
		spawnGate = new Promise<void>((r) => {
			openGate = r;
		});

		const inFlight = provider.ensureServer();
		// Let doStart enter createOpencodeServer before disposing.
		await Bun.sleep(0);
		expect(spawned.length).toBe(1);

		provider.dispose();
		openGate();

		await expect(inFlight).rejects.toThrow("disposed during startup");
		// The late-completing spawn must reap its own server and leave no
		// handler behind — a disposed provider must never hold a live child.
		expect(spawned[0]!.closed).toBe(true);
		expect(process.listeners("exit").length).toBe(listenersBefore);

		// The provider is still usable afterwards: a fresh start respawns.
		spawnGate = null;
		await provider.ensureServer();
		expect(spawned.length).toBe(2);
		expect(spawned[1]!.closed).toBe(false);
		provider.dispose();
		expect(spawned[1]!.closed).toBe(true);
	});

	test("surfaces a friendly error when opencode is not on PATH (ENOENT)", async () => {
		const provider = makeProvider();
		const listenersBefore = process.listeners("exit").length;

		const enoent = Object.assign(new Error("spawn opencode ENOENT"), {
			code: "ENOENT",
		});
		serverError = enoent;

		const failure = await provider.ensureServer().then(
			() => null,
			(err: unknown) => err as Error,
		);
		expect(failure?.message).toContain("not found on PATH");
		expect(failure?.cause).toBe(enoent);

		// Must not register an exit handler when spawn fails before completion
		expect(process.listeners("exit").length).toBe(listenersBefore);

		// Provider recovers cleanly when CLI becomes available
		serverError = null;
		await provider.ensureServer();
		expect(spawned.length).toBe(1);
		expect(spawned[0]!.closed).toBe(false);
		expect(process.listeners("exit").length).toBe(listenersBefore + 1);

		provider.dispose();
		expect(spawned[0]!.closed).toBe(true);
		expect(process.listeners("exit").length).toBe(listenersBefore);
	});

	test("passes other startup failures through unchanged", async () => {
		const provider = makeProvider();
		// The SDK's exit failure embeds the child's stderr; "not found" there
		// is not a missing binary and must not be rewritten as one.
		const exited = new Error(
			"Server exited with code 1\nServer output: Error: model not found",
		);
		serverError = exited;

		await expect(provider.ensureServer()).rejects.toBe(exited);
	});
});

describe("no eager opencode spawn at runtime startup", () => {
	const repoRoot = resolve(import.meta.dir, "../../..");

	// Both runtimes must keep opencode model discovery behind the deferred
	// provider initializer. An eager fetchModels() at startup spawns
	// `opencode serve` on every session for every user with opencode on PATH.
	for (const relPath of [
		"packages/server/ai-runtime.ts",
		"apps/pi-extension/server/ai-runtime.ts",
	]) {
		test(`${relPath} defers opencode model discovery`, () => {
			const src = readFileSync(resolve(repoRoot, relPath), "utf8");
			const start = src.indexOf('"opencode-sdk"');
			expect(start).toBeGreaterThan(-1);
			const end = src.indexOf("OpenCode not available", start);
			expect(end).toBeGreaterThan(start);
			const block = src.slice(start, end);
			expect(block).toContain("deferModelDiscovery(providerId, provider)");
			expect(block).not.toContain("modelDiscovery.push");
		});
	}
});

/**
 * Ask AI subscribes to OpenCode's events and waits for the first frame before
 * it sends the question, so a short turn cannot finish before anyone listens.
 * What regresses if this fails: a stream that never sends a frame (the SDK
 * retries a refused connection forever) leaves Ask AI hanging with no answer
 * and no error; or the question is sent before the stream is live.
 */
describe("OpenCode Ask AI event stream", () => {
	type Event = { type: string; properties: Record<string, unknown> };

	/** A stream that yields queued events and ends when its signal aborts. */
	function fakeStream(signal: AbortSignal) {
		const queue: Event[] = [];
		let wake: (() => void) | null = null;
		const push = (event: Event) => {
			queue.push(event);
			wake?.();
		};
		signal.addEventListener("abort", () => wake?.(), { once: true });
		const stream = (async function* () {
			while (!signal.aborted) {
				const event = queue.shift();
				if (event) {
					yield event;
					continue;
				}
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
				wake = null;
			}
		})();
		return { stream, push };
	}

	function fakeClient(onSubscribe: (push: (event: Event) => void) => void) {
		const log: string[] = [];
		const signals: AbortSignal[] = [];
		let push: (event: Event) => void = () => {};
		const client = {
			session: {
				create: async () => ({ data: { id: "oc_1" } }),
				abort: async () => ({}),
				promptAsync: async () => {
					log.push("prompt");
					push({ type: "message.part.delta", properties: { sessionID: "oc_1", field: "text", delta: "pong" } });
					push({ type: "session.status", properties: { sessionID: "oc_1", status: { type: "idle" } } });
					return {};
				},
			},
			event: {
				// The v1 client's shape: one options object.
				subscribe: async (options: { signal: AbortSignal }) => {
					log.push("subscribe");
					signals.push(options.signal);
					const made = fakeStream(options.signal);
					push = (event) => {
						log.push(`event:${event.type}`);
						made.push(event);
					};
					onSubscribe(push);
					return { stream: made.stream };
				},
			},
		};
		return { client, log, signals };
	}

	async function ask(client: unknown, timeoutMs = 10_000, onSession?: (session: { abort(): void }) => void) {
		clientFactory = () => client;
		const provider = new OpenCodeProvider({ type: "opencode-sdk", firstEventTimeoutMs: timeoutMs });
		const session = await provider.createSession({ context: { mode: "plan-review", plan: { plan: "# Plan" } } } as never);
		onSession?.(session);
		const messages: Array<Record<string, unknown>> = [];
		for await (const message of session.query("ping")) messages.push(message as Record<string, unknown>);
		provider.dispose();
		return messages;
	}

	test("sends the question only after the first frame, then streams the answer", async () => {
		const { client, log, signals } = fakeClient((push) => {
			setTimeout(() => push({ type: "server.connected", properties: {} }), 20);
		});
		const messages = await ask(client);
		expect(log.slice(0, 3)).toEqual(["subscribe", "event:server.connected", "prompt"]);
		expect(messages).toEqual([
			{ type: "text_delta", delta: "pong" },
			{ type: "result", sessionId: "oc_1", success: true },
		]);
		expect(signals[0]!.aborted).toBe(true);
	});

	test("a stream that never sends a frame ends with an error and no question sent", async () => {
		const { client, log, signals } = fakeClient(() => {});
		const started = Date.now();
		const messages = await ask(client, 50);
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(log).toEqual(["subscribe"]);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({ type: "error", code: "provider_error" });
		expect(String(messages[0]!.error)).toContain("did not connect");
		// The subscription is closed, not left retrying in the background.
		expect(signals[0]!.aborted).toBe(true);
	});

	test("Stop while waiting for the first frame ends the query at once", async () => {
		const { client, log } = fakeClient(() => {});
		const messages = await ask(client, 10_000, (session) => {
			setTimeout(() => session.abort(), 20);
		});
		expect(log).toEqual(["subscribe"]);
		expect(messages).toEqual([{ type: "error", error: "OpenCode query aborted.", code: "provider_error" }]);
	});
});

/**
 * The same three cases through the REAL v1 client against a local SSE server
 * standing in for `opencode serve`. What regresses if this fails: the signal
 * never reaches the client's stream (a wrong call shape is silently ignored),
 * so a timed-out or finished question leaves its /event connection open, and a
 * refused one is retried forever in the background.
 */
describe("OpenCode Ask AI event stream through the real client", async () => {
	const { createOpencodeClient } = await import("@opencode-ai/sdk/client");
	const encoder = new TextEncoder();

	type Mode = "silent" | "answers" | "connects";
	function fakeOpencodeServe(mode: Mode) {
		const events: Array<{ opened: number; closed: number | null }> = [];
		let send: ((event: unknown) => void) | null = null;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/session" && req.method === "POST") {
					return Response.json({ id: "oc_real", title: "t", version: "1", time: { created: 0, updated: 0 } });
				}
				if (url.pathname.endsWith("/prompt_async")) {
					if (mode === "answers") {
						setTimeout(() => {
							send?.({ type: "message.part.delta", properties: { sessionID: "oc_real", field: "text", delta: "pong" } });
							send?.({ type: "session.status", properties: { sessionID: "oc_real", status: { type: "idle" } } });
						}, 10);
					}
					return new Response(null, { status: 204 });
				}
				if (url.pathname.endsWith("/abort")) return Response.json(true);
				if (url.pathname === "/event") {
					const record = { opened: Date.now(), closed: null as number | null };
					events.push(record);
					req.signal.addEventListener("abort", () => {
						record.closed = Date.now();
					});
					const body = new ReadableStream<Uint8Array>({
						start(controller) {
							send = (event) => {
								try {
									controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
								} catch {}
							};
							if (mode !== "silent") send({ type: "server.connected", properties: {} });
						},
						cancel() {
							record.closed ??= Date.now();
						},
					});
					return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
				}
				return new Response("not found", { status: 404 });
			},
		});
		return { url: `http://127.0.0.1:${server.port}`, events, stop: () => server.stop(true) };
	}

	async function askReal(serve: ReturnType<typeof fakeOpencodeServe>, timeoutMs: number, stopAfterMs?: number) {
		clientFactory = () => createOpencodeClient({ baseUrl: serve.url });
		const provider = new OpenCodeProvider({ type: "opencode-sdk", firstEventTimeoutMs: timeoutMs });
		const session = await provider.createSession({ context: { mode: "plan-review", plan: { plan: "# Plan" } } } as never);
		if (stopAfterMs != null) setTimeout(() => session.abort(), stopAfterMs);
		const messages: Array<Record<string, unknown>> = [];
		for await (const message of session.query("ping")) messages.push(message as Record<string, unknown>);
		provider.dispose();
		return messages;
	}

	async function closedSoon(serve: ReturnType<typeof fakeOpencodeServe>): Promise<boolean> {
		for (let i = 0; i < 50 && serve.events.some((e) => e.closed === null); i++) await Bun.sleep(10);
		return serve.events.length > 0 && serve.events.every((e) => e.closed !== null);
	}

	test("a stream that never sends a frame is closed on the timeout", async () => {
		const serve = fakeOpencodeServe("silent");
		try {
			const messages = await askReal(serve, 100);
			expect(String(messages[0]?.error)).toContain("did not connect");
			expect(await closedSoon(serve)).toBe(true);
			expect(serve.events).toHaveLength(1);
		} finally {
			serve.stop();
		}
	});

	test("the stream is closed once the answer is complete", async () => {
		const serve = fakeOpencodeServe("answers");
		try {
			const messages = await askReal(serve, 5_000);
			expect(messages).toEqual([
				{ type: "text_delta", delta: "pong" },
				{ type: "result", sessionId: "oc_real", success: true },
			]);
			expect(await closedSoon(serve)).toBe(true);
		} finally {
			serve.stop();
		}
	});

	test("Stop while waiting for the next event ends the query at once and closes the stream", async () => {
		const serve = fakeOpencodeServe("connects");
		try {
			const started = Date.now();
			const messages = await askReal(serve, 5_000, 100);
			expect(Date.now() - started).toBeLessThan(1_000);
			expect(messages).toEqual([{ type: "error", error: "OpenCode query aborted.", code: "provider_error" }]);
			expect(await closedSoon(serve)).toBe(true);
		} finally {
			serve.stop();
		}
	});
});
