/**
 * Hardened repo file reading for the code-review surfaces.
 *
 * Runtime-agnostic (node:fs + node:path only) so both the Bun review server
 * and the hand-mirrored Pi review server route every full-file read through
 * exactly one guard. Vendored to Pi by `apps/pi-extension/vendor.sh`.
 *
 * Why this exists: the review side's entire traversal defense was
 * `validateFilePath` in review-core.ts, a lexical check that rejects `..`
 * substrings and leading `/`. Lexical checks cannot see a symlink. A repo
 * containing `link -> /etc` passes every lexical test and then reads
 * `link/passwd` straight out of the filesystem. `/api/code-nav/file` also had
 * no size cap at all, so a multi-gigabyte file in the tree was a
 * one-request memory bomb.
 *
 * The guard here is realpath containment: resolve the review root AND the
 * candidate through the filesystem, then require the canonical candidate to
 * live under the canonical root. That is symlink-proof by construction
 * because realpath is what decides, not string shape.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

/**
 * Serve cap for full-file reads, deliberately identical to
 * MAX_REVIEW_FILE_CONTENT_BYTES (packages/shared/review-core.ts:21) so a file
 * that can be context-expanded in the diff can also be opened whole, and vice
 * versa. Kept as its own named constant so this module stays importable by
 * the Pi vendor copy without dragging in all of review-core.
 */
export const MAX_REPO_FILE_BYTES = 5 * 1024 * 1024;

export type RepoFileFailureReason =
	| "invalid-path"
	| "outside-root"
	| "not-found"
	| "not-a-file"
	| "too-large";

export interface RepoFileSuccess {
	ok: true;
	/** The request path, normalized to repo-relative POSIX form. */
	filePath: string;
	/** Canonical on-disk path, after symlink resolution. */
	absolutePath: string;
	content: string;
	size: number;
}

export interface RepoFileFailure {
	ok: false;
	reason: RepoFileFailureReason;
	message: string;
	/** Present on "too-large" so the client can render a real number. */
	size?: number;
}

export type RepoFileResult = RepoFileSuccess | RepoFileFailure;

/** HTTP status each failure maps to. Shared so both runtimes answer alike. */
export const REPO_FILE_ERROR_STATUS: Record<RepoFileFailureReason, number> = {
	"invalid-path": 400,
	"outside-root": 403,
	"not-found": 404,
	"not-a-file": 400,
	"too-large": 413,
};

function fail(
	reason: RepoFileFailureReason,
	message: string,
	size?: number,
): RepoFileFailure {
	return size === undefined
		? { ok: false, reason, message }
		: { ok: false, reason, message, size };
}

/**
 * Shape validation for a client-supplied repo-relative path.
 *
 * This is the cheap pre-filter, NOT the security boundary — containment is.
 * It exists so obviously hostile input is rejected before it ever touches the
 * filesystem, and so error messages stay honest ("invalid path" vs "not
 * found", which would otherwise leak whether a path outside the repo exists).
 */
export function validateRepoFilePath(
	rawPath: unknown,
): { ok: true; path: string } | RepoFileFailure {
	if (typeof rawPath !== "string" || rawPath.length === 0) {
		return fail("invalid-path", "Missing path");
	}
	// A NUL truncates the path at the syscall boundary on some platforms.
	if (rawPath.includes("\0")) {
		return fail("invalid-path", "Invalid path");
	}
	// Normalize Windows separators up front so the segment checks below see
	// every segment, however the client spelled them.
	const normalized = rawPath.replace(/\\/g, "/");
	if (isAbsolute(rawPath) || normalized.startsWith("/")) {
		return fail("invalid-path", "Path must be relative to the review root");
	}
	// Windows drive-qualified paths ("C:foo", "C:/foo") are absolute in intent
	// even when node's isAbsolute disagrees on a POSIX host.
	if (/^[a-zA-Z]:/.test(normalized)) {
		return fail("invalid-path", "Path must be relative to the review root");
	}
	const segments = normalized.split("/");
	if (segments.some((segment) => segment === "..")) {
		return fail("invalid-path", "Invalid path");
	}
	// Strip "." and empty segments so "./a//b" normalizes to "a/b".
	const cleaned = segments.filter(
		(segment) => segment.length > 0 && segment !== ".",
	);
	if (cleaned.length === 0) {
		return fail("invalid-path", "Invalid path");
	}
	return { ok: true, path: cleaned.join("/") };
}

