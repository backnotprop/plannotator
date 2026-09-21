import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createFileBrowserWatchRegistry,
	type FileBrowserChangeEvent,
	type FileBrowserWatchTarget,
} from "./file-browser-watch-core";

// Timing note: watcher construction is deferred one macrotask and broadcasts
// are debounced, so every expectation polls with a deadline instead of
// asserting instantly.

interface Recorded {
	events: FileBrowserChangeEvent[];
}

function makeRegistry(options?: {
	teardownGraceMs?: number;
	contentWatchBackend?: "auto" | "chokidar" | "native";
	nativeWatch?: unknown;
}) {
	const recorded = new Map<string, Recorded>();
	const registry = createFileBrowserWatchRegistry<string>({
		send: (subscriber, event) => {
			const box = recorded.get(subscriber);
			if (!box) return false;
			box.events.push(event);
			return true;
		},
		getGitMetadataWatchPaths: () => [],
		debounceMs: 20,
		...(options?.teardownGraceMs !== undefined && { teardownGraceMs: options.teardownGraceMs }),
		...(options?.contentWatchBackend && { contentWatchBackend: options.contentWatchBackend }),
		...(options?.nativeWatch !== undefined && { nativeWatch: options.nativeWatch as never }),
	});
	const subscribe = (name: string, target: FileBrowserWatchTarget) => {
		recorded.set(name, { events: [] });
		const handle = registry.ensure(target);
		registry.attach(handle, name, target.watchPath);
		return handle;
	};
	return { registry, recorded, subscribe };
}

function dirTarget(watchPath: string): FileBrowserWatchTarget {
	return { key: `dir:${watchPath}`, watchPath, watchGit: false };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(25);
	}
	throw new Error("Timed out waiting for condition");
}

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "plannotator-watch-core-"));
}

describe("file-browser-watch-core", () => {
	test("a native-watch creation failure falls back to chokidar without losing events", async () => {
		const root = makeTempDir();
		const throwingNativeWatch = () => {
			throw new Error("recursive watch unavailable");
		};
		const { registry, recorded, subscribe } = makeRegistry({
			contentWatchBackend: "native",
			nativeWatch: throwingNativeWatch,
		});
		try {
			subscribe("client", dirTarget(root));
			// Let the deferred warmup run and chokidar's scan settle.
			await Bun.sleep(250);
			writeFileSync(join(root, "plan.md"), "created");
			await waitFor(() => (recorded.get("client")?.events.length ?? 0) > 0);
			expect(recorded.get("client")?.events[0]).toMatchObject({ type: "changed", reason: "files" });
		} finally {
			registry.closeAll();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test(
		"a native-watch runtime error swaps to chokidar and forces a catch-up refresh",
		async () => {
			const root = makeTempDir();
			// A fake native watcher: created successfully, then fails at runtime.
			let created: (EventEmitter & { close: () => void }) | null = null;
			const fakeNativeWatch = (() => {
				const emitter = new EventEmitter() as EventEmitter & { close: () => void };
				emitter.close = () => {};
				created = emitter;
				return emitter;
			}) as unknown as typeof import("node:fs").watch;
			const { registry, recorded, subscribe } = makeRegistry({
				contentWatchBackend: "native",
				nativeWatch: fakeNativeWatch,
			});
			try {
				subscribe("client", dirTarget(root));
				await waitFor(() => created !== null);
				(created as unknown as EventEmitter).emit("error", new Error("EMFILE"));
				// The swap itself forces one refresh so changes made during the
				// gap are not lost.
				await waitFor(() => (recorded.get("client")?.events.length ?? 0) > 0);
				// And the chokidar replacement keeps delivering real events, with the
				// swap counted as a second construction in the diagnostics.
				expect(registry.diagnostics().contentWatcherStarts).toBe(2);
				await Bun.sleep(250);
				const before = recorded.get("client")?.events.length ?? 0;
				writeFileSync(join(root, "after-swap.md"), "x");
				await waitFor(() => (recorded.get("client")?.events.length ?? 0) > before);
			} finally {
				registry.closeAll();
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	test("a resubscription inside the teardown grace reuses the warm watcher", async () => {
		const root = makeTempDir();
		const { registry, recorded, subscribe } = makeRegistry({ teardownGraceMs: 60_000 });
		try {
			const handle = subscribe("first", dirTarget(root));
			await Bun.sleep(100);
			expect(registry.diagnostics()).toMatchObject({ entries: 1, contentWatcherStarts: 1 });

			// Last subscriber leaves: the entry must survive the grace window.
			registry.release(handle, "first");
			expect(registry.diagnostics().entries).toBe(1);

			// Reconnect: same entry, no second construction. This is the #1313
			// freeze loop regression guard: a rebuild here re-pays the full scan.
			subscribe("second", dirTarget(root));
			await Bun.sleep(100);
			expect(registry.diagnostics()).toMatchObject({ entries: 1, contentWatcherStarts: 1 });

			// The reused watcher still delivers to the new subscriber.
			writeFileSync(join(root, "reconnect.md"), "x");
			await waitFor(() => (recorded.get("second")?.events.length ?? 0) > 0);
		} finally {
			registry.closeAll();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("an expired teardown grace closes the entry", async () => {
		const root = makeTempDir();
		const { registry, subscribe } = makeRegistry({ teardownGraceMs: 120 });
		try {
			const handle = subscribe("only", dirTarget(root));
			await Bun.sleep(50);
			registry.release(handle, "only");
			expect(registry.diagnostics().entries).toBe(1);
			await waitFor(() => registry.diagnostics().entries === 0, 2_000);
		} finally {
			registry.closeAll();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("closeAll tears down immediately, including entries inside their grace window", async () => {
		const root = makeTempDir();
		const { registry, subscribe } = makeRegistry({ teardownGraceMs: 60_000 });
		try {
			const handle = subscribe("only", dirTarget(root));
			registry.release(handle, "only");
			expect(registry.diagnostics().entries).toBe(1);
			registry.closeAll();
			expect(registry.diagnostics().entries).toBe(0);
		} finally {
			registry.closeAll();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
