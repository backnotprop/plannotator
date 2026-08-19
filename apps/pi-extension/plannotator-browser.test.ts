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
import {
	getActiveBrowserSessionCount,
	shouldUseLocalPrCheckout,
	startBrowserDecisionSession,
	startServerWithSelfPreemption,
	stopAllBrowserDecisionSessions,
} from "./plannotator-browser.ts";

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
