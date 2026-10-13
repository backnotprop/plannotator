/**
 * The shared `plannotator:request` event API across a session replacement
 * (#1864). A `plan-review` opened through it used to keep its server after
 * /reload; a decision from that tab ran the replaced runtime's listener,
 * whose `pi.events.emit` threw Pi's stale-ctx error inside the HTTP handler
 * and ended the Pi process.
 *
 * Driven with the real Pi plan server behind a fake Pi whose bus throws the
 * stale-ctx error once the runtime is replaced.
 *
 * What regresses if this fails:
 *  - a decision arriving after the runtime went stale crashes Pi, or is not
 *    recorded for `review-status`;
 *  - a tab left open across /reload stops recording its decision for
 *    `review-status` (the README's recovery promise), or its decision is
 *    emitted onto the replaced runtime's dead bus.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PLANNOTATOR_REQUEST_CHANNEL,
	PLANNOTATOR_REVIEW_RESULT_CHANNEL,
	registerPlannotatorEventListeners,
	writeReviewStatusesAtomically,
	type PlannotatorReviewStatusResult,
} from "./plannotator-events.ts";
import { startPlanReviewServer, type PlanServerResult } from "./server/serverPlan.ts";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const STALE_MESSAGE =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";
const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_AI", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_FEEDBACK_HISTORY"] as const;

const tempDirs: string[] = [];
const servers: PlanServerResult[] = [];
const savedEnv: Record<string, string | undefined> = {};

function sandbox(): string {
	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
	const dir = mkdtempSync(join(tmpdir(), "plannotator-pi-events-"));
	tempDirs.push(dir);
	process.env.PLANNOTATOR_DATA_DIR = join(dir, "data");
	process.env.PLANNOTATOR_AI = "disabled";
	process.env.PLANNOTATOR_REMOTE = "0";
	process.env.PLANNOTATOR_FEEDBACK_HISTORY = "0";
	delete process.env.PLANNOTATOR_PORT;
	return dir;
}

afterEach(() => {
	for (const server of servers.splice(0)) server.stop();
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key]!;
	}
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Handler = (data: unknown, ctx?: unknown) => unknown;

function createHarness(dir: string) {
	const sessionHandlers = new Map<string, Handler[]>();
	const busHandlers = new Map<string, Handler[]>();
	const results: unknown[] = [];
	let stale = false;
	const pi = {
		on: (event: string, handler: Handler) => sessionHandlers.set(event, [...(sessionHandlers.get(event) ?? []), handler]),
		events: {
			on: (channel: string, handler: Handler) => busHandlers.set(channel, [...(busHandlers.get(channel) ?? []), handler]),
			// Pi's guard: a replaced runtime's bus throws synchronously.
			emit: (channel: string, data: unknown) => {
				if (stale) throw new Error(STALE_MESSAGE);
				if (channel === PLANNOTATOR_REVIEW_RESULT_CHANNEL) results.push(data);
				for (const handler of busHandlers.get(channel) ?? []) void handler(data);
			},
		},
	};
	registerPlannotatorEventListeners(pi as never, {
		reviewStatusPath: join(dir, "review-status.json"),
		startPlanReviewSession: async (_ctx, planContent) => {
			const server = await startPlanReviewServer({ plan: planContent, htmlContent: MINIMAL_HTML });
			servers.push(server);
			return {
				url: server.url,
				reviewId: server.reviewId,
				waitForDecision: server.waitForDecision,
				stop: server.stop,
				hostControl: server.hostControl,
				onDecision: server.onDecision,
				updatePlan: server.updatePlan,
				closeKeepingDraft: server.closeKeepingDraft,
			};
		},
	});

	/** Send a request straight to the listener (the bus may be stale) and wait for its answer. */
	const request = (action: string, payload: unknown) =>
		new Promise<any>((resolve) => {
			for (const handler of busHandlers.get(PLANNOTATOR_REQUEST_CHANNEL) ?? []) {
				void handler({ requestId: `r-${Math.random()}`, action, payload, respond: resolve });
			}
		});

	return {
		results,
		request,
		async startSession() {
			for (const handler of sessionHandlers.get("session_start") ?? []) await handler({ reason: "startup" }, { hasUI: true, cwd: dir });
		},
		async shutdown() {
			for (const handler of sessionHandlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "reload" });
			stale = true;
		},
		/** A teardown that never reaches our session_shutdown handler. */
		goStale() {
			stale = true;
		},
		async reviewStatus(reviewId: string): Promise<PlannotatorReviewStatusResult> {
			const response = await request("review-status", { reviewId });
			return response.result;
		},
	};
}

async function openPlanReview(harness: ReturnType<typeof createHarness>, title: string) {
	const response = await harness.request("plan-review", { planContent: `# ${title} ${Math.random()}\n` });
	expect(response).toMatchObject({ status: "handled", result: { status: "pending" } });
	const reviewId: string = response.result.reviewId;
	const server = servers.find((s) => s.reviewId === reviewId)!;
	return { reviewId, url: server.url };
}

async function trapFatal(run: () => Promise<void>): Promise<unknown[]> {
	const fatal: unknown[] = [];
	const onFatal = (err: unknown) => fatal.push(err);
	process.on("uncaughtException", onFatal);
	process.on("unhandledRejection", onFatal);
	try {
		await run();
		await new Promise((resolve) => setTimeout(resolve, 50));
	} finally {
		process.off("uncaughtException", onFatal);
		process.off("unhandledRejection", onFatal);
	}
	return fatal;
}

