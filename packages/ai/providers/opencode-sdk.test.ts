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
}

let spawned: FakeSpawn[] = [];
let clientFactory: () => unknown = () => ({});
let spawnGate: Promise<void> | null = null;

mock.module("@opencode-ai/sdk", () => ({
	createOpencodeServer: async (opts: {
		hostname?: string;
		port?: number;
		timeout?: number;
	}) => {
		const record: FakeSpawn = { ...opts, closed: false };
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
			expect(block).toContain("providerInitializers.set");
			expect(block).not.toContain("modelDiscovery.push");
		});
	}
});
