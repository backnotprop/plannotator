/**
 * #1864: a decision reaches code another extension instance owns (the
 * event API's review-result emit). After /reload or a session switch that
 * code throws Pi's stale-ctx error SYNCHRONOUSLY. The decision is published
 * from inside the HTTP handler, so a throw that escapes there is an uncaught
 * error that ends the whole Pi process.
 *
 * What regresses if this fails:
 *  - a throwing decision listener crashes Pi (or fails the reviewer's POST);
 *  - a plan review closed because its session ended leaves the open tab
 *    offering a decision nobody can receive (no `session-closed` event, or a
 *    late decision accepted).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAnnotateServer } from "./serverAnnotate.ts";
import { startPlanReviewServer } from "./serverPlan.ts";
import { startReviewServer } from "./serverReview.ts";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const STALE_MESSAGE = "This extension ctx is stale after session replacement or reload.";
const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_AI", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_FEEDBACK_HISTORY", "PLANNOTATOR_ANNOTATE_HISTORY"] as const;

async function sandboxed(run: () => Promise<void>): Promise<void> {
	const saved: Record<string, string | undefined> = {};
	for (const key of ENV_KEYS) saved[key] = process.env[key];
	const dataDir = mkdtempSync(join(tmpdir(), "plannotator-pi-decision-listener-"));
	try {
		process.env.PLANNOTATOR_DATA_DIR = dataDir;
		process.env.PLANNOTATOR_AI = "disabled";
		process.env.PLANNOTATOR_REMOTE = "0";
		process.env.PLANNOTATOR_FEEDBACK_HISTORY = "0";
		process.env.PLANNOTATOR_ANNOTATE_HISTORY = "0";
		delete process.env.PLANNOTATOR_PORT;
		await run();
	} finally {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key]!;
		}
		rmSync(dataDir, { recursive: true, force: true });
	}
}

/** Collect anything the host would see as a fatal process error while `run` executes. */
async function trapFatal(run: () => Promise<void>): Promise<unknown[]> {
	const fatal: unknown[] = [];
	const onFatal = (err: unknown) => fatal.push(err);
	process.on("uncaughtException", onFatal);
	process.on("unhandledRejection", onFatal);
	try {
		await run();
		// Let any escaped microtask or timer surface before the hooks come off.
		await new Promise((resolve) => setTimeout(resolve, 50));
	} finally {
		process.off("uncaughtException", onFatal);
		process.off("unhandledRejection", onFatal);
	}
	return fatal;
}

const postJson = (url: string, body: unknown) =>
	fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function readEvent(url: string, want: (event: Record<string, unknown>) => boolean, act: () => void | Promise<void>) {
	const response = await fetch(`${url}/api/external-annotations/stream`);
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let acted = false;
	const deadline = Date.now() + 3000;
	try {
		while (Date.now() < deadline) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let index: number;
			while ((index = buffer.indexOf("\n\n")) >= 0) {
				const chunk = buffer.slice(0, index);
				buffer = buffer.slice(index + 2);
				if (!chunk.startsWith("data: ")) continue;
				const event = JSON.parse(chunk.slice(6)) as Record<string, unknown>;
				if (want(event)) return event;
			}
			// The first chunk (the snapshot) proves the stream is subscribed.
			if (!acted) {
				acted = true;
				await act();
			}
		}
		return null;
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}

