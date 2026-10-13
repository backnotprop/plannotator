import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FAKE_CODEX_MODEL, fakeAgentClis } from "../../../tests/test-fixtures/fake-agent-clis.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("createPiAIRuntime Codex discovery", () => {
	test("capabilities does not execute Codex and session activation does", async () => {
		if (process.platform === "win32") return;

		const dir = mkdtempSync(join(tmpdir(), "plannotator-pi-lazy-codex-"));
		tempDirs.push(dir);
		const marker = join(dir, "codex-ran");
		const codex = join(dir, "codex");
		writeFileSync(codex, `#!/bin/sh\necho ran > '${marker}'\nexit 1\n`);
		chmodSync(codex, 0o755);

		const runner = join(dir, "runner.ts");
		const runtimeUrl = pathToFileURL(join(import.meta.dir, "ai-runtime.ts")).href;
		writeFileSync(runner, `
			import { existsSync } from "node:fs";
			import { createPiAIRuntime } from ${JSON.stringify(runtimeUrl)};
			const runtime = await createPiAIRuntime({ cwd: ${JSON.stringify(dir)} });
			if (!runtime) throw new Error("Pi AI runtime unavailable");
			const capabilities = await runtime.endpoints["/api/ai/capabilities"](
				new Request("http://localhost/api/ai/capabilities"),
			);
			const data = await capabilities.json();
			const afterCapabilities = existsSync(${JSON.stringify(marker)});
			const session = await runtime.endpoints["/api/ai/session"](
				new Request("http://localhost/api/ai/session", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						context: { mode: "plan-review", plan: { plan: "# Test" } },
						providerId: "codex-sdk",
					}),
				}),
			);
			console.log(JSON.stringify({
				hasCodex: data.providers.some((provider) => provider.id === "codex-sdk"),
				afterCapabilities,
				sessionStatus: session.status,
				afterSession: existsSync(${JSON.stringify(marker)}),
			}));
			runtime.dispose();
		`);

		const proc = Bun.spawn([process.execPath, runner], {
			cwd: join(import.meta.dir, ".."),
			env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout.trim())).toEqual({
			hasCodex: true,
			afterCapabilities: false,
			sessionStatus: 200,
			afterSession: true,
		});
	}, 15_000);

	test("capabilities?activate= runs discovery once and shares it with the session path", async () => {
		if (process.platform === "win32") return;

		const dir = mkdtempSync(join(tmpdir(), "plannotator-pi-activate-codex-"));
		tempDirs.push(dir);
		const marker = join(dir, "codex-ran");
		const codex = join(dir, "codex");
		writeFileSync(codex, `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`);
		chmodSync(codex, 0o755);

		const runner = join(dir, "runner.ts");
		const runtimeUrl = pathToFileURL(join(import.meta.dir, "ai-runtime.ts")).href;
		writeFileSync(runner, `
			import { existsSync, readFileSync } from "node:fs";
			import { createPiAIRuntime } from ${JSON.stringify(runtimeUrl)};
			const runs = () => existsSync(${JSON.stringify(marker)})
				? readFileSync(${JSON.stringify(marker)}, "utf8").trim().split("\\n").length
				: 0;
			const runtime = await createPiAIRuntime({ cwd: ${JSON.stringify(dir)} });
			if (!runtime) throw new Error("Pi AI runtime unavailable");
			const probe = await runtime.endpoints["/api/ai/capabilities"](
				new Request("http://localhost/api/ai/capabilities"),
			);
			const runsAfterProbe = runs();
			const activate = await runtime.endpoints["/api/ai/capabilities"](
				new Request("http://localhost/api/ai/capabilities?activate=codex-sdk"),
			);
			const runsAfterActivate = runs();
			const session = await runtime.endpoints["/api/ai/session"](
				new Request("http://localhost/api/ai/session", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						context: { mode: "plan-review", plan: { plan: "# Test" } },
						providerId: "codex-sdk",
					}),
				}),
			);
			console.log(JSON.stringify({
				probeStatus: probe.status,
				runsAfterProbe,
				activateStatus: activate.status,
				runsAfterActivate,
				sessionStatus: session.status,
				runsAfterSession: runs(),
			}));
			runtime.dispose();
		`);

		const proc = Bun.spawn([process.execPath, runner], {
			cwd: join(import.meta.dir, ".."),
			env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout.trim())).toEqual({
			probeStatus: 200,
			runsAfterProbe: 0,
			activateStatus: 200,
			runsAfterActivate: 1,
			sessionStatus: 200,
			runsAfterSession: 1,
		});
	}, 15_000);
});

