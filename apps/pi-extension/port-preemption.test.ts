import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startServerWithSelfPreemption } from "./plannotator-browser.ts";

describe("startServerWithSelfPreemption", () => {
	const portInUse = () => new Error("Port 19432 in use after 5 retries");

	test("passes through a successful start without touching tracked sessions", async () => {
		let stops = 0;
		const result = await startServerWithSelfPreemption(
			async () => "ok",
			() => { stops++; return true; },
		);
		expect(result).toBe("ok");
		expect(stops).toBe(0);
	});

	test("stops tracked sessions and retries once on port-in-use", async () => {
		let stops = 0;
		let attempts = 0;
		const result = await startServerWithSelfPreemption(
			async () => {
				attempts++;
				if (attempts === 1) throw portInUse();
				return "second";
			},
			() => { stops++; return true; },
		);
		expect(result).toBe("second");
		expect(attempts).toBe(2);
		expect(stops).toBe(1);
	});

	test("rethrows port-in-use after a single attempt when no session is tracked", async () => {
		let attempts = 0;
		await expect(
			startServerWithSelfPreemption(
				async () => {
					attempts++;
					throw portInUse();
				},
				() => false,
			),
		).rejects.toThrow("Port 19432 in use after 5 retries");
		expect(attempts).toBe(1);
	});

	test("also preempts on explicit-range exhaustion", async () => {
		let stops = 0;
		let attempts = 0;
		const result = await startServerWithSelfPreemption(
			async () => {
				attempts++;
				if (attempts === 1) throw new Error("Port selection 19432-19442 exhausted");
				return "second";
			},
			() => { stops++; return true; },
		);
		expect(result).toBe("second");
		expect(stops).toBe(1);
	});

	test("rethrows non-port errors without stopping tracked sessions", async () => {
		let stops = 0;
		await expect(
			startServerWithSelfPreemption(
				async () => {
					throw new Error("File not found");
				},
				() => { stops++; return true; },
			),
		).rejects.toThrow("File not found");
		expect(stops).toBe(0);
	});

	test("rethrows the second failure when the port is held by another process", async () => {
		let attempts = 0;
		await expect(
			startServerWithSelfPreemption(
				async () => {
					attempts++;
					throw portInUse();
				},
				() => true,
			),
		).rejects.toThrow("Port 19432 in use after 5 retries");
		expect(attempts).toBe(2);
	});
});

describe("self-preemption call sites", () => {
	test("all four server starts in plannotator-browser.ts are wrapped", () => {
		const src = readFileSync(join(import.meta.dir, "plannotator-browser.ts"), "utf-8");
		const count = (needle: string) => src.split(needle).length - 1;
		expect(count("await startServerWithSelfPreemption(() => startPlanReviewServer(")).toBe(2);
		expect(count("await startServerWithSelfPreemption(() => startReviewServer(")).toBe(1);
		expect(count("await startServerWithSelfPreemption(() => startAnnotateServer(")).toBe(1);
	});
});

describe("pi server stop() drains connections", () => {
	const serverFiles = ["serverAnnotate.ts", "serverPlan.ts", "serverReview.ts"];

	for (const file of serverFiles) {
		test(`${file} calls closeAllConnections after close`, () => {
			const src = readFileSync(join(import.meta.dir, "server", file), "utf-8");
			const closeIdx = src.indexOf("server.close();");
			const drainIdx = src.indexOf("server.closeAllConnections?.();");
			expect(closeIdx).toBeGreaterThan(-1);
			expect(drainIdx).toBeGreaterThan(closeIdx);
		});
	}
});
