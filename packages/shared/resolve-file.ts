/** Resolves a user-provided path to an absolute file: exact path, then case-insensitive relative path, then bare filename within the project root. Used by the CLI and `/api/doc`. */

import { homedir } from "os";
import { isAbsolute, join, resolve, win32 } from "path";
import { existsSync, readdirSync, type Dirent } from "fs";
import { readdir } from "node:fs/promises";

import { buildAnnotatableTextRegex } from "./annotatable";
import { getExtraMarkdownExtensions } from "./markdown-extensions";
import { CODE_FILE_REGEX as CODE_FILE_BASENAME_REGEX } from "./code-file";
export { CODE_FILE_REGEX, isCodeFilePath } from "./code-file";
export { MAX_ANNOTATABLE_FILE_BYTES } from "./annotatable";
/** Extension predicates re-exported here are the CONFIG-AWARE ones (they honor `markdownExtensions`): server code must use these, not the pure constants in @plannotator/core/annotatable. */
export {
	getAnnotatableTextRegex,
	getAnnotatableDocRegex,
	getAnnotatableExtensionsHint,
	getExtraMarkdownExtensions,
	isAnnotatableTextPath,
	isAnnotatableDocPath,
} from "./markdown-extensions";

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

const DEFAULT_FILE_BROWSER_MAX_FILES = 5_000;

export function getFileBrowserMaxFiles(): number {
	const value = Number.parseInt(
		process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES ?? "",
		10,
	);
	return Number.isFinite(value) && value > 0
		? value
		: DEFAULT_FILE_BROWSER_MAX_FILES;
}

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

/** The files single-file annotate resolution accepts: any unambiguously plain-text format plus the configured extra markdown extensions. HTML is excluded (it has its own branch at the call sites). */
function isSearchableMarkdownPath(input: string, extra: readonly string[]): boolean {
	return buildAnnotatableTextRegex(extra).test(input.trim());
}

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

type FileWalkState = {
	visitedFiles: number;
	readonly limit: number;
};

function walkFiles(
	dir: string,
	root: string,
	results: string[],
	ignoredDirs: string[],
	fileMatcher: (name: string) => boolean,
	state: FileWalkState,
): void {
	if (state.visitedFiles >= state.limit) return;
	const entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
	for (const entry of entries) {
		if (state.visitedFiles >= state.limit) return;
		if (entry.isDirectory()) {
			if (ignoredDirs.some((d) => d === entry.name + "/")) continue;
			try {
				walkFiles(
					join(dir, entry.name),
					root,
					results,
					ignoredDirs,
					fileMatcher,
					state,
				);
			} catch {
				/* skip dirs we can't read */
			}
		} else if (entry.isFile()) {
			state.visitedFiles += 1;
			if (fileMatcher(entry.name)) {
				const relative = join(dir, entry.name)
					.slice(root.length + 1)
					.replace(/\\/g, "/");
				results.push(relative);
			}
		}
	}
}

function walkMarkdownFiles(
	dir: string,
	root: string,
	results: string[],
	ignoredDirs: string[],
	extra: readonly string[],
): void {
	const matcher = buildAnnotatableTextRegex(extra);
	try {
		walkFiles(
			dir,
			root,
			results,
			ignoredDirs,
			(name) => matcher.test(name),
			{ visitedFiles: 0, limit: getFileBrowserMaxFiles() },
		);
	} catch {
		/* fail soft for markdown — preserves existing behavior */
	}
}

const FILE_LIST_CACHE_TTL_MS = 30_000;
const fileListCache = new Map<
	string,
	{ promise: Promise<string[] | null>; startedAt: number }
>();

function fileListCacheKey(projectRoot: string, kind: string): string {
	return `${projectRoot}|${kind}`;
}

async function walkCodeFiles(
	dir: string,
	root: string,
	results: string[],
	state: FileWalkState,
): Promise<void> {
	if (state.visitedFiles >= state.limit) return;
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (state.visitedFiles >= state.limit) return;
		if (entry.isDirectory()) {
			if (CODE_IGNORED_DIRS.some((d) => d === entry.name + "/")) continue;
			try {
				await walkCodeFiles(join(dir, entry.name), root, results, state);
			} catch {
				/* skip dirs we can't read */
			}
		} else if (entry.isFile()) {
			state.visitedFiles += 1;
			if (CODE_FILE_BASENAME_REGEX.test(entry.name)) {
				const relative = join(dir, entry.name)
					.slice(root.length + 1)
					.replace(/\\/g, "/");
				results.push(relative);
			}
		}
	}
}

