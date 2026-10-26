/**
 * The per-directory watcher Linux uses (#1439), driven on every platform
 * through the "directories" backend over an in-memory filesystem and a fake
 * fs.watch, so the cap, unreadable folders, failures and scan ordering are
 * proven without real inotify, real permissions or thousands of folders.
 * file-browser-watch-linux.test.ts runs the same paths on a real Linux
 * filesystem.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { dirname, join, relative } from "node:path";
import {
	createFileBrowserWatchRegistry,
	directoryWatchLimitFor,
	type DirectoryWatchFs,
	type FileBrowserChangeEvent,
	type FileBrowserWatchTarget,
} from "./file-browser-watch-core";
import { isFileBrowserWatchExcludedPath } from "./reference-common";

const ROOT = "/repo";

type Listener = (event: string, filename: string | null) => void;

class FakeWatcher extends EventEmitter {
	closed = false;
	constructor(readonly path: string, readonly listener: Listener) {
		super();
	}
	close() {
		this.closed = true;
	}
}

function codeError(code: string): Error {
	return Object.assign(new Error(code), { code });
}

/** An in-memory folder tree with a fake fs.watch over it. */
class FakeWorld {
	private nextIno = 1;
	readonly nodes = new Map<string, { dir: boolean; ino: number }>();
	/** Paths whose stat/readdir/watch throw EACCES. */
	readonly unreadable = new Set<string>();
	/** path -> error code fs.watch throws for it. */
	readonly watchErrors = new Map<string, string>();
	/** Throw ENOSPC once this many watches are live. */
	systemWatchLimit = Infinity;
	readonly watchers = new Map<string, FakeWatcher>();
	readdirDelayMs = 0;
	readdirsInFlight = 0;
	maxReaddirsInFlight = 0;
	readdirCalls = 0;

	constructor() {
		this.mkdir(ROOT);
	}

	mkdir(path: string): void {
		this.nodes.set(path, { dir: true, ino: this.nextIno++ });
	}

	file(path: string): void {
		this.nodes.set(path, { dir: false, ino: this.nextIno++ });
	}

	/** Make `count` nested folders under `parent` ("<prefix>0".."<prefix>N"). */
	folders(parent: string, prefix: string, count: number): string[] {
		const out: string[] = [];
		for (let i = 0; i < count; i += 1) {
			const path = join(parent, `${prefix}${i}`);
			this.mkdir(path);
			out.push(path);
		}
		return out;
	}

	remove(path: string): void {
		for (const key of [...this.nodes.keys()]) {
			if (key === path || key.startsWith(`${path}/`)) this.nodes.delete(key);
		}
	}

	liveWatches(): string[] {
		return [...this.watchers.values()].filter((w) => !w.closed).map((w) => w.path).sort();
	}

	/** Deliver an inotify-style event from the watch on `directory`. */
	emit(directory: string, event: "rename" | "change", name: string | null): void {
		const watcher = this.watchers.get(directory);
		if (!watcher || watcher.closed) throw new Error(`no live watch on ${directory}`);
		watcher.listener(event, name);
	}

	/** Create a folder and tell its parent's watch, as inotify would. */
	createDir(path: string): void {
		this.mkdir(path);
		this.emit(dirname(path), "rename", relative(dirname(path), path));
	}

	readonly fs: DirectoryWatchFs = {
		stat: async (path, _followSymlinks) => {
			if (this.unreadable.has(path)) throw codeError("EACCES");
			const node = this.nodes.get(path);
			if (!node) throw codeError("ENOENT");
			return { isDirectory: () => node.dir, dev: 1, ino: node.ino };
		},
		readdir: async (path) => {
			this.readdirCalls += 1;
			this.readdirsInFlight += 1;
			this.maxReaddirsInFlight = Math.max(this.maxReaddirsInFlight, this.readdirsInFlight);
			try {
				if (this.readdirDelayMs > 0) await Bun.sleep(this.readdirDelayMs);
				if (this.unreadable.has(path)) throw codeError("EACCES");
				if (!this.nodes.get(path)?.dir) throw codeError("ENOENT");
				const out: Array<{ name: string; isDirectory(): boolean }> = [];
				for (const [key, node] of this.nodes) {
					if (key !== path && dirname(key) === path) {
						out.push({ name: key.slice(path.length + 1), isDirectory: () => node.dir });
					}
				}
				return out;
			} finally {
				this.readdirsInFlight -= 1;
			}
		},
	};

