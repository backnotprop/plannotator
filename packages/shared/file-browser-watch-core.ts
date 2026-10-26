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
 *    reuses the warm watcher instead of rebuilding it from scratch. An entry
 *    whose watching failed is never reused: the next subscription rebuilds it.
 * 3. On macOS and Windows the content watcher is the platform's native
 *    recursive fs.watch. Linux uses one fs.watch per directory, not per file
 *    (#1439), under a registry-wide budget sized from the system's inotify
 *    allowance. Past the budget the folders nearest the root keep their
 *    watches and deeper ones are skipped (said once in the log); unreadable
 *    folders are skipped. Chokidar remains the fallback on other platforms.
 *
 * The registry is transport-generic: the Bun runtime subscribes
 * ReadableStream controllers, the Pi runtime subscribes node:http responses.
 * Only the `send` callback differs.
 */

import chokidar, { type FSWatcher as ChokidarWatcher } from "chokidar";
import { readFileSync, watch as nodeFsWatch, statSync, type FSWatcher as NodeWatcher } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

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

/**
 * The filesystem reads the per-directory watcher makes. Tests replace them to
 * drive unreadable folders and large trees without real permissions or
 * thousands of real directories.
 */
export interface DirectoryWatchFs {
	/**
	 * `followSymlinks` is true only for the watched root. Every folder below it
	 * is read without following symlinks, so a link to an ancestor can never
	 * send the scan round in a loop.
	 */
	stat(path: string, followSymlinks: boolean): Promise<{ isDirectory(): boolean; dev: number | bigint; ino: number | bigint }>;
	readdir(path: string): Promise<Array<{ name: string; isDirectory(): boolean }>>;
}

export interface FileBrowserWatchRegistryOptions<S> {
	/** Deliver one serialized event to one subscriber; false drops the subscriber. */
	send: (subscriber: S, event: FileBrowserChangeEvent) => boolean;
	getGitMetadataWatchPaths: (watchPath: string) => string[];
	/** Reconnect grace before an unsubscribed watcher is torn down. */
	teardownGraceMs?: number;
	debounceMs?: number;
	/** Tests force the platform fallback (named "chokidar" for compatibility),
	 * force the native branch and its fallback paths on Linux CI, or force the
	 * per-directory watcher on any platform ("directories"). */
	contentWatchBackend?: "auto" | "chokidar" | "native" | "directories";
	/** Test seam for fs.watch failure modes in native and directory backends. */
	nativeWatch?: typeof nodeFsWatch;
	/** Test seam for the per-directory watcher's stat/readdir. */
	directoryFs?: DirectoryWatchFs;
	/** Registry-wide budget of per-directory watches. Default: from the system. */
	maxDirectoryWatches?: number;
	/** How long after a watch is freed the folders the budget skipped get another try. */
	capRetryMs?: number;
	/** Where the watcher says what it skipped. Default console.error. */
	log?: (message: string, error?: unknown) => void;
}

export interface WatchEntryHandle {
	readonly key: string;
}

interface DirectoryWatch {
	watcher: NodeWatcher;
	identity: string;
	depth: number;
}

type ScanDepth = "deep" | "shallow";

/** One subscription's per-directory watches (Linux). */
interface DirectoryTree {
	root: string;
	watches: Map<string, DirectoryWatch>;
	/** Watched directory -> its watched child directories. */
	children: Map<string, Set<string>>;
	/** byDepth[d] = watched directories at depth d (root is 0). */
	byDepth: Array<Set<string>>;
	/**
	 * Folders waiting to be scanned; one scan runs at a time. "deep" scans
	 * the folder and everything below it, "shallow" reconciles its own
	 * children only (a rename in it: Bun on Linux names just one side).
	 */
	pending: Map<string, ScanDepth>;
	scanning: boolean;
	/**
	 * Folders the budget (or the system's watch limit) left unwatched, the
	 * top of each unwatched subtree. A freed watch scans the shallowest of
	 * these, never the whole tree.
	 */
	capSkipped: Set<string>;
	cappedLogged: boolean;
	systemLimitLogged: boolean;
	unreadable: Set<string>;
	unreadableLogged: boolean;
	rootLogged: boolean;
	rootListLogged: boolean;
	/** Directories whose watch errored at runtime; never re-watched. */
	broken: Set<string>;
	brokenLogged: boolean;
}

interface WatchEntry<S> extends WatchEntryHandle {
	key: string;
	target: FileBrowserWatchTarget;
	subscribers: Map<S, string>;
	contentWatcher: ChokidarWatcher | NodeWatcher | null;
	directoryTree?: DirectoryTree;
	gitWatcher: ChokidarWatcher | null;
	debounceTimer: ReturnType<typeof setTimeout> | null;
	/** Deferred off-request construction (#1313). */
	warmupTimer: ReturnType<typeof setTimeout> | null;
	/** Pending reconnect-grace teardown (#1313). */
	teardownTimer: ReturnType<typeof setTimeout> | null;
	closed: boolean;
	/**
	 * Watching could not start, or stopped in a way a fresh build may fix
	 * (the root could not be watched, the system's watch allowance ran out).
	 * ensure() rebuilds a failed entry instead of reusing it.
	 */
	failed: boolean;
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
	 * `directoryWatches` counts live per-directory watches across entries,
	 * `watchedDirectories` lists them, and `scanning` says whether any
	 * directory scan is in flight or queued.
	 */
	diagnostics(): {
		entries: number;
		contentWatcherStarts: number;
		directoryWatches: number;
		watchedDirectories: string[];
		scanning: boolean;
		failedEntries: number;
	};
	/** Tests only: override timing/backend without module-scope mutation. */
	configureForTests(overrides: Partial<Pick<
		FileBrowserWatchRegistryOptions<S>,
		"teardownGraceMs" | "debounceMs" | "contentWatchBackend" | "nativeWatch" | "directoryFs" | "maxDirectoryWatches" | "capRetryMs" | "log"
	>>): void;
}

const DEFAULT_TEARDOWN_GRACE_MS = 30_000;
const DEFAULT_DEBOUNCE_MS = 180;
const DEFAULT_CAP_RETRY_MS = 2_000;
/**
 * The per-directory watch budget. A quarter of the user's inotify allowance,
 * so Plannotator never takes most of what editors and dev servers need
 * (#1439), kept between 1,024 (twice this repository's ~280 tracked folders,
 * enough for a typical working copy's ~750) and 8,192.
 */
const MIN_DIRECTORY_WATCHES = 1_024;
const MAX_DIRECTORY_WATCHES = 8_192;
const FALLBACK_DIRECTORY_WATCHES = 4_096;

let systemDirectoryWatchLimit: number | null = null;

/** Exported for tests: the budget a given inotify allowance yields. */
export function directoryWatchLimitFor(maxUserWatches: number | null): number {
	if (maxUserWatches === null || !Number.isFinite(maxUserWatches) || maxUserWatches <= 0) {
		return FALLBACK_DIRECTORY_WATCHES;
	}
	return Math.min(MAX_DIRECTORY_WATCHES, Math.max(MIN_DIRECTORY_WATCHES, Math.floor(maxUserWatches / 4)));
}

function defaultDirectoryWatchLimit(): number {
	if (systemDirectoryWatchLimit !== null) return systemDirectoryWatchLimit;
	let allowance: number | null = null;
	if (process.platform === "linux") {
		try {
			allowance = Number.parseInt(readFileSync("/proc/sys/fs/inotify/max_user_watches", "utf8").trim(), 10);
		} catch {
			allowance = null;
		}
	}
	systemDirectoryWatchLimit = directoryWatchLimitFor(allowance);
	return systemDirectoryWatchLimit;
}

const defaultDirectoryFs: DirectoryWatchFs = {
	stat: (path, followSymlinks) => (followSymlinks ? stat(path, { bigint: true }) : lstat(path, { bigint: true })),
	readdir: (path) => readdir(path, { withFileTypes: true }),
};

function errorCode(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null && "code" in error) {
		const code = (error as { code: unknown }).code;
		return typeof code === "string" ? code : undefined;
	}
	return undefined;
}