async function startCodeWalk(projectRoot: string): Promise<string[] | null> {
	try {
		const results: string[] = [];
		await walkCodeFiles(projectRoot, projectRoot, results, {
			visitedFiles: 0,
			limit: getFileBrowserMaxFiles(),
		});
		return results;
	} catch {
		return null;
	}
}

/** Trigger (or return the in-flight) walk of `projectRoot` for code files, cached for `FILE_LIST_CACHE_TTL_MS`. Caching the Promise lets concurrent callers share one walk. Null when the walk fails. */
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
 * Resolve a code-file path within a project root: absolute as-is; exact relative; literal `<baseDir>/<input>` (lets out-of-tree linked docs resolve their own relative references); then a case-insensitive suffix match on a segment boundary against the cached file list.
 * `..` segments are honored: `../foo.ts` without a `baseDir` falls through to not_found rather than matching a `foo.ts` somewhere in cwd.
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

	// Strip leading `./` only: list entries never carry it. `..` is meaningful (escape parent) and is not stripped.
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

function resolveMarkdownFileCore(
	input: string,
	projectRoot: string,
	extra: readonly string[],
): ResolveResult {
	const normalizedInput = normalizeUserPathInput(input);
	const searchInput = normalizeSeparators(normalizedInput);
	const isBareFilename = !searchInput.includes("/");
	const targetLookupKey = getLookupKey(searchInput, isBareFilename);

	if (!isSearchableMarkdownPath(normalizedInput, extra)) {
		return { kind: "not_found", input };
	}

	if (isAbsoluteNormalizedUserPath(normalizedInput)) {
		const absolutePath = resolveAbsolutePath(normalizedInput);
		if (fileExists(absolutePath)) {
			return { kind: "found", path: absolutePath };
		}
		return { kind: "not_found", input };
	}

	// An explicit path the user typed (with a separator, including `../` that escapes the root) is honored when it exists, like absolute paths. Bare filenames stay restricted to the in-root search so a stray `notes.md` can't resolve to a parent.
	const fromRoot = resolve(projectRoot, searchInput);
	if (
		fileExists(fromRoot) &&
		(isWithinProjectRoot(fromRoot, projectRoot) || searchInput.includes("/"))
	) {
		return { kind: "found", path: fromRoot };
	}

	const allFiles: string[] = [];
	walkMarkdownFiles(projectRoot, projectRoot, allFiles, IGNORED_DIRS, extra);
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

/** Resolve a markdown file path within a project root. `extraMarkdownExtensions` defaults to the process-wide set resolved from `config.json`. */
export function resolveMarkdownFile(
	input: string,
	projectRoot: string,
	options?: { extraMarkdownExtensions?: readonly string[] },
): ResolveResult {
	const originalInput = input.trim();
	const unquotedInput = stripWrappingQuotes(originalInput);
	const extra = options?.extraMarkdownExtensions ?? getExtraMarkdownExtensions();

	const primary = resolveMarkdownFileCore(unquotedInput, projectRoot, extra);
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

	const fallback = resolveMarkdownFileCore(normalizedInput, projectRoot, extra);
	if (fallback.kind === "found") {
		return fallback;
	}
	if (fallback.kind === "ambiguous") {
		return { ...fallback, input: originalInput };
	}

	return { kind: "not_found", input: originalInput };
}

/** True when a directory contains at least one file matching the extensions (default markdown only); validates folder annotation targets. */
export function hasMarkdownFiles(
	dirPath: string,
	excludedDirs: string[] = IGNORED_DIRS,
	extensions: RegExp = /\.mdx?$/i,
): boolean {
	const state: FileWalkState = {
		visitedFiles: 0,
		limit: getFileBrowserMaxFiles(),
	};

	function walk(dir: string): boolean {
		if (state.visitedFiles >= state.limit) return false;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return false;
		}
		for (const entry of entries) {
			if (state.visitedFiles >= state.limit) return false;
			if (entry.isDirectory()) {
				if (excludedDirs.some((d) => d === entry.name + "/")) continue;
				if (walk(join(dir, entry.name))) return true;
			} else if (entry.isFile()) {
				state.visitedFiles += 1;
				if (extensions.test(entry.name)) return true;
			}
		}
		return false;
	}
	return walk(dirPath);
}
