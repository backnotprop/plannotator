import chokidar, { type FSWatcher } from "chokidar";
import { existsSync, statSync } from "fs";
import { isAbsolute, relative } from "path";
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
	dirPath: string;
	subscribers: Map<ReadableStreamDefaultController, string>;
	contentWatcher: FSWatcher | null;
	gitWatcher: FSWatcher | null;
	debounceTimer: ReturnType<typeof setTimeout> | null;
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
	if (watchers.get(entry.dirPath) === entry) {
		watchers.delete(entry.dirPath);
	}
}

function releaseSubscriber(entry: WatchEntry, controller: ReadableStreamDefaultController): void {
	entry.subscribers.delete(controller);
	if (entry.subscribers.size === 0) closeWatcher(entry);
}

function ensureWatcher(dirPath: string): WatchEntry {
	const existing = watchers.get(dirPath);
	if (existing) return existing;

	const entry: WatchEntry = {
		dirPath,
		subscribers: new Map(),
		contentWatcher: null,
		gitWatcher: null,
		debounceTimer: null,
	};

	entry.contentWatcher = chokidar.watch(dirPath, {
		ignoreInitial: true,
		persistent: true,
		ignored: (path) => isFileBrowserWatchIgnoredPath(path, dirPath),
		awaitWriteFinish: {
			stabilityThreshold: 120,
			pollInterval: 30,
		},
	});
	entry.contentWatcher.on("all", () => scheduleBroadcast(entry, "files"));
	entry.contentWatcher.on("error", () => scheduleBroadcast(entry, "files"));

	const gitWatchPaths = getGitMetadataWatchPaths(dirPath);
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

	watchers.set(dirPath, entry);
	return entry;
}

export function handleFileBrowserFilesStream(
	req: Request,
	options?: { disableIdleTimeout?: () => void },
): Response {
	const url = new URL(req.url);
	const rawDirPaths = url.searchParams.getAll("dirPath");
	if (rawDirPaths.length === 0) {
		return Response.json({ error: "Missing dirPath parameter" }, { status: 400 });
	}

	const dirPaths: string[] = [];
	const clientDirPaths: string[] = [];
	for (const rawDirPath of rawDirPaths) {
		const dirPath = resolveUserPath(rawDirPath);
		if (!isValidDirectory(dirPath)) {
			return Response.json({ error: "Invalid directory path" }, { status: 400 });
		}
		if (!dirPaths.includes(dirPath)) {
			dirPaths.push(dirPath);
			clientDirPaths.push(rawDirPath);
		}
	}

	options?.disableIdleTimeout?.();
	const entries = dirPaths.map((dirPath) => ensureWatcher(dirPath));

	let controllerRef: ReadableStreamDefaultController | null = null;
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	const stream = new ReadableStream({
		start(controller) {
			controllerRef = controller;
			for (let i = 0; i < entries.length; i++) {
				const entry = entries[i]!;
				const clientDirPath = clientDirPaths[i] ?? entry.dirPath;
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
					for (const entry of entries) releaseSubscriber(entry, controller);
					if (heartbeatTimer) clearInterval(heartbeatTimer);
				}
			}, HEARTBEAT_MS);
		},
		cancel() {
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			if (controllerRef) {
				for (const entry of entries) releaseSubscriber(entry, controllerRef);
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
