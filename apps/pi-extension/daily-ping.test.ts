/**
 * Pi parity for the daily ping (server/daily-ping.ts over the vendored
 * generated/daily-ping.ts), in a temp data dir against a loopback receiver:
 * each Pi server (plan review, code review, annotate) runs the same check as
 * the CLI and sends the same bytes; Pi and the Bun side share ping.json, so a
 * computer sends once a day whichever runs first; a Pi run from this checkout
 * sends nothing; the Settings switch syncs through Pi's POST /api/config.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDailyPing } from "../../packages/shared/daily-ping.ts";
import { loadConfig, TELEMETRY_CI_VARS } from "./generated/config.ts";
import { startAnnotateServer, startPlanReviewServer, startReviewServer } from "./server.ts";
import { piPingVersion, setPiPingVersionForTests } from "./server/daily-ping.ts";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const PATCH = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n";
const KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_TELEMETRY_URL", "PLANNOTATOR_UPDATE_CHECK", "DO_NOT_TRACK", "NO_ANON_PING", ...TELEMETRY_CI_VARS] as const;
const saved: Record<string, string | undefined> = {};
let dataDir: string;
let receiver: ReturnType<typeof Bun.serve>;
let bodies: string[];

const today = () => new Date().toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const noticed = () => writeFileSync(join(dataDir, "ping.json"), JSON.stringify({ firstWeek: "2026-01-05", noticeDay: yesterday() }));

async function until(check: () => boolean, ms = 3000): Promise<void> {
	const end = Date.now() + ms;
	while (!check() && Date.now() < end) await Bun.sleep(20);
}

beforeEach(() => {
	for (const key of KEYS) saved[key] = process.env[key];
	for (const key of ["DO_NOT_TRACK", "NO_ANON_PING", ...TELEMETRY_CI_VARS]) delete process.env[key];
	dataDir = mkdtempSync(join(tmpdir(), "plannotator-pi-daily-ping-"));
	process.env.PLANNOTATOR_DATA_DIR = dataDir;
	process.env.PLANNOTATOR_REMOTE = "0";
	process.env.PLANNOTATOR_UPDATE_CHECK = "0";
	delete process.env.PLANNOTATOR_PORT;
	bodies = [];
	receiver = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			bodies.push(`${req.method} ${new URL(req.url).pathname} ${await req.text()}`);
			return new Response(null, { status: 204 });
		},
	});
	process.env.PLANNOTATOR_TELEMETRY_URL = `http://127.0.0.1:${receiver.port}`;
});

afterEach(() => {
	setPiPingVersionForTests(null);
	receiver.stop(true);
	for (const key of KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	rmSync(dataDir, { recursive: true, force: true });
});

describe("the daily ping on the Pi servers", () => {
	const servers = {
		plan: () => startPlanReviewServer({ plan: "# Plan", origin: "pi", htmlContent: MINIMAL_HTML }),
		review: () => startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: MINIMAL_HTML }),
		annotate: () => startAnnotateServer({ markdown: "# T", filePath: join(dataDir, "t.md"), htmlContent: MINIMAL_HTML }),
	};
	for (const [name, start] of Object.entries(servers)) {
		test(`${name}: the same request as the CLI, once; the Bun side then sends nothing that day`, async () => {
			setPiPingVersionForTests({ version: "0.28.46" });
			noticed();
			const server = await start();
			try {
				await until(() => bodies.length > 0 && JSON.parse(readFileSync(join(dataDir, "ping.json"), "utf8")).lastDay !== undefined);
				expect(bodies).toEqual(['POST /ping {"version":"0.28.46","age":4}']);
				expect(JSON.parse(readFileSync(join(dataDir, "ping.json"), "utf8")).lastDay).toBe(today());
				expect(await checkDailyPing({ version: "0.28.46" })).toBe("sent-today");
				expect(bodies).toHaveLength(1);
			} finally {
				server.stop();
			}
		});
	}

	test("a Pi run from this checkout is a dev build: no request", async () => {
		expect(piPingVersion()).toBeUndefined();
		noticed();
		const server = await startPlanReviewServer({ plan: "# Plan", origin: "pi", htmlContent: MINIMAL_HTML });
		try {
			await Bun.sleep(300);
			expect(bodies).toEqual([]);
		} finally {
			server.stop();
		}
	});

	test("DO_NOT_TRACK: no request from Pi either", async () => {
		setPiPingVersionForTests({ version: "0.28.46" });
		process.env.DO_NOT_TRACK = "1";
		noticed();
		const server = await startPlanReviewServer({ plan: "# Plan", origin: "pi", htmlContent: MINIMAL_HTML });
		try {
			await Bun.sleep(300);
			expect(bodies).toEqual([]);
		} finally {
			server.stop();
		}
	});

	test("the Settings switch through Pi's POST /api/config, and serverConfig's telemetry", async () => {
		const server = await startPlanReviewServer({ plan: "# Plan", origin: "pi", htmlContent: MINIMAL_HTML });
		const config = async () => ((await (await fetch(`${server.url}/api/plan`)).json()) as { serverConfig: Record<string, unknown> }).serverConfig;
		const post = (body: unknown) => fetch(`${server.url}/api/config`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
		try {
			expect(await config()).toMatchObject({ telemetry: true });
			await post({ telemetry: "no" });
			expect(loadConfig().telemetry).toBeUndefined();
			await post({ telemetry: false });
			expect(loadConfig().telemetry).toBe(false);
			expect(await config()).toMatchObject({ telemetry: false });
			process.env.NO_ANON_PING = "1";
			expect((await config()).telemetryEnv).toBe("NO_ANON_PING");
		} finally {
			server.stop();
		}
	});
});
