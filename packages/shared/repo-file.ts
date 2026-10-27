/**
 * Contained, capped reads of one file from a review working tree.
 *
 * Runtime-agnostic (node:fs and node:path only), so the Bun review server and
 * the Pi review server send every code-navigation file read, every
 * working-tree read for diff expansion and every working-tree image read
 * through this one guard. Pi gets a copy through `apps/pi-extension/vendor.sh`.
 *
 * Why it exists: the old defense was `validateFilePath`, a string check that
 * refuses `..` and a leading `/`. A string check cannot see a symlink, so a
 * repo holding `link -> /etc/hosts` (or `dir -> /etc`) passed it and the server
 * read the target. `/api/code-nav/file` also had no size cap, and reading a
 * FIFO blocked the server forever.
 *
 * The boundary is realpath containment: resolve the root and the candidate
 * through the filesystem, and require the real candidate to sit under the real
 * root. The file is then opened without following a final symlink and without
 * waiting on a FIFO, and checked on the open descriptor (regular file, size
 * under the cap) before any byte is read. Every byte comes from that
 * descriptor; nothing reopens the path.
 *
 * Swaps between the check and the open. `O_NOFOLLOW` covers only the final
 * component: a writer inside the repo who swaps a directory on the way for a
 * symlink to the outside after realpath ran makes an open by path land
 * outside. Node has no openat(), so after the open the read must be proved
 * contained some other way ({@link repoFileReadMethod}):
 *
 * 1. "descriptor" (Linux under Bun and Node; macOS under Bun): ask the kernel
 *    which file the descriptor really is, and require that path inside the
 *    root. Linux: `readlink(/proc/self/fd/N)`. macOS: Bun resolves
 *    `realpath(/dev/fd/N)` through fcntl(F_GETPATH). Node on macOS has no
 *    such call (it answers `/dev/fd/...`), and neither has Windows.
 * 2. "dir-stamps" (everything else: Node on macOS, so Pi; Windows; Linux
 *    without /proc): before the open, lstat every directory from the real
 *    root down (none may be a symlink) and keep its dev, ino and ctime; after
 *    it, the file's inode must match before and after, the realpath must
 *    still be contained, and every directory must still have the same dev,
 *    ino and ctime, deepest first. Any rename or new entry in a directory
 *    moves its ctime, so if none moved, no name on the way changed while the
 *    open ran. A changed directory makes the read try again (three times),
 *    so a busy directory is not refused.
 *
 * Measured on macOS (APFS) against an atomic swapper (renamex_np RENAME_SWAP
 * in a tight loop, flipping `sub` with `sub -> outside`), 30 s per run: no
 * escape for "descriptor" (Bun 1.4.4) or "dir-stamps" (Node 24 and Bun), at
 * the function and over HTTP on both servers. The previous recheck by path
 * alone escaped 2 to 6 times per run. Linux and Windows were not measured.
 *
 * Where "dir-stamps" is still best effort: it trusts a directory's ctime to
 * change on every entry change. APFS and ext4 keep it in nanoseconds; on a
 * filesystem with coarse timestamps (HFS+ keeps seconds, FAT no ctime) a
 * swap and its undo inside one tick leave it unchanged, and only the inode
 * and realpath rechecks remain. NTFS keeps 100 ns, but Windows was not
 * tested. A writer who can mount a filesystem over a directory (which leaves
 * the parent's ctime alone) is out of scope: that needs the user's own
 * rights, which already read every file.
 *
 * The root itself is pinned per review session ({@link pinRepoRoots}): its
 * real path, dev and ino when the server started (or when a session first
 * read it). Someone who can write the root's parent (a worktree under
 * `.claude/worktrees`, a repo in /tmp, a nested repo) could otherwise
 * `mv repo repo.old; ln -s /elsewhere repo`, and every check above would pass
 * against the new "root". A pinned root that no longer resolves to the same
 * directory is refused; a racing swap of the root is caught like any other
 * directory on the way. A root legitimately replaced mid-review is refused
 * until the review ends; pins are dropped when the last session stops.
 *
 * Hard links: a hard link inside the repo to a file outside it is the same
 * inode at a contained path, so it cannot be told apart and is read. Git never
 * creates hard links, so a cloned repo cannot carry one; making one needs
 * local write access to both places, which is the same as copying the file.
 */

