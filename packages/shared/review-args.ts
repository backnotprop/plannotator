import type { VcsSelection } from "./vcs-core";
import type { DiffType } from "./review-core";
import { readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { isAbsoluteUserPath, resolveUserPath, stripWrappingQuotes } from "./resolve-file";

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
  /**
   * Non-URL positional words, in order. Hosts turn them into a review
   * directory with `resolveReviewTarget` (which needs the filesystem and the
   * invoking cwd); words that name no directory are tolerated as prose.
   */
  words?: string[];
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
   * `true` when the invocation carried `--gate` (#1907): the caller waits for
   * the reviewer's sign-off, so a bare Approve must reach it. The review page
   * always has Approve and the CLI always prints the approval, so the flag
   * changes nothing here; it marks the intent for a host that otherwise only
   * logs a bare Approve (the Claude Code mod takes the command over as the
   * `plannotator` tool's gated review).
   */
  gate?: boolean;
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
  let gate = false;
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

  const urls = positional.filter(isReviewUrl);
  const words = positional.filter((token) => !isReviewUrl(token));
  if (urls.length > 1) {
    errors.push("Review accepts only one PR/MR URL");
  }
  const prUrl = urls[0];
  // Static patch mode wins over VCS detection entirely, so every VCS/PR
  // selector combined with it is a usage error — fail loudly in one place
  // rather than silently ignoring the flag in each runtime. (A directory
  // target is refused by resolveReviewTarget, which knows what the words name.)
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
  /** Absolute directory the review opens in; undefined means the invoking cwd. */
  directory?: string;
  /** Words that named no target and were ignored as prose (#1483 tolerance). */
  ignored: string[];
}

/** Path-shaped words are directory candidates even inside prose. */
function looksLikePath(word: string): boolean {
  return /[\\/]/.test(word) || word.startsWith(".") || word.startsWith("~");
}

/**
 * Turn the parser's positional words into a review directory, before any VCS
 * discovery. Slash-command hosts forward raw user words verbatim, so prose
 * among several words stays tolerated (#1483):
 *
 * - A sole word is the target: an existing directory opens there, and a file
 *   or a word that names nothing throws (a typo'd target must never review
 *   the caller's repo). Two sole words stay prose: one holding whitespace
 *   that is not path-shaped (a quoted sentence), and a bare word beside
 *   `--patch-file`, which takes no directory.
 * - Among several words only path-shaped ones are candidates (in prose, a bare
 *   word that happens to match a directory never hijacks). A candidate that is
 *   an existing directory is the target; one that is missing or a file is
 *   prose ("the frontend/backend split", "look at ./notes.txt") and ignored.
 * - Every other word is returned in `ignored`, and the review opens in the
 *   invoking cwd exactly as before directory targets existed.
 * - Two targets (two directories, or a directory and a PR/MR URL) throw.
 */
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
      if (pathLike || (!/\s/.test(word) && parsed.patchFile === undefined)) {
        throw new Error(missingReviewFolderMessage(word, resolved, cwd));
      }
      ignored.push(word);
      continue;
    }
    if (!isDirectory) throw new Error(reviewFileTargetMessage(word, resolved));
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

const REVIEW_CURRENT_PROJECT_LINE = "To review the current project instead, run: plannotator review";

/**
 * The refusal for a target that names nothing. People and agents both read
 * it, so it ends in commands that work as written: a close folder name when
 * one exists, `--diff-type` for a diff mode's name, a PR URL for a number.
 */
function missingReviewFolderMessage(word: string, resolved: string, cwd: string): string {
  const lines = [
    isAbsoluteUserPath(word)
      ? `No folder at ${resolved}; nothing was opened.`
      : `No folder "${word}" in ${cwd}; nothing was opened.`,
  ];
  const suggestions = suggestReviewFolders(word, cwd);
  if ((REVIEW_OPEN_DIFF_TYPES as readonly string[]).includes(word)) {
    lines.push(`To open the current project's ${word} diff, run: plannotator review --diff-type ${word}`);
  } else if (/^#?\d+$/.test(word)) {
    const number = word.replace("#", "");
    lines.push(`To review pull request ${number}, pass its URL: plannotator review https://github.com/<owner>/<repo>/pull/${number}`);
  } else if (suggestions.length === 1) {
    lines.push(`Did you mean ${suggestions[0]}? Run: plannotator review ${shellWord(suggestions[0]!)}`);
  } else if (suggestions.length > 1) {
    lines.push(`Did you mean one of these folders? ${suggestions.join(", ")}`);
  } else {
    lines.push("To review another folder, run: plannotator review <path to an existing folder>");
  }
  lines.push(REVIEW_CURRENT_PROJECT_LINE);
  return lines.join("\n");
}

function reviewFileTargetMessage(word: string, resolved: string): string {
  return [
    `${resolved} is a file, not a folder; nothing was opened.`,
    `To comment on the file, run: plannotator annotate ${shellWord(word)}`,
    REVIEW_CURRENT_PROJECT_LINE,
  ].join("\n");
}

/**
 * Existing folders close to a path that names nothing, written the way the
 * word was typed. Each missing segment is matched against its parent's
 * folders; a missing segment before the last must have exactly one match.
 */
function suggestReviewFolders(word: string, cwd: string): string[] {
  const sep = /[\\/]/.exec(word)?.[0] ?? "/";
  const parts = word.split(/[\\/]+/);
  while (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  // An empty first part is the root of an absolute path.
  const typed = (segments: string[]) => (segments.length === 0 ? "." : segments.join(sep) || sep);
  const fixed: string[] = [];
  let corrected = false;
  for (let i = 0; i < parts.length; i++) {
    const segment = parts[i]!;
    if (segment === "" || isDirectoryPath(resolveUserPath(typed([...fixed, segment]), cwd))) {
      fixed.push(segment);
      continue;
    }
    const names = closeFolderNames(segment, resolveUserPath(typed(fixed), cwd));
    if (i === parts.length - 1) return names.map((name) => typed([...fixed, name]));
    if (names.length !== 1) return [];
    fixed.push(names[0]!);
    corrected = true;
  }
  return corrected ? [typed(fixed)] : [];
}

function isDirectoryPath(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Up to three folders in `parent` that `name` begins (3+ characters) or is
 * within a small edit distance of, ignoring case; the closest only.
 */
function closeFolderNames(name: string, parent: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  const typed = name.toLowerCase();
  const limit = typed.length <= 2 ? 0 : typed.length <= 4 ? 1 : 2;
  const scored: { name: string; distance: number }[] = [];
  for (const entry of entries.slice(0, 5000)) {
    if (entry.name.startsWith(".") && !name.startsWith(".")) continue;
    const candidate = entry.name.toLowerCase();
    const distance = typed.length >= 3 && candidate.startsWith(typed) ? 0 : editDistance(typed, candidate, limit);
    if (distance > limit) continue;
    if (entry.isDirectory() || (entry.isSymbolicLink() && isDirectoryPath(join(parent, entry.name)))) {
      scored.push({ name: entry.name, distance });
    }
  }
  scored.sort((a, b) => a.distance - b.distance || a.name.length - b.name.length || a.name.localeCompare(b.name));
  const best = scored[0]?.distance;
  return scored.filter((entry) => entry.distance === best).slice(0, 3).map((entry) => entry.name);
}

/** Optimal string alignment distance (swapping two neighbours costs 1), capped at `limit + 1`. */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous: number[] = [];
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      let value = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, previous[j - 2]! + 1);
      next.push(value);
    }
    previous = row;
    row = next;
  }
  return Math.min(row[b.length]!, limit + 1);
}

/** A word to paste after a command, quoted when a shell would split it. */
function shellWord(word: string): string {
  return /^[\w@%+=:,./\\~-]+$/.test(word) || word.includes('"') ? word : `"${word}"`;
}

/** One-line notice for words `resolveReviewTarget` ignored, or undefined. */
export function formatIgnoredReviewWords(target: ReviewTarget): string | undefined {
  return target.ignored.length > 0
    ? `Ignoring words that name no directory or PR/MR URL: ${target.ignored.join(" ")}`
    : undefined;
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

/**
 * The words in a review command's argument text: whitespace separates and
 * quotes group, while a backslash is an ordinary character, so a typed Windows
 * path (`C:\dev\feature`) stays whole. Exported for a host that passes the
 * words themselves on to the CLI (apps/dsh-plugin).
 */
export function tokenizeReviewArgs(input: string): string[] {
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