	readonly watch = ((path: string, _options: unknown, listener: Listener) => {
		const code = this.watchErrors.get(path) ?? (this.unreadable.has(path) ? "EACCES" : undefined);
		if (code) throw codeError(code);
		if (this.liveWatches().length >= this.systemWatchLimit) throw codeError("ENOSPC");
		const watcher = new FakeWatcher(path, listener);
		this.watchers.set(path, watcher);
		return watcher;
	}) as unknown as typeof import("node:fs").watch;
}

function setup(world: FakeWorld, options: { maxDirectoryWatches?: number; capRetryMs?: number } = {}) {
	const events: FileBrowserChangeEvent[] = [];
	const logs: string[] = [];
	const registry = createFileBrowserWatchRegistry<string>({
		send: (_subscriber, event) => {
			events.push(event);
			return true;
		},
		getGitMetadataWatchPaths: () => [],
		debounceMs: 5,
		contentWatchBackend: "directories",
		nativeWatch: world.watch,
		directoryFs: world.fs,
		capRetryMs: options.capRetryMs ?? 10,
		log: (message) => logs.push(message),
		...(options.maxDirectoryWatches !== undefined && { maxDirectoryWatches: options.maxDirectoryWatches }),
	});
	const target = (root = ROOT): FileBrowserWatchTarget => ({
		key: `dir:${root}`,
		watchPath: root,
		watchGit: false,
		ignored: (path) => {
			const rel = relative(root, path);
			return Boolean(rel) && !rel.startsWith("..") && isFileBrowserWatchExcludedPath(rel);
		},
	});
	const subscribe = (name = "client", root = ROOT) => {
		const handle = registry.ensure(target(root));
		registry.attach(handle, name, root);
		return handle;
	};
	const settled = async () => {
		await waitFor(() => !registry.diagnostics().scanning);
		await Bun.sleep(15);
		await waitFor(() => !registry.diagnostics().scanning);
	};
	return { registry, events, logs, subscribe, target, settled };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error("Timed out waiting for condition");
}