async function captureErrors<T>(run: () => Promise<T>): Promise<{ value: T; logged: string[] }> {
	const logged: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => {
		logged.push(args.map(String).join(" "));
	};
	try {
		return { value: await run(), logged };
	} finally {
		console.error = original;
	}
}

const postJson = (url: string, body: unknown) =>
	fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("plannotator:request plan-review across a session replacement", () => {
	test("a decision after the runtime went stale is answered, recorded, and does not crash Pi", async () => {
		const dir = sandbox();
		const harness = createHarness(dir);
		await harness.startSession();
		const { reviewId, url } = await openPlanReview(harness, "Stale emit");

		// The issue's path: the runtime was replaced and its bus now throws.
		harness.goStale();
		const { logged } = await captureErrors(async () => {
			const fatal = await trapFatal(async () => {
				const res = await postJson(`${url}/api/approve`, { feedback: "ship it" });
				expect(res.status).toBe(200);
			});
			expect(fatal).toEqual([]);
		});
		// The emit's own guard caught it (not only publishDecision's backstop).
		expect(logged.some((line) => line.includes(`could not emit the review result for ${reviewId}`))).toBe(true);
		expect(await harness.reviewStatus(reviewId)).toMatchObject({ status: "completed", reviewId, approved: true, feedback: "ship it" });
	});

	test("a decision on a live session still emits the review result", async () => {
		const dir = sandbox();
		const harness = createHarness(dir);
		await harness.startSession();
		const { reviewId, url } = await openPlanReview(harness, "Live emit");
		expect((await postJson(`${url}/api/deny`, { feedback: "rework" })).status).toBe(200);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(harness.results).toEqual([expect.objectContaining({ reviewId, approved: false, feedback: "rework" })]);
	});

	// The README promises `review-status` lets a caller recover across session
	// restarts, so the tab stays usable after /reload: its decision is recorded
	// for the replacement to read, and nothing is emitted onto the dead bus.
	test("after session end the tab still decides: recorded for review-status, never emitted", async () => {
		const dir = sandbox();
		const harness = createHarness(dir);
		await harness.startSession();
		const decided = await openPlanReview(harness, "Decided before");
		const open = await openPlanReview(harness, "Still open");
		expect((await postJson(`${decided.url}/api/approve`, {})).status).toBe(200);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(harness.results).toHaveLength(1);

		await harness.shutdown(); // /reload: shutdown, then the runtime goes stale
		const { logged } = await captureErrors(async () => {
			const fatal = await trapFatal(async () => {
				const res = await postJson(`${open.url}/api/approve`, { feedback: "after reload" });
				expect(res.status).toBe(200);
			});
			expect(fatal).toEqual([]);
		});
		// Not attempted at all (a stale emit would have been logged).
		expect(logged.filter((line) => line.includes("could not emit"))).toEqual([]);
		expect(harness.results).toHaveLength(1);
		expect(await harness.reviewStatus(open.reviewId)).toMatchObject({ status: "completed", approved: true, feedback: "after reload" });
		expect(await harness.reviewStatus(decided.reviewId)).toMatchObject({ status: "completed", approved: true });
	});
});

// review-status is the recovery path across restarts, so its file must never
// be torn by a crash mid-write, nor wiped when it cannot be read.
describe("review-status file", () => {
	test("a decision is written through a temp file and rename, leaving no temp behind", async () => {
		const dir = sandbox();
		const harness = createHarness(dir);
		await harness.startSession();
		const { reviewId, url } = await openPlanReview(harness, "Atomic write");
		expect((await postJson(`${url}/api/approve`, {})).status).toBe(200);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(readdirSync(dir).filter((name) => name.startsWith("review-status"))).toEqual(["review-status.json"]);
		const stored = JSON.parse(readFileSync(join(dir, "review-status.json"), "utf-8"));
		expect(stored[reviewId]).toMatchObject({ status: "completed", approved: true });
	});

	test("a failed write removes its temp file and leaves the old file", () => {
		const dir = sandbox();
		// A non-empty directory where the file should be: the rename fails.
		const target = join(dir, "status.json");
		mkdirSync(target);
		writeFileSync(join(target, "keep"), "x");
		expect(() => writeReviewStatusesAtomically(target, { r: { status: "pending" } })).toThrow();
		expect(readdirSync(dir)).toEqual(["status.json"]);
		expect(readdirSync(target)).toEqual(["keep"]);
	});

	test("a file that cannot be parsed is kept as it is, never replaced with only the new review", async () => {
		const dir = sandbox();
		const statusPath = join(dir, "review-status.json");
		const torn = '{"older-review":{"status":"completed","reviewId":"older-review","approved":tr';
		writeFileSync(statusPath, torn);
		const harness = createHarness(dir);
		await harness.startSession();
		const { logged, value: reviewId } = await captureErrors(async () => {
			const opened = await openPlanReview(harness, "Torn file");
			expect((await postJson(`${opened.url}/api/deny`, { feedback: "no" })).status).toBe(200);
			await new Promise((resolve) => setTimeout(resolve, 20));
			return opened.reviewId;
		});
		expect(readFileSync(statusPath, "utf-8")).toBe(torn);
		expect(logged.some((line) => line.includes(statusPath) && line.includes(reviewId))).toBe(true);
		expect(await harness.reviewStatus(reviewId)).toEqual({ status: "missing" });
	});
});