function isGone(error: unknown): boolean {
	const code = errorCode(error);
	return code === "ENOENT" || code === "ENOTDIR";
}

function isUnreadable(error: unknown): boolean {
	const code = errorCode(error);
	return code === "EACCES" || code === "EPERM";
}

/** The system ran out of watches or descriptors, not this folder's fault. */
function isSystemLimit(error: unknown): boolean {
	const code = errorCode(error);
	return code === "ENOSPC" || code === "EMFILE" || code === "ENFILE";
}

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

function isWithin(path: string, ancestor: string): boolean {
	return path === ancestor || path.startsWith(ancestor.endsWith(sep) ? ancestor : `${ancestor}${sep}`);
}

export function createFileBrowserWatchRegistry<S>(
	initialOptions: FileBrowserWatchRegistryOptions<S>,
): FileBrowserWatchRegistry<S> {
	const options = { ...initialOptions };
	const watchers = new Map<string, WatchEntry<S>>();
	let contentWatcherStarts = 0;
	let directoryWatcherCount = 0;
	let capRetryTimer: ReturnType<typeof setTimeout> | null = null;

	const teardownGraceMs = () => options.teardownGraceMs ?? DEFAULT_TEARDOWN_GRACE_MS;
	const debounceMs = () => options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	const maxDirectoryWatches = () => options.maxDirectoryWatches ?? defaultDirectoryWatchLimit();
	const directoryFs = () => options.directoryFs ?? defaultDirectoryFs;
	const log = (message: string, error?: unknown) => {
		try {
			if (options.log) options.log(message, error);
			else console.error(`[plannotator] ${message}`, error ?? "");
		} catch {
			// Logging must never take down the server.
		}
	};

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

	// --- Per-directory watcher (Linux, #1439) ---------------------------------

	function depthOf(tree: DirectoryTree, path: string): number {
		const rel = relative(tree.root, path);
		return rel ? rel.split(sep).length : 0;
	}

	function deepestDepth(tree: DirectoryTree): number {
		for (let depth = tree.byDepth.length - 1; depth >= 0; depth -= 1) {
			if ((tree.byDepth[depth]?.size ?? 0) > 0) return depth;
		}
		return -1;
	}

	/** A new watch at `depth` would be refused by the budget. */
	function wouldBeCapped(tree: DirectoryTree, depth: number): boolean {
		return directoryWatcherCount >= maxDirectoryWatches() && deepestDepth(tree) <= depth;
	}

	/** Close one directory's watch (not its subtree). */
	function closeWatch(tree: DirectoryTree, path: string): boolean {
		const owned = tree.watches.get(path);
		if (!owned) return false;
		try {
			owned.watcher.close();
		} catch {
			// Continue releasing.
		}
		tree.watches.delete(path);
		tree.byDepth[owned.depth]?.delete(path);
		directoryWatcherCount -= 1;
		tree.children.get(dirname(path))?.delete(path);
		return true;
	}

	/** Close the watches of a directory and everything below it. */
	function removeTree(tree: DirectoryTree, path: string, { freed = true } = {}): void {
		const stack = [path];
		let released = 0;
		while (stack.length > 0) {
			const current = stack.pop()!;
			const kids = tree.children.get(current);
			if (kids) {
				stack.push(...kids);
				tree.children.delete(current);
			}
			if (closeWatch(tree, current)) released += 1;
		}
		// Skipped folders at or below a removed folder are gone with it.
		dropCapSkipped(tree, (skipped) => isWithin(skipped, path));
		if (released > 0 && freed) scheduleCapRetry();
	}

	function dropCapSkipped(tree: DirectoryTree, matches: (path: string) => boolean): void {
		if (tree.capSkipped.size === 0) return;
		for (const skipped of [...tree.capSkipped]) {
			if (matches(skipped)) tree.capSkipped.delete(skipped);
		}
	}

	function closeDirectoryTree(tree: DirectoryTree): void {
		tree.pending.clear();
		tree.capSkipped.clear();
		for (const path of [...tree.watches.keys()]) closeWatch(tree, path);
		tree.children.clear();
	}

	/**
	 * A watch was freed. After a pause, as many of the folders the budget
	 * skipped as there are free watches get a scan, shallowest first. Only
	 * those folders are scanned, not the trees around them.
	 */
	function scheduleCapRetry(): void {
		if (capRetryTimer) return;
		let anySkipped = false;
		for (const entry of watchers.values()) {
			if (!entry.closed && (entry.directoryTree?.capSkipped.size ?? 0) > 0) anySkipped = true;
		}
		if (!anySkipped) return;
		const timer = setTimeout(() => {
			capRetryTimer = null;
			let free = maxDirectoryWatches() - directoryWatcherCount;
			if (free <= 0) return;
			const candidates: Array<{ entry: WatchEntry<S>; tree: DirectoryTree; path: string; depth: number }> = [];
			for (const entry of watchers.values()) {
				const tree = entry.directoryTree;
				if (entry.closed || !tree) continue;
				for (const path of tree.capSkipped) candidates.push({ entry, tree, path, depth: depthOf(tree, path) });
			}
			candidates.sort((a, b) => a.depth - b.depth);
			for (const { entry, tree, path } of candidates) {
				if (free <= 0) break;
				tree.capSkipped.delete(path);
				requestScan(entry, tree, path, "deep");
				free -= 1;
			}
		}, options.capRetryMs ?? DEFAULT_CAP_RETRY_MS);
		(timer as { unref?: () => void }).unref?.();
		capRetryTimer = timer;
	}

	function noteCapped(tree: DirectoryTree): void {
		if (tree.cappedLogged) return;
		tree.cappedLogged = true;
		log(
			`Live refresh for ${tree.root}: the folder-watch limit (${maxDirectoryWatches()}) was reached. ` +
				"Folders nearest the top keep refreshing; deeper folders are not watched.",
		);
	}

	function noteSystemLimit(tree: DirectoryTree, error: unknown): void {
		if (tree.systemLimitLogged) return;
		tree.systemLimitLogged = true;
		log(
			`Live refresh for ${tree.root}: the system ran out of file watches; folders already watched keep refreshing. ` +
				"Raising fs.inotify.max_user_watches lets more folders refresh.",
			error,
		);
	}

	/** The root itself cannot be watched: nothing below it refreshes. */
	function noteRootFailed(entry: WatchEntry<S>, tree: DirectoryTree, reason: string, error?: unknown): void {
		entry.failed = true;
		scheduleBroadcast(entry, "files");
		if (tree.rootLogged) return;
		tree.rootLogged = true;
		log(`Live refresh for ${tree.root} is off: ${reason}. Reloading the page tries again.`, error);
	}

	function reportSkipped(tree: DirectoryTree): void {
		if (tree.unreadable.size > 0 && !tree.unreadableLogged) {
			tree.unreadableLogged = true;
			const [first] = tree.unreadable;
			const count = tree.unreadable.size;
			log(`Live refresh for ${tree.root}: skipped ${count} folder${count === 1 ? "" : "s"} it cannot read (for example ${first}).`);
		}
	}

	type WatchResult =
		| { kind: "watched" }
		| { kind: "capped" | "gone" }
		| { kind: "skipped"; reason: string; error?: unknown };

	function ensureWatch(entry: WatchEntry<S>, tree: DirectoryTree, path: string, identity: string): WatchResult {
		const existing = tree.watches.get(path);
		if (existing?.identity === identity) return { kind: "watched" };
		// Same path, new directory (recreated or moved in): only this watch is
		// replaced; the scan reconciles the children below it.
		if (existing) closeWatch(tree, path);
		if (tree.broken.has(path)) return { kind: "skipped", reason: "its watch failed earlier" };

		const depth = depthOf(tree, path);
		if (directoryWatcherCount >= maxDirectoryWatches()) {
			// Prefer folders nearest the root: a shallower folder takes the slot
			// of this tree's deepest watch (which has no watched children).
			const deepest = deepestDepth(tree);
			noteCapped(tree);
			if (deepest <= depth) return { kind: "capped" };
			const [evicted] = tree.byDepth[deepest]!;
			closeWatch(tree, evicted!);
			tree.capSkipped.add(evicted!);
		}

		let watcher: NodeWatcher;
		try {
			watcher = (options.nativeWatch ?? nodeFsWatch)(path, { persistent: true }, (event, filename) => {
				if (tree.watches.get(path)?.watcher !== watcher) return;
				onDirectoryEvent(entry, tree, path, event, filename);
			});
		} catch (error) {
			if (isGone(error)) return { kind: "gone" };
			if (isUnreadable(error)) {
				if (path !== tree.root) tree.unreadable.add(path);
				return { kind: "skipped", reason: "it cannot be read", error };
			}
			if (isSystemLimit(error)) {
				noteSystemLimit(tree, error);
				return { kind: "capped" };
			}
			tree.broken.add(path);
			if (path !== tree.root && !tree.brokenLogged) {
				tree.brokenLogged = true;
				log(`Live refresh for ${tree.root}: could not watch ${path}; skipping it.`, error);
			}
			return { kind: "skipped", reason: "it could not be watched", error };
		}
		tree.watches.set(path, { watcher, identity, depth });
		(tree.byDepth[depth] ??= new Set()).add(path);
		directoryWatcherCount += 1;
		tree.capSkipped.delete(path);
		if (path !== tree.root) {
			const parent = dirname(path);
			let kids = tree.children.get(parent);
			if (!kids) {
				kids = new Set();
				tree.children.set(parent, kids);
			}
			kids.add(path);
		}
		watcher.on("error", (error) => {
			if (tree.watches.get(path)?.watcher !== watcher || !isCurrent(entry)) return;
			if (isGone(error)) {
				removeTree(tree, path);
			} else {
				// One folder's watch broke: drop that watch only, keep the rest.
				closeWatch(tree, path);
				tree.broken.add(path);
				if (path === tree.root) {
					noteRootFailed(entry, tree, "its watch failed", error);
				} else if (!tree.brokenLogged) {
					tree.brokenLogged = true;
					log(`Live refresh for ${tree.root}: the watch on ${path} failed; skipping it.`, error);
				}
			}
			scheduleBroadcast(entry, "files");
		});
		return { kind: "watched" };
	}

	function onDirectoryEvent(
		entry: WatchEntry<S>,
		tree: DirectoryTree,
		directory: string,
		event: string,
		filename: string | Buffer | null | undefined,
	): void {
		try {
			if (filename == null) {
				// No name: something in this folder (or the folder itself) changed.
				scheduleBroadcast(entry, "files");
				requestScan(entry, tree, directory, "shallow");
				return;
			}
			const changedPath = join(directory, filename.toString());
			// Creating, renaming, or touching an ignored path (dist/,
			// node_modules/, .git/) never changes the file list.
			if (entry.target.ignored?.(changedPath)) return;
			scheduleBroadcast(entry, "files");
			if (event !== "rename") return; // a content edit needs no scan
			// A name appeared or went away. A watched folder (gone, replaced, or
			// moved) gets a deep scan; anything else is found, if it is a new
			// folder, by re-listing this folder once. Bun on Linux reports a move
			// inside the tree under one name only, so the re-list is also what
			// finds a moved folder's new name. A burst of new files costs one
			// queued re-list, never a scan per file.
			if (tree.watches.has(changedPath)) requestScan(entry, tree, changedPath, "deep");
			requestScan(entry, tree, directory, "shallow");
		} catch {
			// A watcher event must never take down the server.
		}
	}

	/**
	 * Queue a scan. Scans never overlap: one drain loop runs them in order.
	 * A request already covered by a queued deep scan of the folder or one of
	 * its ancestors, or by the same request, is dropped (a walk up to the
	 * root: constant work per event, whatever is queued).
	 */
	function requestScan(entry: WatchEntry<S>, tree: DirectoryTree, path: string, depth: ScanDepth): void {
		if (!isCurrent(entry) || !isWithin(path, tree.root)) return;
		const queued = tree.pending.get(path);
		if (queued === "deep" || (queued === "shallow" && depth === "shallow")) return;
		if (path !== tree.root) {
			for (let ancestor = dirname(path); ; ancestor = dirname(ancestor)) {
				if (tree.pending.get(ancestor) === "deep") return;
				if (ancestor === tree.root || ancestor === dirname(ancestor)) break;
			}
		}
		tree.pending.set(path, depth);
		if (!tree.scanning) void drainScans(entry, tree);
	}

	async function drainScans(entry: WatchEntry<S>, tree: DirectoryTree): Promise<void> {
		tree.scanning = true;
		try {
			while (tree.pending.size > 0 && isCurrent(entry)) {
				const [[next, depth]] = tree.pending;
				tree.pending.delete(next);
				await scanSubtree(entry, tree, next, depth);
			}
		} catch (error) {
			log(`Live refresh for ${tree.root}: a folder scan failed.`, error);
		} finally {
			tree.scanning = false;
		}
		if (!isCurrent(entry)) return;
		reportSkipped(tree);
		// Slots are still free and folders are still waiting (a retry spent a
		// slot on a folder that was gone): try again. Never while the system
		// itself refuses watches, which would only loop.
		if (
			tree.capSkipped.size > 0 &&
			!tree.systemLimitLogged &&
			directoryWatcherCount < maxDirectoryWatches()
		) {
			scheduleCapRetry();
		}
	}

	/**
	 * Breadth-first, so when the budget runs out the folders kept are the ones
	 * nearest the start. Unreadable and vanished folders are skipped; nothing
	 * here stops watching the rest of the tree.
	 */
	async function scanSubtree(entry: WatchEntry<S>, tree: DirectoryTree, start: string, depth: ScanDepth): Promise<void> {
		const fs = directoryFs();
		const queue = [start];
		for (let next = 0; next < queue.length; next += 1) {
			if (!isCurrent(entry)) return;
			const directory = queue[next]!;
			const isRoot = directory === tree.root;
			if (!isRoot && entry.target.ignored?.(directory)) {
				tree.capSkipped.delete(directory);
				removeTree(tree, directory);
				continue;
			}

			let identity: string;
			try {
				const stats = await fs.stat(directory, isRoot);
				if (!isCurrent(entry)) return;
				if (!stats.isDirectory()) {
					tree.capSkipped.delete(directory);
					removeTree(tree, directory);
					if (isRoot) noteRootFailed(entry, tree, "it is not a folder");
					continue;
				}
				identity = `${stats.dev}:${stats.ino}`;
			} catch (error) {
				if (!isCurrent(entry)) return;
				tree.capSkipped.delete(directory);
				removeTree(tree, directory);
				if (isRoot) {
					noteRootFailed(entry, tree, isGone(error) ? "it no longer exists" : "it cannot be read", isGone(error) ? undefined : error);
				} else if (isUnreadable(error)) {
					tree.unreadable.add(directory);
				} else if (!isGone(error)) {
					log(`Live refresh for ${tree.root}: could not inspect ${directory}; skipping it.`, error);
				}
				continue;
			}

			const result = ensureWatch(entry, tree, directory, identity);
			if (result.kind === "gone") {
				tree.capSkipped.delete(directory);
				removeTree(tree, directory);
				if (isRoot) noteRootFailed(entry, tree, "it no longer exists");
				continue;
			}
			if (result.kind !== "watched") {
				// Its subtree stays unwatched; drop anything left from before.
				removeTree(tree, directory, { freed: false });
				if (result.kind === "capped") {
					tree.capSkipped.add(directory);
					if (isRoot) noteRootFailed(entry, tree, "no file watches are left");
				} else if (isRoot && result.kind === "skipped") {
					noteRootFailed(entry, tree, result.reason, result.error);
				}
				continue;
			}

			let children: Array<{ name: string; isDirectory(): boolean }>;
			try {
				children = await fs.readdir(directory);
			} catch (error) {
				if (!isCurrent(entry)) return;
				if (isGone(error)) {
					removeTree(tree, directory);
				} else if (isRoot) {
					if (!tree.rootListLogged) {
						tree.rootListLogged = true;
						log(`Live refresh for ${tree.root}: cannot list it, so only its own entries refresh.`, error);
					}
				} else if (isUnreadable(error)) {
					tree.unreadable.add(directory);
				} else {
					log(`Live refresh for ${tree.root}: could not list ${directory}; skipping its folders.`, error);
				}
				continue;
			}
			if (!isCurrent(entry)) return;

			const childDirectories = new Set<string>();
			for (const child of children) {
				if (!child.isDirectory()) continue;
				const childPath = join(directory, child.name);
				if (entry.target.ignored?.(childPath)) continue;
				childDirectories.add(childPath);
			}
			// Skipped folders that are no longer here (deleted or moved away).
			dropCapSkipped(tree, (skipped) => dirname(skipped) === directory && !childDirectories.has(skipped));
			// Folders that went away (or became ignored) since the last scan.
			for (const watched of [...(tree.children.get(directory) ?? [])]) {
				if (!childDirectories.has(watched)) removeTree(tree, watched);
			}
			if (depth === "deep") {
				queue.push(...childDirectories);
			} else {
				// Shallow: only folders not watched yet get a (deep) scan, and not
				// ones the budget would refuse again (no stat per save at the cap).
				const childDepth = depthOf(tree, directory) + 1;
				for (const childPath of childDirectories) {
					if (tree.watches.has(childPath)) continue;
					if (wouldBeCapped(tree, childDepth)) {
						tree.capSkipped.add(childPath);
						continue;
					}
					requestScan(entry, tree, childPath, "deep");
				}
			}
		}
	}

	function startDirectoryContentWatcher(entry: WatchEntry<S>, target: FileBrowserWatchTarget): void {
		const tree: DirectoryTree = {
			root: target.watchPath,
			watches: new Map(),
			children: new Map(),
			byDepth: [],
			pending: new Map(),
			scanning: false,
			capSkipped: new Set(),
			cappedLogged: false,
			systemLimitLogged: false,
			unreadable: new Set(),
			unreadableLogged: false,
			rootLogged: false,
			rootListLogged: false,
			broken: new Set(),
			brokenLogged: false,
		};
		entry.directoryTree = tree;
		requestScan(entry, tree, tree.root, "deep");
	}

	function startFallbackContentWatcher(entry: WatchEntry<S>, target: FileBrowserWatchTarget): void {
		if (process.platform === "linux") {
			startDirectoryContentWatcher(entry, target);
			return;
		}
		entry.contentWatcher = startChokidarContentWatcher(entry, target);
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
		if (backend === "directories") {
			startDirectoryContentWatcher(entry, target);
			return;
		}
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
					// Native watching failed at runtime. Swap to the platform fallback
					// and force one refresh so changes during the swap are not lost.
					try {
						watcher.close();
					} catch {
						// Already closed.
					}
					if (isCurrent(entry) && entry.contentWatcher === watcher) {
						log(`Native file watching failed for ${target.watchPath}; switching to the fallback watcher:`, error);
						entry.contentWatcher = null;
						contentWatcherStarts += 1;
						startFallbackContentWatcher(entry, target);
						scheduleBroadcast(entry, "files");
					}
				});
				entry.contentWatcher = watcher;
				return;
			} catch (error) {
				// Native creation failed. Fall through to the platform fallback.
				log(`Native file watching unavailable for ${target.watchPath}; using the fallback watcher:`, error);
			}
		}
		startFallbackContentWatcher(entry, target);
	}

	function buildWatchers(entry: WatchEntry<S>, target: FileBrowserWatchTarget): void {
		if (!isCurrent(entry)) return;
		try {
			startContentWatcher(entry, target);
		} catch (error) {
			// A watcher that cannot start must not take down the stream, but the
			// subscriber is now living without live refreshes; say so. The next
			// subscription rebuilds instead of reusing this entry.
			entry.failed = true;
			log(`File watcher failed to start for ${target.watchPath}:`, error);
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
			log(`Git metadata watcher failed to start for ${target.watchPath}:`, error);
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
		const hadDirectoryWatches = (entry.directoryTree?.watches.size ?? 0) > 0;
		if (entry.directoryTree) closeDirectoryTree(entry.directoryTree);
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
		if (hadDirectoryWatches) scheduleCapRetry();
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

	function createEntry(target: FileBrowserWatchTarget): WatchEntry<S> {
		const entry: WatchEntry<S> = {
			key: target.key,
			target,
			subscribers: new Map(),
			contentWatcher: null,
			gitWatcher: null,
			debounceTimer: null,
			warmupTimer: null,
			teardownTimer: null,
			closed: false,
			failed: false,
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
	}

	return {
		ensure(target) {
			const existing = watchers.get(target.key);
			if (existing && !existing.failed) {
				// A resubscription inside the grace window reuses the warm entry.
				if (existing.teardownTimer) {
					clearTimeout(existing.teardownTimer);
					existing.teardownTimer = null;
				}
				return existing;
			}
			const entry = createEntry(target);
			if (existing) {
				// A failed entry is rebuilt, never reused. Its live subscribers move
				// to the new entry so every open tab gets the recovered watching.
				for (const [subscriber, clientDirPath] of existing.subscribers) {
					entry.subscribers.set(subscriber, clientDirPath);
				}
				existing.subscribers.clear();
				closeEntry(existing);
			}
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
			if (capRetryTimer) clearTimeout(capRetryTimer);
			capRetryTimer = null;
		},
		diagnostics() {
			const watchedDirectories: string[] = [];
			let scanning = false;
			let failedEntries = 0;
			for (const entry of watchers.values()) {
				if (entry.failed) failedEntries += 1;
				const tree = entry.directoryTree;
				if (!tree) continue;
				watchedDirectories.push(...tree.watches.keys());
				if (tree.scanning || tree.pending.size > 0) scanning = true;
			}
			return {
				entries: watchers.size,
				contentWatcherStarts,
				directoryWatches: directoryWatcherCount,
				watchedDirectories: watchedDirectories.sort(),
				scanning,
				failedEntries,
			};
		},
		configureForTests(overrides) {
			Object.assign(options, overrides);
		},
	};
}
