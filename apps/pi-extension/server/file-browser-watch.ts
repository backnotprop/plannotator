import { existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, isAbsolute, relative } from "node:path";

import {
	createExactFileWatchListener,
	createFileBrowserWatchRegistry,
	type FileBrowserChangeEvent,
	type FileBrowserWatchRegistry,
	type FileBrowserWatchTarget,
	type WatchEntryHandle,
} from "../generated/file-browser-watch-core.ts";
import { isFileBrowserExcludedPath } from "../generated/reference-common.ts";
import { resolveUserPath } from "../generated/resolve-file.ts";
import { getGitMetadataWatchPaths } from "../generated/workspace-status.ts";
import { json } from "./helpers.ts";

// The watcher engine (deferred warmup, reconnect grace, native recursive
// backend) lives in the vendored file-browser-watch-core (#1313). This module
// keeps only the Pi transport: request parsing, the node:http SSE response,
// and heartbeats.

const HEARTBEAT_MS = 30_000;

function serialize(event: FileBrowserChangeEvent): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}

const registry: FileBrowserWatchRegistry<ServerResponse> = createFileBrowserWatchRegistry<ServerResponse>({
	send: (subscriber, event) => {
		try {
			subscriber.write(serialize(event));
			return true;
		} catch {
			return false;
		}
	},
	getGitMetadataWatchPaths,
});

export { createExactFileWatchListener };

/** Immediate teardown of every live watcher. Server stop and tests. */
export function closeAllFileBrowserWatchers(): void {
	registry.closeAll();
}

/** Tests only. See FileBrowserWatchRegistry.diagnostics/configureForTests. */
export const __fileBrowserWatchTestHooks = {
	diagnostics: () => registry.diagnostics(),
	configure: (overrides: Parameters<FileBrowserWatchRegistry<ServerResponse>["configureForTests"]>[0]) =>
		registry.configureForTests(overrides),
};

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

function isValidFileTarget(filePath: string): boolean {
	if (!filePath) return false;
	try {
		if (existsSync(filePath)) return !statSync(filePath).isDirectory();
		return isValidDirectory(dirname(filePath));
	} catch {
		return false;
	}
}

export function handleFileBrowserStreamRequest(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
	if (url.pathname !== "/api/reference/files/stream" || req.method !== "GET") return false;

	const rawDirPaths = url.searchParams.getAll("dirPath");
	const rawFilePaths = url.searchParams.getAll("filePath");
	if ((rawDirPaths.length > 0) === (rawFilePaths.length > 0)) {
		json(res, { error: "Provide exactly one of dirPath or filePath" }, 400);
		return true;
	}

	const targets = new Map<string, FileBrowserWatchTarget & { clientDirPath: string }>();
	if (rawDirPaths.length > 0) {
		for (const rawDirPath of rawDirPaths) {
			const dirPath = resolveUserPath(rawDirPath);
			if (!isValidDirectory(dirPath)) {
				json(res, { error: "Invalid directory path" }, 400);
				return true;
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
				json(res, { error: "Invalid file path" }, 400);
				return true;
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

	const subscriptions: Array<{ handle: WatchEntryHandle; clientDirPath: string }> = [...targets.values()].map((target) => ({
		handle: registry.ensure(target),
		clientDirPath: target.clientDirPath,
	}));
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
	res.setTimeout(0);
	for (const { handle, clientDirPath } of subscriptions) {
		res.write(serialize({
			type: "ready",
			dirPath: clientDirPath,
			reason: "initial",
			timestamp: Date.now(),
		}));
		registry.attach(handle, res, clientDirPath);
	}

	const heartbeat = setInterval(() => {
		try {
			res.write(": heartbeat\n\n");
		} catch {
			for (const { handle } of subscriptions) registry.release(handle, res);
			clearInterval(heartbeat);
		}
	}, HEARTBEAT_MS);

	res.on("close", () => {
		clearInterval(heartbeat);
		for (const { handle } of subscriptions) registry.release(handle, res);
	});
	return true;
}
