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
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
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
const legacyInfo = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } }) });
afterAll(() => legacyInfo.stop(true));
let serverUrl = legacyInfo.url.origin;
let clientConfig: { headers?: Record<string, string> } = {};

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
				OPENCODE_SERVER_USERNAME: process.env.OPENCODE_SERVER_USERNAME,
				OPENCODE_PASSWORD: process.env.OPENCODE_PASSWORD,
				OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD,
				PLANNOTATOR_ASK_AI_CHILD: process.env.PLANNOTATOR_ASK_AI_CHILD,
				PLANNOTATOR_INBOX_TOOL: process.env.PLANNOTATOR_INBOX_TOOL,
				PLANNOTATOR_AGENT_TOOL: process.env.PLANNOTATOR_AGENT_TOOL,
			},
		};
		spawned.push(record);
		if (spawnGate) await spawnGate;
		return {
			url: serverUrl,
			close: () => {
				record.closed = true;
			},
		};
	},
	createOpencodeClient: (config: typeof clientConfig) => {
		clientConfig = config;
		return clientFactory();
	},
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
	serverUrl = legacyInfo.url.origin;
});

const CREDENTIALS = ["OPENCODE_SERVER_USERNAME", "OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD"] as const;
/** Clears the credential names for a test and puts the runner's own values back after it. */
function saveCredentials() {
	const saved = CREDENTIALS.map((name) => [name, process.env[name]] as const);
	for (const name of CREDENTIALS) delete process.env[name];
	return {
		restore() {
			for (const [name, value] of saved) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		},
	};
}

