import type { VcsSelection } from "./vcs-core";
import type { DiffType } from "./review-core";
import { statSync } from "node:fs";
import { resolveUserPath, stripWrappingQuotes } from "./resolve-file";

/**
 * The flat git diff ids `review --diff-type` accepts — exactly GIT_DIFF_TYPES
 * in vcs-core, pinned by test (a git diff type added to one list and not the
 * other would make a valid mode unreachable from the CLI). Kept as a literal
 * list here (type-only imports elsewhere) so review-args stays light for
 * plugin hosts. Session-navigation states (`commit:<sha>`, `worktree:*`,
 * `gitbutler:*`, jj/p4 modes) are deliberately not open states.
 */
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
  /** Local review directory, resolved against the invoking session by the host. */
  directory?: string;
  patchFile?: string;
  vcsType?: VcsSelection;
  useLocal: boolean;
  /** Compare target the session opens against (`--base <ref>`). */
  base?: string;
  /** Diff mode the session opens in (`--diff-type <id>`). */
  diffType?: DiffType;
  /**
   * `false` when the invocation carried `--no-git-remote-check` (issue #1553):
   * this session must make no `git ls-remote` call at all. Undefined means
   * the flag was absent, leaving PLANNOTATOR_GIT_REMOTE_CHECK / config.gitRemoteCheck
   * to decide. Hosts forward it to the review server, which resolves the
   * precedence in one place.
   */
  gitRemoteCheck?: boolean;
  /**
   * Argument-shape problems the host must surface before starting a session.
   * Always present; empty means the invocation parsed cleanly. Hosts differ in
   * how they surface these (CLI exits 1, Pi/OpenCode notify), which is why the
   * parser reports rather than throws.
   */
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
  const errors: string[] = [];
  const positional: string[] = [];

  let patchFile: string | undefined;
  // --local / --no-local conflict with --patch-file only when the user typed
  // one: useLocal defaults to true, so check the flag's presence, not the
  // value. Both spellings are PR-review selectors, so both are usage errors.
  let localFlagSeen = false;

  // Index-based so value-taking flags consume their value token before the
  // positional collector sees it — otherwise `--base main <PR_URL>` would put
  // "main" in positional[0] and lose the URL.
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
        // Belt-and-braces before the ref ever reaches git (`--end-of-options`
        // on the rev-parse probe is the primary guard): no whitespace, no
        // range syntax.
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
          // Unknown dash-prefixed tokens error loudly, matching the annotate
          // contract ("a typo'd flag errors the way it always did"). Silently
          // dropping them meant a mistyped flag vanished on every host — and a
          // dashed token in positional[0] could even shadow a PR URL.
          errors.push(`Unknown review option: ${token}`);
        } else {
          positional.push(token);
        }
        break;
    }
  }

  const target = positional[0];
  if (positional.length > 1) {
    errors.push("Review accepts only one directory or PR/MR URL. Omit prose; quote paths containing spaces.");
  }
  const directory = target && !isReviewUrl(target) ? target : undefined;
  // Static patch mode wins over VCS detection entirely, so every VCS/PR
  // selector combined with it is a usage error — fail loudly in one place
  // rather than silently ignoring the flag in each runtime.
  if (patchFile !== undefined) {
    if (target && isReviewUrl(target)) {
      errors.push("--patch-file cannot be combined with a PR/MR URL");
    }
    if (directory) errors.push("--patch-file cannot be combined with a review directory");
    if (base) errors.push("--patch-file cannot be combined with --base");
    if (diffType) errors.push("--patch-file cannot be combined with --diff-type");
    if (vcsType) errors.push("--patch-file cannot be combined with --git/--gitbutler");
    if (localFlagSeen) errors.push("--patch-file cannot be combined with --local/--no-local");
  }
  return {
    prUrl: target && isReviewUrl(target) ? target : undefined,
    ...(directory === undefined ? {} : { directory }),
    patchFile,
    vcsType,
    useLocal,
    base,
    diffType,
    ...(gitRemoteCheck === undefined ? {} : { gitRemoteCheck }),
    errors,
  };
}

/** Validate before VCS discovery so a typo can never review the caller's repo. */
export function resolveReviewDirectory(directory: string | undefined, cwd: string): string {
  if (directory === undefined) return cwd;
  const resolved = resolveUserPath(directory, cwd);
  let isDirectory: boolean;
  try {
    isDirectory = statSync(resolved).isDirectory();
  } catch {
    throw new Error(`Review directory does not exist or is not accessible: ${resolved}`);
  }
  if (!isDirectory) throw new Error(`Review target is not a directory: ${resolved}`);
  return resolved;
}

/** Feedback returns to the invoking agent, whose cwd may be a different repo. */
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