describe("a decision consumer that throws synchronously never escapes the HTTP handler", () => {
	test("plan: POST /api/approve answers normally and every other listener still runs", () =>
		sandboxed(async () => {
			const server = await startPlanReviewServer({ plan: `# Throwing listener ${Math.random()}\n`, htmlContent: MINIMAL_HTML });
			const seen: string[] = [];
			try {
				const fatal = await trapFatal(async () => {
					server.onDecision(() => {
						seen.push("stale");
						throw new Error(STALE_MESSAGE);
					});
					server.onDecision((result) => {
						seen.push(result.approved ? "approved" : "denied");
					});
					const res = await postJson(`${server.url}/api/approve`, {});
					expect(res.status).toBe(200);
					expect(await res.json()).toMatchObject({ ok: true });
					expect(await server.waitForDecision()).toMatchObject({ approved: true });
				});
				expect(fatal).toEqual([]);
				expect(seen.sort()).toEqual(["approved", "stale"]);
			} finally {
				server.stop();
			}
		}));

	test("plan: a throwing listener on deny is just as harmless", () =>
		sandboxed(async () => {
			const server = await startPlanReviewServer({ plan: `# Throwing listener deny ${Math.random()}\n`, htmlContent: MINIMAL_HTML });
			try {
				const fatal = await trapFatal(async () => {
					server.onDecision(() => {
						throw new Error(STALE_MESSAGE);
					});
					const res = await postJson(`${server.url}/api/deny`, { feedback: "no" });
					expect(res.status).toBe(200);
				});
				expect(fatal).toEqual([]);
			} finally {
				server.stop();
			}
		}));

	// Review and annotate settle a promise instead of calling listeners, so a
	// consumer's synchronous throw lands in the consumer's own chain. Pinned so
	// a synchronous fan-out added to either server cannot reintroduce #1864.
	test("review: POST /api/feedback answers normally when the decision's consumer throws", () =>
		sandboxed(async () => {
			const server = await startReviewServer({ rawPatch: "diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+b\n", gitRef: "HEAD", htmlContent: MINIMAL_HTML });
			try {
				let consumerRan = false;
				const fatal = await trapFatal(async () => {
					const consumed = server.waitForDecision().then(() => {
						consumerRan = true;
						throw new Error(STALE_MESSAGE);
					}).then(() => null, (err: unknown) => err);
					const res = await postJson(`${server.url}/api/feedback`, { approved: false, feedback: "fix it", annotations: [] });
					expect(res.status).toBe(200);
					expect(((await consumed) as Error).message).toBe(STALE_MESSAGE);
				});
				expect(fatal).toEqual([]);
				expect(consumerRan).toBe(true);
			} finally {
				server.stop();
			}
		}));

	test("annotate: POST /api/feedback answers normally when the decision's consumer throws", () =>
		sandboxed(async () => {
			const server = await startAnnotateServer({
				markdown: `# Throwing consumer ${Math.random()}`,
				filePath: join(tmpdir(), "notes.md"),
				htmlContent: MINIMAL_HTML,
			});
			try {
				let consumerRan = false;
				const fatal = await trapFatal(async () => {
					const consumed = server.waitForDecision().then(() => {
						consumerRan = true;
						throw new Error(STALE_MESSAGE);
					}).then(() => null, (err: unknown) => err);
					const res = await postJson(`${server.url}/api/feedback`, { feedback: "note", annotations: [] });
					expect(res.status).toBe(200);
					expect(((await consumed) as Error).message).toBe(STALE_MESSAGE);
				});
				expect(fatal).toEqual([]);
				expect(consumerRan).toBe(true);
			} finally {
				server.stop();
			}
		}));
});

describe("plan: closeKeepingDraft (the session that opened the review ended)", () => {
	test("tells the open tab, keeps the draft, and refuses a late decision", () =>
		sandboxed(async () => {
			const server = await startPlanReviewServer({ plan: `# Closed plan ${Math.random()}\n`, htmlContent: MINIMAL_HTML });
			const decided: unknown[] = [];
			server.onDecision((result) => {
				decided.push(result);
			});
			try {
				await postJson(`${server.url}/api/draft`, { annotations: [{ id: "a1" }, { id: "a2" }], globalAttachments: [] });
				const event = await readEvent(server.url, (e) => e.type === "session-closed", () => {
					expect(server.closeKeepingDraft()).toEqual({ closed: true, unsentAnnotations: 2 });
				});
				// "session", not "agent": plan mode or the Pi session ended; nobody asked to close it.
				expect(event).toEqual({ type: "session-closed", by: "session", unsentAnnotations: 2 });

				const late = await postJson(`${server.url}/api/approve`, {});
				expect(late.status).toBe(409);
				expect((await postJson(`${server.url}/api/deny`, { feedback: "late" })).status).toBe(409);
				expect(server.updatePlan("# Revised\n")).toBeNull();
				expect(decided).toEqual([]);
				expect((await (await fetch(`${server.url}/api/draft`)).json()).annotations).toHaveLength(2);
				expect(server.closeKeepingDraft()).toEqual({ closed: false, reason: "decided" });
			} finally {
				server.stop();
			}
		}));

	test("the tab still gets the event when the server stops right after", () =>
		sandboxed(async () => {
			const server = await startPlanReviewServer({ plan: `# Closed then stopped ${Math.random()}\n`, htmlContent: MINIMAL_HTML });
			let stopped = false;
			try {
				const event = await readEvent(server.url, (e) => e.type === "session-closed", () => {
					server.closeKeepingDraft();
					server.stop();
					stopped = true;
				});
				expect(event).toMatchObject({ type: "session-closed", by: "session" });
			} finally {
				if (!stopped) server.stop();
			}
		}));

	test("a decided review is not closed", () =>
		sandboxed(async () => {
			const server = await startPlanReviewServer({ plan: `# Decided ${Math.random()}\n`, htmlContent: MINIMAL_HTML });
			try {
				expect((await postJson(`${server.url}/api/approve`, {})).status).toBe(200);
				expect(server.closeKeepingDraft()).toEqual({ closed: false, reason: "decided" });
			} finally {
				server.stop();
			}
		}));
});
