import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Namespace import on purpose: cleanup is feature-detected so this file can also run against a module that lacks the teardown export.
import * as referenceWatch from "./reference-watch";

const tempDirs: string[] = [];

afterAll(() => {
	(referenceWatch as { closeAllFileBrowserWatchers?: () => void }).closeAllFileBrowserWatchers?.();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function buildLargeTree(root: string): void {
	// Depth and breadth both amplify and the blowup is nonlinear: this 780-directory shape blocked the old implementation for 77 seconds, while a flat tree of similar size and a 340-directory nested variant scanned in under a second.
	const build = (base: string, depth: number): void => {
		for (let i = 0; i < 5; i++) {
			const dir = join(base, `d${i}`);
			mkdirSync(dir);
			for (let f = 0; f < 8; f++) {
				writeFileSync(join(dir, `f${f}.md`), "content");
			}
			if (depth > 1) build(dir, depth - 1);
		}
	};
	build(root, 4);
}

async function readFirstEvent(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	timeoutMs: number,
): Promise<void> {
	const timeout = new Promise<never>((_, reject) => {
		setTimeout(() => reject(new Error("Timed out waiting for SSE ready")), timeoutMs);
	});
	await Promise.race([reader.read(), timeout]);
}

describe("file browser watcher responsiveness (#1313)", () => {
	// chokidar's directory scan under Bun costs ~40ms per directory and can stall the server for seconds on a tree this size. The native recursive backend exists only on macOS and Windows; Linux keeps chokidar, so the tight bound is not asserted there.
	test.skipIf(process.platform === "linux")(
		"the event loop stays responsive while a large tree's watcher warms",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "plannotator-watch-large-"));
			tempDirs.push(root);
			buildLargeTree(root);

			const url = new URL("http://localhost/api/reference/files/stream");
			url.searchParams.append("dirPath", root);

			const started = performance.now();
			const response = referenceWatch.handleFileBrowserFilesStream(new Request(url.toString()));
			expect(response.status).toBe(200);
			const reader = response.body?.getReader();
			if (!reader) throw new Error("Missing response body");
			try {
				// The stream must stay open through the measurement: cancelling the reader releases the subscription and aborts the warmup.
				await readFirstEvent(reader, 2_000);

				for (let i = 0; i < 10; i++) {
					await new Promise((resolve) => setTimeout(resolve, 0));
				}
				const elapsed = performance.now() - started;
				expect(elapsed).toBeLessThan(1_500);
			} finally {
				await reader.cancel();
			}
		},
	);

	// Platform-agnostic half: the SSE ready event is not gated on the watcher scan. chokidar is forced through the test hooks, and the stream is torn down right after the assertion to abort the scan.
	test("SSE ready is served before the watcher scan starts on the fallback backend", async () => {
		const hooks = (referenceWatch as {
			__fileBrowserWatchTestHooks?: {
				diagnostics: () => { entries: number; contentWatcherStarts: number };
				configure: (overrides: { contentWatchBackend?: "auto" | "chokidar" | "native" }) => void;
			};
		}).__fileBrowserWatchTestHooks;
		if (!hooks) throw new Error("test hooks missing");
		const root = mkdtempSync(join(tmpdir(), "plannotator-watch-fallback-"));
		tempDirs.push(root);
		buildLargeTree(root);

		// Clear the previous test's entry still in reconnect grace so the entry count is this test's own.
		(referenceWatch as { closeAllFileBrowserWatchers?: () => void }).closeAllFileBrowserWatchers?.();
		hooks.configure({ contentWatchBackend: "chokidar" });
		try {
			const url = new URL("http://localhost/api/reference/files/stream");
			url.searchParams.append("dirPath", root);
			const started = performance.now();
			const response = referenceWatch.handleFileBrowserFilesStream(new Request(url.toString()));
			expect(response.status).toBe(200);
			const reader = response.body?.getReader();
			if (!reader) throw new Error("Missing response body");
			try {
				await readFirstEvent(reader, 2_000);
				expect(performance.now() - started).toBeLessThan(1_000);
				expect(hooks.diagnostics().entries).toBe(1);
			} finally {
				await reader.cancel();
			}
		} finally {
			// Abort the deferred chokidar scan before it can slow later tests.
			(referenceWatch as { closeAllFileBrowserWatchers?: () => void }).closeAllFileBrowserWatchers?.();
			hooks.configure({ contentWatchBackend: undefined });
		}
	});
});
