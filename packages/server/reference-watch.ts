import { existsSync, statSync } from "fs";
import { dirname, isAbsolute, relative } from "path";
import {
	createExactFileWatchListener,
	createFileBrowserWatchRegistry,
	type FileBrowserChangeEvent,
	type FileBrowserWatchRegistry,
	type FileBrowserWatchTarget,
	type WatchEntryHandle,
} from "@plannotator/shared/file-browser-watch-core";
import { isFileBrowserExcludedPath } from "@plannotator/shared/reference-common";
import { resolveUserPath } from "@plannotator/shared/resolve-file";
import { getGitMetadataWatchPaths } from "@plannotator/shared/workspace-status";

// The watcher engine (deferred warmup, reconnect grace, native recursive
// backend) lives in @plannotator/shared/file-browser-watch-core (#1313).
// This module keeps only the Bun transport: request parsing, the SSE
// ReadableStream, and heartbeats.

const HEARTBEAT_MS = 30_000;
const encoder = new TextEncoder();

function serialize(event: FileBrowserChangeEvent): Uint8Array {
	return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

const registry: FileBrowserWatchRegistry<ReadableStreamDefaultController> = createFileBrowserWatchRegistry<ReadableStreamDefaultController>({
	send: (subscriber, event) => {
		try {
			subscriber.enqueue(serialize(event));
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
	configure: (overrides: Parameters<FileBrowserWatchRegistry<ReadableStreamDefaultController>["configureForTests"]>[0]) =>
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

	const targets = new Map<string, FileBrowserWatchTarget & { clientDirPath: string }>();
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
	const subscriptions: Array<{ handle: WatchEntryHandle; clientDirPath: string }> = [...targets.values()].map((target) => ({
		handle: registry.ensure(target),
		clientDirPath: target.clientDirPath,
	}));

	let controllerRef: ReadableStreamDefaultController | null = null;
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	const stream = new ReadableStream({
		start(controller) {
			controllerRef = controller;
			for (const { handle, clientDirPath } of subscriptions) {
				registry.attach(handle, controller, clientDirPath);
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
					for (const { handle } of subscriptions) registry.release(handle, controller);
					if (heartbeatTimer) clearInterval(heartbeatTimer);
				}
			}, HEARTBEAT_MS);
		},
		cancel() {
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			if (controllerRef) {
				for (const { handle } of subscriptions) registry.release(handle, controllerRef);
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
