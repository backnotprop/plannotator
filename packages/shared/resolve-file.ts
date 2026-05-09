/**
 * Smart markdown file resolution.
 *
 * Resolves a user-provided path to an absolute file path using three strategies:
 * 1. Exact path (absolute or relative to cwd)
 * 2. Case-insensitive relative path search within project root
 * 3. Case-insensitive bare filename search within project root
 *
 * Used by both the CLI (`plannotator annotate`) and the `/api/doc` endpoint.
 */

import { homedir } from "os";
import { isAbsolute, join, resolve, win32 } from "path";
import { existsSync, readdirSync, type Dirent } from "fs";

const MARKDOWN_PATH_REGEX = /\.mdx?$/i;

import { CODE_FILE_REGEX as CODE_FILE_BASENAME_REGEX } from "./code-file";
export { CODE_FILE_REGEX, isCodeFilePath } from "./code-file";

const WINDOWS_DRIVE_PATH_PATTERNS = [
	/^\/cygdrive\/([a-zA-Z])\/(.+)$/,
	/^\/([a-zA-Z])\/(.+)$/,
];

const IGNORED_DIRS = [
	"node_modules/",
	".git/",
	"dist/",
	"build/",
	".next/",
	"__pycache__/",
	".obsidian/",
	".trash/",
];

const CODE_IGNORED_DIRS = [
	...IGNORED_DIRS,
	".turbo/",
	".cache/",
	"target/",
	"vendor/",
	"coverage/",
	".venv/",
	".pytest_cache/",
];

export type ResolveResult =
	| { kind: "found"; path: string }
	| { kind: "not_found"; input: string }
	| { kind: "ambiguous"; input: string; matches: string[] }
	| { kind: "unavailable"; input: string };

function normalizeSeparators(input: string): string {
	return input.replace(/\\/g, "/");
}

function stripTrailingSlashes(input: string): string {
	return input.replace(/\/+$/, "");
}

export function expandHomePath(input: string, home = homedir()): string {
	if (input === "~") {
		return home;
	}

	if (input.startsWith("~/") || input.startsWith("~\\")) {
		return join(home, input.slice(2));
	}

	return input;
}

export function stripWrappingQuotes(input: string): string {
	if (input.length < 2) {
		return input;
	}

	const first = input[0];
	const last = input[input.length - 1];
	if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
		return input.slice(1, -1);
	}

	return input;
}

export function normalizeUserPathInput(
	input: string,
	platform = process.platform,
): string {
	const trimmedInput = input.trim();
	const unquotedInput = stripWrappingQuotes(trimmedInput);
	const expandedInput = expandHomePath(unquotedInput);

	if (platform !== "win32") {
		return expandedInput;
	}

	for (const pattern of WINDOWS_DRIVE_PATH_PATTERNS) {
		const match = expandedInput.match(pattern);
		if (!match) {
			continue;
		}

		const [, driveLetter, rest] = match;
		return `${driveLetter.toUpperCase()}:/${rest}`;
	}

	return expandedInput;
}

function isAbsoluteNormalizedUserPath(
	input: string,
	platform = process.platform,
): boolean {
	if (hasWindowsDriveLetter(input)) {
		return true;
	}

	return platform === "win32"
		? win32.isAbsolute(input)
		: isAbsolute(input);
}

export function isAbsoluteUserPath(
	input: string,
	platform = process.platform,
): boolean {
	return isAbsoluteNormalizedUserPath(normalizeUserPathInput(input, platform), platform);
}

export function resolveUserPath(
	input: string,
	baseDir = process.cwd(),
	platform = process.platform,
): string {
	const normalizedInput = normalizeUserPathInput(input, platform);
	if (!normalizedInput) {
		return "";
	}
	return isAbsoluteNormalizedUserPath(normalizedInput, platform)
		? resolveAbsolutePath(normalizedInput, platform)
		: resolve(baseDir, normalizedInput);
}

function normalizeComparablePath(input: string): string {
	return stripTrailingSlashes(normalizeSeparators(resolveUserPath(input)));
}

