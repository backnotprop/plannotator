import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	createExactFileWatchListener,
	handleFileBrowserFilesStream,
	isFileBrowserWatchIgnoredPath,
} from "./reference-watch";

const tempDirs: string[] = [];
const WATCH_READY_MS = 250;
const EVENT_TIMEOUT_MS = 2_000;

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

interface SSEEvent {
	type?: string;
	dirPath?: string;
	reason?: string;
}

interface SSECollector {
	next(timeoutMs?: number): Promise<SSEEvent>;
	close(): Promise<void>;
}

function collectSSE(response: Response): SSECollector {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Missing response body");
	const decoder = new TextDecoder();
	const events: SSEEvent[] = [];
	const waiters: Array<(event: SSEEvent) => void> = [];
	let pending = "";

	const pump = async () => {
		try {
			while (true) {
				const result = await reader.read();
				if (result.done) break;
				pending += decoder.decode(result.value, { stream: true });
				const blocks = pending.split("\n\n");
				pending = blocks.pop() ?? "";
				for (const block of blocks) {
					const line = block.split("\n").find((item) => item.startsWith("data: "));
					if (!line) continue;
					const event = JSON.parse(line.slice("data: ".length)) as SSEEvent;
					const waiter = waiters.shift();
					if (waiter) waiter(event);
					else events.push(event);
				}
			}
		} catch {
			// Reader cancellation closes the collector.
		}
	};
	void pump();

	return {
		next(timeoutMs = EVENT_TIMEOUT_MS) {
			const event = events.shift();
			if (event) return Promise.resolve(event);
			return new Promise<SSEEvent>((resolve, reject) => {
				let timeout: ReturnType<typeof setTimeout>;
				const waiter = (nextEvent: SSEEvent) => {
					clearTimeout(timeout);
					resolve(nextEvent);
				};
				waiters.push(waiter);
				timeout = setTimeout(() => {
					const index = waiters.indexOf(waiter);
					if (index >= 0) waiters.splice(index, 1);
					reject(new Error("Timed out waiting for SSE event"));
				}, timeoutMs);
			});
		},
		close() {
			return reader.cancel();
		},
	};
}

async function readSSEEvents(response: Response, count: number): Promise<SSEEvent[]> {
	const collector = collectSSE(response);
	const events: SSEEvent[] = [];
	try {
		while (events.length < count) events.push(await collector.next());
		return events;
	} finally {
		await collector.close();
	}
}

async function expectNoEvent(collector: SSECollector, timeoutMs = 500): Promise<void> {
	try {
		const event = await collector.next(timeoutMs);
		throw new Error(`Unexpected SSE event: ${JSON.stringify(event)}`);
	} catch (error) {
		if (error instanceof Error && error.message === "Timed out waiting for SSE event") return;
		throw error;
	}
}