/**
 * True when `candidate` is the canonical root itself or lives beneath it.
 *
 * Both inputs must already be realpath-resolved by the caller; comparing
 * un-resolved paths is what makes lexical containment checks defeatable.
 * The trailing-separator form is what stops the classic `/repo-evil` prefix
 * match against root `/repo`.
 */
export function isContainedPath(candidate: string, root: string): boolean {
	if (candidate === root) return true;
	const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
	return candidate.startsWith(rootWithSep);
}

function realpathOrNull(target: string): string | null {
	try {
		return realpathSync(target);
	} catch {
		return null;
	}
}

/**
 * Resolve a repo-relative request path to a canonical, contained absolute path
 * without reading it. Split out from `readRepoFile` so callers that only need
 * the location (existence probes, editor hand-off) share the same guard.
 */
export function resolveRepoFilePath(
	root: string,
	rawPath: unknown,
):
	| { ok: true; filePath: string; absolutePath: string }
	| RepoFileFailure {
	const validated = validateRepoFilePath(rawPath);
	if (!validated.ok) return validated;

	const canonicalRoot = realpathOrNull(root);
	if (canonicalRoot === null) {
		return fail("not-found", "Review root is unavailable");
	}

	const candidate = resolve(canonicalRoot, validated.path);
	// Lexical pre-check. Redundant with the realpath check below, but it keeps
	// a path that is out of bounds on its face from being stat'ed at all.
	if (!isContainedPath(candidate, canonicalRoot)) {
		return fail("outside-root", "Path is outside the review root");
	}

	const canonicalCandidate = realpathOrNull(candidate);
	if (canonicalCandidate === null) {
		// Covers both "does not exist" and "dangling symlink". Reported as
		// not-found either way so the response never confirms what lives
		// outside the repo.
		return fail("not-found", "File not found");
	}

	// THE security boundary: the canonical, symlink-resolved destination must
	// still be inside the canonical root.
	if (!isContainedPath(canonicalCandidate, canonicalRoot)) {
		return fail("outside-root", "Path is outside the review root");
	}

	return {
		ok: true,
		filePath: validated.path,
		absolutePath: canonicalCandidate,
	};
}

/**
 * Read one file from the review working tree, contained and capped.
 *
 * The size check reads `stat` before `readFileSync` on purpose: checking after
 * the read would mean the oversized file was already resident in memory, which
 * is the thing the cap exists to prevent.
 */
export function readRepoFile(root: string, rawPath: unknown): RepoFileResult {
	const resolved = resolveRepoFilePath(root, rawPath);
	if (!resolved.ok) return resolved;

	let stats: ReturnType<typeof statSync>;
	try {
		stats = statSync(resolved.absolutePath);
	} catch {
		return fail("not-found", "File not found");
	}

	if (!stats.isFile()) {
		return fail("not-a-file", "Path is not a file");
	}
	if (stats.size > MAX_REPO_FILE_BYTES) {
		return fail(
			"too-large",
			`File is too large to open (max ${MAX_REPO_FILE_BYTES} bytes)`,
			stats.size,
		);
	}

	let content: string;
	try {
		content = readFileSync(resolved.absolutePath, "utf8");
	} catch {
		return fail("not-found", "File could not be read");
	}

	return {
		ok: true,
		filePath: resolved.filePath,
		absolutePath: resolved.absolutePath,
		content,
		size: stats.size,
	};
}
