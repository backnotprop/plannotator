// Remote mode suppresses the browser launch so these tests never spawn the
// developer's browser or read their ~/.plannotator config. BROWSER overrides
// bypass the remote-mode suppression, so they are cleared too. (env reads
// happen at call time, so setting these before the tests run is sufficient.)
// Restored in afterAll: bun test shares one process across files, and other
// suites assert non-remote behavior.
const savedEnv = {
	PLANNOTATOR_REMOTE: process.env.PLANNOTATOR_REMOTE,
	PLANNOTATOR_BROWSER: process.env.PLANNOTATOR_BROWSER,
	BROWSER: process.env.BROWSER,
};
process.env.PLANNOTATOR_REMOTE = "1";
delete process.env.PLANNOTATOR_BROWSER;
delete process.env.BROWSER;

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getActiveBrowserSessionCount,
	shouldUseLocalPrCheckout,
	startBrowserDecisionSession,
	startMarkdownAnnotationSession,
	startServerWithSelfPreemption,
	stopAllBrowserDecisionSessions,
} from "./plannotator-browser.ts";
import { sessionOpenedMessage } from "./session-opened.ts";
import { NO_BROWSER } from "../../tests/helpers/no-browser.ts";

afterAll(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("shouldUseLocalPrCheckout", () => {
	test("uses local PR checkout by default", () => {
		expect(shouldUseLocalPrCheckout({})).toBe(true);
		expect(shouldUseLocalPrCheckout({ useLocal: true })).toBe(true);
	});

	test("honors the Pi --no-local opt-out", () => {
		expect(shouldUseLocalPrCheckout({ useLocal: false })).toBe(false);
	});
});

describe("browser URL notification", () => {
	/** Run one session start with a launcher that opens nothing and collect what it notifies. */
	async function notificationsFor(options: { mode?: string; announcedInTurn?: boolean; plannotatorBrowser?: string }): Promise<string[]> {
		const previousRemote = process.env.PLANNOTATOR_REMOTE;
		const previousPlannotatorBrowser = process.env.PLANNOTATOR_BROWSER;
		const previousBrowser = process.env.BROWSER;
		const notifications: string[] = [];

		process.env.PLANNOTATOR_REMOTE = "0";
		// A program that exits at once: the launch "succeeds" and opens nothing.
		process.env.PLANNOTATOR_BROWSER = options.plannotatorBrowser ?? NO_BROWSER;
		delete process.env.BROWSER;

		try {
			const ctx = {
				mode: options.mode,
				hasUI: true,
				ui: {
					notify(message: string) {
						notifications.push(message);
					},
				},
			} as any;
			const session = startBrowserDecisionSession(
				{ url: "http://localhost:4321", stop() {} },
				ctx,
				() => new Promise<never>(() => {}),
				undefined,
				{ announcedInTurn: options.announcedInTurn },
			);

			// The launch is fire-and-forget; give the spawn its tick.
			await new Promise((resolve) => setTimeout(resolve, 50));
			session.stop();
			return notifications;
		} finally {
			if (previousRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
			else process.env.PLANNOTATOR_REMOTE = previousRemote;
			if (previousPlannotatorBrowser === undefined) delete process.env.PLANNOTATOR_BROWSER;
			else process.env.PLANNOTATOR_BROWSER = previousPlannotatorBrowser;
			if (previousBrowser === undefined) delete process.env.BROWSER;
			else process.env.BROWSER = previousBrowser;
		}
	}

	// The archive and the event API have no in-turn message, so the URL comes
	// after the turn, RPC sessions included (#1407), even when the launch worked.
	test("a caller with no in-turn message gets the URL after the turn", async () => {
		expect(await notificationsFor({ mode: "rpc" })).toEqual(["Plannotator session ready: http://localhost:4321"]);
		expect(await notificationsFor({})).toEqual(["Plannotator session ready: http://localhost:4321"]);
	});

	// Slash commands, the tool and plan review already showed the URL in their
	// in-turn message: a launch that worked adds nothing (remote used to show
	// the URL twice).
	test("a caller that showed the URL in its own message gets no second notice", async () => {
		expect(await notificationsFor({ mode: "rpc", announcedInTurn: true })).toEqual([]);
		expect(await notificationsFor({ announcedInTurn: true })).toEqual([]);
	});

	// PLANNOTATOR_BROWSER=none is a choice, not a failed launch. openBrowser
	// returns before launching anything, so this stays in process.
	test("PLANNOTATOR_BROWSER=none: the after-turn notice says why, and a failure notice never shows", async () => {
		// no-browser-guard: sentinel under test (openBrowser returns before any launch)
		expect(await notificationsFor({ plannotatorBrowser: "none" })).toEqual([
			"Plannotator session ready: http://localhost:4321 — Not opening a browser (PLANNOTATOR_BROWSER=none).", // no-browser-guard: sentinel under test (expected text, nothing is set)
		]);
		// no-browser-guard: sentinel under test (openBrowser returns before any launch)
		expect(await notificationsFor({ plannotatorBrowser: "none", announcedInTurn: true })).toEqual([]);
	});
});

test("a nonblocking gated annotation keeps its lease off and waits for an explicit decision", async () => {
	const keys = ["PLANNOTATOR_REMOTE", "PLANNOTATOR_PORT", "PLANNOTATOR_DATA_DIR", "PLANNOTATOR_BROWSER"] as const;
	const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	const dir = mkdtempSync(join(tmpdir(), "plannotator-pi-nonblocking-"));
	const htmlPath = join(import.meta.dir, "plannotator.html");
	const stubbed = !existsSync(htmlPath);
	if (stubbed) writeFileSync(htmlPath, "<!doctype html><title>Annotate</title>");
	process.env.PLANNOTATOR_DATA_DIR = dir;
	process.env.PLANNOTATOR_REMOTE = "0";
	process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
	delete process.env.PLANNOTATOR_PORT;
	const ctx = { cwd: dir, hasUI: true, ui: { notify() {} } } as ExtensionContext;
	let session: Awaited<ReturnType<typeof startMarkdownAnnotationSession>> | undefined;
	try {
		session = await startMarkdownAnnotationSession(ctx, join(dir, "notes.md"), "# Notes", "annotate", undefined, undefined, undefined, true);
		const plan = await (await fetch(`${session.url}/api/plan`)).json();
		expect(plan.gate).toBe(true);
		expect(plan.clientLease).toEqual({ enabled: false });
		const lease = await fetch(`${session.url}/api/annotate/client-lease`);
		expect(lease.status).toBe(404);
		await lease.body?.cancel();
		expect(session.hostControl?.status().decided).toBe(false);
		const decision = session.waitForDecision();
		expect((await fetch(`${session.url}/api/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(200);
		expect(await decision).toMatchObject({ approved: true });
	} finally {
		session?.stop();
		for (const key of keys) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		if (stubbed) rmSync(htmlPath, { force: true });
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("sessionOpenedMessage", () => {
	const url = "http://localhost:4321";
	function withRemote<T>(value: string, fn: () => T): T {
		const previous = process.env.PLANNOTATOR_REMOTE;
		process.env.PLANNOTATOR_REMOTE = value;
		try {
			return fn();
		} finally {
			if (previous === undefined) delete process.env.PLANNOTATOR_REMOTE;
			else process.env.PLANNOTATOR_REMOTE = previous;
		}
	}

	// Regression (#1134): a local session whose browser opened printed no URL,
	// so a closed tab had no way back.
	test("carries the URL for a local session", () => {
		const message = withRemote("0", () => sessionOpenedMessage("Code review opened", url));
		expect(message.split(url).length - 1).toBe(1);
	});

	test("says no browser opens when PLANNOTATOR_BROWSER says none", () => {
		const previous = process.env.PLANNOTATOR_BROWSER;
		// no-browser-guard: sentinel under test (nothing is launched here)
		process.env.PLANNOTATOR_BROWSER = "none";
		try {
			const message = withRemote("0", () => sessionOpenedMessage("Code review opened", url));
			expect(message.split(url).length - 1).toBe(1);
			expect(message).toContain("Not opening a browser (PLANNOTATOR_BROWSER=none)."); // no-browser-guard: sentinel under test (expected text, nothing is set)
		} finally {
			if (previous === undefined) delete process.env.PLANNOTATOR_BROWSER;
			else process.env.PLANNOTATOR_BROWSER = previous;
		}
	});

	test("carries the URL for a remote session", () => {
		const message = withRemote("1", () => sessionOpenedMessage("Code review opened", url));
		expect(message.split(url).length - 1).toBe(1);
		expect(message).toContain("forward the port");
	});
});

describe("browser session cleanup", () => {
	const ctx = {
		hasUI: true,
		ui: {
			notify() {},
			theme: { fg: () => "" },
			setStatus() {},
		},
	} as any;

	test("positive: host shutdown stops every active browser session and rejects its pending decision", async () => {
		const stopCounts = [0, 0];
		const never = new Promise<never>(() => {});
		const sessions = stopCounts.map((_, index) =>
			startBrowserDecisionSession(
				{ url: `http://localhost:${index + 1}`, stop: () => stopCounts[index]++ },
				ctx,
				() => never,
			),
		);
		const decisions = sessions.map((session) => session.waitForDecision().catch((error) => error));

		stopAllBrowserDecisionSessions();

		expect(stopCounts).toEqual([1, 1]);
		expect(getActiveBrowserSessionCount()).toBe(0);
		for (const decision of decisions) {
			const error = await decision;
			expect(error).toBeInstanceOf(Error);
			expect(error.message).toBe("Plannotator browser session was stopped.");
		}
	});

	test("positive: tool cancellation stops its browser session immediately", async () => {
		let stops = 0;
		const controller = new AbortController();
		const session = startBrowserDecisionSession(
			{ url: "http://localhost:1", stop: () => stops++ },
			ctx,
			() => new Promise<never>(() => {}),
			controller.signal,
		);
		const decision = session.waitForDecision().catch((error) => error);

		controller.abort();

		expect(stops).toBe(1);
		expect((await decision).message).toBe("Plannotator browser session was stopped.");
	});

	test("negative: an already-aborted tool never leaves an active browser session", async () => {
		let stops = 0;
		const controller = new AbortController();
		controller.abort();

		const session = startBrowserDecisionSession(
			{ url: "http://localhost:1", stop: () => stops++ },
			ctx,
			() => new Promise<never>(() => {}),
			controller.signal,
		);
		const decision = session.waitForDecision().catch((error) => error);
		stopAllBrowserDecisionSessions();

		expect(stops).toBe(1);
		expect((await decision).message).toBe("Plannotator browser session was stopped.");
	});

	test("negative: host shutdown does not stop an already-stopped session again", async () => {
		let stops = 0;
		const session = startBrowserDecisionSession(
			{ url: "http://localhost:1", stop: () => stops++ },
			ctx,
			() => new Promise<never>(() => {}),
		);
		const decision = session.waitForDecision().catch((error) => error);

		session.stop();
		stopAllBrowserDecisionSessions();
		stopAllBrowserDecisionSessions();

		expect(stops).toBe(1);
		expect((await decision).message).toBe("Plannotator browser session was stopped.");
	});

	test("negative: host shutdown is a no-op when no browser sessions are active", () => {
		// Every prior test stopped its sessions, so the registry must be empty;
		// a leaked entry here would make the no-op claim vacuous.
		expect(getActiveBrowserSessionCount()).toBe(0);
		expect(() => stopAllBrowserDecisionSessions()).not.toThrow();
		expect(getActiveBrowserSessionCount()).toBe(0);
	});

	test("positive: self-preemption stops only sessions registered before the failing start", async () => {
		let staleStops = 0;
		let freshStops = 0;
		const never = new Promise<never>(() => {});
		startBrowserDecisionSession(
			{ url: "http://localhost:1", stop: () => staleStops++ },
			ctx,
			() => never,
		);
		// Date.now() has millisecond resolution; make the stale session strictly
		// older than the failing start.
		await new Promise((resolve) => setTimeout(resolve, 5));

		let attempts = 0;
		const result = await startServerWithSelfPreemption(async () => {
			attempts++;
			if (attempts === 1) {
				// A concurrent sibling command binds while this start is failing;
				// its fresh session must survive the sweep.
				startBrowserDecisionSession(
					{ url: "http://localhost:2", stop: () => freshStops++ },
					ctx,
					() => never,
				);
				throw new Error("Port 19432 in use after 5 retries");
			}
			return "ok";
		});

		expect(result).toBe("ok");
		expect(attempts).toBe(2);
		expect(staleStops).toBe(1);
		expect(freshStops).toBe(0);
		expect(getActiveBrowserSessionCount()).toBe(1);
		stopAllBrowserDecisionSessions();
		expect(freshStops).toBe(1);
		expect(getActiveBrowserSessionCount()).toBe(0);
	});

	test("negative: self-preemption rethrows when every tracked session is younger than the failing start", async () => {
		let freshStops = 0;
		const never = new Promise<never>(() => {});
		let attempts = 0;
		await expect(
			startServerWithSelfPreemption(async () => {
				attempts++;
				startBrowserDecisionSession(
					{ url: "http://localhost:1", stop: () => freshStops++ },
					ctx,
					() => never,
				);
				throw new Error("Port 19432 in use after 5 retries");
			}),
		).rejects.toThrow("Port 19432 in use after 5 retries");

		expect(attempts).toBe(1);
		expect(freshStops).toBe(0);
		expect(getActiveBrowserSessionCount()).toBe(1);
		stopAllBrowserDecisionSessions();
		expect(getActiveBrowserSessionCount()).toBe(0);
	});
});
