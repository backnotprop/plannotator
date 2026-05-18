import { describe, expect, test } from "bun:test";
import {
	normalizeAnnotationMarkdownForBinary,
	shouldUseLocalPrCheckout,
	startBinarySession,
} from "./plannotator-browser";

describe("shouldUseLocalPrCheckout", () => {
	test("uses local PR checkout by default", () => {
		expect(shouldUseLocalPrCheckout({})).toBe(true);
		expect(shouldUseLocalPrCheckout({ useLocal: true })).toBe(true);
	});

	test("honors the Pi --no-local opt-out", () => {
		expect(shouldUseLocalPrCheckout({ useLocal: false })).toBe(false);
	});
});

describe("normalizeAnnotationMarkdownForBinary", () => {
	test("omits blank markdown so the binary can load filePath content", () => {
		expect(normalizeAnnotationMarkdownForBinary(undefined)).toBeUndefined();
		expect(normalizeAnnotationMarkdownForBinary("")).toBeUndefined();
		expect(normalizeAnnotationMarkdownForBinary("   \n\t")).toBeUndefined();
		expect(normalizeAnnotationMarkdownForBinary("# Notes")).toBe("# Notes");
	});
});

describe("startBinarySession", () => {
	test("rejects launch errors that happen before a session URL is ready", async () => {
		await expect(startBinarySession(async () => {
			throw new Error("startup failed");
		})).rejects.toThrow("startup failed");
	});

	test("returns a session once a URL is ready and leaves later failures on waitForDecision", async () => {
		const session = await startBinarySession(async (onSession) => {
			onSession({ mode: "plan", url: "http://localhost:1234", port: 1234, isRemote: false });
			throw new Error("decision failed");
		});

		expect(session.url).toBe("http://localhost:1234");
		await expect(session.waitForDecision()).rejects.toThrow("decision failed");
	});

	test("waits for slow session readiness when no startup timeout is provided", async () => {
		const session = await startBinarySession(async (onSession) => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			onSession({ mode: "review", url: "http://localhost:5678", port: 5678, isRemote: false });
			return { approved: true };
		});

		expect(session.url).toBe("http://localhost:5678");
		await expect(session.waitForDecision()).resolves.toEqual({ approved: true });
	});

	test("can return before a slow session URL is ready", async () => {
		const session = await startBinarySession(async (onSession) => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			onSession({ mode: "plan", url: "http://localhost:9999", port: 9999, isRemote: false });
			return { approved: true };
		}, undefined, { waitForReady: false });

		expect(session.url).toBe("plannotator://pending");
		await expect(session.waitForDecision()).resolves.toEqual({ approved: true });
		expect(session.url).toBe("http://localhost:9999");
	});

	test("surfaces deferred startup failures through waitForDecision", async () => {
		const session = await startBinarySession(async () => {
			throw new Error("startup failed later");
		}, undefined, { waitForReady: false });

		expect(session.url).toBe("plannotator://pending");
		await expect(session.waitForDecision()).rejects.toThrow("startup failed later");
	});

	test("rejects if the binary exits without reporting a session URL", async () => {
		await expect(startBinarySession(async () => ({ approved: true }))).rejects.toThrow(
			"Plannotator exited before reporting a browser session URL.",
		);
	});

	test("rejects when no session URL is reported before an explicit startup timeout", async () => {
		await expect(startBinarySession(
			(_onSession, signal) => new Promise<never>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			}),
			undefined,
			{ readyTimeoutMs: 1 },
		)).rejects.toThrow("Timed out waiting for Plannotator session URL.");
	});
});