function waitForWatcher(): Promise<void> {
	return Bun.sleep(WATCH_READY_MS);
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

	test("requires exactly one watch parameter mode", () => {
		const root = makeTempDir("plannotator-watch-mode-");
		const filePath = join(root, "plan.md");
		writeFileSync(filePath, "initial");

		const missing = handleFileBrowserFilesStream(
			new Request("http://localhost/api/reference/files/stream"),
		);
		const mixedUrl = new URL("http://localhost/api/reference/files/stream");
		mixedUrl.searchParams.append("dirPath", root);
		mixedUrl.searchParams.append("filePath", filePath);
		const mixed = handleFileBrowserFilesStream(new Request(mixedUrl));

		expect(missing.status).toBe(400);
		expect(mixed.status).toBe(400);
	});

	test("watches an exact file through writes, deletion, recreation, and rename-away", async () => {
		const root = makeTempDir("plannotator-watch-file-");
		const target = join(root, "plan.md");
		const sibling = join(root, "sibling.md");
		const nestedDir = join(root, "nested");
		writeFileSync(target, "initial");
		mkdirSync(nestedDir);
		await waitForWatcher();

		const url = new URL("http://localhost/api/reference/files/stream");
		url.searchParams.append("filePath", target);
		const response = handleFileBrowserFilesStream(new Request(url));
		const collector = collectSSE(response);

		try {
			expect(response.status).toBe(200);
			expect(await collector.next()).toMatchObject({
				type: "ready",
				dirPath: root,
				reason: "initial",
			});
			await waitForWatcher();

			writeFileSync(target, "written");
			expect(await collector.next()).toMatchObject({ type: "changed", dirPath: root, reason: "files" });

			writeFileSync(sibling, "sibling");
			writeFileSync(join(nestedDir, "nested.md"), "nested");
			await expectNoEvent(collector);

			unlinkSync(target);
			expect(await collector.next()).toMatchObject({ type: "changed", dirPath: root, reason: "files" });

			writeFileSync(target, "recreated");
			expect(await collector.next()).toMatchObject({ type: "changed", dirPath: root, reason: "files" });

			renameSync(target, join(root, "renamed.md"));
			expect(await collector.next()).toMatchObject({ type: "changed", dirPath: root, reason: "files" });
		} finally {
			await collector.close();
		}
	});

	test("keeps watching after atomic rename-over saves", async () => {
		const root = makeTempDir("plannotator-watch-atomic-");
		const target = join(root, "plan.md");
		writeFileSync(target, "initial");
		await waitForWatcher();
		const url = new URL("http://localhost/api/reference/files/stream");
		url.searchParams.append("filePath", target);
		const collector = collectSSE(handleFileBrowserFilesStream(new Request(url)));

		try {
			await collector.next();
			await waitForWatcher();
			for (const content of ["first", "second"]) {
				const replacement = join(root, `plan-${content}.tmp`);
				writeFileSync(replacement, content);
				renameSync(replacement, target);
				expect(await collector.next()).toMatchObject({
					type: "changed",
					dirPath: root,
					reason: "files",
				});
			}
		} finally {
			await collector.close();
		}
	});

	test("allows a missing leaf when its parent exists and reports its creation", async () => {
		const root = makeTempDir("plannotator-watch-missing-");
		const target = join(root, "future.md");
		const url = new URL("http://localhost/api/reference/files/stream");
		url.searchParams.append("filePath", target);
		const response = handleFileBrowserFilesStream(new Request(url));
		const collector = collectSSE(response);

		try {
			expect(response.status).toBe(200);
			expect(await collector.next()).toMatchObject({ type: "ready", dirPath: root });
			await waitForWatcher();
			writeFileSync(target, "created");
			expect(await collector.next()).toMatchObject({ type: "changed", dirPath: root, reason: "files" });
		} finally {
			await collector.close();
		}
	});

	test("rejects file targets with an invalid parent or a directory leaf", () => {
		const root = makeTempDir("plannotator-watch-invalid-");
		const emptyUrl = new URL("http://localhost/api/reference/files/stream");
		emptyUrl.searchParams.append("filePath", "");
		const missingParentUrl = new URL("http://localhost/api/reference/files/stream");
		missingParentUrl.searchParams.append("filePath", join(root, "missing", "plan.md"));
		const directoryUrl = new URL("http://localhost/api/reference/files/stream");
		directoryUrl.searchParams.append("filePath", root);

		expect(handleFileBrowserFilesStream(new Request(emptyUrl)).status).toBe(400);
		expect(handleFileBrowserFilesStream(new Request(missingParentUrl)).status).toBe(400);
		expect(handleFileBrowserFilesStream(new Request(directoryUrl)).status).toBe(400);
	});

	test("deduplicates equivalent exact-file targets", async () => {
		const root = makeTempDir("plannotator-watch-dedupe-");
		const target = join(root, "plan.md");
		writeFileSync(target, "initial");
		await waitForWatcher();
		const url = new URL("http://localhost/api/reference/files/stream");
		url.searchParams.append("filePath", target);
		url.searchParams.append("filePath", join(root, ".", "plan.md"));
		const response = handleFileBrowserFilesStream(new Request(url));
		const collector = collectSSE(response);

		try {
			expect(await collector.next()).toMatchObject({ type: "ready", dirPath: root });
			await expectNoEvent(collector);
		} finally {
			await collector.close();
		}
	});

	test("keeps directory and exact-file watchers as separate cache entries", async () => {
		const root = makeTempDir("plannotator-watch-cache-");
		const target = join(root, "plan.md");
		const sibling = join(root, "sibling.md");
		writeFileSync(target, "initial");
		await waitForWatcher();
		const dirUrl = new URL("http://localhost/api/reference/files/stream");
		dirUrl.searchParams.append("dirPath", root);
		const fileUrl = new URL("http://localhost/api/reference/files/stream");
		fileUrl.searchParams.append("filePath", target);
		const dirCollector = collectSSE(handleFileBrowserFilesStream(new Request(dirUrl)));
		const fileCollector = collectSSE(handleFileBrowserFilesStream(new Request(fileUrl)));

		try {
			await dirCollector.next();
			await fileCollector.next();
			await waitForWatcher();
			writeFileSync(sibling, "sibling");
			expect(await dirCollector.next()).toMatchObject({ type: "changed", reason: "files" });
			await expectNoEvent(fileCollector);
		} finally {
			await dirCollector.close();
			await fileCollector.close();
		}
	});

	test("preserves recursive directory watching", async () => {
		const root = makeTempDir("plannotator-watch-recursive-");
		const nested = join(root, "docs", "nested");
		mkdirSync(nested, { recursive: true });
		const url = new URL("http://localhost/api/reference/files/stream");
		url.searchParams.append("dirPath", root);
		const collector = collectSSE(handleFileBrowserFilesStream(new Request(url)));

		try {
			await collector.next();
			await waitForWatcher();
			writeFileSync(join(nested, "plan.md"), "nested");
			expect(await collector.next()).toMatchObject({ type: "changed", dirPath: root, reason: "files" });
		} finally {
			await collector.close();
		}
	});

	test("tolerates watcher events delivered without a filename", () => {
		const root = makeTempDir("plannotator-watch-nameless-");
		const target = join(root, "plan.md");
		writeFileSync(target, "initial");
		let changes = 0;
		const listener = createExactFileWatchListener(root, target, () => {
			changes += 1;
		});
		const hostileName = { toString: () => { throw new Error("unreadable filename"); } } as unknown as string;

		// Bun on Linux reports undefined (not null) for events on the watched directory.
		expect(() => listener("rename", undefined)).not.toThrow();
		expect(() => listener("change", null)).not.toThrow();
		expect(() => listener("rename", hostileName)).not.toThrow();
		expect(changes).toBe(2);

		changes = 0;
		listener("change", "sibling.md");
		expect(changes).toBe(0);
	});

	test("keeps streaming when the watched parent directory itself changes", async () => {
		const root = makeTempDir("plannotator-watch-parent-");
		const target = join(root, "plan.md");
		writeFileSync(target, "initial");
		await waitForWatcher();
		const url = new URL("http://localhost/api/reference/files/stream");
		url.searchParams.append("filePath", target);
		const collector = collectSSE(handleFileBrowserFilesStream(new Request(url)));

		try {
			expect(await collector.next()).toMatchObject({ type: "ready", dirPath: root });
			await waitForWatcher();

			// Metadata churn on the parent directory (tar -x, rsync -a, cp -a).
			chmodSync(root, statSync(root).mode);
			utimesSync(root, new Date(), new Date());
			await waitForWatcher();

			writeFileSync(target, "written");
			expect(await collector.next()).toMatchObject({ type: "changed", dirPath: root, reason: "files" });
		} finally {
			await collector.close();
		}
	});

	test("does not report adjacent Git metadata changes for an exact file", async () => {
		const root = makeTempDir("plannotator-watch-git-");
		const target = join(root, "plan.md");
		const gitDir = join(root, ".git");
		mkdirSync(gitDir);
		writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
		writeFileSync(target, "initial");
		await waitForWatcher();
		const url = new URL("http://localhost/api/reference/files/stream");
		url.searchParams.append("filePath", target);
		const collector = collectSSE(handleFileBrowserFilesStream(new Request(url)));

		try {
			await collector.next();
			await waitForWatcher();
			writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/other\n");
			await expectNoEvent(collector);
		} finally {
			await collector.close();
		}
	});
});
