import type { VcsSelection } from "./vcs-core";
import type { DiffType } from "./review-core";
import { statSync } from "node:fs";
import { resolveUserPath, stripWrappingQuotes } from "./resolve-file";

export const REVIEW_OPEN_DIFF_TYPES = [
  "since-base",
  "local-vs-remote",
  "uncommitted",
  "staged",
  "unstaged",
  "last-commit",
  "branch",
  "merge-base",
  "all",
] as const;

export type ReviewOpenDiffType = (typeof REVIEW_OPEN_DIFF_TYPES)[number];

export interface ParsedReviewArgs {
  prUrl?: string;
  words?: string[];
  patchFile?: string;
  vcsType?: VcsSelection;
  useLocal: boolean;
  base?: string;
  diffType?: DiffType;
  gitRemoteCheck?: boolean;
  gate?: boolean;
  errors: string[];
}

export function parseReviewArgs(input: string | string[]): ParsedReviewArgs {
  const tokens = Array.isArray(input)
    ? input.map((token) => stripWrappingQuotes(token.trim())).filter(Boolean)
    : tokenizeReviewArgs(input ?? "");

  let vcsType: VcsSelection | undefined;
  let useLocal = true;
  let base: string | undefined;
  let diffType: DiffType | undefined;
  let gitRemoteCheck: boolean | undefined;
  let gate = false;
  const errors: string[] = [];
  const positional: string[] = [];

  let patchFile: string | undefined;
  let localFlagSeen = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    switch (token) {
      case "--git":
        vcsType = "git";
        break;
      case "--gitbutler":
        vcsType = "gitbutler";
        break;
      case "--patch-file": {
        const value = tokens[i + 1];
        if (value === undefined || value.startsWith("--")) {
          errors.push("--patch-file requires a path or -");
          break;
        }
        i++;
        if (patchFile !== undefined) {
          errors.push("--patch-file may only be specified once");
          break;
        }
        patchFile = value;
        break;
      }
      case "--no-git-remote-check":
        gitRemoteCheck = false;
        break;
      case "--gate":
        gate = true;
        break;
      case "--local":
        useLocal = true;
        localFlagSeen = true;
        break;
      case "--no-local":
        useLocal = false;
        localFlagSeen = true;
        break;
      case "--base": {
        const value = tokens[i + 1];
        if (value === undefined || value.startsWith("-")) {
          errors.push("Missing value for --base");
          break;
        }
        i++;
        if (base !== undefined) {
          errors.push("--base may only be specified once");
          break;
        }
        if (/\s/.test(value) || value.includes("..")) {
          errors.push(`Invalid base ref: ${value}`);
          break;
        }
        base = value;
        break;
      }
      case "--diff-type": {
        const value = tokens[i + 1];
        if (value === undefined || value.startsWith("-")) {
          errors.push("Missing value for --diff-type");
          break;
        }
        i++;
        if (diffType !== undefined) {
          errors.push("--diff-type may only be specified once");
          break;
        }
        if (!(REVIEW_OPEN_DIFF_TYPES as readonly string[]).includes(value)) {
          errors.push(
            `Unknown diff type: ${value}. Expected one of: ${REVIEW_OPEN_DIFF_TYPES.join(", ")}`,
          );
          break;
        }
        diffType = value as DiffType;
        break;
      }
      default:
        if (token.startsWith("-")) {
          errors.push(`Unknown review option: ${token}`);
        } else {
          positional.push(token);
        }
        break;
    }
  }

  const urls = positional.filter(isReviewUrl);
  const words = positional.filter((token) => !isReviewUrl(token));
  if (urls.length > 1) {
    errors.push("Review accepts only one PR/MR URL");
  }
  const prUrl = urls[0];
  if (patchFile !== undefined) {
    if (prUrl) {
      errors.push("--patch-file cannot be combined with a PR/MR URL");
    }
    if (base) errors.push("--patch-file cannot be combined with --base");
    if (diffType) errors.push("--patch-file cannot be combined with --diff-type");
    if (vcsType) errors.push("--patch-file cannot be combined with --git/--gitbutler");
    if (localFlagSeen) errors.push("--patch-file cannot be combined with --local/--no-local");
  }
  return {
    prUrl,
    ...(words.length === 0 ? {} : { words }),
    patchFile,
    vcsType,
    useLocal,
    base,
    diffType,
    ...(gitRemoteCheck === undefined ? {} : { gitRemoteCheck }),
    ...(gate ? { gate } : {}),
    errors,
  };
}

export interface ReviewTarget {
  directory?: string;
  ignored: string[];
}

function looksLikePath(word: string): boolean {
  return /[\\/]/.test(word) || word.startsWith(".") || word.startsWith("~");
}

export function resolveReviewTarget(
  parsed: Pick<ParsedReviewArgs, "prUrl" | "words" | "patchFile">,
  cwd: string,
): ReviewTarget {
  const words = parsed.words ?? [];
  const sole = words.length === 1 && parsed.prUrl === undefined;
  const directories: string[] = [];
  const ignored: string[] = [];
  for (const word of words) {
    const pathLike = looksLikePath(word);
    if (!sole && !pathLike) {
      ignored.push(word);
      continue;
    }
    const resolved = resolveUserPath(word, cwd);
    let isDirectory: boolean | undefined;
    try {
      isDirectory = statSync(resolved).isDirectory();
    } catch {
      isDirectory = undefined;
    }
    if (!sole && !isDirectory) {
      ignored.push(word);
      continue;
    }
    if (isDirectory === undefined) {
      if (pathLike) throw new Error(`Review directory does not exist or is not accessible: ${resolved}`);
      ignored.push(word);
      continue;
    }
    if (!isDirectory) throw new Error(`Review target is not a directory: ${resolved}`);
    directories.push(resolved);
  }
  if (directories.length + (parsed.prUrl ? 1 : 0) > 1) {
    throw new Error("Review accepts only one directory or PR/MR URL. Quote paths containing spaces.");
  }
  if (directories.length > 0 && parsed.patchFile !== undefined) {
    throw new Error("--patch-file cannot be combined with a review directory");
  }
  return { ...(directories[0] === undefined ? {} : { directory: directories[0] }), ignored };
}

export function formatIgnoredReviewWords(target: ReviewTarget): string | undefined {
  return target.ignored.length > 0
    ? `Ignoring words that name no directory or PR/MR URL: ${target.ignored.join(" ")}`
    : undefined;
}

export function withReviewDirectory(feedback: string, directory?: string): string {
  return directory && feedback.trim()
    ? `Review directory: ${directory}\n\n${feedback}`
    : feedback;
}

function isReviewUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function tokenizeReviewArgs(input: string): string[] {
  const raw = input.trim();
  if (!raw) return [];

  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) tokens.push(current);
  return tokens.map((token) => stripWrappingQuotes(token.trim())).filter(Boolean);
}
