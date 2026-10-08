/**
 * Pi twin of packages/server/plan-history-midnight.test.ts (#1679).
 *
 * What regresses if this fails: the Pi plan server keys history by today's
 * date again, so a plan revised across UTC midnight loses its version diff,
 * or a revision pushed into an open review (updatePlan) leaves the session's
 * chain; or the decision snapshot in plans/ stops being named by the
 * decision day.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPlanReviewServer } from "./serverPlan.ts";
import { detectProjectName } from "./project.ts";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_AI", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_FEEDBACK_HISTORY"] as const;

async function sandboxed(run: (dataDir: string) => Promise<void>): Promise<void> {
	const saved: Record<string, string | undefined> = {};
	for (const key of ENV_KEYS) saved[key] = process.env[key];
	const dataDir = mkdtempSync(join(tmpdir(), "plannotator-pi-plan-midnight-"));
	try {
		process.env.PLANNOTATOR_DATA_DIR = dataDir;
		process.env.PLANNOTATOR_AI = "disabled";
		process.env.PLANNOTATOR_REMOTE = "0";
		process.env.PLANNOTATOR_FEEDBACK_HISTORY = "0";
		delete process.env.PLANNOTATOR_PORT;
		await run(dataDir);
	} finally {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key]!;
		}
		rmSync(dataDir, { recursive: true, force: true });
	}
}

const utcDay = (ms: number) => new Date(ms).toISOString().split("T")[0];

describe("pi plan server history across midnight (#1679)", () => {
	test("continues yesterday's chain, keeps revisions on it, and dates the archive today", async () => sandboxed(async (dataDir) => {
		const project = detectProjectName();
		const v1 = "# Pi Midnight Chain\n\n- [ ] First step.\n";
		const v2 = "# Pi Midnight Chain\n\n- [ ] First step, revised.\n";
		const v3 = "# Pi Midnight Chain\n\n- [ ] First step, revised again.\n";
		const savedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
		const yesterdaySlug = `pi-midnight-chain-${utcDay(Date.now() - 24 * 60 * 60 * 1000)}`;
		const chainDir = join(dataDir, "history", project, yesterdaySlug);
		mkdirSync(chainDir, { recursive: true });
		writeFileSync(join(chainDir, "001.md"), v1);
		utimesSync(join(chainDir, "001.md"), savedAt, savedAt);

		const server = await startPlanReviewServer({ plan: v2, htmlContent: MINIMAL_HTML, origin: "pi", planRevisions: true });
		try {
			const payload = (await (await fetch(`${server.url}/api/plan`)).json()) as Record<string, any>;
			expect(payload.previousPlan).toBe(v1);
			expect(payload.versionInfo.version).toBe(2);
			const versions = (await (await fetch(`${server.url}/api/plan/versions`)).json()) as Record<string, any>;
			expect(versions.slug).toBe(yesterdaySlug);

			expect(server.updatePlan(v3)).toEqual({ revision: 1, version: 3, unchanged: false });
			expect(existsSync(join(chainDir, "003.md"))).toBe(true);
			const revised = (await (await fetch(`${server.url}/api/plan`)).json()) as Record<string, any>;
			expect(revised.previousPlan).toBe(v2);

			const approve = await fetch(`${server.url}/api/approve`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ planSave: { enabled: true }, planRevision: 1 }),
			});
			expect(approve.status).toBe(200);
			const body = (await approve.json()) as { savedPath?: string };
			expect(body.savedPath).toBe(join(dataDir, "plans", `pi-midnight-chain-${utcDay(Date.now())}-approved.md`));
		} finally {
			server.stop();
		}
	}));
});
