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

import { isAbsolute, resolve, win32 } from "path";
import { existsSync } from "fs";

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

function normalizeComparablePath(input: string): string {
  return stripTrailingSlashes(normalizeSeparators(resolve(input)));
}

function isWithinProjectRoot(candidate: string, projectRoot: string): boolean {
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

function resolveAbsolutePath(input: string, platform = process.platform): string {
  // Use win32.resolve for Windows paths regardless of reported platform
  return (platform === "win32" || hasWindowsDriveLetter(input))
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

export function normalizeMarkdownPathInput(
  input: string,
  platform = process.platform,
): string {
  if (platform !== "win32") {
    return input;
  }

  for (const pattern of WINDOWS_DRIVE_PATH_PATTERNS) {
    const match = input.match(pattern);
    if (!match) {
      continue;
    }

    const [, driveLetter, rest] = match;
    return `${driveLetter.toUpperCase()}:/${rest}`;
  }

  return input;
}

export function isAbsoluteMarkdownPath(
  input: string,
  platform = process.platform,
): boolean {
  const normalizedInput = normalizeMarkdownPathInput(input, platform);
  // Always check for Windows drive letters (handles compiled Bun exes where
  // process.platform may not reflect the actual OS correctly)
  if (hasWindowsDriveLetter(normalizedInput)) {
    return true;
  }
  return platform === "win32"
    ? win32.isAbsolute(normalizedInput)
    : isAbsolute(normalizedInput);
}

/**
 * Resolve a markdown file path within a project root.
 *
 * @param input - User-provided path (absolute, relative, or bare filename)
 * @param projectRoot - Project root directory to search within
 */
export async function resolveMarkdownFile(
  input: string,
  projectRoot: string,
): Promise<ResolveResult> {
  // Trim whitespace/CR that may leak from Windows shell pipelines
  input = input.trim();
  const normalizedInput = normalizeMarkdownPathInput(input);
  const searchInput = normalizeSeparators(normalizedInput);
  const isBareFilename = !searchInput.includes("/");
  const targetLookupKey = getLookupKey(searchInput, isBareFilename);

  // Restrict to markdown files
  if (!isSearchableMarkdownPath(normalizedInput)) {
    return { kind: "not_found", input };
  }

  // 1. Absolute path — use as-is (no project root restriction;
  //    the user explicitly typed the full path)
  if (isAbsoluteMarkdownPath(normalizedInput)) {
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
  const glob = new Bun.Glob("**/*.[mM][dD]{,[xX]}");
  const matches: string[] = [];

  for await (const match of glob.scan({ cwd: projectRoot, onlyFiles: true })) {
    const normalizedMatch = normalizeSeparators(match);

    if (IGNORED_DIRS.some((dir) => normalizedMatch.includes(dir))) continue;

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
    const relative = matches.map((match) => normalizeComparablePath(match).replace(projectRootPrefix, ""));
    return { kind: "ambiguous", input, matches: relative };
  }

  return { kind: "not_found", input };
}
