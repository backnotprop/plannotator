import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as referenceWatch from "./reference-watch";

const tempDirs: string[] = [];

afterAll(() => {
	(referenceWatch as { closeAllFileBrowserWatchers?: () => void }).closeAllFileBrowserWatchers?.();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function buildLargeTree(root: string): void {
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
			(referenceWatch as { closeAllFileBrowserWatchers?: () => void }).closeAllFileBrowserWatchers?.();
			hooks.configure({ contentWatchBackend: undefined });
		}
	});
});
