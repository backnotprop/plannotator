/**
 * The `agentTool` setting through the Pi (node:http) servers, the mirror of
 * packages/server/agent-tool-config.test.ts: POST /api/config refuses a
 * cross-origin write on every server and accepts `agentTool` as a boolean
 * only, and /api/plan's serverConfig reports the Pi host's view (off by
 * default on Pi). Pi's servers always run inside the Pi extension, which is
 * the tool's host, so they always advertise it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./generated/config.ts";
import { setPiHost } from "./pi-host.ts";
import { startAnnotateServer, startPlanReviewServer, startReviewServer } from "./server.ts";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const PATCH = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n";
const KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_AGENT_TOOL"] as const;
const saved: Record<string, string | undefined> = {};
let dataDir: string;

beforeEach(() => {
	for (const key of KEYS) saved[key] = process.env[key];
	dataDir = mkdtempSync(join(tmpdir(), "plannotator-pi-agent-tool-config-"));
	process.env.PLANNOTATOR_DATA_DIR = dataDir;
	process.env.PLANNOTATOR_REMOTE = "0";
	delete process.env.PLANNOTATOR_PORT;
	delete process.env.PLANNOTATOR_AGENT_TOOL;
});

afterEach(() => {
	setPiHost("pi");
	for (const key of KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	rmSync(dataDir, { recursive: true, force: true });
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
	fetch(`${url}/api/config`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const serverConfig = async (url: string) =>
	((await (await fetch(`${url}/api/plan`)).json()) as { serverConfig: Record<string, unknown> }).serverConfig;

describe("POST /api/config on the Pi servers", () => {
	const servers = {
		plan: () => startPlanReviewServer({ plan: "# Plan", origin: "pi", htmlContent: MINIMAL_HTML }),
		review: () => startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: MINIMAL_HTML }),
		annotate: () => startAnnotateServer({ markdown: "# Test", filePath: join(dataDir, "t.md"), htmlContent: MINIMAL_HTML }),
	};
	for (const [name, start] of Object.entries(servers)) {
		test(`${name}: a cross-origin write is refused and writes nothing; same-origin and Origin-less writes work`, async () => {
			const server = await start();
			try {
				const forged = await fetch(`${server.url}/api/config`, {
					method: "POST",
					headers: { "Content-Type": "text/plain", Origin: "https://evil.example" },
					body: JSON.stringify({ agentTool: true, autoUpdate: true }),
				});
				expect(forged.status).toBe(403);
				expect(loadConfig()).toEqual({});

				expect((await post(server.url, { agentTool: true }, { Origin: new URL(server.url).origin })).status).toBe(200);
				expect(loadConfig().agentTool).toBe(true);
				expect((await post(server.url, { agentTool: false })).status).toBe(200);
				expect(loadConfig().agentTool).toBe(false);
				expect((await post(server.url, { agentTool: "true" })).status).toBe(200);
				expect(loadConfig().agentTool).toBe(false);
			} finally {
				server.stop();
			}
		});
	}
});

describe("the agent tool advert on the Pi servers", () => {
	test("the Pi view: off by default, a saved choice, an env override", async () => {
		const server = await startAnnotateServer({ markdown: "# Test", filePath: join(dataDir, "t.md"), htmlContent: MINIMAL_HTML });
		try {
			expect(await serverConfig(server.url)).toMatchObject({ agentTool: false, agentToolConfigured: false, agentToolHost: "pi", agentToolEnabled: false });
			await post(server.url, { agentTool: true });
			expect(await serverConfig(server.url)).toMatchObject({ agentTool: true, agentToolConfigured: true, agentToolEnabled: true });
			process.env.PLANNOTATOR_AGENT_TOOL = "0";
			expect(await serverConfig(server.url)).toMatchObject({ agentTool: true, agentToolEnv: false, agentToolEnabled: false });
		} finally {
			server.stop();
		}
	});

	// In Oh My Pi the tool is on by default: Settings shows it on, and the
	// one-time "turn it on" offer (which needs an off, unconfigured host) never applies.
	test("the Oh My Pi view: on by default, still overridable both ways", async () => {
		setPiHost("oh-my-pi");
		const servers = [
			await startPlanReviewServer({ plan: "# Plan", origin: "pi", htmlContent: MINIMAL_HTML }),
			await startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: MINIMAL_HTML }),
			await startAnnotateServer({ markdown: "# Test", filePath: join(dataDir, "t.md"), htmlContent: MINIMAL_HTML }),
		];
		try {
			for (const server of servers) {
				const config =
					server === servers[1]
						? ((await (await fetch(`${server.url}/api/diff`)).json()) as { serverConfig: Record<string, unknown> }).serverConfig
						: await serverConfig(server.url);
				expect(config).toMatchObject({ agentTool: true, agentToolConfigured: false, agentToolHost: "oh-my-pi", agentToolEnabled: true });
			}
			const annotate = servers[2]!;
			await post(annotate.url, { agentTool: false });
			expect(await serverConfig(annotate.url)).toMatchObject({ agentTool: false, agentToolConfigured: true, agentToolEnabled: false });
			process.env.PLANNOTATOR_AGENT_TOOL = "1";
			expect(await serverConfig(annotate.url)).toMatchObject({ agentToolEnv: true, agentToolEnabled: true });
		} finally {
			for (const server of servers) server.stop();
		}
	});
});