describe("createPiAIRuntime Pi discovery", () => {
	// Pi's model discovery spawns `pi` and waits up to 10s; it must not hold a
	// plain capabilities answer, only an explicit ?activate= (or a session).
	test("plain capabilities answers at once without spawning a slow pi; ?activate= spawns it", async () => {
		if (process.platform === "win32") return;

		const dir = mkdtempSync(join(tmpdir(), "plannotator-pi-lazy-pi-"));
		tempDirs.push(dir);
		const marker = join(dir, "pi-ran");
		const pi = join(dir, "pi");
		writeFileSync(pi, `#!/bin/sh\necho ran >> '${marker}'\nsleep 5\n`);
		chmodSync(pi, 0o755);

		const runner = join(dir, "runner.ts");
		const runtimeUrl = pathToFileURL(join(import.meta.dir, "ai-runtime.ts")).href;
		writeFileSync(runner, `
			import { existsSync } from "node:fs";
			import { createPiAIRuntime } from ${JSON.stringify(runtimeUrl)};
			const runtime = await createPiAIRuntime({ cwd: ${JSON.stringify(dir)} });
			if (!runtime) throw new Error("Pi AI runtime unavailable");
			const startedAt = Date.now();
			const capabilities = await runtime.endpoints["/api/ai/capabilities"](
				new Request("http://localhost/api/ai/capabilities"),
			);
			const elapsedMs = Date.now() - startedAt;
			const data = await capabilities.json();
			const afterCapabilities = existsSync(${JSON.stringify(marker)});
			void runtime.endpoints["/api/ai/capabilities"](
				new Request("http://localhost/api/ai/capabilities?activate=pi-sdk"),
			);
			let afterActivate = false;
			for (let i = 0; i < 60 && !afterActivate; i++) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				afterActivate = existsSync(${JSON.stringify(marker)});
			}
			console.log(JSON.stringify({
				hasPi: data.providers.some((provider) => provider.id === "pi-sdk"),
				fast: elapsedMs < 2000,
				afterCapabilities,
				afterActivate,
			}));
			process.exit(0);
		`);

		const proc = Bun.spawn([process.execPath, runner], {
			cwd: import.meta.dir,
			env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout.trim())).toEqual({
			hasPi: true,
			fast: true,
			afterCapabilities: false,
			afterActivate: true,
		});
	}, 15_000);
});

describe("createPiAIRuntime with a session bridge", () => {
	// The Pi session that opened Plannotator answers Ask AI and nothing else:
	// with a bridge no SDK provider is listed or reachable by id, even with
	// Codex installed. The agent-job launchers still get the discovered Claude
	// / Codex catalogs from ?activate=<id> (under `catalogProviders`). Without
	// a bridge, Codex is offered as before.
	test("serves only the bridge for Ask AI, keeps launcher catalogs, and refuses other providers", async () => {
		if (process.platform === "win32") return;

		const dir = mkdtempSync(join(tmpdir(), "plannotator-pi-bridge-only-"));
		tempDirs.push(dir);
		fakeAgentClis(dir);

		const runner = join(dir, "runner.ts");
		const runtimeUrl = pathToFileURL(join(import.meta.dir, "ai-runtime.ts")).href;
		writeFileSync(runner, `
			import { createPiAIRuntime } from ${JSON.stringify(runtimeUrl)};
			const bridge = {
				host: "pi",
				modes: { turn: true, transient: false },
				status: () => "ready",
				ask: () => {},
			};
			const caps = async (runtime, query) => (await runtime.endpoints["/api/ai/capabilities"](
				new Request("http://localhost/api/ai/capabilities" + query),
			)).json();
			const withBridge = await createPiAIRuntime({ cwd: ${JSON.stringify(dir)}, sessionBridge: bridge, getServerPort: () => 4321 });
			const without = await createPiAIRuntime({ cwd: ${JSON.stringify(dir)} });
			if (!withBridge || !without) throw new Error("Pi AI runtime unavailable");
			const plainBridged = await caps(withBridge, "");
			const codex = await caps(withBridge, "?activate=codex-sdk");
			const claude = await caps(withBridge, "?activate=claude-agent-sdk");
			const sessionStatus = {};
			for (const providerId of ["codex-sdk", "claude-agent-sdk"]) {
				sessionStatus[providerId] = (await withBridge.endpoints["/api/ai/session"](
					new Request("http://localhost/api/ai/session", {
						method: "POST",
						headers: { "Content-Type": "application/json", host: "localhost:4321" },
						body: JSON.stringify({ context: { mode: "plan-review", plan: { plan: "# Test" } }, providerId }),
					}),
				)).status;
			}
			const plain = await caps(without, "");
			console.log(JSON.stringify({
				bridged: {
					providerIds: plainBridged.providers.map((p) => p.id),
					defaultProvider: plainBridged.defaultProvider,
					catalogProviders: plainBridged.catalogProviders ?? null,
				},
				codex: {
					providerIds: codex.providers.map((p) => p.id),
					catalog: codex.catalogProviders.map((p) => ({ id: p.id, modelIds: p.models.map((m) => m.id), modelsSource: p.modelsSource, toolVersion: p.toolVersion })),
				},
				claude: {
					providerIds: claude.providers.map((p) => p.id),
					ids: claude.catalogProviders.map((p) => p.id),
					toolVersion: claude.catalogProviders[0]?.toolVersion ?? null,
				},
				sessionStatus,
				withoutBridgeHasCodex: plain.providers.some((p) => p.id === "codex-sdk"),
				withoutBridgeHasBridge: plain.providers.some((p) => p.id === "session-bridge"),
			}));
			withBridge.dispose();
			without.dispose();
		`);

		const proc = Bun.spawn([process.execPath, runner], {
			cwd: join(import.meta.dir, ".."),
			env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual({
			bridged: { providerIds: ["session-bridge"], defaultProvider: "session-bridge", catalogProviders: null },
			codex: {
				providerIds: ["session-bridge"],
				catalog: [{ id: "codex-sdk", modelIds: [FAKE_CODEX_MODEL], modelsSource: "discovered", toolVersion: "0.999.0" }],
			},
			claude: { providerIds: ["session-bridge"], ids: ["claude-agent-sdk"], toolVersion: "2.1.999" },
			sessionStatus: { "codex-sdk": 503, "claude-agent-sdk": 503 },
			withoutBridgeHasCodex: true,
			withoutBridgeHasBridge: false,
		});
	}, 30_000);
});
