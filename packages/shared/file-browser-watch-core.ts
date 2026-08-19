/**
 * Shared engine for the file-browser SSE watchers (Bun and Pi runtimes).
 *
 * #1313: the historical per-runtime implementations built a chokidar watcher
 * over the whole workspace synchronously on the request path. chokidar's
 * directory scan monopolizes the event loop for roughly 40ms per directory
 * under Bun, so a 228-directory repository froze the entire server for about
 * nine seconds, and because teardown was immediate on the last unsubscribe,
 * every EventSource reconnect paid the scan again. This module fixes the
 * class, once, for both runtimes:
 *
 * 1. Watcher construction is deferred off the request path, so the SSE ready
 *    event and concurrent API requests are served before any scan starts.
 * 2. Teardown gets a reconnect grace window. A reload or transient disconnect
 *    reuses the warm watcher instead of rebuilding it from scratch.
 * 3. On macOS and Windows the content watcher is the platform's native
 *    recursive fs.watch (measured at ~0ms for the same tree). chokidar
 *    remains the Linux backend (recursive fs.watch is unreliable there) and
 *    the runtime fallback whenever native watching fails. That fallback is a
 *    correctness fallback, not a performance one: the deferred warmup moves
 *    the scan off the first request, but a chokidar scan of a large tree
 *    still saturates the event loop while it runs. The reconnect grace keeps
 *    that a once-per-session cost instead of a per-reconnect one.
 *
 * The registry is transport-generic: the Bun runtime subscribes
 * ReadableStream controllers, the Pi runtime subscribes node:http responses.
 * Only the `send` callback differs.
 */

import chokidar, { type FSWatcher as ChokidarWatcher } from "chokidar";
import { watch as nodeFsWatch, statSync, type FSWatcher as NodeWatcher } from "node:fs";
import { resolve } from "node:path";

export interface FileBrowserChangeEvent {
	type: "ready" | "changed";
	dirPath: string;
	reason: "files" | "git" | "initial";
	timestamp: number;
}

export interface FileBrowserWatchTarget {
	key: string;
	watchPath: string;
	watchGit: boolean;
	exactFilePath?: string;
	ignored?: (path: string) => boolean;
}

export interface FileBrowserWatchRegistryOptions<S> {
	/** Deliver one serialized event to one subscriber; false drops the subscriber. */
	send: (subscriber: S, event: FileBrowserChangeEvent) => boolean;
	getGitMetadataWatchPaths: (watchPath: string) => string[];
	/** Reconnect grace before an unsubscribed watcher is torn down. */
	teardownGraceMs?: number;
	debounceMs?: number;
	/**
	 * Tests force "chokidar" to exercise the fallback backend everywhere, or
	 * "native" to exercise the native branch and its fallback paths on
	 * platforms where auto would pick chokidar (Linux CI).
	 */
	contentWatchBackend?: "auto" | "chokidar" | "native";
	/** Test seam for native-watch failure modes. Defaults to fs.watch. */
	nativeWatch?: typeof nodeFsWatch;
}

export interface WatchEntryHandle {
	readonly key: string;
}

interface WatchEntry<S> extends WatchEntryHandle {
	key: string;
	subscribers: Map<S, string>;
	contentWatcher: ChokidarWatcher | NodeWatcher | null;
	gitWatcher: ChokidarWatcher | null;
	debounceTimer: ReturnType<typeof setTimeout> | null;
	/** Deferred off-request construction (#1313). */
	warmupTimer: ReturnType<typeof setTimeout> | null;
	/** Pending reconnect-grace teardown (#1313). */
	teardownTimer: ReturnType<typeof setTimeout> | null;
	closed: boolean;
}

export interface FileBrowserWatchRegistry<S> {
	ensure(target: FileBrowserWatchTarget): WatchEntryHandle;
	attach(handle: WatchEntryHandle, subscriber: S, clientDirPath: string): void;
	release(handle: WatchEntryHandle, subscriber: S): void;
	/** Immediate teardown of every entry. Server stop and tests. */
	closeAll(): void;
	/**
	 * Tests only: entry count and how many content watchers were ever
	 * constructed. The grace-period test pins that a reconnect does not
	 * rebuild (starts stays flat), which is exactly the #1313 regression.
	 */
	diagnostics(): { entries: number; contentWatcherStarts: number };
	/** Tests only: override timing/backend without module-scope mutation. */
	configureForTests(overrides: Partial<Pick<FileBrowserWatchRegistryOptions<S>, "teardownGraceMs" | "debounceMs" | "contentWatchBackend" | "nativeWatch">>): void;
}

const DEFAULT_TEARDOWN_GRACE_MS = 30_000;
const DEFAULT_DEBOUNCE_MS = 180;

