import chokidar, { type FSWatcher } from "chokidar";
import { existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, relative } from "node:path";

import { isFileBrowserExcludedPath } from "../generated/reference-common.js";
import { resolveUserPath } from "../generated/resolve-file.js";
import { getGitMetadataWatchPaths } from "../generated/workspace-status.js";
import { json } from "./helpers.js";

interface FileBrowserChangeEvent {
	type: "ready" | "changed";
	dirPath: string;
	reason: "files" | "git" | "initial";
	timestamp: number;
}

interface WatchEntry {
	dirPath: string;
	subscribers: Map<ServerResponse, string>;
	contentWatcher: FSWatcher | null;
	gitWatcher: FSWatcher | null;
	debounceTimer: ReturnType<typeof setTimeout> | null;
}

const HEARTBEAT_MS = 30_000;
const DEBOUNCE_MS = 180;
const watchers = new Map<string, WatchEntry>();

function serialize(event: FileBrowserChangeEvent): string {
	return `data: ${JSON.stringify(event)}\n\n`;
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
	for (const [res, clientDirPath] of entry.subscribers) {
		const payload = serialize({
			type: "changed",
			dirPath: clientDirPath,
			reason,
			timestamp: Date.now(),
		});
		try {
			res.write(payload);
		} catch {
			entry.subscribers.delete(res);
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

function releaseSubscriber(entry: WatchEntry, res: ServerResponse): void {
	entry.subscribers.delete(res);
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

export function handleFileBrowserStreamRequest(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
	if (url.pathname !== "/api/reference/files/stream" || req.method !== "GET") return false;

	const rawDirPaths = url.searchParams.getAll("dirPath");
	if (rawDirPaths.length === 0) {
		json(res, { error: "Missing dirPath parameter" }, 400);
		return true;
	}

	const dirPaths: string[] = [];
	const clientDirPaths: string[] = [];
	for (const rawDirPath of rawDirPaths) {
		const dirPath = resolveUserPath(rawDirPath);
		if (!isValidDirectory(dirPath)) {
			json(res, { error: "Invalid directory path" }, 400);
			return true;
		}
		if (!dirPaths.includes(dirPath)) {
			dirPaths.push(dirPath);
			clientDirPaths.push(rawDirPath);
		}
	}

	const entries = dirPaths.map((dirPath) => ensureWatcher(dirPath));
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
	res.setTimeout(0);
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		const clientDirPath = clientDirPaths[i] ?? entry.dirPath;
		res.write(serialize({
			type: "ready",
			dirPath: clientDirPath,
			reason: "initial",
			timestamp: Date.now(),
		}));
		entry.subscribers.set(res, clientDirPath);
	}

	const heartbeat = setInterval(() => {
		try {
			res.write(": heartbeat\n\n");
		} catch {
			for (const entry of entries) releaseSubscriber(entry, res);
			clearInterval(heartbeat);
		}
	}, HEARTBEAT_MS);

	res.on("close", () => {
		clearInterval(heartbeat);
		for (const entry of entries) releaseSubscriber(entry, res);
	});
	return true;
}
