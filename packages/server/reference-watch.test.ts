import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { handleFileBrowserFilesStream, isFileBrowserWatchIgnoredPath } from "./reference-watch";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function readSSEEvents(response: Response, count: number): Promise<Array<{ type?: string; dirPath?: string }>> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Missing response body");
	const decoder = new TextDecoder();
	const events: Array<{ type?: string; dirPath?: string }> = [];
	let pending = "";

	try {
		while (events.length < count) {
			let timeout: ReturnType<typeof setTimeout> | null = null;
			const result = await Promise.race([
				reader.read(),
				new Promise<never>((_, reject) => {
					timeout = setTimeout(() => reject(new Error("Timed out waiting for SSE event")), 1000);
				}),
			]);
			if (timeout) clearTimeout(timeout);
			if (result.done) break;
			pending += decoder.decode(result.value, { stream: true });
			const blocks = pending.split("\n\n");
			pending = blocks.pop() ?? "";
			for (const block of blocks) {
				const line = block.split("\n").find((item) => item.startsWith("data: "));
				if (!line) continue;
				events.push(JSON.parse(line.slice("data: ".length)));
			}
		}
		return events;
	} finally {
		await reader.cancel();
	}
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("handleFileBrowserFilesStream", () => {
	test("ignores nested excluded folders for watcher paths", () => {
		const root = join(tmpdir(), "plannotator-watch-root");

		expect(isFileBrowserWatchIgnoredPath(join(root, "packages", "app", "node_modules"), root)).toBe(true);
		expect(isFileBrowserWatchIgnoredPath(join(root, "packages", "app", "node_modules", "pkg", "readme.md"), root)).toBe(true);
		expect(isFileBrowserWatchIgnoredPath(join(root, "docs", "dist", "generated.md"), root)).toBe(true);
		expect(isFileBrowserWatchIgnoredPath(join(root, "docs", "plan.md"), root)).toBe(false);
		expect(isFileBrowserWatchIgnoredPath(root, root)).toBe(false);
		expect(isFileBrowserWatchIgnoredPath(join(dirname(root), "outside", "node_modules"), root)).toBe(false);
	});

	test("opens one SSE stream for multiple roots", async () => {
		const first = makeTempDir("plannotator-watch-a-");
		const second = makeTempDir("plannotator-watch-b-");
		const url = new URL("http://localhost/api/reference/files/stream");
		url.searchParams.append("dirPath", first);
		url.searchParams.append("dirPath", second);

		const response = handleFileBrowserFilesStream(new Request(url.toString()));
		const events = await readSSEEvents(response, 2);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		expect(events.map((event) => [event.type, event.dirPath]).sort()).toEqual([
			["ready", first],
			["ready", second],
		].sort());
	});

	test("echoes the subscribed client path instead of the resolved watcher path", async () => {
		const root = makeTempDir("plannotator-watch-c-");
		const nonCanonicalRoot = join(dirname(root), "..", basename(dirname(root)), basename(root));
		const url = new URL("http://localhost/api/reference/files/stream");
		url.searchParams.append("dirPath", nonCanonicalRoot);

		const response = handleFileBrowserFilesStream(new Request(url.toString()));
		const events = await readSSEEvents(response, 1);

		expect(response.status).toBe(200);
		expect(events[0]?.type).toBe("ready");
		expect(events[0]?.dirPath).toBe(nonCanonicalRoot);
	});
});
