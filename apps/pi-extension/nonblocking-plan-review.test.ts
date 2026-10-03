/**
 * Non-blocking Pi plan review: plannotator_submit_plan returns once the
 * review is open, and the reviewer's decision arrives later as a session
 * message. Driven through the real extension with a fake review session.
 *
 * What regresses if this fails:
 *  - the tool blocks again until the reviewer decides (Ask this session and
 *    ordinary chat stall for the whole review);
 *  - the agent gains write access before approval (planning restrictions
 *    lifted on submit instead of on approval);
 *  - an approval / deny / answers-only decision never reaches the agent, or
 *    reaches it with the wrong prompt;
 *  - a revision submitted while the review is open opens a second tab
 *    instead of updating the open one;
 *  - leaving plan mode leaves the review open, and its decision later yanks
 *    the session back into execution.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plannotator, { type PlannotatorExtensionDeps } from "./index.ts";
import type { PlanReviewDecision } from "./plannotator-browser.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

interface FakeReview {
	plan: string;
	decide: (result: PlanReviewDecision) => void;
	stopped: boolean;
	pushes: string[];
	decided: boolean;
	/** The server accepted a decision and is still recording it (updatePlan refuses). */
	claimed: boolean;
}

function createHarness(cwd: string) {
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<any> }>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const entries: Array<{ type: string; data: any }> = [];
	const sentUserMessages: Array<{ text: string; options: unknown }> = [];
	const reviews: FakeReview[] = [];
	const state = { activeTools: ["read", "bash", "edit", "write"] };

	const pi = {
		events: { on: () => undefined, emit: () => undefined },
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerFlag: () => undefined,
		registerShortcut: () => undefined,
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(tool.name, tool),
		getFlag: () => true,
		getActiveTools: () => [...state.activeTools],
		setActiveTools: (next: string[]) => { state.activeTools = [...next]; },
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => undefined,
		setModel: async () => true,
		getCommands: () => [],
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
		sendMessage: () => undefined,
		sendUserMessage: (text: string, options: unknown) => sentUserMessages.push({ text, options }),
	};

	const ctx = {
		cwd,
		hasUI: true,
		mode: "tui",
		isProjectTrusted: () => true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => undefined,
		model: undefined,
		modelRegistry: { find: () => undefined },
		sessionManager: {
			getBranch: () => [],
			getEntries: () => [],
			getSessionId: () => "test-session",
			getSessionFile: () => null,
			getSessionName: () => undefined,
		},
		ui: {
			notify: () => undefined,
			setStatus: () => undefined,
			setWidget: () => undefined,
			theme: { fg: (_color: string, text: string) => text, strikethrough: (text: string) => text },
		},
	};

	const startPlanReview: NonNullable<PlannotatorExtensionDeps["startPlanReview"]> = async (_ctx, planContent) => {
		let resolve!: (result: PlanReviewDecision) => void;
		let reject!: (err: Error) => void;
		const decision = new Promise<PlanReviewDecision>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		const review: FakeReview = {
			plan: planContent,
			stopped: false,
			pushes: [],
			decided: false,
			claimed: false,
			decide: (result) => {
				review.decided = true;
				resolve(result);
			},
		};
		reviews.push(review);
		return {
			url: `http://localhost:${4000 + reviews.length}`,
			reviewId: `review-${reviews.length}`,
			waitForDecision: () => decision,
			onDecision: () => () => undefined,
			stop: () => {
				if (review.stopped) return;
				review.stopped = true;
				const err = new Error("Plannotator browser session was stopped.");
				err.name = "PlannotatorBrowserSessionStopped";
				reject(err);
			},
			updatePlan: (plan: string) => {
				if (review.decided || review.claimed || review.stopped) return null;
				if (plan === review.plan) return { revision: review.pushes.length, version: review.pushes.length + 1, unchanged: true };
				review.plan = plan;
				review.pushes.push(plan);
				return { revision: review.pushes.length, version: review.pushes.length + 1, unchanged: false };
			},
		} as never;
	};

	const lastPhase = () => {
		const persisted = entries.filter((entry) => entry.type === "plannotator");
		return persisted.at(-1)?.data?.phase as string | undefined;
	};

	return {
		ctx,
		reviews,
		entries,
		sentUserMessages,
		lastPhase,
		async start() {
			plannotator(pi as never, { startPlanReview, hasPlanBrowserHtml: () => true });
			for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
		},
		submit(filePath: string) {
			return tools.get("plannotator_submit_plan")!.execute("call-1", { filePath }, undefined, undefined, ctx);
		},
		markDone(step: number) {
			return tools.get("plannotator_mark_done")!.execute("call-2", { step }, undefined, undefined, ctx);
		},
		async beforeAgentStart() {
			const results = [];
			for (const handler of handlers.get("before_agent_start") ?? []) results.push(await handler({}, ctx));
			return results as Array<{ message?: { content?: string } } | undefined>;
		},
		async writeAttempt(path: string) {
			for (const handler of handlers.get("tool_call") ?? []) {
				const result = await handler({ toolName: "write", input: { path } }, ctx);
				if (result) return result as { block?: boolean };
			}
			return undefined;
		},
		async togglePlanMode() {
			await commands.get("plannotator-plan-mode")!.handler("", ctx);
		},
		async settle(until: () => boolean) {
			for (let i = 0; i < 50 && !until(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
		},
	};
}

const PLAN = "# Plan\n\n- [ ] Implement the change\n";

async function plannedSession() {
	const cwd = makeTempDir("plannotator-nonblocking-");
	writeFileSync(join(cwd, "PLAN.md"), PLAN);
	const harness = createHarness(cwd);
	await harness.start();
	return { cwd, harness };
}

describe("non-blocking plan review", () => {
	test("submit returns while the review is open and planning restrictions stay on", async () => {
		const { harness } = await plannedSession();
		const result = await harness.submit("PLAN.md");

		expect(result.details).toMatchObject({ approved: false, pending: true });
		expect(result.terminate).toBe(true);
		expect(harness.reviews).toHaveLength(1);
		expect(harness.sentUserMessages).toEqual([]);
		expect(harness.lastPhase()).toBe("planning");
		expect((await harness.writeAttempt("src/app.ts"))?.block).toBe(true);
	});

	test("approval arrives as a message that starts execution", async () => {
		const { harness } = await plannedSession();
		await harness.submit("PLAN.md");

		harness.reviews[0]!.decide({ approved: true });
		await harness.settle(() => harness.sentUserMessages.length > 0);

		expect(harness.sentUserMessages).toHaveLength(1);
		expect(harness.sentUserMessages[0]!.text).toContain("Plan approved");
		expect(harness.sentUserMessages[0]!.text).toContain("PLAN.md");
		expect(harness.sentUserMessages[0]!.options).toEqual({ deliverAs: "followUp" });
		expect(harness.lastPhase()).toBe("executing");
		expect(harness.entries).toContainEqual({ type: "plannotator-execute", data: { lastSubmittedPath: "PLAN.md", approvedPlan: PLAN } });
		// The file still holds the approved text: no unreviewed-edit warning.
		expect(harness.sentUserMessages[0]!.text).not.toContain("has changed since the reviewer saw it");
		expect(await harness.writeAttempt("src/app.ts")).toBeUndefined();
	});

	test("a deny arrives as the denied prompt and keeps planning; an answers-only deny uses the answered prompt", async () => {
		const { harness } = await plannedSession();
		await harness.submit("PLAN.md");
		harness.reviews[0]!.decide({ approved: false, feedback: "Split step one." });
		await harness.settle(() => harness.sentUserMessages.length > 0);

		expect(harness.sentUserMessages[0]!.text).toContain("NOT APPROVED");
		expect(harness.sentUserMessages[0]!.text).toContain("Split step one.");
		expect(harness.lastPhase()).toBe("planning");

		// The resubmission opens a new review: the first one is decided.
		await harness.submit("PLAN.md");
		expect(harness.reviews).toHaveLength(2);
		harness.reviews[1]!.decide({ approved: false, feedback: "## Answers", answersOnly: true });
		await harness.settle(() => harness.sentUserMessages.length > 1);
		expect(harness.sentUserMessages[1]!.text).toContain("answered the questions");
		expect(harness.sentUserMessages[1]!.text).not.toContain("NOT APPROVED");
	});

	test("a revision while the review is open updates that review instead of opening another", async () => {
		const { cwd, harness } = await plannedSession();
		await harness.submit("PLAN.md");
		const revised = `${PLAN}- [ ] Add a test\n`;
		writeFileSync(join(cwd, "PLAN.md"), revised);

		const result = await harness.submit("PLAN.md");
		expect(result.details).toMatchObject({ pending: true, revised: true });
		expect(harness.reviews).toHaveLength(1);
		expect(harness.reviews[0]!.pushes).toEqual([revised]);

		// The approval executes the revised checklist.
		harness.reviews[0]!.decide({ approved: true });
		await harness.settle(() => harness.sentUserMessages.length > 0);
		expect(harness.sentUserMessages[0]!.text).toContain("plannotator_mark_done");
		expect(harness.lastPhase()).toBe("executing");
	});

	test("a revision submitted while a decision is being recorded keeps that decision", async () => {
		const { cwd, harness } = await plannedSession();
		await harness.submit("PLAN.md");
		// The reviewer denied; the server is still recording it (note integrations).
		harness.reviews[0]!.claimed = true;
		writeFileSync(join(cwd, "PLAN.md"), `${PLAN}- [ ] Add a test\n`);

		const result = await harness.submit("PLAN.md");
		expect(result.details).toMatchObject({ pending: true, decisionInFlight: true });
		expect(result.terminate).toBe(true);
		// No second review, and the first one is not stopped (that would drop the deny).
		expect(harness.reviews).toHaveLength(1);
		expect(harness.reviews[0]!.stopped).toBe(false);

		harness.reviews[0]!.decide({ approved: false, feedback: "Split step one." });
		await harness.settle(() => harness.sentUserMessages.length > 0);
		expect(harness.sentUserMessages[0]!.text).toContain("Split step one.");
		expect(harness.lastPhase()).toBe("planning");
	});

	test("approval carries the approved text; unreviewed file edits are flagged and never executed", async () => {
		const { cwd, harness } = await plannedSession();
		await harness.submit("PLAN.md");
		// The agent edits the file after submitting; the reviewer approves the
		// version on screen (the server names it on the decision).
		const unreviewed = `${PLAN}- [ ] Drop the production database\n`;
		writeFileSync(join(cwd, "PLAN.md"), unreviewed);
		harness.reviews[0]!.decide({ approved: true, plan: PLAN });
		await harness.settle(() => harness.sentUserMessages.length > 0);

		const message = harness.sentUserMessages[0]!.text;
		expect(message).toContain("## Approved plan");
		expect(message).toContain("- [ ] Implement the change");
		expect(message).toContain("PLAN.md has changed since the reviewer saw it");
		expect(message).not.toContain("Drop the production database");
		expect(harness.entries).toContainEqual({ type: "plannotator-execute", data: { lastSubmittedPath: "PLAN.md", approvedPlan: PLAN } });

		// The execution turn's framing lists the approved steps, not the file's.
		const framing = (await harness.beforeAgentStart()).map((result) => result?.message?.content ?? "").join("\n");
		expect(framing).toContain("Implement the change");
		expect(framing).not.toContain("Drop the production database");

		// Progress is never written onto the unreviewed file's boxes.
		const done = await harness.markDone(1);
		expect(done.details).toMatchObject({ completed: true, step: 1 });
		expect(readFileSync(join(cwd, "PLAN.md"), "utf-8")).toBe(unreviewed);
	});

	test("approval falls back to the open review's text when the decision names none", async () => {
		const { harness } = await plannedSession();
		await harness.submit("PLAN.md");
		harness.reviews[0]!.decide({ approved: true });
		await harness.settle(() => harness.sentUserMessages.length > 0);
		expect(harness.sentUserMessages[0]!.text).toContain("- [ ] Implement the change");
		// Progress persists into the file while it still holds the approved checklist.
		await harness.markDone(1);
		expect(readFileSync(join(harness.ctx.cwd, "PLAN.md"), "utf-8")).toContain("- [x] Implement the change");
	});

	test("leaving plan mode closes the open review and its decision is dropped", async () => {
		const { harness } = await plannedSession();
		await harness.submit("PLAN.md");

		await harness.togglePlanMode();
		expect(harness.reviews[0]!.stopped).toBe(true);
		expect(harness.lastPhase()).toBe("idle");

		harness.reviews[0]!.decide({ approved: true });
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(harness.sentUserMessages).toEqual([]);
		expect(harness.lastPhase()).toBe("idle");
	});
});
