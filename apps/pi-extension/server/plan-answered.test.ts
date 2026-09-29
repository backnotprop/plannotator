/**
 * Pi mirror of packages/server/plan-answered.test.ts: the Pi plan server
 * carries `answersOnly` from /api/deny to the decision, and the vendored
 * prompts pick `plan.answered` for it.
 *
 * What regresses if this fails: on Pi, Send answers reaches the agent as
 * "YOUR PLAN WAS NOT APPROVED", or an ordinary deny changes wording.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPlanReviewServer } from "./serverPlan.ts";
import { detectProjectName } from "./project.ts";
import { generateSlug, getPlanVersionPath } from "../generated/storage.ts";
import {
	buildPlanFileRule,
	composePlanDeniedMessage,
	getPlanDeniedPrompt,
	getPlanToolName,
} from "../generated/prompts.ts";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_AI", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_FEEDBACK_HISTORY"] as const;
const saved: Record<string, string | undefined> = {};
const tempDirs: string[] = [];
const createdPlans: string[] = [];

beforeEach(() => {
	for (const key of ENV_KEYS) saved[key] = process.env[key];
	const dir = mkdtempSync(join(tmpdir(), "plannotator-pi-plan-answered-"));
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
	// Plan version history goes through generated/storage.ts, whose data dir is
	// fixed at import time; remove the slugs these tests created there.
	const project = detectProjectName();
	for (const plan of createdPlans) {
		const versionPath = getPlanVersionPath(project, generateSlug(plan), 1);
		if (versionPath) rmSync(join(versionPath, ".."), { recursive: true, force: true });
	}
});

async function denyWith(body: Record<string, unknown>) {
	const plan = `# Pi plan answered test ${Math.random().toString(36).slice(2, 10)}\n\nStep one.\n`;
	createdPlans.push(plan);
	const server = await startPlanReviewServer({ plan, htmlContent: MINIMAL_HTML, origin: "pi" });
	try {
		const response = await fetch(`${server.url}/api/deny`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ planSave: { enabled: false }, ...body }),
		});
		expect(response.status).toBe(200);
		return await server.waitForDecision();
	} finally {
		server.stop();
	}
}

// Exactly what apps/pi-extension/index.ts sends back to the agent on deny.
const piMessage = (decision: { feedback?: string; answersOnly?: boolean }) =>
	composePlanDeniedMessage("pi", {}, {
		toolName: getPlanToolName("pi"),
		planFileRule: buildPlanFileRule(getPlanToolName("pi"), "PLAN.md"),
		feedback: decision.feedback || "Plan rejected. Please revise.",
	}, { answersOnly: decision.answersOnly });

describe("pi plan /api/deny answersOnly", () => {
	const answers = "# Plan Feedback\n\n## Answers to your questions\n\n1 of 1 question answered.\n";

	test("answersOnly: true reaches the decision and selects the answered prompt", async () => {
		const decision = await denyWith({ feedback: answers, answersOnly: true });
		expect(decision.approved).toBe(false);
		expect(decision.answersOnly).toBe(true);
		const message = piMessage(decision);
		expect(message).not.toContain("NOT APPROVED");
		expect(message).toContain("answered the questions");
		expect(message).toContain("plannotator_submit_plan");
		expect(message).toContain("PLAN.md");
		expect(message).toContain(answers);
	});

	test("an ordinary deny carries no flag and its message is the denied prompt, unchanged", async () => {
		const decision = await denyWith({ feedback: "Split step one." });
		expect("answersOnly" in decision).toBe(false);
		expect(piMessage(decision)).toBe(getPlanDeniedPrompt("pi", {}, {
			toolName: "plannotator_submit_plan",
			planFileRule: buildPlanFileRule("plannotator_submit_plan", "PLAN.md"),
			feedback: "Split step one.",
		}));
	});

	test("only a boolean true counts", async () => {
		const decision = await denyWith({ feedback: answers, answersOnly: 1 });
		expect("answersOnly" in decision).toBe(false);
	});
});