function getFileSignature(filePath: string): string {
	try {
		const stats = statSync(filePath, { bigint: true });
		return stats.isDirectory()
			? "directory"
			: `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
	} catch {
		return "missing";
	}
}

export function createExactFileWatchListener(
	watchPath: string,
	exactFilePath: string,
	onChange: () => void,
): (event: unknown, filename: string | Buffer | null | undefined) => void {
	let signature = getFileSignature(exactFilePath);
	return (_event, filename) => {
		try {
			const nextSignature = getFileSignature(exactFilePath);
			// Events on the watched directory itself arrive without a filename, as
			// null on some platforms and undefined on others (Bun on Linux).
			const eventMatches = filename == null
				|| resolve(watchPath, filename.toString()) === exactFilePath;
			if (eventMatches || nextSignature !== signature) {
				signature = nextSignature;
				onChange();
			}
		} catch {
			// A watcher event must never take down the server.
		}
	};
}

function nativeRecursiveSupported(): boolean {
	return process.platform === "darwin" || process.platform === "win32";
}

export function createFileBrowserWatchRegistry<S>(
	initialOptions: FileBrowserWatchRegistryOptions<S>,
): FileBrowserWatchRegistry<S> {
	const options = { ...initialOptions };
	const watchers = new Map<string, WatchEntry<S>>();
	let contentWatcherStarts = 0;

	const teardownGraceMs = () => options.teardownGraceMs ?? DEFAULT_TEARDOWN_GRACE_MS;
	const debounceMs = () => options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

	function broadcast(entry: WatchEntry<S>, reason: "files" | "git"): void {
		const hadSubscribers = entry.subscribers.size > 0;
		for (const [subscriber, clientDirPath] of entry.subscribers) {
			const event: FileBrowserChangeEvent = {
				type: "changed",
				dirPath: clientDirPath,
				reason,
				timestamp: Date.now(),
			};
			let delivered = false;
			try {
				delivered = options.send(subscriber, event);
			} catch {
				delivered = false;
			}
			if (!delivered) entry.subscribers.delete(subscriber);
		}
		// Dead subscribers discovered here never call release(), so an entry
		// emptied by delivery failures must still enter the teardown grace or
		// it lives until closeAll.
		if (hadSubscribers && entry.subscribers.size === 0) scheduleTeardown(entry);
	}

	function scheduleBroadcast(entry: WatchEntry<S>, reason: "files" | "git"): void {
		if (entry.closed) return;
		if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
		entry.debounceTimer = setTimeout(() => {
			entry.debounceTimer = null;
			broadcast(entry, reason);
		}, debounceMs());
	}

	function isCurrent(entry: WatchEntry<S>): boolean {
		return !entry.closed && watchers.get(entry.key) === entry;
	}

	function startChokidarContentWatcher(entry: WatchEntry<S>, target: FileBrowserWatchTarget): ChokidarWatcher {
		const watcher = chokidar.watch(target.watchPath, {
			ignoreInitial: true,
			persistent: true,
			ignored: target.ignored,
			awaitWriteFinish: {
				stabilityThreshold: 120,
				pollInterval: 30,
			},
		});
		watcher.on("all", () => scheduleBroadcast(entry, "files"));
		watcher.on("error", () => scheduleBroadcast(entry, "files"));
		return watcher;
	}

	function startContentWatcher(entry: WatchEntry<S>, target: FileBrowserWatchTarget): void {
		contentWatcherStarts += 1;
		if (target.exactFilePath) {
			const exactFilePath = target.exactFilePath;
			const watcher = (options.nativeWatch ?? nodeFsWatch)(
				target.watchPath,
				{ persistent: true },
				createExactFileWatchListener(target.watchPath, exactFilePath, () => scheduleBroadcast(entry, "files")),
			);
			watcher.on("error", () => scheduleBroadcast(entry, "files"));
			entry.contentWatcher = watcher;
			return;
		}

		const backend = options.contentWatchBackend ?? "auto";
		if (backend === "native" || (backend === "auto" && nativeRecursiveSupported())) {
			try {
				const nativeWatch = options.nativeWatch ?? nodeFsWatch;
				const watcher = nativeWatch(target.watchPath, { recursive: true, persistent: true }, (_event, filename) => {
					try {
						if (filename != null) {
							const abs = resolve(target.watchPath, filename.toString());
							if (target.ignored?.(abs)) return;
						}
						scheduleBroadcast(entry, "files");
					} catch {
						// A watcher event must never take down the server.
					}
				});
				watcher.on("error", (error) => {
					// Native watching failed at runtime. Swap to the chokidar backend
					// and force one refresh so anything that changed during the swap
					// window is not lost.
					try {
						watcher.close();
					} catch {
						// Already closed.
					}
					if (isCurrent(entry) && entry.contentWatcher === watcher) {
						console.error(
							`[plannotator] Native file watching failed for ${target.watchPath}; switching to the fallback watcher:`,
							error,
						);
						contentWatcherStarts += 1;
						entry.contentWatcher = startChokidarContentWatcher(entry, target);
						scheduleBroadcast(entry, "files");
					}
				});
				entry.contentWatcher = watcher;
				return;
			} catch (error) {
				// Native creation failed. Fall through to chokidar.
				console.error(
					`[plannotator] Native file watching unavailable for ${target.watchPath}; using the fallback watcher:`,
					error,
				);
			}
		}
		entry.contentWatcher = startChokidarContentWatcher(entry, target);
	}

	function buildWatchers(entry: WatchEntry<S>, target: FileBrowserWatchTarget): void {
		if (!isCurrent(entry)) return;
		try {
			startContentWatcher(entry, target);
		} catch (error) {
			// A watcher that cannot start must not take down the stream, but the
			// subscriber is now living without live refreshes; say so.
			console.error(`[plannotator] File watcher failed to start for ${target.watchPath}:`, error);
		}
		try {
			const gitWatchPaths = target.watchGit
				? options.getGitMetadataWatchPaths(target.watchPath)
				: [];
			if (gitWatchPaths.length > 0) {
				entry.gitWatcher = chokidar.watch(gitWatchPaths, {
					ignoreInitial: true,
					persistent: true,
					// These are exact metadata files. Keep this non-recursive so a future
					// target cannot make startup walk the repository's entire refs tree.
					depth: 0,
					awaitWriteFinish: {
						stabilityThreshold: 80,
						pollInterval: 30,
					},
				});
				entry.gitWatcher.on("all", () => scheduleBroadcast(entry, "git"));
				entry.gitWatcher.on("error", () => scheduleBroadcast(entry, "git"));
			}
		} catch (error) {
			// Same containment for the git metadata watcher.
			console.error(`[plannotator] Git metadata watcher failed to start for ${target.watchPath}:`, error);
		}
	}

	function closeEntry(entry: WatchEntry<S>): void {
		entry.closed = true;
		if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
		if (entry.warmupTimer) clearTimeout(entry.warmupTimer);
		if (entry.teardownTimer) clearTimeout(entry.teardownTimer);
		entry.debounceTimer = null;
		entry.warmupTimer = null;
		entry.teardownTimer = null;
		try {
			void entry.contentWatcher?.close();
		} catch {
			// A throwing close must not block the rest of the teardown.
		}
		try {
			void entry.gitWatcher?.close();
		} catch {
			// Same.
		}
		if (watchers.get(entry.key) === entry) {
			watchers.delete(entry.key);
		}
	}

	function scheduleTeardown(entry: WatchEntry<S>): void {
		if (entry.closed) return;
		if (entry.teardownTimer) clearTimeout(entry.teardownTimer);
		const timer = setTimeout(() => {
			entry.teardownTimer = null;
			if (entry.subscribers.size === 0) closeEntry(entry);
		}, teardownGraceMs());
		// The grace window must never hold the process open after the server
		// is otherwise done.
		(timer as { unref?: () => void }).unref?.();
		entry.teardownTimer = timer;
	}

	return {
		ensure(target) {
			const existing = watchers.get(target.key);
			if (existing) {
				// A resubscription inside the grace window reuses the warm entry.
				if (existing.teardownTimer) {
					clearTimeout(existing.teardownTimer);
					existing.teardownTimer = null;
				}
				return existing;
			}
			const entry: WatchEntry<S> = {
				key: target.key,
				subscribers: new Map(),
				contentWatcher: null,
				gitWatcher: null,
				debounceTimer: null,
				warmupTimer: null,
				teardownTimer: null,
				closed: false,
			};
			// Construction is deferred off the request path: the caller's SSE
			// ready event and concurrent API requests are served before any
			// directory scan begins (#1313).
			entry.warmupTimer = setTimeout(() => {
				entry.warmupTimer = null;
				buildWatchers(entry, target);
			}, 0);
			watchers.set(target.key, entry);
			return entry;
		},
		attach(handle, subscriber, clientDirPath) {
			const entry = watchers.get(handle.key);
			if (!entry || entry.closed) return;
			entry.subscribers.set(subscriber, clientDirPath);
		},
		release(handle, subscriber) {
			const entry = watchers.get(handle.key);
			if (!entry) return;
			entry.subscribers.delete(subscriber);
			if (entry.subscribers.size === 0) scheduleTeardown(entry);
		},
		closeAll() {
			for (const entry of [...watchers.values()]) closeEntry(entry);
		},
		diagnostics() {
			return { entries: watchers.size, contentWatcherStarts };
		},
		configureForTests(overrides) {
			Object.assign(options, overrides);
		},
	};
}