describe("per-directory watcher (Linux backend)", () => {
	test("watches every folder once and skips ignored ones", async () => {
		const world = new FakeWorld();
		world.mkdir("/repo/docs");
		world.mkdir("/repo/docs/guides");
		world.file("/repo/docs/plan.md");
		world.mkdir("/repo/node_modules");
		world.mkdir("/repo/node_modules/pkg");
		world.mkdir("/repo/.jj");
		world.mkdir("/repo/.jj/repo");
		world.mkdir("/repo/dist");
		const { registry, subscribe, settled } = setup(world);
		try {
			subscribe();
			await settled();
			expect(world.liveWatches()).toEqual(["/repo", "/repo/docs", "/repo/docs/guides"]);
			expect(registry.diagnostics().directoryWatches).toBe(3);
		} finally {
			registry.closeAll();
		}
		expect(world.liveWatches()).toEqual([]);
	});

	test("past the cap it keeps the folders nearest the root, says so once, and keeps refreshing", async () => {
		const world = new FakeWorld();
		// 3 top folders, each with 3 children, each with 3 grandchildren: 1 + 3 + 9 + 27.
		for (const top of world.folders(ROOT, "t", 3)) {
			for (const mid of world.folders(top, "m", 3)) world.folders(mid, "g", 3);
		}
		const { registry, events, logs, subscribe, settled } = setup(world, { maxDirectoryWatches: 10 });
		try {
			subscribe();
			await settled();
			const watched = world.liveWatches();
			expect(watched).toHaveLength(10);
			// Breadth first: the root and every depth-1 and depth-2 folder fit
			// before any grandchild (1 + 3 + 6 of the 9 at depth 2).
			expect(watched).toContain(ROOT);
			for (const top of ["/repo/t0", "/repo/t1", "/repo/t2"]) expect(watched).toContain(top);
			expect(watched.some((path) => path.split("/").length > 4)).toBe(false);
			expect(logs.filter((line) => line.includes("folder-watch limit"))).toHaveLength(1);

			// Watching never stopped: a change in a watched folder still refreshes.
			world.file("/repo/t1/new.md");
			world.emit("/repo/t1", "rename", "new.md");
			await waitFor(() => events.length > 0);
			expect(events.at(-1)).toMatchObject({ type: "changed", reason: "files" });

			// More folders past the cap: still one log line, still 10 watches.
			world.createDir("/repo/t0/m0/deeper");
			await settled();
			expect(world.liveWatches()).toHaveLength(10);
			expect(logs.filter((line) => line.includes("folder-watch limit"))).toHaveLength(1);
		} finally {
			registry.closeAll();
		}
	});

	test("a new shallow folder takes the slot of the deepest watch when the budget is full", async () => {
		const world = new FakeWorld();
		world.mkdir("/repo/a");
		world.mkdir("/repo/a/b");
		world.mkdir("/repo/a/b/c");
		const { registry, subscribe, settled } = setup(world, { maxDirectoryWatches: 4 });
		try {
			subscribe();
			await settled();
			expect(world.liveWatches()).toEqual(["/repo", "/repo/a", "/repo/a/b", "/repo/a/b/c"]);
			world.createDir("/repo/top");
			await settled();
			expect(world.liveWatches()).toEqual(["/repo", "/repo/a", "/repo/a/b", "/repo/top"]);
		} finally {
			registry.closeAll();
		}
	});

	test("a freed watch lets the folders the cap skipped back in", async () => {
		const world = new FakeWorld();
		world.folders(ROOT, "f", 5);
		const { registry, subscribe, settled } = setup(world, { maxDirectoryWatches: 4 });
		try {
			subscribe();
			await settled();
			expect(world.liveWatches()).toHaveLength(4);
			const skipped = ["/repo/f0", "/repo/f1", "/repo/f2", "/repo/f3", "/repo/f4"].filter(
				(path) => !world.liveWatches().includes(path),
			);
			expect(skipped).toHaveLength(2);
			// Remove one watched folder: the retry scan picks a skipped one up.
			const watchedChild = world.liveWatches().find((path) => path !== ROOT)!;
			world.remove(watchedChild);
			world.emit(ROOT, "rename", watchedChild.slice(ROOT.length + 1));
			await waitFor(() => world.liveWatches().some((path) => skipped.includes(path)));
			await settled();
			expect(world.liveWatches()).toHaveLength(4);
			expect(world.liveWatches()).not.toContain(watchedChild);
		} finally {
			registry.closeAll();
		}
	});

	test("an unreadable folder is skipped and everything else keeps being watched", async () => {
		const world = new FakeWorld();
		world.mkdir("/repo/docs");
		world.mkdir("/repo/docs/deep");
		world.mkdir("/repo/volume"); // owned by another user, as a docker volume
		world.mkdir("/repo/volume/data");
		world.mkdir("/repo/listonly"); // stat works, listing does not
		world.mkdir("/repo/zz");
		world.unreadable.add("/repo/volume");
		const { registry, events, logs, subscribe, settled } = setup(world);
		// readdir alone refused for one folder.
		const readdir = world.fs.readdir;
		world.fs.readdir = async (path) => {
			if (path === "/repo/listonly") throw codeError("EACCES");
			return readdir(path);
		};
		try {
			subscribe();
			await settled();
			expect(world.liveWatches()).toEqual(["/repo", "/repo/docs", "/repo/docs/deep", "/repo/listonly", "/repo/zz"]);
			expect(registry.diagnostics().failedEntries).toBe(0);
			expect(logs.filter((line) => line.includes("cannot read"))).toHaveLength(1);
			world.createDir("/repo/zz/later");
			await waitFor(() => world.liveWatches().includes("/repo/zz/later"));
			expect(events.length).toBeGreaterThan(0);
		} finally {
			registry.closeAll();
		}
	});

	test("a folder whose watch fails to start is skipped, not fatal", async () => {
		const world = new FakeWorld();
		world.mkdir("/repo/a");
		world.mkdir("/repo/b");
		world.watchErrors.set("/repo/a", "EIO");
		const { registry, subscribe, settled } = setup(world);
		try {
			subscribe();
			await settled();
			expect(world.liveWatches()).toEqual(["/repo", "/repo/b"]);
			expect(registry.diagnostics().failedEntries).toBe(0);
		} finally {
			registry.closeAll();
		}
	});

	test("one folder's runtime watch error drops that watch only", async () => {
		const world = new FakeWorld();
		world.mkdir("/repo/a");
		world.mkdir("/repo/b");
		const { registry, events, subscribe, settled } = setup(world);
		try {
			subscribe();
			await settled();
			world.watchers.get("/repo/a")!.emit("error", codeError("EIO"));
			await waitFor(() => events.length > 0);
			expect(world.liveWatches()).toEqual(["/repo", "/repo/b"]);
			world.createDir("/repo/b/c");
			await waitFor(() => world.liveWatches().includes("/repo/b/c"));
		} finally {
			registry.closeAll();
		}
	});

	test("running out of system watches on a deep folder keeps the rest and does not mark the entry failed", async () => {
		const world = new FakeWorld();
		world.folders(ROOT, "f", 6);
		world.systemWatchLimit = 3;
		const { registry, logs, subscribe, settled } = setup(world);
		try {
			subscribe("first");
			await settled();
			expect(world.liveWatches()).toHaveLength(3);
			expect(logs.filter((line) => line.includes("ran out of file watches"))).toHaveLength(1);
			// Not failed: a reload reuses the entry instead of rebuilding every
			// watch while the system is still at its limit.
			expect(registry.diagnostics().failedEntries).toBe(0);
			subscribe("second");
			await settled();
			expect(registry.diagnostics()).toMatchObject({ entries: 1, contentWatcherStarts: 1, directoryWatches: 3 });

			// A freed watch lets the skipped folders back in.
			world.systemWatchLimit = Infinity;
			const watched = world.liveWatches().find((path) => path !== ROOT)!;
			world.remove(watched);
			world.emit(ROOT, "rename", watched.slice(ROOT.length + 1));
			// Every skipped folder comes back: root + the 5 folders left.
			await waitFor(() => world.liveWatches().length === 6 && !world.liveWatches().includes(watched));
		} finally {
			registry.closeAll();
		}
	});

	test("no watch left for the root marks the entry failed, and a reload rebuilds it", async () => {
		const world = new FakeWorld();
		world.folders(ROOT, "f", 2);
		world.systemWatchLimit = 0;
		const { registry, logs, subscribe, settled } = setup(world);
		try {
			subscribe("first");
			await settled();
			expect(world.liveWatches()).toEqual([]);
			expect(registry.diagnostics().failedEntries).toBe(1);
			expect(logs.some((line) => line.includes(`Live refresh for ${ROOT} is off`))).toBe(true);
			world.systemWatchLimit = Infinity;
			subscribe("second");
			await waitFor(() => world.liveWatches().length === 3);
			expect(registry.diagnostics()).toMatchObject({ entries: 1, failedEntries: 0, contentWatcherStarts: 2 });
		} finally {
			registry.closeAll();
		}
	});

	test("an unreadable root is reported as the root being off, not as one skipped folder", async () => {
		const world = new FakeWorld();
		world.unreadable.add(ROOT);
		const { registry, logs, subscribe, settled } = setup(world);
		try {
			subscribe();
			await settled();
			expect(registry.diagnostics().failedEntries).toBe(1);
			expect(logs).toEqual([`Live refresh for ${ROOT} is off: it cannot be read. Reloading the page tries again.`]);
		} finally {
			registry.closeAll();
		}
	});

	test("a freed watch in a capped tree scans only skipped folders, never the whole tree again", async () => {
		const world = new FakeWorld();
		for (const top of world.folders(ROOT, "t", 4)) world.folders(top, "m", 4);
		const { registry, subscribe, settled } = setup(world, { maxDirectoryWatches: 8 });
		try {
			subscribe();
			await settled();
			expect(world.liveWatches()).toHaveLength(8);
			// Delete one watched depth-2 folder, five times over.
			for (let round = 0; round < 5; round += 1) {
				const victim = world.liveWatches().find((path) => path.split("/").length === 4)!;
				const rootListingsBefore = world.readdirCalls;
				world.remove(victim);
				world.emit(dirname(victim), "rename", victim.slice(dirname(victim).length + 1));
				await waitFor(() => world.liveWatches().length === 8 && !world.liveWatches().includes(victim));
				await settled();
				// The parent's re-list plus the one skipped folder's scan: a few
				// listings, not the 1 + 4 + 16 a full rescan would take.
				expect(world.readdirCalls - rootListingsBefore).toBeLessThanOrEqual(3);
			}
		} finally {
			registry.closeAll();
		}
	});

	test("skipped folders that are deleted or moved away are forgotten, so freed slots go to real folders", async () => {
		const world = new FakeWorld();
		world.mkdir("/repo/a");
		world.mkdir("/repo/a/x");
		world.mkdir("/repo/b");
		world.mkdir("/repo/b/y");
		world.mkdir("/repo/c");
		world.mkdir("/repo/d");
		const { registry, subscribe, settled } = setup(world, { maxDirectoryWatches: 3 });
		try {
			subscribe();
			await settled();
			expect(world.liveWatches()).toEqual([ROOT, "/repo/a", "/repo/b"]);
			// c and d were skipped; c is deleted, d moved out of the tree.
			world.remove("/repo/c");
			world.emit(ROOT, "rename", "c");
			world.remove("/repo/d");
			world.emit(ROOT, "rename", "d");
			await settled();
			// Removing b frees one watch and forgets b/y with it.
			world.remove("/repo/b");
			world.emit(ROOT, "rename", "b");
			await waitFor(() => world.liveWatches().includes("/repo/a/x"));
			await settled();
			expect(world.liveWatches()).toEqual([ROOT, "/repo/a", "/repo/a/x"]);
		} finally {
			registry.closeAll();
		}
	});

	test("a root that can be watched but not listed says so once", async () => {
		const world = new FakeWorld();
		const readdir = world.fs.readdir;
		world.fs.readdir = async (path) => {
			if (path === ROOT) throw codeError("EACCES");
			return readdir(path);
		};
		const { registry, logs, subscribe, settled } = setup(world);
		try {
			subscribe();
			await settled();
			for (let i = 0; i < 3; i += 1) {
				world.emit(ROOT, "rename", `f${i}.md`);
				await settled();
			}
			expect(logs.filter((line) => line.includes("cannot list it"))).toHaveLength(1);
			expect(registry.diagnostics().failedEntries).toBe(0);
		} finally {
			registry.closeAll();
		}
	});

	test("a burst of new files queues one re-list, not a scan per file", async () => {
		const world = new FakeWorld();
		world.mkdir("/repo/docs");
		world.readdirDelayMs = 2;
		const { registry, subscribe, settled } = setup(world);
		try {
			subscribe();
			await settled();
			const before = world.readdirCalls;
			const started = performance.now();
			for (let i = 0; i < 20_000; i += 1) {
				world.file(`/repo/docs/f${i}.md`);
				world.emit("/repo/docs", "rename", `f${i}.md`);
			}
			const emitMs = performance.now() - started;
			await settled();
			// Constant work per event: 20k events take far less than a second.
			expect(emitMs).toBeLessThan(1_000);
			expect(world.readdirCalls - before).toBeLessThanOrEqual(2);
		} finally {
			registry.closeAll();
		}
	});

	test("a failed watch is not reused: the next subscription rebuilds it and keeps the open tabs", async () => {
		const world = new FakeWorld();
		world.mkdir("/repo/docs");
		world.watchErrors.set(ROOT, "EIO");
		const { registry, events, subscribe, settled } = setup(world);
		try {
			subscribe("old-tab");
			await settled();
			expect(world.liveWatches()).toEqual([]);
			expect(registry.diagnostics().failedEntries).toBe(1);

			world.watchErrors.delete(ROOT);
			subscribe("reload");
			await waitFor(() => world.liveWatches().length === 2);
			expect(registry.diagnostics()).toMatchObject({ entries: 1, failedEntries: 0, contentWatcherStarts: 2 });

			// Both the reloaded tab and the tab that was already open hear changes.
			events.length = 0;
			world.file("/repo/docs/a.md");
			world.emit("/repo/docs", "rename", "a.md");
			await waitFor(() => events.length >= 2);
			expect(new Set(events.map((event) => event.dirPath))).toEqual(new Set([ROOT]));
		} finally {
			registry.closeAll();
		}
	});

	test("a healthy watch is still reused across a reconnect", async () => {
		const world = new FakeWorld();
		const { registry, subscribe, settled } = setup(world);
		try {
			const handle = subscribe("first");
			await settled();
			registry.release(handle, "first");
			subscribe("second");
			await settled();
			expect(registry.diagnostics()).toMatchObject({ entries: 1, contentWatcherStarts: 1 });
		} finally {
			registry.closeAll();
		}
	});

	test("creating an ignored folder neither refreshes nor watches it", async () => {
		const world = new FakeWorld();
		const { registry, events, subscribe, settled } = setup(world);
		try {
			subscribe();
			await settled();
			world.createDir("/repo/dist");
			world.createDir("/repo/node_modules");
			world.emit(ROOT, "change", "dist");
			await Bun.sleep(40);
			expect(events).toEqual([]);
			expect(world.liveWatches()).toEqual([ROOT]);

			world.createDir("/repo/docs");
			await waitFor(() => events.length > 0);
			await settled();
			expect(world.liveWatches()).toEqual([ROOT, "/repo/docs"]);
		} finally {
			registry.closeAll();
		}
	});

	test("scans never overlap, and a burst of events settles on the right watches", async () => {
		const world = new FakeWorld();
		world.folders(ROOT, "a", 4);
		world.readdirDelayMs = 3;
		const { registry, subscribe, settled } = setup(world);
		try {
			subscribe();
			await settled();
			world.maxReaddirsInFlight = 0;
			// Create, delete and recreate folders while scans are still running.
			for (let i = 0; i < 6; i += 1) world.createDir(`/repo/b${i}`);
			world.remove("/repo/a1");
			world.emit(ROOT, "rename", "a1");
			world.mkdir("/repo/b0/inner"); // its parent is still being scanned
			world.remove("/repo/b3");
			world.emit(ROOT, "rename", "b3");
			world.emit(ROOT, "rename", null as unknown as string);
			await settled();
			expect(world.maxReaddirsInFlight).toBe(1);
			const expected = [...world.nodes.entries()].filter(([, node]) => node.dir).map(([path]) => path).sort();
			expect(world.liveWatches()).toEqual(expected);
			expect(registry.diagnostics().watchedDirectories).toEqual(expected);
		} finally {
			registry.closeAll();
		}
	});

	test("a folder removed and recreated is watched again under its new identity", async () => {
		const world = new FakeWorld();
		world.mkdir("/repo/a");
		world.mkdir("/repo/a/b");
		const { registry, subscribe, settled } = setup(world);
		try {
			subscribe();
			await settled();
			const first = world.watchers.get("/repo/a")!;
			world.remove("/repo/a");
			world.emit(ROOT, "rename", "a");
			await settled();
			expect(world.liveWatches()).toEqual([ROOT]);
			world.mkdir("/repo/a");
			world.mkdir("/repo/a/c");
			world.emit(ROOT, "rename", "a");
			await settled();
			expect(world.liveWatches()).toEqual([ROOT, "/repo/a", "/repo/a/c"]);
			expect(first.closed).toBe(true);
			expect(world.watchers.get("/repo/a")).not.toBe(first);
		} finally {
			registry.closeAll();
		}
	});

	test("a folder moved inside the tree is followed when only its old name is reported (Bun on Linux)", async () => {
		const world = new FakeWorld();
		world.mkdir("/repo/old");
		world.mkdir("/repo/old/inner");
		const { registry, subscribe, settled } = setup(world);
		try {
			subscribe();
			await settled();
			for (const [path, node] of [...world.nodes]) {
				if (path === "/repo/old" || path.startsWith("/repo/old/")) {
					world.nodes.delete(path);
					world.nodes.set(path.replace("/repo/old", "/repo/new"), node);
				}
			}
			world.emit(ROOT, "rename", "old");
			await settled();
			expect(world.liveWatches()).toEqual([ROOT, "/repo/new", "/repo/new/inner"]);
		} finally {
			registry.closeAll();
		}
	});

	test("subscriptions share one budget and closing one returns its watches", async () => {
		const world = new FakeWorld();
		world.mkdir("/other");
		world.folders("/other", "x", 3);
		world.folders(ROOT, "y", 3);
		const { registry, subscribe, settled } = setup(world, { maxDirectoryWatches: 6 });
		try {
			const other = subscribe("a", "/other");
			await settled();
			subscribe("b", ROOT);
			await settled();
			expect(registry.diagnostics().directoryWatches).toBe(6);
			expect(world.liveWatches().filter((path) => path.startsWith(ROOT))).toHaveLength(2);
			registry.configureForTests({ teardownGraceMs: 1 });
			registry.release(other, "a");
			await waitFor(() => world.liveWatches().filter((path) => path.startsWith(ROOT)).length === 4);
			expect(registry.diagnostics().directoryWatches).toBe(4);
		} finally {
			registry.closeAll();
		}
	});

	test("the budget follows the system's inotify allowance, within bounds", () => {
		expect(directoryWatchLimitFor(8_192)).toBe(2_048);
		expect(directoryWatchLimitFor(65_536)).toBe(8_192);
		expect(directoryWatchLimitFor(1_048_576)).toBe(8_192);
		expect(directoryWatchLimitFor(1_000)).toBe(1_024);
		expect(directoryWatchLimitFor(null)).toBe(4_096);
		expect(directoryWatchLimitFor(Number.NaN)).toBe(4_096);
	});
});

