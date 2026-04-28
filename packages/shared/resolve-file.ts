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

export type ResolveResult =
	| { kind: "found"; path: string }
	| { kind: "not_found"; input: string }
	| { kind: "ambiguous"; input: string; matches: string[] };

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

/** Recursively walk a directory collecting markdown files, skipping ignored dirs. */
function walkMarkdownFiles(dir: string, root: string, results: string[], ignoredDirs: string[]): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (ignoredDirs.some((d) => d === entry.name + "/")) continue;
			walkMarkdownFiles(join(dir, entry.name), root, results, ignoredDirs);
		} else if (entry.isFile() && /\.mdx?$/i.test(entry.name)) {
			const relative = join(dir, entry.name)
				.slice(root.length + 1)
				.replace(/\\/g, "/");
			results.push(relative);
		}
	}
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
