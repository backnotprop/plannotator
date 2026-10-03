/**
 * Revised plans pushed into an open Pi plan review (non-blocking
 * plannotator_submit_plan).
 *
 * What regresses if this fails:
 *  - a revision the agent pushes never reaches the open tab (no new
 *    /api/plan text, no revision bump, no version diff), so the reviewer
 *    keeps reading a plan the agent has replaced;
 *  - a decision made on the older revision is accepted, approving or
 *    denying text the reviewer never saw;
 *  - the approved snapshot records the plan the server started with instead
 *    of the one that was approved;
 *  - a push after the decision silently mutates a settled review instead of
 *    telling the caller to open a new one.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPlanReviewServer } from "./serverPlan.ts";
import { detectProjectName } from "./project.ts";
import { generateSlug, getPlanVersionPath } from "../generated/storage.ts";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_AI", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_FEEDBACK_HISTORY"] as const;
const saved: Record<string, string | undefined> = {};
const tempDirs: string[] = [];
const createdPlans: string[] = [];

beforeEach(() => {
	for (const key of ENV_KEYS) saved[key] = process.env[key];
	const dir = mkdtempSync(join(tmpdir(), "plannotator-pi-plan-revision-"));
	tempDirs.push(dir);
	process.env.PLANNOTATOR_DATA_DIR = dir;
	process.env.PLANNOTATOR_AI = "disabled";
	process.env.PLANNOTATOR_REMOTE = "0";
	process.env.PLANNOTATOR_FEEDBACK_HISTORY = "0";
	delete process.env.PLANNOTATOR_PORT;
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key]!;
	}
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
	// Version history goes through generated/storage.ts, whose data dir is fixed
	// at import time; remove the slugs these tests created there.
	const project = detectProjectName();
	for (const plan of createdPlans) {
		const versionPath = getPlanVersionPath(project, generateSlug(plan), 1);
		if (versionPath) rmSync(join(versionPath, ".."), { recursive: true, force: true });
	}
});

function planPair() {
	const title = `# Pi plan revision test ${Math.random().toString(36).slice(2, 10)}`;
	const v1 = `${title}\n\n- [ ] First step.\n`;
	const v2 = `${title}\n\n- [ ] First step, revised.\n- [ ] Second step.\n`;
	createdPlans.push(v1);
	return { v1, v2 };
}

async function getJson(url: string) {
	const response = await fetch(url);
	return (await response.json()) as Record<string, any>;
}

async function post(url: string, body: Record<string, unknown>) {
	return fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("pi plan server revisions", () => {
	test("a pushed revision is served with its version diff and a bumped revision", async () => {
		const { v1, v2 } = planPair();
		const server = await startPlanReviewServer({ plan: v1, htmlContent: MINIMAL_HTML, origin: "pi", planRevisions: true });
		try {
			const before = await getJson(`${server.url}/api/plan`);
			expect(before.planRevision).toBe(0);
			expect(before.plan).toBe(v1);

			const result = server.updatePlan(v2);
			expect(result).toEqual({ revision: 1, version: 2, unchanged: false });

			expect(await getJson(`${server.url}/api/plan/revision`)).toEqual({ revision: 1, decided: false });
			const after = await getJson(`${server.url}/api/plan`);
			expect(after.plan).toBe(v2);
			expect(after.planRevision).toBe(1);
			expect(after.previousPlan).toBe(v1);
			expect(after.versionInfo.version).toBe(2);
		} finally {
			server.stop();
		}
	});

	test("an identical push changes nothing", async () => {
		const { v1 } = planPair();
		const server = await startPlanReviewServer({ plan: v1, htmlContent: MINIMAL_HTML, origin: "pi", planRevisions: true });
		try {
			expect(server.updatePlan(v1)).toMatchObject({ revision: 0, unchanged: true });
			expect((await getJson(`${server.url}/api/plan`)).planRevision).toBe(0);
		} finally {
			server.stop();
		}
	});

	test("a decision on an older revision is refused; one on the current revision settles with the current plan", async () => {
		const { v1, v2 } = planPair();
		const dir = mkdtempSync(join(tmpdir(), "plannotator-pi-plan-revision-save-"));
		tempDirs.push(dir);
		const server = await startPlanReviewServer({ plan: v1, htmlContent: MINIMAL_HTML, origin: "pi", planRevisions: true });
		try {
			server.updatePlan(v2);

			const stale = await post(`${server.url}/api/approve`, { planRevision: 0, planSave: { enabled: false } });
			expect(stale.status).toBe(409);
			expect(await stale.json()).toMatchObject({ code: "plan_revised", planRevision: 1 });
			const staleDeny = await post(`${server.url}/api/deny`, { planRevision: 0, feedback: "no", planSave: { enabled: false } });
			expect(staleDeny.status).toBe(409);
			expect((await getJson(`${server.url}/api/plan/revision`)).decided).toBe(false);

			const ok = await post(`${server.url}/api/approve`, { planRevision: 1, planSave: { enabled: true, customPath: dir } });
			expect(ok.status).toBe(200);
			const { savedPath } = (await ok.json()) as { savedPath?: string };
			expect(savedPath).toBeTruthy();
			expect(readFileSync(savedPath!, "utf-8")).toContain("Second step.");
			expect((await server.waitForDecision()).approved).toBe(true);

			// Settled: a later push is the caller's cue to open a new review.
			expect(server.updatePlan(`${v2}\nMore.\n`)).toBeNull();
		} finally {
			server.stop();
		}
	});

	test("a decision body without planRevision (older client) is accepted", async () => {
		const { v1, v2 } = planPair();
		const server = await startPlanReviewServer({ plan: v1, htmlContent: MINIMAL_HTML, origin: "pi", planRevisions: true });
		try {
			server.updatePlan(v2);
			const response = await post(`${server.url}/api/deny`, { feedback: "Split it.", planSave: { enabled: false } });
			expect(response.status).toBe(200);
			expect(await server.waitForDecision()).toMatchObject({ approved: false, feedback: "Split it." });
		} finally {
			server.stop();
		}
	});
});
