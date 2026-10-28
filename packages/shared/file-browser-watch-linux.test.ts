/**
 * The per-directory watcher on a real Linux filesystem with real inotify
 * (#1439). The same paths run everywhere over a fake filesystem in
 * file-browser-watch-directories.test.ts; this file proves the real thing.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
	createFileBrowserWatchRegistry,
	type FileBrowserChangeEvent,
	type FileBrowserWatchTarget,
} from "./file-browser-watch-core";
import { isFileBrowserWatchExcludedPath } from "./reference-common";

const onLinux = process.platform === "linux";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(20);
	}
	throw new Error("Timed out waiting for condition");
}

function setup(options: { maxDirectoryWatches?: number } = {}) {
	const root = mkdtempSync(join(tmpdir(), "plannotator-linux-watch-"));
	const events: FileBrowserChangeEvent[] = [];
	const logs: string[] = [];
	const registry = createFileBrowserWatchRegistry<string>({
		send: (_subscriber, event) => {
			events.push(event);
			return true;
		},
		getGitMetadataWatchPaths: () => [],
		debounceMs: 20,
		capRetryMs: 20,
		log: (message) => logs.push(message),
		...(options.maxDirectoryWatches !== undefined && { maxDirectoryWatches: options.maxDirectoryWatches }),
	});
	const target: FileBrowserWatchTarget = {
		key: `dir:${root}`,
		watchPath: root,
		watchGit: false,
		ignored: (path) => {
			const rel = relative(root, path);
			return Boolean(rel) && !rel.startsWith("..") && isFileBrowserWatchExcludedPath(rel);
		},
	};
	const subscribe = () => registry.attach(registry.ensure(target), "client", root);
	const settled = async () => {
		await Bun.sleep(50);
		await waitFor(() => !registry.diagnostics().scanning);
	};
	const cleanup = () => {
		registry.closeAll();
		rmSync(root, { recursive: true, force: true });
	};
	return { root, registry, events, logs, subscribe, settled, cleanup };
}

describe.skipIf(!onLinux)("per-directory watcher on real Linux inotify", () => {
	test("one watch per folder, following new nested folders", async () => {
		const world = setup();
		try {
			mkdirSync(join(world.root, "docs", "guides"), { recursive: true });
			for (let i = 0; i < 50; i += 1) writeFileSync(join(world.root, "docs", `f${i}.md`), "x");
			world.subscribe();
			await world.settled();
			expect(world.registry.diagnostics().watchedDirectories).toEqual([
				world.root,
				join(world.root, "docs"),
				join(world.root, "docs", "guides"),
			]);

			mkdirSync(join(world.root, "docs", "guides", "new"));
			await waitFor(() => world.registry.diagnostics().watchedDirectories.includes(join(world.root, "docs", "guides", "new")));
			await world.settled();
			world.events.length = 0;
			writeFileSync(join(world.root, "docs", "guides", "new", "plan.md"), "created");
			await waitFor(() => world.events.length > 0);
			expect(world.events.at(-1)).toMatchObject({ type: "changed", reason: "files" });
		} finally {
			world.cleanup();
		}
	});

	test("more folders than the old 512 cap are all watched under the default budget", async () => {
		const world = setup();
		try {
			for (let i = 0; i < 30; i += 1) {
				for (let j = 0; j < 20; j += 1) mkdirSync(join(world.root, `pkg${i}`, `src${j}`), { recursive: true });
			}
			world.subscribe();
			await world.settled();
			// 1 root + 30 packages + 600 source folders.
			expect(world.registry.diagnostics().directoryWatches).toBe(631);
			expect(world.logs).toEqual([]);
			writeFileSync(join(world.root, "pkg29", "src19", "deep.md"), "x");
			await waitFor(() => world.events.length > 0);
		} finally {
			world.cleanup();
		}
	});

	test("a moved folder keeps refreshing under its new name", async () => {
		const world = setup();
		try {
			mkdirSync(join(world.root, "old", "inner"), { recursive: true });
			world.subscribe();
			await world.settled();
			renameSync(join(world.root, "old"), join(world.root, "new"));
			await waitFor(() => world.registry.diagnostics().watchedDirectories.includes(join(world.root, "new", "inner")));
			await world.settled();
			expect(world.registry.diagnostics().watchedDirectories).toEqual([
				world.root,
				join(world.root, "new"),
				join(world.root, "new", "inner"),
			]);
			world.events.length = 0;
			writeFileSync(join(world.root, "new", "inner", "after-move.md"), "x");
			await waitFor(() => world.events.length > 0);
		} finally {
			world.cleanup();
		}
	});

	test("a symlink to a folder is not followed, so a link to an ancestor cannot loop", async () => {
		const world = setup();
		try {
			mkdirSync(join(world.root, "docs"));
			world.subscribe();
			await world.settled();
			symlinkSync(world.root, join(world.root, "docs", "loop"));
			await waitFor(() => world.events.length > 0);
			await world.settled();
			expect(world.registry.diagnostics().watchedDirectories).toEqual([world.root, join(world.root, "docs")]);
		} finally {
			world.cleanup();
		}
	});

	test("a burst of new files keeps the event loop responsive", async () => {
		const world = setup();
		try {
			mkdirSync(join(world.root, "notes"));
			world.subscribe();
			await world.settled();
			// Another process writes the files, so the lag measured here is the
			// watcher's own work. Before the fix every file queued a scan and each
			// queueing walked the whole queue: quadratic, about a 2 s stall at 20k
			// files and a minute at 100k.
			let maxLagMs = 0;
			let last = performance.now();
			const ticker = setInterval(() => {
				const now = performance.now();
				maxLagMs = Math.max(maxLagMs, now - last - 10);
				last = now;
			}, 10);
			try {
				const writer = Bun.spawn(
					[process.execPath, "-e", `const fs=require("fs");for(let i=0;i<20000;i++)fs.writeFileSync(process.env.BURST_DIR+"/f"+i+".md","x")`],
					{ stdout: "ignore", stderr: "inherit", env: { ...process.env, BURST_DIR: join(world.root, "notes") } },
				);
				expect(await writer.exited).toBe(0);
				await waitFor(() => world.events.length > 0);
				await world.settled();
				await Bun.sleep(100);
			} finally {
				clearInterval(ticker);
			}
			expect(maxLagMs).toBeLessThan(1_000);
			expect(world.registry.diagnostics().watchedDirectories).toEqual([world.root, join(world.root, "notes")]);
		} finally {
			world.cleanup();
		}
	}, 30_000);

	test("creating an ignored folder does not refresh", async () => {
		const world = setup();
		try {
			world.subscribe();
			await world.settled();
			mkdirSync(join(world.root, "dist"));
			mkdirSync(join(world.root, "node_modules"));
			writeFileSync(join(world.root, "node_modules", "x.js"), "x");
			await Bun.sleep(400);
			expect(world.events).toEqual([]);
			expect(world.registry.diagnostics().watchedDirectories).toEqual([world.root]);
		} finally {
			world.cleanup();
		}
	});

	test("past the cap the root keeps refreshing", async () => {
		const world = setup({ maxDirectoryWatches: 3 });
		try {
			for (let i = 0; i < 6; i += 1) mkdirSync(join(world.root, `d${i}`, "inner"), { recursive: true });
			world.subscribe();
			await world.settled();
			const watched = world.registry.diagnostics().watchedDirectories;
			expect(watched).toHaveLength(3);
			expect(watched).toContain(world.root);
			expect(world.logs.some((line) => line.includes("folder-watch limit"))).toBe(true);
			writeFileSync(join(world.root, "top.md"), "x");
			await waitFor(() => world.events.length > 0);
		} finally {
			world.cleanup();
		}
	});

	test("folders the cap skipped that are later deleted never hold back a real folder", async () => {
		const world = setup({ maxDirectoryWatches: 3 });
		try {
			const top = ["a", "b", "c"].map((name) => join(world.root, name));
			for (const [i, folder] of top.entries()) mkdirSync(join(folder, `inner${i}`), { recursive: true });
			world.subscribe();
			await world.settled();
			// Which top folder the cap skips follows readdir order, which real
			// filesystems do not sort (ext4 lists by name hash).
			const watched = world.registry.diagnostics().watchedDirectories;
			expect(watched).toHaveLength(3);
			expect(watched).toContain(world.root);
			const skipped = top.filter((folder) => !watched.includes(folder));
			expect(skipped).toHaveLength(1);
			const [freed, kept] = top.filter((folder) => watched.includes(folder));
			const keptInner = join(kept!, `inner${top.indexOf(kept!)}`);
			// The skipped folder goes away, then another frees a watch.
			rmSync(skipped[0]!, { recursive: true });
			await world.settled();
			rmSync(freed!, { recursive: true });
			await waitFor(() => world.registry.diagnostics().watchedDirectories.includes(keptInner));
			await world.settled();
			expect(world.registry.diagnostics().watchedDirectories).toEqual([world.root, kept!, keptInner]);
		} finally {
			world.cleanup();
		}
	});

	test.skipIf(isRoot)("an unreadable folder is skipped and the rest keeps refreshing", async () => {
		const world = setup();
		const locked = join(world.root, "volume");
		try {
			mkdirSync(join(locked, "data"), { recursive: true });
			mkdirSync(join(world.root, "docs"));
			chmodSync(locked, 0o000);
			world.subscribe();
			await world.settled();
			expect(world.registry.diagnostics().watchedDirectories).toEqual([world.root, join(world.root, "docs")]);
			expect(world.registry.diagnostics().failedEntries).toBe(0);
			writeFileSync(join(world.root, "docs", "plan.md"), "x");
			await waitFor(() => world.events.length > 0);
		} finally {
			chmodSync(locked, 0o755);
			world.cleanup();
		}
	});
});
