import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPlanReviewServer } from "./serverPlan.ts";
import { detectProjectName } from "./project.ts";
import { generateSlug, PLAN_HISTORY_CONTINUE_WINDOW_MS } from "../generated/storage.ts";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_AI", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_FEEDBACK_HISTORY"] as const;
const HOUR = 60 * 60 * 1000;

async function sandboxed(run: (dataDir: string) => Promise<void>): Promise<void> {
	const saved: Record<string, string | undefined> = {};
	for (const key of ENV_KEYS) saved[key] = process.env[key];
	const dataDir = mkdtempSync(join(tmpdir(), "plannotator-pi-history-span-"));
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

function slugDatedDaysAgo(plan: string, days: number): string {
	const date = new Date();
	date.setUTCDate(date.getUTCDate() - days);
	return generateSlug(plan).replace(/\d{4}-\d{2}-\d{2}$/, date.toISOString().split("T")[0]);
}

function seedVersion(dataDir: string, project: string, slug: string, content: string, ageMs: number): void {
	const dir = join(dataDir, "history", project, slug);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "001.md");
	writeFileSync(file, content, "utf-8");
	const when = new Date(Date.now() - ageMs);
	utimesSync(file, when, when);
}

async function getJson(url: string) {
	return (await (await fetch(url)).json()) as Record<string, any>;
}

describe("pi plan review spanning a day boundary", () => {
	test("continues yesterday's chain, and a pushed revision stays on it", async () => sandboxed(async (dataDir) => {
		const project = detectProjectName();
		const v1 = "# Pi inference capacity\n\nThe version the reviewer annotated.\n";
		const v2 = "# Pi inference capacity\n\nRevised the next day.\n";
		const v3 = "# Pi inference capacity\n\nRevised again in the same review.\n";
		const chain = slugDatedDaysAgo(v1, 1);
		seedVersion(dataDir, project, chain, v1, 3 * HOUR);

		const server = await startPlanReviewServer({ plan: v2, htmlContent: MINIMAL_HTML, origin: "pi", planRevisions: true });
		try {
			const first = await getJson(`${server.url}/api/plan`);
			expect(first.previousPlan).toBe(v1);
			expect(first.versionInfo.version).toBe(2);

			expect(server.updatePlan(v3)).toMatchObject({ version: 3, unchanged: false });
			const after = await getJson(`${server.url}/api/plan`);
			expect(after.previousPlan).toBe(v2);
			const versions = await getJson(`${server.url}/api/plan/versions`);
			expect(versions.slug).toBe(chain);
			expect(versions.versions).toHaveLength(3);
			expect(existsSync(join(dataDir, "history", project, generateSlug(v1)))).toBe(false);
		} finally {
			server.stop();
		}
	}));

	for (const decision of ["approve", "deny"] as const) {
		test(`${decision} writes plans/{heading}-{today} while history continues an older chain`, async () => sandboxed(async (dataDir) => {
			const project = detectProjectName();
			const v1 = `# Pi archive split ${decision}\n\n- [ ] First step.\n`;
			const v2 = `# Pi archive split ${decision}\n\n- [ ] First step, revised.\n`;
			const chain = slugDatedDaysAgo(v1, 1);
			seedVersion(dataDir, project, chain, v1, 2 * HOUR);

			const server = await startPlanReviewServer({ plan: v2, htmlContent: MINIMAL_HTML, origin: "pi" });
			try {
				expect(existsSync(join(dataDir, "history", project, chain, "002.md"))).toBe(true);
				const response = await fetch(`${server.url}/api/${decision}`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ planSave: { enabled: true }, ...(decision === "deny" ? { feedback: "Change step one." } : {}) }),
				});
				expect(response.status).toBe(200);
				const result = await server.waitForDecision();
				const status = decision === "approve" ? "approved" : "denied";
				expect(result.savedPath).toBe(join(dataDir, "plans", `${generateSlug(v2)}-${status}.md`));
				expect(generateSlug(v2)).not.toBe(chain);
			} finally {
				server.stop();
			}
		}));
	}

	test("a same-heading plan after two quiet days starts a new chain", async () => sandboxed(async (dataDir) => {
		const project = detectProjectName();
		const plan = "# Implementation Plan\n\nUnrelated work, days later.\n";
		seedVersion(dataDir, project, slugDatedDaysAgo(plan, 3), "# Implementation Plan\n\nAn older plan.\n", PLAN_HISTORY_CONTINUE_WINDOW_MS + HOUR);

		const server = await startPlanReviewServer({ plan, htmlContent: MINIMAL_HTML, origin: "pi" });
		try {
			const payload = await getJson(`${server.url}/api/plan`);
			expect(payload.versionInfo.version).toBe(1);
			expect(payload.previousPlan).toBeNull();
		} finally {
			server.stop();
		}
	}));
});