describe("exact-file watches", () => {
	test("a failed exact-file watch is rebuilt by the next subscription", async () => {
		let fail = true;
		const created: FakeWatcher[] = [];
		const watch = ((path: string, _options: unknown, listener: Listener) => {
			if (fail) throw codeError("ENOSPC");
			const watcher = new FakeWatcher(path, listener);
			created.push(watcher);
			return watcher;
		}) as unknown as typeof import("node:fs").watch;
		const registry = createFileBrowserWatchRegistry<string>({
			send: () => true,
			getGitMetadataWatchPaths: () => [],
			nativeWatch: watch,
			log: () => {},
		});
		const target: FileBrowserWatchTarget = {
			key: "file:/repo/plan.md",
			watchPath: "/repo",
			watchGit: false,
			exactFilePath: "/repo/plan.md",
		};
		try {
			registry.attach(registry.ensure(target), "tab", "/repo");
			await waitFor(() => registry.diagnostics().failedEntries === 1);
			fail = false;
			registry.attach(registry.ensure(target), "reload", "/repo");
			await waitFor(() => created.length === 1);
			expect(registry.diagnostics()).toMatchObject({ entries: 1, failedEntries: 0, contentWatcherStarts: 2 });
		} finally {
			registry.closeAll();
		}
	});
});
