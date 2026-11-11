/**
 * Reads one working-tree file for the review UI the way an editor does: links are followed wherever they point.
 * Guarded: size (the cap is checked on the open file before any byte is read) and hangs (O_NONBLOCK plus fstat refuses a FIFO, device or directory; Pi's server shares its host's event loop). Request paths still get cheap string checks.
 */

import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { MAX_REVIEW_FILE_CONTENT_BYTES, validateFilePath } from "./review-core";

export const MAX_REPO_FILE_BYTES = MAX_REVIEW_FILE_CONTENT_BYTES;

export type RepoFileFailureReason = "invalid-path" | "not-found" | "not-a-file" | "too-large";

export type RepoFileResult =
	| { ok: true; content: string; size: number }
	| {
		ok: false;
		reason: RepoFileFailureReason;
		message: string;
		size?: number;
		maxBytes?: number;
	};

export type RepoFileFailure = Extract<RepoFileResult, { ok: false }>;

/**
 * Bytes to text. Each runtime keeps the output it had: Node's
 * `readFileSync(path, "utf-8")` keeps a BOM ({@link decodeUtf8}, the default);
 * the Bun server passes a decoder that matches `Bun.file().text()`.
 */
export type RepoFileDecoder = (bytes: Uint8Array) => string | Promise<string>;

export const decodeUtf8: RepoFileDecoder = (bytes) =>
	Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");

export interface RepoFileReadOptions {
	maxBytes?: number;
	decode?: RepoFileDecoder;
}

export const REPO_FILE_ERROR_STATUS: Record<RepoFileFailureReason, number> = {
	"invalid-path": 400,
	"not-found": 404,
	"not-a-file": 400,
	"too-large": 413,
};

export function repoFileErrorBody(failure: RepoFileFailure) {
	return {
		error: failure.message,
		reason: failure.reason,
		...(failure.size !== undefined && { size: failure.size }),
		...(failure.maxBytes !== undefined && { maxBytes: failure.maxBytes }),
	};
}

function fail(reason: RepoFileFailureReason, message: string): RepoFileFailure {
	return { ok: false, reason, message };
}

// Not on Windows, where opening a FIFO does not block anyway.
const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0);

export async function readFileCapped(path: string, options: RepoFileReadOptions = {}): Promise<RepoFileResult> {
	const maxBytes = options.maxBytes ?? MAX_REPO_FILE_BYTES;
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, OPEN_FLAGS);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// Windows refuses to open a directory as a file.
		if (code === "EISDIR") return fail("not-a-file", "This path is not a regular file");
		return fail("not-found", "File not found");
	}
	try {
		const stats = await handle.stat();
		if (!stats.isFile()) return fail("not-a-file", "This path is not a regular file");
		if (stats.size > maxBytes) {
			return {
				ok: false,
				reason: "too-large",
				message: `File is too large to preview (${stats.size} bytes; the limit is ${maxBytes} bytes)`,
				size: stats.size,
				maxBytes,
			};
		}
		// Read at most one byte more than fstat reported, so the read never
		// passes the cap. A file that grew since fstat is refused only when
		// that extra byte crosses the cap; otherwise what was read is
		// returned, a snapshot of the file's start.
		const buffer = Buffer.alloc(Math.min(stats.size, maxBytes) + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
			if (bytesRead === 0) break;
			length += bytesRead;
		}
		if (length > maxBytes) {
			return { ok: false, reason: "too-large", message: "File is too large to preview", size: length, maxBytes };
		}
		const bytes = buffer.subarray(0, length);
		return { ok: true, content: await (options.decode ?? decodeUtf8)(bytes), size: length };
	} catch {
		return fail("not-found", "File could not be read");
	} finally {
		await handle.close().catch(() => {});
	}
}

/** {@link readFileCapped} for a request path relative to `root`, after the endpoints' string checks. */
export async function readRepoFile(
	root: string,
	rawPath: string | null | undefined,
	options: RepoFileReadOptions = {},
): Promise<RepoFileResult> {
	if (!rawPath) return fail("invalid-path", "Missing path");
	if (rawPath.includes("\0")) return fail("invalid-path", "Invalid path");
	try {
		validateFilePath(rawPath);
	} catch {
		return fail("invalid-path", "Invalid path");
	}
	return readFileCapped(resolve(root, rawPath), options);
}