export function isWithinProjectRoot(candidate: string, projectRoot: string): boolean {
	const normalizedCandidate = normalizeComparablePath(candidate);
	const normalizedProjectRoot = normalizeComparablePath(projectRoot);
	return (
		normalizedCandidate === normalizedProjectRoot ||
		normalizedCandidate.startsWith(`${normalizedProjectRoot}/`)
	);
}

function getLowercaseBasename(input: string): string {
	const normalizedInput = normalizeSeparators(input);
	return normalizedInput.split("/").pop()!.toLowerCase();
}

function getLookupKey(input: string, isBareFilename: boolean): string {
	return isBareFilename ? getLowercaseBasename(input) : input.toLowerCase();
}

function resolveAbsolutePath(
	input: string,
	platform = process.platform,
): string {
	// Use win32.resolve for Windows paths regardless of reported platform
	return platform === "win32" || hasWindowsDriveLetter(input)
		? win32.resolve(input)
		: resolve(input);
}

function isSearchableMarkdownPath(input: string): boolean {
	return MARKDOWN_PATH_REGEX.test(input.trim());
}

/** Check if a path looks like a Windows absolute path (e.g. C:\ or C:/) */
function hasWindowsDriveLetter(input: string): boolean {
	return /^[a-zA-Z]:[/\\]/.test(input);
}

/** Cross-platform file existence check using Node fs (more reliable than Bun.file in compiled exes) */
function fileExists(filePath: string): boolean {
	try {
		return existsSync(filePath);
	} catch {
		return false;
	}
}

/** Recursively walk a directory collecting files matching `fileMatcher`, skipping ignored dirs. */
function walkFiles(
	dir: string,
	root: string,
	results: string[],
	ignoredDirs: string[],
	fileMatcher: (name: string) => boolean,
): void {
	const entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (ignoredDirs.some((d) => d === entry.name + "/")) continue;
			try {
				walkFiles(join(dir, entry.name), root, results, ignoredDirs, fileMatcher);
			} catch {
				/* skip dirs we can't read */
			}
		} else if (entry.isFile() && fileMatcher(entry.name)) {
			const relative = join(dir, entry.name)
				.slice(root.length + 1)
				.replace(/\\/g, "/");
			results.push(relative);
		}
	}
}

function walkMarkdownFiles(dir: string, root: string, results: string[], ignoredDirs: string[]): void {
	try {
		walkFiles(dir, root, results, ignoredDirs, (name) => /\.mdx?$/i.test(name));
	} catch {
		/* fail soft for markdown — preserves existing behavior */
	}
}

// --- Code-file resolution (async, cached) ---

const FILE_LIST_CACHE_TTL_MS = 30_000;
const fileListCache = new Map<
	string,
	{ promise: Promise<string[] | null>; startedAt: number }
>();

function fileListCacheKey(projectRoot: string, kind: string): string {
	return `${projectRoot}|${kind}`;
}

function startCodeWalk(projectRoot: string): Promise<string[] | null> {
	return Promise.resolve().then(() => {
		try {
			const results: string[] = [];
			walkFiles(projectRoot, projectRoot, results, CODE_IGNORED_DIRS, (name) =>
				CODE_FILE_BASENAME_REGEX.test(name),
			);
			return results;
		} catch {
			return null;
		}
	});
}

/**
 * Trigger (or return the in-flight) walk of `projectRoot` for code files.
 * Cached for `FILE_LIST_CACHE_TTL_MS`. Storing a Promise (not a value) makes
 * concurrent callers piggyback on the same walk — first arrival wins.
 *
 * Returns `null` (wrapped in Promise) when the walk fails (perms, etc).
 */
export function warmFileListCache(
	projectRoot: string,
	kind: "code",
): Promise<string[] | null> {
	const key = fileListCacheKey(projectRoot, kind);
	const entry = fileListCache.get(key);
	if (entry && Date.now() - entry.startedAt < FILE_LIST_CACHE_TTL_MS) {
		return entry.promise;
	}
	const promise = startCodeWalk(projectRoot);
	fileListCache.set(key, { promise, startedAt: Date.now() });
	return promise;
}

