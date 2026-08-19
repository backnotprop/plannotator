import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	createExactFileWatchListener,
	handleFileBrowserStreamRequest,
	isFileBrowserWatchIgnoredPath,
} from "./file-browser-watch.ts";

const tempDirs: string[] = [];
const servers: Server[] = [];
const WATCH_READY_MS = 250;

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function startWatchServer(): Promise<string> {
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (!handleFileBrowserStreamRequest(req, res, url)) {
			res.writeHead(404).end();
		}
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing test server address");
	return `http://127.0.0.1:${address.port}`;
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
		next(timeoutMs = 2_000) {
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

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("Pi file browser watcher", () => {
	test("ignores nested excluded folders for watcher paths", () => {
		const root = join(tmpdir(), "plannotator-pi-watch-root");

		expect(isFileBrowserWatchIgnoredPath(join(root, "packages", "app", "node_modules"), root)).toBe(true);
		expect(isFileBrowserWatchIgnoredPath(join(root, "packages", "app", "node_modules", "pkg", "readme.md"), root)).toBe(true);
		expect(isFileBrowserWatchIgnoredPath(join(root, "docs", "dist", "generated.md"), root)).toBe(true);
		expect(isFileBrowserWatchIgnoredPath(join(root, "docs", "plan.md"), root)).toBe(false);
		expect(isFileBrowserWatchIgnoredPath(root, root)).toBe(false);
		expect(isFileBrowserWatchIgnoredPath(join(dirname(root), "outside", "node_modules"), root)).toBe(false);
	});

	test("requires exactly one valid watch parameter mode", async () => {
		const root = makeTempDir("plannotator-pi-watch-mode-");
		const target = join(root, "plan.md");
		writeFileSync(target, "initial");
		const origin = await startWatchServer();
		const missing = await fetch(`${origin}/api/reference/files/stream`);
		const mixedUrl = new URL(`${origin}/api/reference/files/stream`);
		mixedUrl.searchParams.append("dirPath", root);
		mixedUrl.searchParams.append("filePath", target);
		const emptyUrl = new URL(`${origin}/api/reference/files/stream`);
		emptyUrl.searchParams.append("filePath", "");
		const invalidParentUrl = new URL(`${origin}/api/reference/files/stream`);
		invalidParentUrl.searchParams.append("filePath", join(root, "missing", "plan.md"));
		const directoryUrl = new URL(`${origin}/api/reference/files/stream`);
		directoryUrl.searchParams.append("filePath", root);

		expect(missing.status).toBe(400);
		expect((await fetch(mixedUrl)).status).toBe(400);
		expect((await fetch(emptyUrl)).status).toBe(400);
		expect((await fetch(invalidParentUrl)).status).toBe(400);
		expect((await fetch(directoryUrl)).status).toBe(400);
	});

	test("watches an exact file through writes, deletion, recreation, and rename-away", async () => {
		const root = makeTempDir("plannotator-pi-watch-file-");
		const target = join(root, "plan.md");
		const nested = join(root, "nested");
		writeFileSync(target, "initial");
		mkdirSync(nested);
		await waitForWatcher();
		const origin = await startWatchServer();
		const url = new URL(`${origin}/api/reference/files/stream`);
		url.searchParams.append("filePath", target);
		const response = await fetch(url);
		const collector = collectSSE(response);

		try {
			expect(response.status).toBe(200);
			expect(await collector.next()).toMatchObject({ type: "ready", dirPath: root, reason: "initial" });
			await waitForWatcher();

			writeFileSync(target, "written");
			expect(await collector.next()).toMatchObject({ type: "changed", dirPath: root, reason: "files" });

			writeFileSync(join(root, "sibling.md"), "sibling");
			writeFileSync(join(nested, "nested.md"), "nested");
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
		const root = makeTempDir("plannotator-pi-watch-atomic-");
		const target = join(root, "plan.md");
		writeFileSync(target, "initial");
		await waitForWatcher();
		const origin = await startWatchServer();
		const url = new URL(`${origin}/api/reference/files/stream`);
		url.searchParams.append("filePath", target);
		const collector = collectSSE(await fetch(url));

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

	test("allows a missing leaf when its parent exists", async () => {
		const root = makeTempDir("plannotator-pi-watch-missing-");
		const target = join(root, "future.md");
		const origin = await startWatchServer();
		const url = new URL(`${origin}/api/reference/files/stream`);
		url.searchParams.append("filePath", target);
		const collector = collectSSE(await fetch(url));

		try {
			expect(await collector.next()).toMatchObject({ type: "ready", dirPath: root });
			await waitForWatcher();
			writeFileSync(target, "created");
			expect(await collector.next()).toMatchObject({ type: "changed", dirPath: root, reason: "files" });
		} finally {
			await collector.close();
		}
	});

	test("deduplicates equivalent exact-file targets", async () => {
		const root = makeTempDir("plannotator-pi-watch-dedupe-");
		const target = join(root, "plan.md");
		writeFileSync(target, "initial");
		await waitForWatcher();
		const origin = await startWatchServer();
		const url = new URL(`${origin}/api/reference/files/stream`);
		url.searchParams.append("filePath", target);
		url.searchParams.append("filePath", join(root, ".", "plan.md"));
		const collector = collectSSE(await fetch(url));

		try {
			expect(await collector.next()).toMatchObject({ type: "ready", dirPath: root });
			await expectNoEvent(collector);
		} finally {
			await collector.close();
		}
	});

	test("keeps directory and file caches separate while preserving recursive directory watching", async () => {
		const root = makeTempDir("plannotator-pi-watch-cache-");
		const target = join(root, "plan.md");
		const nested = join(root, "nested");
		writeFileSync(target, "initial");
		mkdirSync(nested);
		await waitForWatcher();
		const origin = await startWatchServer();
		const dirUrl = new URL(`${origin}/api/reference/files/stream`);
		dirUrl.searchParams.append("dirPath", root);
		const fileUrl = new URL(`${origin}/api/reference/files/stream`);
		fileUrl.searchParams.append("filePath", target);
		const dirCollector = collectSSE(await fetch(dirUrl));
		const fileCollector = collectSSE(await fetch(fileUrl));

		try {
			await dirCollector.next();
			await fileCollector.next();
			await waitForWatcher();
			writeFileSync(join(nested, "sibling.md"), "nested");
			expect(await dirCollector.next()).toMatchObject({ type: "changed", dirPath: root, reason: "files" });
			await expectNoEvent(fileCollector);
		} finally {
			await dirCollector.close();
			await fileCollector.close();
		}
	});

	test("tolerates watcher events delivered without a filename", () => {
		const root = makeTempDir("plannotator-pi-watch-nameless-");
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
		const root = makeTempDir("plannotator-pi-watch-parent-");
		const target = join(root, "plan.md");
		writeFileSync(target, "initial");
		await waitForWatcher();
		const origin = await startWatchServer();
		const url = new URL(`${origin}/api/reference/files/stream`);
		url.searchParams.append("filePath", target);
		const collector = collectSSE(await fetch(url));

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

	test("does not report adjacent Git metadata for an exact file", async () => {
		const root = makeTempDir("plannotator-pi-watch-git-");
		const target = join(root, "plan.md");
		const gitDir = join(root, ".git");
		mkdirSync(gitDir);
		writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
		writeFileSync(target, "initial");
		await waitForWatcher();
		const origin = await startWatchServer();
		const url = new URL(`${origin}/api/reference/files/stream`);
		url.searchParams.append("filePath", target);
		const collector = collectSSE(await fetch(url));

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
