import { describe, expect, test } from "bun:test";
import {
	openArchiveBrowserAction,
	startCodeReviewBrowserSession,
	startBrowserDecisionSession,
	startLastMessageAnnotationSession,
	startMarkdownAnnotationSession,
	startPlanReviewBrowserSession,
	stopActiveBrowserDecisionSessions,
	trackBrowserDecisionSessionStart,
	shouldUseLocalPrCheckout,
} from "./plannotator-browser.ts";
import { loadPlannotatorBrowser } from "./plannotator-browser-runtime.ts";
import {
	resumePlannotatorBrowserSessions,
	stopActivePlannotatorBrowserSessions,
} from "./plannotator-events.ts";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const presenterFixture = fileURLToPath(
	new URL(
		"../../packages/shared/test-fixtures/presenter-fixture.mjs",
		import.meta.url,
	),
);
if (process.platform !== "win32") chmodSync(presenterFixture, 0o755);

async function waitForRequestCount(logPath: string, expectedCount: number): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if (existsSync(logPath)) {
			const requests = readFileSync(logPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
			if (requests.length >= expectedCount) return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${expectedCount} presenter requests.`);
}

describe("shouldUseLocalPrCheckout", () => {
	test("uses local PR checkout by default", () => {
		expect(shouldUseLocalPrCheckout({})).toBe(true);
		expect(shouldUseLocalPrCheckout({ useLocal: true })).toBe(true);
	});

	test("honors the Pi --no-local opt-out", () => {
		expect(shouldUseLocalPrCheckout({ useLocal: false })).toBe(false);
	});
});

describe.skipIf(process.platform === "win32")("Pi presenter lifecycle", () => {
	test("preserves the decision result and dismisses the exact presentation", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "plannotator-pi-presenter-"));
		const logPath = join(tempDir, "requests.jsonl");
		const originalPresenter = process.env.PLANNOTATOR_PRESENTER;
		const originalLog = process.env.PLANNOTATOR_TEST_PRESENTER_LOG;
		const originalMode = process.env.PLANNOTATOR_TEST_PRESENTER_MODE;
		process.env.PLANNOTATOR_PRESENTER = presenterFixture;
		process.env.PLANNOTATOR_TEST_PRESENTER_LOG = logPath;
		delete process.env.PLANNOTATOR_TEST_PRESENTER_MODE;

		let serverStops = 0;
		const server = {
			url: "http://localhost:45678",
			stop: () => {
				serverStops += 1;
			},
		};
		const notifications: string[] = [];
		const ctx = {
			ui: {
				notify: (message: string) => notifications.push(message),
			},
		} as unknown as Parameters<typeof startBrowserDecisionSession>[1];

		try {
			const session = startBrowserDecisionSession(
				server,
				ctx,
				async () => ({ approved: true, feedback: "ship it" }),
				"plan",
			);
			await expect(session.waitForDecision()).resolves.toEqual({
				approved: true,
				feedback: "ship it",
			});

			const requests = readFileSync(logPath, "utf8")
				.trim()
				.split(/\r?\n/)
				.map((line) => JSON.parse(line));
			expect(requests).toEqual([
				{
					protocol: 1,
					action: "present",
					url: server.url,
					kind: "plan",
				},
				{
					protocol: 1,
					action: "dismiss",
					handle: { fixture: server.url, kind: "plan" },
				},
			]);
			expect(serverStops).toBe(1);
			expect(notifications).toEqual([]);
		} finally {
			if (originalPresenter === undefined) {
				delete process.env.PLANNOTATOR_PRESENTER;
			} else {
				process.env.PLANNOTATOR_PRESENTER = originalPresenter;
			}
			if (originalLog === undefined) {
				delete process.env.PLANNOTATOR_TEST_PRESENTER_LOG;
			} else {
				process.env.PLANNOTATOR_TEST_PRESENTER_LOG = originalLog;
			}
			if (originalMode === undefined) {
				delete process.env.PLANNOTATOR_TEST_PRESENTER_MODE;
			} else {
				process.env.PLANNOTATOR_TEST_PRESENTER_MODE = originalMode;
			}
			rmSync(tempDir, { recursive: true, force: true });
		}
	}, 10_000);

	test("stopping a pending presentation prevents a late browser fallback", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "plannotator-pi-cancel-"));
		const browserPath = join(tempDir, "browser.sh");
		const browserLog = join(tempDir, "browser.log");
		writeFileSync(
			browserPath,
			"#!/bin/sh\nprintf '%s\\n' \"$1\" > \"$PLANNOTATOR_TEST_BROWSER_LOG\"\n",
			"utf8",
		);
		chmodSync(browserPath, 0o755);

		const originalPresenter = process.env.PLANNOTATOR_PRESENTER;
		const originalBrowser = process.env.BROWSER;
		const originalPlannotatorBrowser = process.env.PLANNOTATOR_BROWSER;
		const originalBrowserLog = process.env.PLANNOTATOR_TEST_BROWSER_LOG;
		const originalMode = process.env.PLANNOTATOR_TEST_PRESENTER_MODE;
		process.env.PLANNOTATOR_PRESENTER = presenterFixture;
		process.env.PLANNOTATOR_TEST_PRESENTER_MODE = "hang";
		process.env.BROWSER = browserPath;
		delete process.env.PLANNOTATOR_BROWSER;
		process.env.PLANNOTATOR_TEST_BROWSER_LOG = browserLog;

		let serverStops = 0;
		const notifications: string[] = [];
		const server = {
			url: "http://localhost:45679",
			stop: () => {
				serverStops += 1;
			},
		};
		const ctx = {
			ui: {
				notify: (message: string) => notifications.push(message),
			},
		} as unknown as Parameters<typeof startBrowserDecisionSession>[1];

		try {
			const session = startBrowserDecisionSession(
				server,
				ctx,
				() => new Promise<never>(() => {}),
				"plan",
			);
			const firstStop = session.stop();
			const secondStop = session.stop();
			expect(secondStop).toBe(firstStop);
			await firstStop;

			expect(serverStops).toBe(1);
			expect(existsSync(browserLog)).toBe(false);
			expect(notifications).toEqual([]);
		} finally {
			if (originalPresenter === undefined) {
				delete process.env.PLANNOTATOR_PRESENTER;
			} else {
				process.env.PLANNOTATOR_PRESENTER = originalPresenter;
			}
			if (originalBrowser === undefined) {
				delete process.env.BROWSER;
			} else {
				process.env.BROWSER = originalBrowser;
			}
			if (originalPlannotatorBrowser === undefined) {
				delete process.env.PLANNOTATOR_BROWSER;
			} else {
				process.env.PLANNOTATOR_BROWSER = originalPlannotatorBrowser;
			}
			if (originalBrowserLog === undefined) {
				delete process.env.PLANNOTATOR_TEST_BROWSER_LOG;
			} else {
				process.env.PLANNOTATOR_TEST_BROWSER_LOG = originalBrowserLog;
			}
			if (originalMode === undefined) {
				delete process.env.PLANNOTATOR_TEST_PRESENTER_MODE;
			} else {
				process.env.PLANNOTATOR_TEST_PRESENTER_MODE = originalMode;
			}
			rmSync(tempDir, { recursive: true, force: true });
		}
	}, 10_000);

	test("the lazy shutdown wrapper awaits dismissal of every active session", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "plannotator-pi-shutdown-"));
		const logPath = join(tempDir, "requests.jsonl");
		const originalPresenter = process.env.PLANNOTATOR_PRESENTER;
		const originalLog = process.env.PLANNOTATOR_TEST_PRESENTER_LOG;
		const originalMode = process.env.PLANNOTATOR_TEST_PRESENTER_MODE;
		process.env.PLANNOTATOR_PRESENTER = presenterFixture;
		process.env.PLANNOTATOR_TEST_PRESENTER_LOG = logPath;
		delete process.env.PLANNOTATOR_TEST_PRESENTER_MODE;

		const stopCounts = [0, 0];
		const ctx = {
			ui: {
				notify: () => undefined,
			},
		} as unknown as Parameters<typeof startBrowserDecisionSession>[1];

		try {
			// Register the dynamic browser module so the production lazy wrapper
			// can clean it without changing startup behavior.
			await loadPlannotatorBrowser();
			startBrowserDecisionSession(
				{
					url: "http://localhost:45680",
					stop: () => {
						stopCounts[0] += 1;
					},
				},
				ctx,
				() => new Promise<never>(() => {}),
				"review",
			);
			startBrowserDecisionSession(
				{
					url: "http://localhost:45681",
					stop: () => {
						stopCounts[1] += 1;
					},
				},
				ctx,
				() => new Promise<never>(() => {}),
				"annotate",
			);
			await waitForRequestCount(logPath, 2);
			await new Promise((resolve) => setTimeout(resolve, 50));

			await stopActivePlannotatorBrowserSessions();
			await stopActiveBrowserDecisionSessions();

			const requests = readFileSync(logPath, "utf8")
				.trim()
				.split(/\r?\n/)
				.map((line) => JSON.parse(line));
			expect(requests).toHaveLength(4);
			expect(requests).toContainEqual(
				{
					protocol: 1,
					action: "present",
					url: "http://localhost:45680",
					kind: "review",
				},
			);
			expect(requests).toContainEqual(
				{
					protocol: 1,
					action: "present",
					url: "http://localhost:45681",
					kind: "annotate",
				},
			);
			expect(requests).toContainEqual(
				{
					protocol: 1,
					action: "dismiss",
					handle: { fixture: "http://localhost:45680", kind: "review" },
				},
			);
			expect(requests).toContainEqual(
				{
					protocol: 1,
					action: "dismiss",
					handle: { fixture: "http://localhost:45681", kind: "annotate" },
				},
			);
			expect(stopCounts).toEqual([1, 1]);
		} finally {
			await stopActiveBrowserDecisionSessions().catch(() => undefined);
			await resumePlannotatorBrowserSessions();
			if (originalPresenter === undefined) {
				delete process.env.PLANNOTATOR_PRESENTER;
			} else {
				process.env.PLANNOTATOR_PRESENTER = originalPresenter;
			}
			if (originalLog === undefined) {
				delete process.env.PLANNOTATOR_TEST_PRESENTER_LOG;
			} else {
				process.env.PLANNOTATOR_TEST_PRESENTER_LOG = originalLog;
			}
			if (originalMode === undefined) {
				delete process.env.PLANNOTATOR_TEST_PRESENTER_MODE;
			} else {
				process.env.PLANNOTATOR_TEST_PRESENTER_MODE = originalMode;
			}
			rmSync(tempDir, { recursive: true, force: true });
		}
	}, 10_000);

	test("shutdown waits for a pending server start and rejects its late session", async () => {
		let releaseStart!: () => void;
		const startReleased = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		let serverStops = 0;
		const ctx = {
			ui: {
				notify: () => undefined,
			},
		} as unknown as Parameters<typeof startBrowserDecisionSession>[1];

		try {
			await resumePlannotatorBrowserSessions();
			const startup = trackBrowserDecisionSessionStart(async () => {
				await startReleased;
				return startBrowserDecisionSession(
					{
						url: "http://localhost:45683",
						stop: () => {
							serverStops += 1;
						},
					},
					ctx,
					() => new Promise<never>(() => {}),
					"plan",
				);
			});
			let startupSettled = false;
			const observedStartup = startup
				.then(
					(session) => ({ status: "resolved" as const, session }),
					(error: unknown) => ({ status: "rejected" as const, error }),
				)
				.then((outcome) => {
					startupSettled = true;
					return outcome;
				});

			const shutdown = stopActiveBrowserDecisionSessions();
			releaseStart();
			await shutdown;
			expect(startupSettled).toBe(true);
			const outcome = await observedStartup;

			expect(outcome.status).toBe("rejected");
			if (outcome.status === "rejected") {
				if (!(outcome.error instanceof Error)) {
					throw new Error("Expected pending startup to reject with an Error.");
				}
				expect(outcome.error.message).toContain("shutting down");
			}
			expect(serverStops).toBe(1);
		} finally {
			releaseStart();
			await stopActiveBrowserDecisionSessions().catch(() => undefined);
			await resumePlannotatorBrowserSessions();
		}
	});

	test("the shutdown latch rejects every entrypoint and closes direct late registrations", async () => {
		const ctx = {
			cwd: process.cwd(),
			hasUI: true,
			ui: {
				notify: () => undefined,
				setStatus: () => undefined,
				theme: {
					fg: (_color: string, message: string) => message,
				},
			},
		} as unknown as Parameters<typeof startPlanReviewBrowserSession>[0];

		await stopActiveBrowserDecisionSessions();
		try {
			await expect(startPlanReviewBrowserSession(ctx, "# Late plan")).rejects.toThrow("shutting down");
			await expect(startCodeReviewBrowserSession(ctx)).rejects.toThrow("shutting down");
			await expect(
				startMarkdownAnnotationSession(ctx, "note.md", "Late note", "annotate"),
			).rejects.toThrow("shutting down");
			await expect(startLastMessageAnnotationSession(ctx, "Late message")).rejects.toThrow(
				"shutting down",
			);
			await expect(openArchiveBrowserAction(ctx)).rejects.toThrow("shutting down");

			let directServerStops = 0;
			expect(() =>
				startBrowserDecisionSession(
					{
						url: "http://localhost:45682",
						stop: () => {
							directServerStops += 1;
						},
					},
					ctx,
					() => new Promise<never>(() => {}),
					"plan",
				),
			).toThrow("shutting down");
			expect(directServerStops).toBe(1);
		} finally {
			await resumePlannotatorBrowserSessions();
		}

		const unavailableCtx = {
			...ctx,
			hasUI: false,
		} as unknown as Parameters<typeof startPlanReviewBrowserSession>[0];
		await expect(startPlanReviewBrowserSession(unavailableCtx, "# Next session")).rejects.toThrow(
			"unavailable",
		);
	});
});