/**
 * Resolve a code-file path within a project root.
 *
 * Strategies:
 *   1. Absolute path → use as-is.
 *   2. Exact relative from project root.
 *   3. If `baseDir` provided, literal `<baseDir>/<input>` existence check —
 *      lets out-of-tree linked docs resolve their own relative references
 *      (e.g. `../script.ts` in `~/notes/foo.md` finds `~/script.ts`).
 *   4. Case-insensitive suffix match against the cached file list:
 *      - bare basename input → match any file with that basename;
 *      - input with `/` → match files whose path equals or ends with `/<input>`
 *        on a segment boundary (so `editor/App.tsx` matches `packages/editor/App.tsx`
 *        but not `myeditor/App.tsx`).
 *
 * `..` segments in the input are honored: only `./` is stripped before suffix
 * matching. `../foo.ts` without a `baseDir` correctly falls through to
 * not_found rather than fabricating a match against `foo.ts` somewhere in cwd.
 */
export async function resolveCodeFile(
	input: string,
	projectRoot: string,
	baseDir?: string,
): Promise<ResolveResult> {
	const originalInput = input.trim();
	const unquotedInput = stripWrappingQuotes(originalInput);
	const normalizedInput = normalizeUserPathInput(unquotedInput);
	const searchInput = normalizeSeparators(normalizedInput);

	if (!searchInput) {
		return { kind: "not_found", input: originalInput };
	}

	if (isAbsoluteNormalizedUserPath(normalizedInput)) {
		const absolutePath = resolveAbsolutePath(normalizedInput);
		if (fileExists(absolutePath)) {
			return { kind: "found", path: absolutePath };
		}
		return { kind: "not_found", input: originalInput };
	}

	const fromRoot = resolve(projectRoot, searchInput);
	if (isWithinProjectRoot(fromRoot, projectRoot) && fileExists(fromRoot)) {
		return { kind: "found", path: fromRoot };
	}

	if (baseDir) {
		const fromBase = resolve(baseDir, searchInput);
		if (fileExists(fromBase)) {
			return { kind: "found", path: fromBase };
		}
	}

	const fileList = await warmFileListCache(projectRoot, "code");
	if (fileList === null) {
		return { kind: "unavailable", input: originalInput };
	}

	// Strip leading `./` so suffix matching works on inputs like
	// `./editor/App.tsx` — file list entries never carry that segment.
	// `../` is intentionally NOT stripped: `..` is meaningful (escape parent),
	// not noise. If we can't honor it via baseDir, the input has no
	// suffix-match equivalent in the in-tree file list.
	const cleanedInput = searchInput.replace(/^(?:\.\/)+/, "");
	if (!cleanedInput || cleanedInput.startsWith("../")) {
		return { kind: "not_found", input: originalInput };
	}
	const target = cleanedInput.toLowerCase();
	const isBareFilename = !cleanedInput.includes("/");
	const matches: string[] = [];

	for (const f of fileList) {
		const fl = f.toLowerCase();
		if (isBareFilename) {
			const base = fl.split("/").pop();
			if (base === target) matches.push(resolve(projectRoot, f));
		} else {
			if (fl === target || fl.endsWith("/" + target)) {
				matches.push(resolve(projectRoot, f));
			}
		}
	}

	if (matches.length === 1) {
		return { kind: "found", path: matches[0] };
	}
	if (matches.length > 1) {
		return { kind: "ambiguous", input: originalInput, matches };
	}
	return { kind: "not_found", input: originalInput };
}

/**
 * Resolve a markdown file path within a project root.
 *
 * @param input - User-provided path (absolute, relative, or bare filename)
 * @param projectRoot - Project root directory to search within
 */