describe("OpenCode protocol detection and authentication", () => {
	test("temporary credentials are removed even when spawn fails", async () => {
		const saved = saveCredentials();
		const provider = makeProvider();
		try {
			serverError = new Error("spawn failed");
			await expect(provider.ensureServer()).rejects.toThrow("spawn failed");
			for (const name of CREDENTIALS) expect(process.env[name]).toBeUndefined();
			serverError = null;
			await provider.ensureServer();
			for (const name of CREDENTIALS) expect(process.env[name]).toBeUndefined();
		} finally {
			provider.dispose();
			saved.restore();
		}
	});

	test("the spawn gets a fresh password, the v1 client authenticates, and the host env is restored", async () => {
		const saved = saveCredentials();
		process.env.OPENCODE_SERVER_USERNAME = "personal";
		process.env.OPENCODE_PASSWORD = "personal-current";
		process.env.OPENCODE_SERVER_PASSWORD = "personal-password";
		const provider = makeProvider();
		try {
			await provider.ensureServer();
			const first = spawned[0]!.env;
			expect(first.OPENCODE_SERVER_USERNAME).toBe("opencode");
			expect(first.OPENCODE_SERVER_PASSWORD).toMatch(/^[\w-]{43}$/);
			// OpenCode 2 reads OPENCODE_PASSWORD first: it must be ours too, not the shell's.
			expect(first.OPENCODE_PASSWORD).toBe(first.OPENCODE_SERVER_PASSWORD);
			expect(clientConfig.headers?.Authorization).toBe(`Basic ${Buffer.from(`opencode:${first.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`);
			expect(process.env.OPENCODE_SERVER_USERNAME).toBe("personal");
			expect(process.env.OPENCODE_PASSWORD).toBe("personal-current");
			expect(process.env.OPENCODE_SERVER_PASSWORD).toBe("personal-password");
			provider.dispose();
			await provider.ensureServer();
			expect(spawned[1]!.env.OPENCODE_SERVER_PASSWORD).not.toBe(first.OPENCODE_SERVER_PASSWORD);
		} finally {
			provider.dispose();
			saved.restore();
		}
	});

	test("an OpenCode 1 whose /api/info fails (its catch-all, offline) keeps the 1.x client", async () => {
		const offline = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Internal Server Error", { status: 500 }) });
		serverUrl = offline.url.origin;
		clientConfig = {};
		const provider = makeProvider();
		try {
			await provider.ensureServer();
			expect(spawned[0]!.closed).toBe(false);
			expect(clientConfig.headers?.Authorization).toStartWith("Basic ");
		} finally { provider.dispose(); offline.stop(true); }
	});

	test("a failed detection reaps the server and removes its exit handler", async () => {
		const stopped = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
		serverUrl = stopped.url.origin;
		stopped.stop(true);
		const provider = makeProvider();
		const listeners = process.listeners("exit").length;
		try {
			await expect(provider.ensureServer()).rejects.toThrow();
			expect(spawned[0]!.closed).toBe(true);
			expect(process.listeners("exit").length).toBe(listeners);
		} finally { provider.dispose(); }
	});

	test("dispose during detection cannot resurrect the server", async () => {
		let reply: () => void = () => {};
		let received: () => void = () => {};
		const request = new Promise<void>((resolve) => { received = resolve; });
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
			return new Response(new ReadableStream({ start(controller) {
				reply = () => {
					controller.enqueue(new TextEncoder().encode('{"version":"2.3.2"}'));
					controller.close();
				};
				received();
			} }));
		} });
		serverUrl = server.url.origin;
		const provider = makeProvider();
		const listeners = process.listeners("exit").length;
		try {
			const pending = provider.ensureServer();
			await request;
			provider.dispose();
			reply();
			await expect(pending).rejects.toThrow("disposed during startup");
			expect(spawned[0]!.closed).toBe(true);
			expect(process.listeners("exit").length).toBe(listeners);
		} finally { provider.dispose(); server.stop(true); }
	});
});

describe("OpenCode 2 through an authenticated HTTP server", () => {
	function serve(mode: "answer" | "silent" | "close" | "fail" | "reject" | "wait" = "answer") {
		const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
		let send: (type: string, data?: Record<string, unknown>) => void = () => {};
		let cancelled = false;
		let badAuth = 0;
		let preferred = "other";
		let emptyModels = false;
		const server = Bun.serve({
			hostname: "127.0.0.1", port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				const path = url.pathname;
				// OpenCode 2's order: the current name, then the legacy one.
				const env = spawned.at(-1)?.env;
				const password = env?.OPENCODE_PASSWORD ?? env?.OPENCODE_SERVER_PASSWORD;
				if (req.headers.get("Authorization") !== `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`) {
					badAuth++;
					return Response.json({ message: "Authentication required" }, { status: 401 });
				}
				const body = req.method === "POST" ? await req.json() : undefined;
				calls.push({ path: path + url.search, body });
				if (path === "/api/info") return Response.json({ version: "2.3.2" });
				if (path === "/api/event") return new Response(new ReadableStream({
					start(controller) {
						send = (type, data = {}) => {
							try { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data })}\r\n\r\n`)); } catch {}
						};
						if (mode === "close") controller.close();
						else if (mode !== "silent") send("server.connected");
					},
					cancel() { cancelled = true; },
				}), { headers: { "Content-Type": "text/event-stream" } });
				if (path === "/api/session") return Response.json({ data: { id: "v2" } });
				if (path.endsWith("/fork")) return Response.json({ data: { id: "forked" } });
				if (path.startsWith("/api/session/") && path.endsWith("/model")) return new Response(null, { status: 204 });
				if (path.endsWith("/missing")) return Response.json({ _tag: "SessionNotFoundError", message: "No session" }, { status: 404 });
				if (path.endsWith("/prompt")) {
					if (mode === "reject") return Response.json({ _tag: "InvalidRequestError", message: "Bad prompt" }, { status: 400 });
					send("session.execution.succeeded", { sessionID: "v2" });
					send("session.execution.started", { sessionID: "unrelated" });
					send("session.execution.failed", { sessionID: "unrelated", error: { message: "wrong session" } });
					send("session.execution.started", { sessionID: "v2" });
					if (mode === "wait") {
						send("permission.asked", { sessionID: "v2", id: "req", action: "shell", metadata: { command: "ls" }, message: "Allow ls?" });
					} else if (mode === "fail") send("session.execution.failed", { sessionID: "v2", error: { message: "Model unavailable" } });
					else {
						send("session.tool.input.started", { sessionID: "v2", id: "t", name: "shell" });
						send("session.tool.called", { sessionID: "v2", id: "t", input: { command: "ls" } });
						send("session.tool.success", { sessionID: "v2", id: "t", content: [{ type: "text", text: "file.ts" }] });
						send("session.text.delta", { sessionID: "v2", delta: "pong" });
						send("session.text.ended", { sessionID: "v2", text: "pong" });
						send("session.execution.succeeded", { sessionID: "v2" });
					}
				}
				if (path.endsWith("/reply")) send("session.execution.succeeded", { sessionID: "v2" });
				if (path.endsWith("/interrupt")) send("session.execution.interrupted", { sessionID: "v2", reason: "user" });
				const model = (id: string, enabled = true) => ({ id, providerID: "opencode", name: id.toUpperCase(), enabled });
				if (path === "/api/model") return Response.json({ data: emptyModels ? [] : [model("one"), model("other"), model("off", false)] });
				if (path === "/api/model/default") return Response.json({ data: model(preferred) });
				return Response.json({ data: { id: "v2" } });
			},
		});
		serverUrl = server.url.origin;
		const provider = new OpenCodeProvider({ type: "opencode-sdk", cwd: "/scratch/a b", firstEventTimeoutMs: 30 });
		return { provider, calls, setEmptyModels() { emptyModels = true; }, setDefault(id: string) { preferred = id; }, get badAuth() { return badAuth; }, get cancelled() { return cancelled; }, close() { provider.dispose(); server.stop(true); } };
	}
	const context = { mode: "plan-review", plan: { plan: "# Plan" } } as const;

	test("create, synthetic once, streaming tools, one-shot, fork/resume and models use the v2 contract", async () => {
		const fake = serve();
		try {
			const session = await fake.provider.createSession({ context, model: "opencode/family/model", oneShot: { systemPrompt: "JUDGE" } });
			const messages = await Array.fromAsync(session.query("ping"));
			expect(messages).toEqual([
				{ type: "tool_use", toolName: "shell", toolInput: { command: "ls" }, toolUseId: "t" },
				{ type: "tool_result", toolUseId: "t", result: "file.ts" },
				{ type: "text_delta", delta: "pong" },
				{ type: "result", sessionId: "v2", success: true },
			]);
			await Array.fromAsync(session.query("again"));
			expect(fake.calls.filter((call) => call.path.endsWith("/synthetic"))).toEqual([{ path: "/api/session/v2/synthetic", body: { text: "JUDGE", resume: false } }]);
			expect(fake.calls.find((call) => call.path === "/api/session")?.body).toEqual({ location: { directory: "/scratch/a b" }, model: { providerID: "opencode", id: "family/model" }, permissions: [{ action: "*", resource: "*", effect: "deny" }] });
			expect(fake.calls.findIndex((call) => call.path === "/api/event")).toBeLessThan(fake.calls.findIndex((call) => call.path.endsWith("/synthetic")));
			expect(fake.calls.filter((call) => call.path.endsWith("/prompt")).map((call) => call.body)).toEqual([{ text: "ping" }, { text: "again" }]);
			expect((await fake.provider.forkSession({ context: { ...context, parent: { sessionId: "v2" } }, model: "opencode/family/model" } as never)).id).toBe("forked");
			expect(fake.calls.find((call) => call.path === "/api/session/forked/model")?.body).toEqual({ model: { providerID: "opencode", id: "family/model" } });
			expect(fake.calls.find((call) => call.path.endsWith("/fork"))?.body).toEqual({});
			const resumed = await fake.provider.resumeSession("v2");
			await Array.fromAsync(resumed.query("resume"));
			expect(fake.calls.filter((call) => call.path.endsWith("/synthetic"))).toHaveLength(1);
			await expect(fake.provider.resumeSession("missing")).rejects.toThrow("OpenCode HTTP 404: SessionNotFoundError: No session");
			await fake.provider.fetchModels();
			expect(fake.provider.models).toEqual([{ id: "opencode/one", label: "ONE (opencode)", default: false }, { id: "opencode/other", label: "OTHER (opencode)", default: true }]);
			expect(fake.calls.some((call) => call.path === "/api/model?location%5Bdirectory%5D=%2Fscratch%2Fa+b")).toBe(true);
			fake.setDefault("missing");
			await fake.provider.fetchModels();
			expect(fake.provider.models?.[0]?.default).toBe(true);
			await fake.provider.createSession({ context });
			expect(fake.calls.filter((call) => call.path === "/api/session").at(-1)?.body).toEqual({ location: { directory: "/scratch/a b" } });
			expect(fake.badAuth).toBe(0);
		} finally { fake.close(); }
	});

	test("empty model discovery leaves the provider usable", async () => {
		const fake = serve();
		try {
			fake.setEmptyModels();
			await fake.provider.fetchModels();
			expect(fake.provider.models).toBeUndefined();
			expect((await fake.provider.createSession({ context })).id).toBe("v2");
		} finally { fake.close(); }
	});

	for (const mode of ["silent", "close", "fail", "reject"] as const) {
		test(`${mode} stream/prompt ends with an error rather than hanging`, async () => {
			const fake = serve(mode);
			try {
				const session = await fake.provider.createSession({ context });
				const messages = await Array.fromAsync(session.query("ping"));
				expect(messages).toHaveLength(1);
				expect(messages[0]?.type).toBe("error");
				if (mode === "silent" || mode === "close") expect(fake.calls.some((call) => call.path.endsWith("/prompt"))).toBe(false);
				if (mode === "reject") expect(messages[0]).toMatchObject({ code: "opencode_prompt_rejected", error: "OpenCode rejected prompt: OpenCode HTTP 400: InvalidRequestError: Bad prompt" });
				if (mode === "fail") expect(messages[0]).toMatchObject({ error: "Model unavailable" });
			} finally { fake.close(); }
		});
	}

	test("permission decisions and Stop reach the v2 endpoints", async () => {
		const fake = serve("wait");
		try {
			const session = await fake.provider.createSession({ context });
			for (const allow of [true, false]) {
				for await (const message of session.query("ls")) {
					if (message.type === "permission_request") {
						expect(message).toMatchObject({ requestId: "req", title: "Allow ls?", toolName: "shell", toolInput: { command: "ls" } });
						session.respondToPermission?.("req", allow, "reason");
					}
				}
			}
			for await (const message of session.query("ls")) {
				if (message.type === "permission_request") session.abort();
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(fake.calls.filter((call) => call.path.endsWith("/reply")).map((call) => call.body)).toEqual([{ decision: "once", message: "reason" }, { decision: "reject", message: "reason" }]);
			expect(fake.calls.find((call) => call.path.endsWith("/interrupt"))?.body).toEqual({});
			expect(fake.cancelled).toBe(true);
		} finally { fake.close(); }
	});
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
			expect(spawned[0]!.env).toMatchObject({ PLANNOTATOR_ASK_AI_CHILD: "1", PLANNOTATOR_INBOX_TOOL: "0", PLANNOTATOR_AGENT_TOOL: "0" });
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

	test("an old rejected startup does not clear the next startup", async () => {
		const provider = makeProvider();
		let releaseOld = () => {};
		let releaseCurrent = () => {};
		try {
			spawnGate = new Promise<void>((resolve) => { releaseOld = resolve; });
			const old = provider.ensureServer().catch((error: unknown) => error);
			await Bun.sleep(0);
			provider.dispose();

			spawnGate = new Promise<void>((resolve) => { releaseCurrent = resolve; });
			const current = provider.ensureServer();
			await Bun.sleep(0);
			releaseOld();
			expect(await old).toBeInstanceOf(Error);
			expect(spawned[0]?.closed).toBe(true);

			const concurrent = provider.ensureServer();
			releaseCurrent();
			await Promise.all([current, concurrent]);
			expect(spawned).toHaveLength(2);
		} finally {
			releaseOld();
			releaseCurrent();
			provider.dispose();
		}
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

	test("a one-shot prompt turns every tool off and carries its own system prompt; a normal question does neither", async () => {
		const bodies: Record<string, unknown>[] = [];
		const made = fakeClient((push) => push({ type: "server.connected", properties: {} }));
		const client = made.client as { session: { promptAsync: (args: { body: Record<string, unknown> }) => Promise<unknown> } };
		const answer = client.session.promptAsync as unknown as () => Promise<unknown>;
		client.session.promptAsync = (args) => {
			bodies.push(args.body);
			return answer();
		};
		clientFactory = () => made.client;
		const provider = new OpenCodeProvider({ type: "opencode-sdk" });
		const context = { mode: "plan-review", plan: { plan: "# Plan" } };
		for await (const _ of (await provider.createSession({ context, oneShot: { systemPrompt: "JUDGE" } } as never)).query("x")) void _;
		for await (const _ of (await provider.createSession({ context } as never)).query("x")) void _;
		provider.dispose();
		expect(bodies[0]).toMatchObject({ system: "JUDGE", tools: { "*": false }, variant: "low" });
		expect(bodies[1]!.tools).toBeUndefined();
	});

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

	type Mode = "silent" | "answers" | "connects" | "rejects";
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
					if (mode === "rejects") {
						return Response.json({ name: "BadRequest", data: { message: "Unknown model" } }, { status: 400 });
					}
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
		const stop = stopAfterMs == null ? undefined : setTimeout(() => session.abort(), stopAfterMs);
		try {
			const messages: Array<Record<string, unknown>> = [];
			for await (const message of session.query("ping")) messages.push(message as Record<string, unknown>);
			return messages;
		} finally {
			clearTimeout(stop);
			provider.dispose();
		}
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

	test("reports a rejected HTTP prompt without waiting for a turn that never started", async () => {
		const serve = fakeOpencodeServe("rejects");
		try {
			const messages = await askReal(serve, 5_000, 250);
			expect(messages).toEqual([{
				type: "error",
				error: "OpenCode rejected prompt: Unknown model",
				code: "opencode_prompt_rejected",
			}]);
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
