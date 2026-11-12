import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDailyPing, type DailyPingTool } from "../../packages/shared/daily-ping.ts";
import { TELEMETRY_CI_VARS } from "./generated/config.ts";
import { startAnnotateServer, startPlanReviewServer, startReviewServer } from "./server.ts";
import { PI_RELEASE_MARK, piPingVersion, piPingVersionAt, setPiPingVersionForTests } from "./server/daily-ping.ts";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const PATCH = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n";
const KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_TELEMETRY_URL", "PLANNOTATOR_UPDATE_CHECK", "DO_NOT_TRACK", "NO_ANON_PING", ...TELEMETRY_CI_VARS] as const;
const saved: Record<string, string | undefined> = {};
let dataDir: string;
let receiver: ReturnType<typeof Bun.serve>;
let bodies: string[];

const today = () => new Date().toISOString().slice(0, 10);
const used = () => writeFileSync(join(dataDir, "ping.json"), JSON.stringify({ firstWeek: "2026-01-05" }));
const sent = (): string[] => {
	try {
		return JSON.parse(readFileSync(join(dataDir, "ping.json"), "utf8")).sent ?? [];
	} catch {
		return [];
	}
};

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
	const servers: [DailyPingTool, () => Promise<{ stop: () => void }>][] = [
		["plan", () => startPlanReviewServer({ plan: "# Plan", origin: "pi", htmlContent: MINIMAL_HTML })],
		["review", () => startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: MINIMAL_HTML })],
		["annotate", () => startAnnotateServer({ markdown: "# T", filePath: join(dataDir, "t.md"), htmlContent: MINIMAL_HTML })],
		["last", () => startAnnotateServer({ markdown: "# T", filePath: "last-message", mode: "annotate-last", htmlContent: MINIMAL_HTML })],
	];
	for (const [tool, start] of servers) {
		test(`${tool}: the same request as the CLI, once; the Bun side then sends nothing more for ${tool} that day`, async () => {
			setPiPingVersionForTests({ version: "0.28.46" });
			used();
			const server = await start();
			try {
				await until(() => sent().includes(tool));
				expect(bodies).toEqual([`POST /ping {"version":"0.28.46","age_week":4,"tool":"${tool}","first":1,"favicon":"none"}`]);
				expect(JSON.parse(readFileSync(join(dataDir, "ping.json"), "utf8"))).toMatchObject({ day: today(), sent: [tool] });
				expect(await checkDailyPing({ version: "0.28.46", tool })).toBe("sent-today");
				expect(bodies).toHaveLength(1);
			} finally {
				server.stop();
			}
		});
	}

	test("Pi reads the same config.json favicon as the CLI: totman is face", async () => {
		setPiPingVersionForTests({ version: "0.28.46" });
		used();
		writeFileSync(join(dataDir, "config.json"), JSON.stringify({ favicon: "totman" }));
		const server = await startPlanReviewServer({ plan: "# Plan", origin: "pi", htmlContent: MINIMAL_HTML });
		try {
			await until(() => sent().includes("plan"));
			expect(bodies).toEqual(['POST /ping {"version":"0.28.46","age_week":4,"tool":"plan","first":1,"favicon":"face"}']);
		} finally {
			server.stop();
		}
	});

	test("the archive browser is not plan review: no request, as in the CLI", async () => {
		setPiPingVersionForTests({ version: "0.28.46" });
		used();
		const server = await startPlanReviewServer({ plan: "", origin: "pi", mode: "archive", htmlContent: MINIMAL_HTML });
		try {
			await Bun.sleep(300);
			expect(bodies).toEqual([]);
			expect(sent()).toEqual([]);
		} finally {
			server.stop();
		}
	});

	test("an installed Pi package without release CI's mark (a local pack, a copied folder) is a dev build", () => {
		const pkg = join(dataDir, "node_modules", "@plannotator", "pi-extension");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@plannotator/pi-extension", version: "0.28.46" }));
		expect(piPingVersionAt(pkg)).toBeUndefined();
		writeFileSync(join(pkg, PI_RELEASE_MARK), JSON.stringify({ version: "0.28.45" }));
		expect(piPingVersionAt(pkg)).toBeUndefined();
		writeFileSync(join(pkg, PI_RELEASE_MARK), JSON.stringify({ version: "0.28.46" }));
		expect(piPingVersionAt(pkg)).toBe("0.28.46");
	});

	test("a Pi run from this checkout is a dev build: no request", async () => {
		expect(piPingVersion()).toBeUndefined();
		used();
		const server = await startPlanReviewServer({ plan: "# Plan", origin: "pi", htmlContent: MINIMAL_HTML });
		try {
			await Bun.sleep(300);
			expect(bodies).toEqual([]);
		} finally {
			server.stop();
		}
	});

	for (const name of ["NO_ANON_PING", "DO_NOT_TRACK"]) {
		test(`${name}=1: no request from Pi either`, async () => {
			setPiPingVersionForTests({ version: "0.28.46" });
			process.env[name] = "1";
			used();
			const server = await startPlanReviewServer({ plan: "# Plan", origin: "pi", htmlContent: MINIMAL_HTML });
			try {
				await Bun.sleep(300);
				expect(bodies).toEqual([]);
				expect(sent()).toEqual([]);
			} finally {
				server.stop();
			}
		});
	}
});