import {
	type BigIntStats,
	closeSync,
	constants as fsConstants,
	fstatSync,
	lstatSync,
	openSync,
	readlinkSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { MAX_REVIEW_FILE_CONTENT_BYTES } from "./review-core";

/**
 * Default cap: the same 5 MB that diff context expansion uses, so a file the
 * diff can expand can also be previewed whole.
 */
export const MAX_REPO_FILE_BYTES = MAX_REVIEW_FILE_CONTENT_BYTES;

export type RepoFileFailureReason =
	| "invalid-path"
	| "outside-root"
	| "not-found"
	| "not-a-file"
	| "too-large"
	/** A directory on the way kept changing during the read; trying again may work. */
	| "changed";

export interface RepoFileSuccess {
	ok: true;
	/** The request path in repo-relative POSIX form. */
	filePath: string;
	/** Real on-disk path, after symlink resolution. */
	absolutePath: string;
	content: string;
	size: number;
}

export interface RepoFileFailure {
	ok: false;
	reason: RepoFileFailureReason;
	message: string;
	/** Present on "too-large" so the client can show the real size. */
	size?: number;
	/** Present on "too-large": the cap that was applied. */
	maxBytes?: number;
}

export type RepoFileResult = RepoFileSuccess | RepoFileFailure;

/**
 * Turns the bytes read from the descriptor into text. Each runtime supplies
 * its own so its output does not change: Node's `readFileSync(path, "utf8")`
 * keeps a leading BOM ({@link decodeUtf8}, the default), while Bun's
 * `Bun.file().text()` strips it and also sniffs a UTF-16 BOM (the Bun server
 * passes its own decoder).
 */
export type RepoFileDecoder = (bytes: Uint8Array) => string | Promise<string>;

/** Node's `readFileSync(path, "utf8")`: bad bytes become U+FFFD, a BOM stays. */
export const decodeUtf8: RepoFileDecoder = (bytes) =>
	Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");

/**
 * Test seam, never set in production (every hook is a function, so none can
 * come from a request). `afterCheck` runs once, after the realpath
 * containment check and before the directory stamps; `beforeOpen` on each
 * attempt, after the stamps and the file's lstat, right before the open (or
 * the readlink of a final symlink); `afterOpen` after it and before the
 * descriptor is verified. Tests swap a directory there to prove the read is
 * refused. `descriptorPath` replaces the kernel's answer for a descriptor
 * (`() => null`: unknown, which forces the directory stamps), so a test can
 * reach each method on any machine.
 */
export interface RepoFileReadHooks {
	afterCheck?: () => void;
	beforeOpen?: () => void;
	afterOpen?: () => void;
	descriptorPath?: (fd: number) => string | null;
}

export interface RepoFileReadOptions {
	/** Cap in bytes; default {@link MAX_REPO_FILE_BYTES}. */
	maxBytes?: number;
	/** Default {@link decodeUtf8}. */
	decode?: RepoFileDecoder;
	hooks?: RepoFileReadHooks;
}

/**
 * What a caller may pass to a runtime's `readWorkingTreeEntry`: the decoder
 * is the runtime's own, never the caller's.
 */
export type RepoWorkingTreeReadOptions = Omit<RepoFileReadOptions, "decode">;

/** HTTP status for each failure. Shared so both runtimes answer alike. */
export const REPO_FILE_ERROR_STATUS: Record<RepoFileFailureReason, number> = {
	"invalid-path": 400,
	"outside-root": 403,
	"not-found": 404,
	"not-a-file": 400,
	"too-large": 413,
	changed: 409,
};

/** The JSON error body both servers send for a failed read. */
export function repoFileErrorBody(failure: RepoFileFailure): {
	error: string;
	reason: RepoFileFailureReason;
	size?: number;
	maxBytes?: number;
} {
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

const OUTSIDE_ROOT = (): RepoFileFailure => fail("outside-root", "Path is outside the repository");
const NOT_FOUND = (): RepoFileFailure => fail("not-found", "File not found");

function tooLarge(size: number, maxBytes: number): RepoFileFailure {
	return {
		ok: false,
		reason: "too-large",
		message: `File is too large to open (${size} bytes; the limit is ${maxBytes} bytes)`,
		size,
		maxBytes,
	};
}

/**
 * Shape check for a client-supplied repo-relative path. A cheap pre-filter,
 * not the security boundary (containment is): it refuses hostile input before
 * the filesystem is touched, and keeps "invalid path" apart from "not found".
 */
export function validateRepoFilePath(
	rawPath: unknown,
): { ok: true; path: string } | RepoFileFailure {
	if (typeof rawPath !== "string" || rawPath.length === 0) {
		return fail("invalid-path", "Missing path");
	}
	if (rawPath.includes("\0")) return fail("invalid-path", "Invalid path");
	const normalized = rawPath.replace(/\\/g, "/");
	if (isAbsolute(rawPath) || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
		return fail("invalid-path", "Path must be relative to the repository");
	}
	if (normalized.split("/").some((segment) => segment === "..")) {
		return fail("invalid-path", "Invalid path");
	}
	// Split the returned path on "/" only: on POSIX a backslash is a legal
	// filename character, so `a\b.txt` must stay one name.
	const cleaned = rawPath.split("/").filter((segment) => segment.length > 0 && segment !== ".");
	if (cleaned.length === 0) return fail("invalid-path", "Invalid path");
	return { ok: true, path: cleaned.join("/") };
}

/**
 * True when `candidate` is `root` or lies under it. Both must already be real
 * paths. The trailing separator stops `/repo-evil` matching root `/repo`.
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

function sameInode(a: BigIntStats, b: BigIntStats): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}

/** Real candidate under an already-real root, or why it is refused. */
function containedRealPath(
	realRoot: string,
	relativePath: string,
): { ok: true; path: string } | RepoFileFailure {
	const realCandidate = realpathOrNull(resolve(realRoot, relativePath));
	// Missing file and dangling symlink both read as not-found, so the answer
	// never confirms what exists outside the repo.
	if (realCandidate === null) return NOT_FOUND();
	if (!isContainedPath(realCandidate, realRoot)) return OUTSIDE_ROOT();
	return { ok: true, path: realCandidate };
}

/**
 * Resolve a repo-relative path to a real, contained absolute path without
 * reading it.
 */
export function resolveRepoFilePath(
	root: string,
	rawPath: unknown,
): { ok: true; filePath: string; absolutePath: string } | RepoFileFailure {
	const validated = validateRepoFilePath(rawPath);
	if (!validated.ok) return validated;

	const pinned = checkRepoRoot(root);
	if (!pinned.ok) return pinned;
	const realRoot = pinned.realRoot;

	const contained = containedRealPath(realRoot, validated.path);
	if (!contained.ok) return contained;
	return { ok: true, filePath: validated.path, absolutePath: contained.path };
}

// --- Pinning the root ---------------------------------------------------------

/**
 * The root as it was when a review session first saw it. Without a pin every
 * read resolves the root path again, so someone who can write the root's
 * parent (a worktree under `.claude/worktrees`, a repo in /tmp, a nested
 * repo) can `mv repo repo.old; ln -s /elsewhere repo` and every check below
 * passes against the new "root".
 */
interface RootPin {
	real: string;
	dev: bigint;
	ino: bigint;
}

/** Keyed by the root as given (resolved lexically) and by its real path. */
const rootPins = new Map<string, RootPin>();
let pinSessions = 0;

function pinKey(root: string): string {
	return resolve(root);
}

function takePin(root: string): RootPin | null {
	const real = realpathOrNull(root);
	if (real === null) return null;
	try {
		const stats = lstatSync(real, { bigint: true });
		if (!stats.isDirectory()) return null;
		const pin = { real, dev: stats.dev, ino: stats.ino };
		rootPins.set(pinKey(root), pin);
		if (!rootPins.has(real)) rootPins.set(real, pin);
		return pin;
	} catch {
		return null;
	}
}

/**
 * Start a review session's root pins: pin `roots` now (missing ones are
 * skipped), and pin any other root on its first read while a session is
 * running. Returns the release; when the last session ends every pin is
 * dropped, so a long-lived host (Pi, OpenCode) does not hold a root that was
 * legitimately replaced between reviews.
 */
export function pinRepoRoots(roots: Iterable<string | null | undefined>): () => void {
	pinSessions++;
	for (const root of roots) {
		if (root && !rootPins.has(pinKey(root))) takePin(root);
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		pinSessions--;
		if (pinSessions === 0) rootPins.clear();
	};
}

/**
 * The root's real path, held to its pin: it must still resolve to the pinned
 * real path, which must still be a directory (not a link) with the pinned
 * dev and ino. Unpinned roots are pinned here while a session runs; with no
 * session (tests, the VS Code guide source) the root is only resolved.
 */
export function checkRepoRoot(root: string): { ok: true; realRoot: string } | RepoFileFailure {
	const real = realpathOrNull(root);
	if (real === null) return fail("not-found", "Repository root is unavailable");
	const pin = rootPins.get(pinKey(root)) ?? rootPins.get(real);
	if (!pin) {
		if (pinSessions > 0 && takePin(root) === null) return fail("not-found", "Repository root is unavailable");
		return { ok: true, realRoot: real };
	}
	const replaced = (): RepoFileFailure => fail("outside-root", "The repository root was replaced during the review");
	if (real !== pin.real) return replaced();
	try {
		const stats = lstatSync(pin.real, { bigint: true });
		if (!stats.isDirectory() || stats.dev !== pin.dev || stats.ino !== pin.ino) return replaced();
	} catch {
		return replaced();
	}
	return { ok: true, realRoot: pin.real };
}

// --- Proving the open is contained -------------------------------------------

/**
 * The kernel's path for an open descriptor, or null when this runtime and
 * platform cannot ask. Node on macOS answers `/dev/fd/N` (or `/dev/fd/<name>`
 * with the native realpath), never the file's path, so any `/dev/` answer
 * counts as unknown.
 */
function kernelDescriptorPath(fd: number): string | null {
	try {
		if (process.platform === "linux") {
			// A deleted file reads "<path> (deleted)": still its old place.
			const path = readlinkSync(`/proc/self/fd/${fd}`);
			return path.startsWith("/") ? path : null;
		}
		if (process.platform === "darwin" && "Bun" in globalThis) {
			const path = realpathSync(`/dev/fd/${fd}`);
			return path.startsWith("/dev/") ? null : path;
		}
	} catch {
		// No /proc, or the runtime cannot resolve the descriptor.
	}
	return null;
}

export type RepoFileReadMethod = "descriptor" | "dir-stamps";

/**
 * How reads under `root` prove the opened file is inside it (see the header):
 * "descriptor" asks the kernel, "dir-stamps" checks every directory on the
 * way before and after the open.
 */
export function repoFileReadMethod(root: string, hooks?: RepoFileReadHooks): RepoFileReadMethod {
	const realRoot = realpathOrNull(root);
	if (realRoot === null) return "dir-stamps";
	let fd: number | undefined;
	try {
		fd = openSync(realRoot, fsConstants.O_RDONLY);
		return (hooks?.descriptorPath ?? kernelDescriptorPath)(fd) !== null ? "descriptor" : "dir-stamps";
	} catch {
		return "dir-stamps";
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** One directory on the way to the file, as lstat saw it before the open. */
interface DirStamp {
	path: string;
	dev: bigint;
	ino: bigint;
	ctimeNs: bigint;
}

/**
 * lstat every directory from the real root down to the file's parent. Each
 * must be a directory: the path came from realpath, so a symlink on the way
 * was swapped in after it ran.
 */
function stampDirs(realRoot: string, realPath: string): DirStamp[] | RepoFileFailure {
	const names = relative(realRoot, realPath).split(sep).slice(0, -1);
	const stamps: DirStamp[] = [];
	let path = realRoot;
	for (let i = 0; i <= names.length; i++) {
		if (i > 0) path = join(path, names[i - 1]);
		let stats: BigIntStats;
		try {
			stats = lstatSync(path, { bigint: true });
		} catch {
			return NOT_FOUND();
		}
		if (stats.isSymbolicLink()) return OUTSIDE_ROOT();
		if (!stats.isDirectory()) return NOT_FOUND();
		stamps.push({ path, dev: stats.dev, ino: stats.ino, ctimeNs: stats.ctimeNs });
	}
	return stamps;
}

/**
 * Deepest first: every directory is still the same inode with the same
 * ctime. Any change to a directory's entries (a rename, a new link) moves its
 * ctime, and the root is the pinned directory (its own ctime moves if it is
 * renamed away and back), so by induction from the root no name on the way
 * changed between the stamps and this check, and the open between them went
 * where the stamps say.
 */
function stampsUnchanged(stamps: readonly DirStamp[]): boolean {
	for (let i = stamps.length - 1; i >= 0; i--) {
		const stamp = stamps[i];
		try {
			const now = lstatSync(stamp.path, { bigint: true });
			if (!now.isDirectory() || now.dev !== stamp.dev || now.ino !== stamp.ino || now.ctimeNs !== stamp.ctimeNs) {
				return false;
			}
		} catch {
			return false;
		}
	}
	return true;
}

/**
 * A directory on the way changed during the read, so the read is tried
 * again: a busy directory is not an attack, and a writer racing every
 * attempt is refused after the last one.
 */
const CHANGED = Symbol("changed during the read");
const MAX_ATTEMPTS = 3;

function changedTooOften(): RepoFileFailure {
	return fail("changed", "The file changed while it was being read. Try again.");
}

/**
 * After an open by path, prove the descriptor is inside the root: the
 * kernel's path for it where the runtime can ask, otherwise the directory
 * stamps plus the caller's identity recheck.
 */
function verifyOpened(
	fd: number,
	realRoot: string,
	stamps: readonly DirStamp[],
	hooks: RepoFileReadHooks | undefined,
	recheckIdentity: () => RepoFileFailure | null,
): RepoFileFailure | typeof CHANGED | null {
	const kernel = (hooks?.descriptorPath ?? kernelDescriptorPath)(fd);
	if (kernel !== null) return isContainedPath(kernel, realRoot) ? null : OUTSIDE_ROOT();
	const refused = recheckIdentity();
	if (refused) return refused;
	return stampsUnchanged(stamps) ? null : CHANGED;
}

// O_NONBLOCK keeps open() from waiting on a FIFO with no writer; O_NOFOLLOW
// refuses a final component swapped for a symlink after the check. Both are
// 0 where the platform does not define them (Windows).
const OPEN_FLAGS =
	fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);

function openForRead(path: string): { ok: true; fd: number } | RepoFileFailure {
	try {
		return { ok: true, fd: openSync(path, OPEN_FLAGS) };
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// ELOOP: the final component became a symlink after the check.
		if (code === "ELOOP") return OUTSIDE_ROOT();
		if (code === "EISDIR") return fail("not-a-file", "Path is not a regular file");
		return fail("not-found", "File not found");
	}
}

/**
 * Read a checked regular file from its descriptor, refusing it when larger
 * than `maxBytes`. Reads one byte past the cap: a file that grew after fstat
 * is caught without reading all of it.
 */
function readCappedFromFd(fd: number, stats: BigIntStats, maxBytes: number): { ok: true; bytes: Buffer } | RepoFileFailure {
	// Directories, FIFOs, sockets and devices are all refused.
	if (!stats.isFile()) return fail("not-a-file", "Path is not a regular file");
	const size = Number(stats.size);
	if (size > maxBytes) return tooLarge(size, maxBytes);
	const buffer = Buffer.alloc(Math.min(size, maxBytes) + 1);
	let length = 0;
	while (length < buffer.length) {
		const read = readSync(fd, buffer, length, buffer.length - length, null);
		if (read === 0) break;
		length += read;
	}
	if (length > maxBytes) {
		return {
			ok: false,
			reason: "too-large",
			message: `File is too large to open (over ${maxBytes} bytes)`,
			size: length,
			maxBytes,
		};
	}
	return { ok: true, bytes: buffer.subarray(0, length) };
}

type CheckedRead = { ok: true; bytes: Buffer; stats: BigIntStats };

/**
 * Open `path`, prove the descriptor is the contained file, check it is a
 * small regular file, and read it. Nothing reopens the path.
 */
function readOpened(
	path: string,
	maxBytes: number,
	hooks: RepoFileReadHooks | undefined,
	verify: (fd: number, opened: BigIntStats) => RepoFileFailure | typeof CHANGED | null,
): CheckedRead | RepoFileFailure | typeof CHANGED {
	hooks?.beforeOpen?.();
	const opened = openForRead(path);
	if (!opened.ok) return opened;
	try {
		const stats = fstatSync(opened.fd, { bigint: true });
		hooks?.afterOpen?.();
		const refused = verify(opened.fd, stats);
		if (refused) return refused;
		const read = readCappedFromFd(opened.fd, stats, maxBytes);
		return read.ok ? { ok: true, bytes: read.bytes, stats } : read;
	} catch {
		return fail("not-found", "File could not be read");
	} finally {
		closeSync(opened.fd);
	}
}

/** Run `attempt` until it is not {@link CHANGED}, at most {@link MAX_ATTEMPTS} times. */
function withRetries<T>(attempt: () => T | typeof CHANGED): T | RepoFileFailure {
	for (let i = 0; i < MAX_ATTEMPTS; i++) {
		const result = attempt();
		if (result !== CHANGED) return result;
	}
	return changedTooOften();
}

/**
 * Read one file from a review working tree: contained by realpath, regular
 * files only, and refused when larger than `maxBytes` (default
 * {@link MAX_REPO_FILE_BYTES}). The checks run on the open descriptor before
 * any read, so an oversized file never lands in memory.
 */
export async function readRepoFile(
	root: string,
	rawPath: unknown,
	options: RepoFileReadOptions = {},
): Promise<RepoFileResult> {
	const maxBytes = options.maxBytes ?? MAX_REPO_FILE_BYTES;
	const hooks = options.hooks;
	const validated = validateRepoFilePath(rawPath);
	if (!validated.ok) return validated;
	const pinned = checkRepoRoot(root);
	if (!pinned.ok) return pinned;
	const realRoot = pinned.realRoot;
	const contained = containedRealPath(realRoot, validated.path);
	if (!contained.ok) return contained;
	// A link inside the repo to the root itself: a directory, never a file.
	if (contained.path === realRoot) return fail("not-a-file", "Path is not a regular file");
	hooks?.afterCheck?.();

	const read = withRetries((): CheckedRead | RepoFileFailure | typeof CHANGED => {
		const stamps = stampDirs(realRoot, contained.path);
		if (!Array.isArray(stamps)) return stamps;
		let before: BigIntStats;
		try {
			before = lstatSync(contained.path, { bigint: true });
		} catch {
			return NOT_FOUND();
		}
		return readOpened(contained.path, maxBytes, hooks, (fd, opened) =>
			verifyOpened(fd, realRoot, stamps, hooks, () => {
				// The path named this inode before the open, and still resolves
				// inside the root, to it, after.
				if (!sameInode(before, opened)) return OUTSIDE_ROOT();
				const again = containedRealPath(realRoot, validated.path);
				if (!again.ok) return again.reason === "not-found" ? again : OUTSIDE_ROOT();
				return sameInode(statSync(again.path, { bigint: true }), opened) ? null : OUTSIDE_ROOT();
			}),
		);
	});
	if (!read.ok) return read;
	return {
		ok: true,
		filePath: validated.path,
		absolutePath: contained.path,
		content: await (options.decode ?? decodeUtf8)(read.bytes),
		size: read.bytes.length,
	};
}

export type RepoWorkingTreeEntry =
	| { ok: true; kind: "symlink"; filePath: string; linkTarget: string }
	| { ok: true; kind: "file"; filePath: string; absolutePath: string; content: string; size: number };

export type RepoWorkingTreeBytes =
	| { ok: true; kind: "symlink"; filePath: string; linkTarget: string }
	| {
			ok: true;
			kind: "file";
			filePath: string;
			absolutePath: string;
			bytes: Uint8Array;
			size: number;
			/** From the descriptor, for a cache validator. */
			mtimeMs: number;
	  };

/**
 * The working-tree path of an entry, without following a final symlink:
 * every directory on the way resolved by realpath and required inside the
 * root, the last name joined on unresolved.
 */
function containedLeaf(realRoot: string, relativePath: string): { ok: true; path: string } | RepoFileFailure {
	const candidate = resolve(realRoot, relativePath);
	const realParent = realpathOrNull(dirname(candidate));
	if (realParent === null) return NOT_FOUND();
	if (!isContainedPath(realParent, realRoot)) return OUTSIDE_ROOT();
	return { ok: true, path: join(realParent, basename(candidate)) };
}

/** After a read by path: the leaf must still be contained and be the same inode. */
function leafStillSame(realRoot: string, relativePath: string, expected: BigIntStats): RepoFileFailure | null {
	const again = containedLeaf(realRoot, relativePath);
	if (!again.ok) return again.reason === "not-found" ? again : OUTSIDE_ROOT();
	return sameInode(lstatSync(again.path, { bigint: true }), expected) ? null : OUTSIDE_ROOT();
}

type LinkRead = { ok: true; kind: "symlink"; linkTarget: string };

/**
 * A final symlink's target string. A link has no descriptor to ask about, so
 * this always uses the path checks: the stamps, the same link inode, and a
 * second read through the rechecked path with the same answer. At worst a
 * swap that beats them leaks a link's target string, never file content.
 */
function readLinkChecked(
	realRoot: string,
	relativePath: string,
	leafPath: string,
	stamps: readonly DirStamp[],
	before: BigIntStats,
	hooks: RepoFileReadHooks | undefined,
): LinkRead | RepoFileFailure | typeof CHANGED {
	try {
		hooks?.beforeOpen?.();
		const linkTarget = readlinkSync(leafPath);
		hooks?.afterOpen?.();
		const refused = leafStillSame(realRoot, relativePath, before);
		if (refused) return refused;
		const again = containedLeaf(realRoot, relativePath);
		if (!again.ok || readlinkSync(again.path) !== linkTarget) return OUTSIDE_ROOT();
		if (!stampsUnchanged(stamps)) return CHANGED;
		return { ok: true, kind: "symlink", linkTarget };
	} catch {
		return fail("not-found", "File could not be read");
	}
}

/**
 * Read one working-tree entry as bytes, with git's view of a symlink: a
 * link's content is its target string, read without following it. Every
 * directory on the way must resolve inside the root, so a path through a
 * symlinked directory that points out is refused. Otherwise the entry must be
 * a regular file no larger than `maxBytes` (default
 * {@link MAX_REPO_FILE_BYTES}); FIFOs and devices are refused.
 *
 * The bytes come from the checked descriptor, never from reopening the path,
 * so a FIFO or a bigger file swapped in after the check cannot block the
 * server or slip past the cap.
 */
export async function readRepoWorkingTreeBytes(
	root: string,
	rawPath: unknown,
	options: RepoWorkingTreeReadOptions = {},
): Promise<RepoWorkingTreeBytes | RepoFileFailure> {
	const maxBytes = options.maxBytes ?? MAX_REPO_FILE_BYTES;
	const hooks = options.hooks;
	const validated = validateRepoFilePath(rawPath);
	if (!validated.ok) return validated;
	const pinned = checkRepoRoot(root);
	if (!pinned.ok) return pinned;
	const realRoot = pinned.realRoot;
	const leaf = containedLeaf(realRoot, validated.path);
	if (!leaf.ok) return leaf;
	hooks?.afterCheck?.();

	const read = withRetries((): CheckedRead | LinkRead | RepoFileFailure | typeof CHANGED => {
		const stamps = stampDirs(realRoot, leaf.path);
		if (!Array.isArray(stamps)) return stamps;
		let before: BigIntStats;
		try {
			before = lstatSync(leaf.path, { bigint: true });
		} catch {
			return NOT_FOUND();
		}
		if (before.isSymbolicLink()) return readLinkChecked(realRoot, validated.path, leaf.path, stamps, before, hooks);
		// Refuse what is plainly not a small regular file before opening it.
		if (!before.isFile()) return fail("not-a-file", "Path is not a regular file");
		if (Number(before.size) > maxBytes) return tooLarge(Number(before.size), maxBytes);
		return readOpened(leaf.path, maxBytes, hooks, (fd, opened) =>
			verifyOpened(fd, realRoot, stamps, hooks, () =>
				sameInode(before, opened) ? leafStillSame(realRoot, validated.path, opened) : OUTSIDE_ROOT(),
			),
		);
	});
	if (!read.ok) return read;
	if ("kind" in read) return { ok: true, kind: "symlink", filePath: validated.path, linkTarget: read.linkTarget };
	return {
		ok: true,
		kind: "file",
		filePath: validated.path,
		absolutePath: leaf.path,
		bytes: read.bytes,
		size: read.bytes.length,
		mtimeMs: Number(read.stats.mtimeMs),
	};
}

/**
 * {@link readRepoWorkingTreeBytes} as text, for diff context expansion.
 * `decode` keeps each runtime's text output as it was (Bun and Node decode a
 * BOM differently).
 */
export async function readRepoWorkingTreeEntry(
	root: string,
	rawPath: unknown,
	options: RepoFileReadOptions = {},
): Promise<RepoWorkingTreeEntry | RepoFileFailure> {
	const entry = await readRepoWorkingTreeBytes(root, rawPath, options);
	if (!entry.ok || entry.kind === "symlink") return entry;
	return {
		ok: true,
		kind: "file",
		filePath: entry.filePath,
		absolutePath: entry.absolutePath,
		content: await (options.decode ?? decodeUtf8)(entry.bytes),
		size: entry.size,
	};
}
