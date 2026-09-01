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
 * 3. Neither runtime's AI setup may call the provider's fetchModels eagerly at
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

interface FakeServerCall {
	hostname?: string;
	port?: number;
	timeout?: number;
}

let serverCalls: FakeServerCall[] = [];
let closeCount = 0;

mock.module("@opencode-ai/sdk", () => ({
	createOpencodeServer: async (opts: FakeServerCall) => {
		serverCalls.push(opts);
		return {
			url: "http://127.0.0.1:54321",
			close: () => {
				closeCount++;
			},
		};
	},
	createOpencodeClient: () => ({}),
}));

const { OpenCodeProvider } = await import("./opencode-sdk.ts");

function makeProvider(port?: number) {
	return new OpenCodeProvider({
		type: "opencode-sdk",
		...(port != null && { port }),
	});
}

beforeEach(() => {
	serverCalls = [];
	closeCount = 0;
});

describe("OpenCodeProvider server lifecycle", () => {
	test("spawns on an OS-assigned port and cleans up on dispose", async () => {
		const provider = makeProvider();
		const listenersBefore = process.listeners("exit").length;

		await provider.ensureServer();

		expect(serverCalls.length).toBe(1);
		// port 0 = OS-assigned free port. A fixed default here reintroduces the
		// shared-server pile-up.
		expect(serverCalls[0]!.port).toBe(0);
		expect(process.listeners("exit").length).toBe(listenersBefore + 1);

		provider.dispose();
		expect(closeCount).toBe(1);
		expect(process.listeners("exit").length).toBe(listenersBefore);
	});

	test("the exit handler closes the spawned server", async () => {
		const provider = makeProvider();
		const before = new Set(process.listeners("exit"));
		await provider.ensureServer();
		const added = process
			.listeners("exit")
			.filter((l) => !before.has(l));
		expect(added.length).toBe(1);

		// Simulate the process exiting without a clean dispose (Ctrl-C routes
		// through process.exit, which runs "exit" listeners).
		(added[0] as () => void)();
		expect(closeCount).toBe(1);

		provider.dispose();
	});

	test("honors an explicitly configured port verbatim", async () => {
		const provider = makeProvider(5555);
		await provider.ensureServer();
		expect(serverCalls[0]!.port).toBe(5555);
		provider.dispose();
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
