import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Namespace import on purpose: this file must also run against the pre-#1313
// module (which lacks the teardown export) to demonstrate the regression, so
// cleanup is feature-detected instead of imported by name.
import * as referenceWatch from "./reference-watch";

const tempDirs: string[] = [];

afterAll(() => {
	(referenceWatch as { closeAllFileBrowserWatchers?: () => void }).closeAllFileBrowserWatchers?.();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function buildLargeTree(root: string): void {
	// Depth and breadth are both amplifiers and the blowup is nonlinear: this
	// exact 780-directory shape blocked the pre-#1313 implementation for 77
	// seconds in measurement, while a flat tree of similar size and a
	// 340-directory nested variant scanned in under a second.
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
	// chokidar's directory scan under Bun costs ~40ms per directory and, before
	// #1313, ran synchronously with request handling: on a repository the size
	// of this synthetic tree the whole server stopped answering for seconds
	// (the reported symptom was "document API requests time out" on folder
	// switches). The native recursive backend that fixes this only exists on
	// macOS and Windows; Linux keeps the chokidar backend and relies on the
	// deferred warmup plus reconnect grace, so the tight bound is not asserted
	// there.
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
				// The stream must STAY OPEN through the measurement: cancelling the
				// reader releases the subscription and aborts the warmup, which is
				// exactly how an earlier version of this test failed to reproduce
				// the bug.
				await readFirstEvent(reader, 2_000);

				// Stand-ins for the /api/doc requests a user's file click issues
				// while the watcher warms: each hop must schedule promptly instead
				// of queueing behind a directory scan.
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

	// The platform-agnostic half of the same property: the SSE ready event is
	// not gated on the watcher scan, on ANY backend. The chokidar backend is
	// forced through the test hooks so this exercises the Linux code path on
	// every platform; the scan still saturates the loop once it starts (the
	// backend is a correctness fallback, not a performance one), so the stream
	// is torn down immediately after the assertion to abort the scan.
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

		// The previous test's entry is still inside its reconnect grace; clear
		// it so the entry count below is this test's own.
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
