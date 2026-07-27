import chokidar, { type FSWatcher as ChokidarWatcher } from "chokidar";
import { existsSync, statSync, watch, type FSWatcher as NodeWatcher } from "fs";
import { dirname, isAbsolute, relative, resolve } from "path";
import { isFileBrowserExcludedPath } from "@plannotator/shared/reference-common";
import { resolveUserPath } from "@plannotator/shared/resolve-file";
import { getGitMetadataWatchPaths } from "@plannotator/shared/workspace-status";

interface FileBrowserChangeEvent {
	type: "ready" | "changed";
	dirPath: string;
	reason: "files" | "git" | "initial";
	timestamp: number;
}

interface WatchEntry {
	key: string;
	subscribers: Map<ReadableStreamDefaultController, string>;
	contentWatcher: ChokidarWatcher | NodeWatcher | null;
	gitWatcher: ChokidarWatcher | null;
	debounceTimer: ReturnType<typeof setTimeout> | null;
}

interface WatchTarget {
	key: string;
	watchPath: string;
	clientDirPath: string;
	watchGit: boolean;
	exactFilePath?: string;
	ignored?: (path: string) => boolean;
}

const HEARTBEAT_MS = 30_000;
const DEBOUNCE_MS = 180;
const watchers = new Map<string, WatchEntry>();
const encoder = new TextEncoder();