function resolveMarkdownFileCore(
	input: string,
	projectRoot: string,
): ResolveResult {
	const normalizedInput = normalizeUserPathInput(input);
	const searchInput = normalizeSeparators(normalizedInput);
	const isBareFilename = !searchInput.includes("/");
	const targetLookupKey = getLookupKey(searchInput, isBareFilename);

	// Restrict to markdown files
	if (!isSearchableMarkdownPath(normalizedInput)) {
		return { kind: "not_found", input };
	}

	// 1. Absolute path — use as-is (no project root restriction;
	//    the user explicitly typed the full path)
	if (isAbsoluteNormalizedUserPath(normalizedInput)) {
		const absolutePath = resolveAbsolutePath(normalizedInput);
		if (fileExists(absolutePath)) {
			return { kind: "found", path: absolutePath };
		}
		return { kind: "not_found", input };
	}

	// 2. Exact relative path from project root
	const fromRoot = resolve(projectRoot, searchInput);
	if (isWithinProjectRoot(fromRoot, projectRoot) && fileExists(fromRoot)) {
		return { kind: "found", path: fromRoot };
	}

	// 3. Case-insensitive search (only scan markdown files)
	const allFiles: string[] = [];
	walkMarkdownFiles(projectRoot, projectRoot, allFiles, IGNORED_DIRS);
	const matches: string[] = [];

	for (const match of allFiles) {
		const normalizedMatch = normalizeSeparators(match);
		const matchLookupKey = getLookupKey(normalizedMatch, isBareFilename);

		if (matchLookupKey === targetLookupKey) {
			const full = resolve(projectRoot, normalizedMatch);
			if (isWithinProjectRoot(full, projectRoot)) {
				matches.push(full);
			}
		}
	}

	if (matches.length === 1) {
		return { kind: "found", path: matches[0] };
	}
	if (matches.length > 1) {
		const projectRootPrefix = `${normalizeComparablePath(projectRoot)}/`;
		const relative = matches.map((match) =>
			normalizeComparablePath(match).replace(projectRootPrefix, ""),
		);
		return { kind: "ambiguous", input, matches: relative };
	}

	return { kind: "not_found", input };
}

/**
 * Resolve a markdown file path within a project root.
 *
 * @param input - User-provided path (absolute, relative, or bare filename)
 * @param projectRoot - Project root directory to search within
 */
export function resolveMarkdownFile(
	input: string,
	projectRoot: string,
): ResolveResult {
	const originalInput = input.trim();
	const unquotedInput = stripWrappingQuotes(originalInput);

	const primary = resolveMarkdownFileCore(unquotedInput, projectRoot);
	if (primary.kind === "found") {
		return primary;
	}
	if (primary.kind === "ambiguous") {
		return { ...primary, input: originalInput };
	}

	if (!unquotedInput.startsWith("@")) {
		return { kind: "not_found", input: originalInput };
	}

	const normalizedInput = unquotedInput.replace(/^@+/, "");
	if (!normalizedInput) {
		return { kind: "not_found", input: originalInput };
	}

	const fallback = resolveMarkdownFileCore(normalizedInput, projectRoot);
	if (fallback.kind === "found") {
		return fallback;
	}
	if (fallback.kind === "ambiguous") {
		return { ...fallback, input: originalInput };
	}

	return { kind: "not_found", input: originalInput };
}

/**
 * Check if a directory contains at least one file matching the given extensions.
 * Used to validate folder annotation targets.
 *
 * @param dirPath - Directory to search
 * @param excludedDirs - Directory names to skip (with trailing slash, e.g. "node_modules/")
 * @param extensions - Regex to match file extensions (default: markdown only)
 */
export function hasMarkdownFiles(
	dirPath: string,
	excludedDirs: string[] = IGNORED_DIRS,
	extensions: RegExp = /\.mdx?$/i,
): boolean {
	function walk(dir: string): boolean {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return false;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (excludedDirs.some((d) => d === entry.name + "/")) continue;
				if (walk(join(dir, entry.name))) return true;
			} else if (entry.isFile() && extensions.test(entry.name)) {
				return true;
			}
		}
		return false;
	}
	return walk(dirPath);
}