function serialize(event: FileBrowserChangeEvent): Uint8Array {
	return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

export function isFileBrowserWatchIgnoredPath(path: string, root: string): boolean {
	const rel = relative(root, path).replace(/\\/g, "/");
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
	return isFileBrowserExcludedPath(rel);
}

function isValidDirectory(dirPath: string): boolean {
	try {
		return existsSync(dirPath) && statSync(dirPath).isDirectory();
	} catch {
		return false;
	}
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

function broadcast(entry: WatchEntry, reason: FileBrowserChangeEvent["reason"]): void {
	for (const [subscriber, clientDirPath] of entry.subscribers) {
		const payload = serialize({
			type: "changed",
			dirPath: clientDirPath,
			reason,
			timestamp: Date.now(),
		});
		try {
			subscriber.enqueue(payload);
		} catch {
			entry.subscribers.delete(subscriber);
		}
	}
}

function scheduleBroadcast(entry: WatchEntry, reason: "files" | "git"): void {
	if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
	entry.debounceTimer = setTimeout(() => {
		entry.debounceTimer = null;
		broadcast(entry, reason);
	}, DEBOUNCE_MS);
}

function closeWatcher(entry: WatchEntry): void {
	if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
	void entry.contentWatcher?.close();
	void entry.gitWatcher?.close();
	if (watchers.get(entry.key) === entry) {
		watchers.delete(entry.key);
	}
}

function releaseSubscriber(entry: WatchEntry, controller: ReadableStreamDefaultController): void {
	entry.subscribers.delete(controller);
	if (entry.subscribers.size === 0) closeWatcher(entry);
}

function ensureWatcher(target: WatchTarget): WatchEntry {
	const existing = watchers.get(target.key);
	if (existing) return existing;

	const entry: WatchEntry = {
		key: target.key,
		subscribers: new Map(),
		contentWatcher: null,
		gitWatcher: null,
		debounceTimer: null,
	};

	if (target.exactFilePath) {
		entry.contentWatcher = watch(
			target.watchPath,
			{ persistent: true },
			createExactFileWatchListener(target.watchPath, target.exactFilePath, () => scheduleBroadcast(entry, "files")),
		);
		entry.contentWatcher.on("error", () => scheduleBroadcast(entry, "files"));
	} else {
		entry.contentWatcher = chokidar.watch(target.watchPath, {
			ignoreInitial: true,
			persistent: true,
			ignored: target.ignored,
			awaitWriteFinish: {
				stabilityThreshold: 120,
				pollInterval: 30,
			},
		});
		entry.contentWatcher.on("all", () => {
			scheduleBroadcast(entry, "files");
		});
		entry.contentWatcher.on("error", () => scheduleBroadcast(entry, "files"));
	}

	const gitWatchPaths = target.watchGit
		? getGitMetadataWatchPaths(target.watchPath)
		: [];
	if (gitWatchPaths.length > 0) {
		entry.gitWatcher = chokidar.watch(gitWatchPaths, {
			ignoreInitial: true,
			persistent: true,
			awaitWriteFinish: {
				stabilityThreshold: 80,
				pollInterval: 30,
			},
		});
		entry.gitWatcher.on("all", () => scheduleBroadcast(entry, "git"));
		entry.gitWatcher.on("error", () => scheduleBroadcast(entry, "git"));
	}

	watchers.set(target.key, entry);
	return entry;
}

function isValidFileTarget(filePath: string): boolean {
	if (!filePath) return false;
	try {
		if (existsSync(filePath)) return !statSync(filePath).isDirectory();
		return isValidDirectory(dirname(filePath));
	} catch {
		return false;
	}
}

export function handleFileBrowserFilesStream(
	req: Request,
	options?: { disableIdleTimeout?: () => void },
): Response {
	const url = new URL(req.url);
	const rawDirPaths = url.searchParams.getAll("dirPath");
	const rawFilePaths = url.searchParams.getAll("filePath");
	if ((rawDirPaths.length > 0) === (rawFilePaths.length > 0)) {
		return Response.json({ error: "Provide exactly one of dirPath or filePath" }, { status: 400 });
	}

	const targets = new Map<string, WatchTarget>();
	if (rawDirPaths.length > 0) {
		for (const rawDirPath of rawDirPaths) {
			const dirPath = resolveUserPath(rawDirPath);
			if (!isValidDirectory(dirPath)) {
				return Response.json({ error: "Invalid directory path" }, { status: 400 });
			}
			const key = `dir:${dirPath}`;
			if (!targets.has(key)) {
				targets.set(key, {
					key,
					watchPath: dirPath,
					clientDirPath: rawDirPath,
					watchGit: true,
					ignored: (path) => isFileBrowserWatchIgnoredPath(path, dirPath),
				});
			}
		}
	} else {
		for (const rawFilePath of rawFilePaths) {
			const filePath = resolveUserPath(rawFilePath);
			if (!isValidFileTarget(filePath)) {
				return Response.json({ error: "Invalid file path" }, { status: 400 });
			}
			const key = `file:${filePath}`;
			if (!targets.has(key)) {
				const parentPath = dirname(filePath);
				targets.set(key, {
					key,
					watchPath: parentPath,
					clientDirPath: dirname(rawFilePath),
					watchGit: false,
					exactFilePath: filePath,
				});
			}
		}
	}

	options?.disableIdleTimeout?.();
	const subscriptions = [...targets.values()].map((target) => ({
		entry: ensureWatcher(target),
		clientDirPath: target.clientDirPath,
	}));

	let controllerRef: ReadableStreamDefaultController | null = null;
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	const stream = new ReadableStream({
		start(controller) {
			controllerRef = controller;
			for (const { entry, clientDirPath } of subscriptions) {
				entry.subscribers.set(controller, clientDirPath);
				controller.enqueue(serialize({
					type: "ready",
					dirPath: clientDirPath,
					reason: "initial",
					timestamp: Date.now(),
				}));
			}
			heartbeatTimer = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(": heartbeat\n\n"));
				} catch {
					for (const { entry } of subscriptions) releaseSubscriber(entry, controller);
					if (heartbeatTimer) clearInterval(heartbeatTimer);
				}
			}, HEARTBEAT_MS);
		},
		cancel() {
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			if (controllerRef) {
				for (const { entry } of subscriptions) releaseSubscriber(entry, controllerRef);
			}
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}
