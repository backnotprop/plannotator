/**
 * Tolerant annotate target selection (#1182).
 *
 * Slash-command hosts forward raw user arguments to `plannotator annotate`
 * verbatim. On Claude Code the skill runs the CLI through a bash-substitution
 * prefix that executes before the model sees anything, so trailing natural
 * language ("/plannotator-annotate the aim doc") lands in the argument slot
 * and used to die with `File not found: the`.
 *
 * This module implements the shared three-tier fallback that every host hooks
 * into at its existing "nothing found" terminal (the first resolution pass is
 * always the host's unchanged pipeline):
 *
 *   1. Fast path: probe each whitespace-delimited token; if exactly one names
 *      an existing file, URL, or folder, proceed with it directly.
 *   2. Ambiguity: two or more tokens resolve; error naming every candidate,
 *      never guess.
 *   3. Handoff: nothing resolves; emit a message that echoes the words tried
 *      and (for CLI surfaces whose output lands in an agent's context) asks
 *      the agent to interpret the request and re-run with a concrete target.
 *
 * Bundles (0.29) come first when the host can open them: several arguments
 * that are ALL existing files named by their paths open as one review, in
 * the typed order (`probeAnnotateBundlePath`, the `bundle` selection, and
 * `resolveAnnotateBundleFiles` for the type and size checks). Anything else
 * falls to the tiers above unchanged; the ambiguity error then gains a hint
 * (`ANNOTATE_BUNDLE_HINT`).
 *
 * Selection and message building are pure; the token probe touches the
 * filesystem via the same primitives the host pipelines use, so a token that
 * probes true resolves on the re-run.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { resolveAtReference, stripAtPrefix } from "./at-reference";
import {
  getAnnotatableExtensionsHint,
  isAnnotatableDocPath,
  MAX_ANNOTATABLE_FILE_BYTES,
  resolveMarkdownFile,
  resolveUserPath,
} from "./resolve-file";
import { diagramRenderKindForPath } from "@plannotator/core/annotatable";
import type { AnnotateBundleFile } from "./annotate-bundle";
import { looksLikeFilePath } from "./plannotator-tool";

export interface AnnotateTokenCandidate {
  /** The whitespace-delimited token the user typed. */
  token: string;
  /**
   * What the token resolved to: an absolute path for folders, HTML files and
   * document matches, the token itself for URLs and ambiguous document names.
   * Feeding this back into the host pipeline on a single match keeps hosts
   * without fuzzy resolution (Pi) consistent with the probe's answer.
   */
  value: string;
}

export type AnnotateTokenSelection =
  | { kind: "single"; candidate: AnnotateTokenCandidate }
  /**
   * Several arguments, and EVERY one names an existing regular file by its
   * path (see `probeAnnotateBundlePath`): one review of all of them, in the
   * typed order, duplicates dropped. Only returned when the caller passes a
   * `bundlePath` probe, i.e. when its host can open bundles.
   */
  | { kind: "bundle"; files: AnnotateTokenCandidate[] }
  /**
   * Several arguments that all READ as file paths (`looksLikeFilePath`), and
   * some of them name nothing at all: an explicit list of files with a typo in
   * it. Never narrowed to the files that do exist (that would review fewer
   * files than were named); the host fails naming `missing`. Only returned
   * with `bundlePath` and `pathExists`; an existing path is never missing.
   */
  | { kind: "missing"; missing: string[] }
  | { kind: "multiple"; candidates: AnnotateTokenCandidate[] }
  | { kind: "none"; words: string[] }
  /**
   * The input contains dash-prefixed tokens the caller did not recognize
   * (every known flag is stripped before selection runs). Tolerance must not
   * apply: silently skipping a typo'd flag would change behavior (for
   * example `--no-jna` fetching via Jina, exactly what `--no-jina` exists to
   * prevent). Callers fall through to their unchanged pipeline so the
   * invocation fails the same way it did before tolerant resolution existed.
   */
  | { kind: "flagged"; flagTokens: string[] };

export type AnnotateTokenProbe = (token: string) => string | null;

export interface ProbeAnnotateTokenOptions {
  /**
   * Whether a bare directory name (no path separator) may resolve as a
   * folder candidate. Defaults to true, which is correct when the token is
   * the sole argument. Multi-token selection passes false so a stray word
   * that happens to match a directory name (or `.`) cannot hijack the
   * fast path; explicit paths like `src/` or `docs/guides` still resolve.
   */
  bareDirectories?: boolean;
}

/**
 * Would `plannotator annotate <token>` reach a specific verdict on this
 * token: open it, or fail with a target-specific error ("Ambiguous
 * filename", "File type not supported", "File too large", empty folder)?
 *
 * Mirrors the CLI resolution branch order: URL, folder, HTML file, then
 * document resolution (strip-first with the literal-`@` fallback for
 * scoped-package-style names), then bare existence (existing-but-unsupported
 * targets belong to the pipeline so its specific errors keep surfacing
 * verbatim). Returns the value to feed the pipeline, or null. An ambiguous
 * document name returns the stripped token so that a sole-candidate run
 * surfaces the existing "Ambiguous filename" error instead of guessing.
 *
 * Cheap for natural-language words: without an annotatable extension the
 * document resolver returns before walking the project, and the remaining
 * checks are single stat calls.
 */
export function probeAnnotateToken(
  token: string,
  projectRoot: string,
  options?: ProbeAnnotateTokenOptions,
): string | null {
  if (!token) return null;

  // Unwrap the `@` reference marker and wrapping quotes before the URL
  // check: the pipeline strips them first (and re-strips harmlessly), so
  // `@https://example.com/page` in a multi-token invocation must count as a
  // URL candidate, not fall through to the handoff.
  const unwrapped = stripAtPrefix(token);
  if (/^https?:\/\//i.test(unwrapped)) return unwrapped;

  const allowBareDirectory = options?.bareDirectories !== false;
  if (allowBareDirectory || /[\\/]/.test(token)) {
    const folder = resolveAtReference(token, (candidate) => {
      try {
        return statSync(resolveUserPath(candidate, projectRoot)).isDirectory();
      } catch {
        return false;
      }
    });
    if (folder !== null) return resolveUserPath(folder, projectRoot);
  }

  const html = resolveAtReference(token, (candidate) => {
    const abs = resolveUserPath(candidate, projectRoot);
    return /\.html?$/i.test(abs) && existsSync(abs);
  });
  if (html !== null) return resolveUserPath(html, projectRoot);

  let doc = resolveMarkdownFile(unwrapped, projectRoot);
  if (doc.kind === "not_found" && unwrapped !== token) {
    doc = resolveMarkdownFile(token, projectRoot);
  }
  if (doc.kind === "found") return doc.path;
  if (doc.kind === "ambiguous") return unwrapped;

  // Bare existence is file-only: directories are candidates exclusively via
  // the folder branch above, so disabling bare directories cannot be undone
  // by this fallback.
  const literal = resolveAtReference(token, (candidate) => {
    try {
      return statSync(resolveUserPath(candidate, projectRoot)).isFile();
    } catch {
      return false;
    }
  });
  if (literal !== null) return resolveUserPath(literal, projectRoot);

  return null;
}

/**
 * Does the whole input name something that the annotate pipeline would reach
 * a specific verdict on? Used by hosts that run the token fallback as a
 * pre-pass: when this is true the unchanged pipeline runs and produces
 * exactly today's behavior.
 */
export function annotateInputNamesExistingTarget(
  input: string,
  projectRoot: string,
): boolean {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return false;
  return probeAnnotateToken(trimmed, projectRoot) !== null;
}

/**
 * The regular file `token` names BY ITS PATH, absolute, or null.
 *
 * "By its path" means the token, resolved against `projectRoot` (absolute
 * paths as they are, `~` expanded, one leading `@` reference marker or
 * wrapping quotes unwrapped, with the literal-`@` fallback for scoped-package
 * names), is a file that exists. A bare name found only by searching the
 * project does NOT count: that is a guess, and a bundle opens exactly what was
 * named. URLs and directories are never bundle files. The file's type is not
 * checked here (`resolveAnnotateBundleFiles` does that, so an unsupported file
 * fails naming itself instead of turning the input into prose).
 */
export function probeAnnotateBundlePath(token: string, projectRoot: string): string | null {
  if (!token) return null;
  if (/^https?:\/\//i.test(stripAtPrefix(token))) return null;
  const candidate = resolveAtReference(token, (value) => {
    try {
      return statSync(resolveUserPath(value, projectRoot)).isFile();
    } catch {
      return false;
    }
  });
  return candidate === null ? null : resolveUserPath(candidate, projectRoot);
}

export interface SelectAnnotateTokenTargetOptions {
  /**
   * The bundle probe (normally `probeAnnotateBundlePath`). When given and
   * every token names a file by its path, the selection is `bundle`. Hosts
   * that cannot open bundles leave it out and keep the #1182 tiers exactly.
   */
  bundlePath?: (token: string) => string | null;
  /**
   * Whether anything (file or directory) exists at the token's path
   * (normally `annotatePathExists`). The `missing` selection needs it: only a
   * token with nothing at its path is missing, so an existing directory such
   * as a stray `.` keeps the #1182 behavior. Without it there is no `missing`.
   */
  pathExists?: (token: string) => boolean;
}

/** Whether anything (file or directory) exists at the path `token` names. */
export function annotatePathExists(token: string, projectRoot: string): boolean {
  return resolveAtReference(token, (value) => existsSync(resolveUserPath(value, projectRoot))) !== null;
}

/** Identity of a file for dropping duplicates: its real path when it has one. */
function bundleIdentity(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Tier 1/2/3 selection over the tokens of the raw argument input. Accepts
 * either the pre-split argv tokens (preserving quoted arguments that contain
 * whitespace) or a single raw string that is split on whitespace. Duplicate
 * tokens are probed once. Any dash-prefixed token makes the selection
 * `flagged` (see the type comment): known flags are stripped by the caller
 * before selection, so whatever remains is an unrecognized flag that must
 * error the way it always did, not be skipped.
 */
export function selectAnnotateTokenTarget(
  rawInput: string | string[],
  probe: AnnotateTokenProbe,
  options: SelectAnnotateTokenTargetOptions = {},
): AnnotateTokenSelection {
  const tokens = (Array.isArray(rawInput)
    ? rawInput.map((token) => token.trim())
    : (rawInput ?? "").trim().split(/\s+/)
  ).filter(Boolean);

  const flagTokens = tokens.filter((token) => token.startsWith("-"));
  if (flagTokens.length > 0) {
    return { kind: "flagged", flagTokens };
  }

  // Bundle rule (0.29): several arguments that are ALL existing files named
  // by their paths open as one review, in the typed order. Anything less
  // (prose around a path, a URL or folder among them, a name found only by
  // searching) keeps the #1182 tiers below unchanged.
  const bundlePath = options.bundlePath;
  const uniqueTokens = [...new Set(tokens)];
  if (bundlePath && uniqueTokens.length > 1) {
    const files: AnnotateTokenCandidate[] = [];
    const identities = new Set<string>();
    let allFiles = true;
    for (const token of uniqueTokens) {
      const value = bundlePath(token);
      if (value === null) {
        allFiles = false;
        break;
      }
      const identity = bundleIdentity(value);
      if (identities.has(identity)) continue;
      identities.add(identity);
      files.push({ token, value });
    }
    if (allFiles) {
      return files.length === 1
        ? { kind: "single", candidate: files[0] as AnnotateTokenCandidate }
        : { kind: "bundle", files };
    }
    // Every word reads as a file path, yet some name nothing at all (nothing
    // at the path, and nothing found by search): a list of files with a typo.
    // Opening the rest would review fewer files than were named, so it fails
    // naming the missing ones. An existing path (a directory such as a stray
    // `.`) is never "missing". Known edge: a dotted word such as `Node.js`
    // or `v2.0` reads as a file path too.
    const pathExists = options.pathExists;
    if (pathExists && uniqueTokens.every((token) => looksLikeFilePath(stripAtPrefix(token)))) {
      const missing = uniqueTokens.filter((token) => !pathExists(token) && probe(token) === null);
      if (missing.length > 0) return { kind: "missing", missing };
    }
  }

  const seen = new Set<string>();
  const words: string[] = [];
  const candidates: AnnotateTokenCandidate[] = [];

  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    words.push(token);
    const value = probe(token);
    if (value !== null) candidates.push({ token, value });
  }

  if (candidates.length === 1) {
    return { kind: "single", candidate: candidates[0] };
  }
  if (candidates.length > 1) {
    return { kind: "multiple", candidates };
  }
  return { kind: "none", words };
}

export const ANNOTATE_USAGE_TARGET =
  "<file.md | file.txt | file.html | https://... | folder/>";

/**
 * Tier-2 error: several tokens each name an existing target. Never guess;
 * name every candidate so the caller can re-run with exactly one.
 */
export function buildAmbiguousAnnotateArgsMessage(
  candidates: AnnotateTokenCandidate[],
  options: { bundleHint?: boolean } = {},
): string {
  return [
    `Ambiguous annotate arguments: ${candidates.length} of them each resolve to an existing target.`,
    ...candidates.map((candidate) => `  ${candidate.token} -> ${candidate.value}`),
    `Re-run with exactly one target: plannotator annotate ${ANNOTATE_USAGE_TARGET}`,
    ...(options.bundleHint ? [ANNOTATE_BUNDLE_HINT] : []),
  ].join("\n");
}

/**
 * The hint line a host that opens bundles adds to the ambiguity error. Its
 * absence is how a host tells an OLDER CLI's refusal of several paths from
 * the current one's (`isOlderCliBundleRefusal` in the tool contract, which
 * keeps its own copy of this text).
 */
export const ANNOTATE_BUNDLE_HINT =
  "To review several files together, pass only their paths: plannotator annotate a.md b.html";

/**
 * The `missing` selection's error: an explicit list of files with one or more
 * that do not exist. Nothing is opened.
 */
export function buildMissingAnnotateFilesMessage(missing: readonly string[]): string {
  return [
    `${missing.length === 1 ? "File" : "Files"} not found: ${missing.join(", ")}`,
    "Every file of a review of several files must exist; nothing was opened. Fix the path and run the command again.",
  ].join("\n");
}

export type AnnotateBundleResolution =
  | { ok: true; files: AnnotateBundleFile[] }
  | { ok: false; message: string };

/**
 * The bundle's files, checked and in order: every one must be a file annotate
 * opens (markdown, plain text, config, diagram source, or HTML) and within the
 * 2MB annotate cap. The first one that is not fails the whole bundle with a
 * message naming it. HTML renders as raw HTML unless `convertHtml` (the
 * `--markdown` flag), exactly as a single HTML file does. Duplicates (the same
 * real file twice) are dropped, keeping the first.
 */
export function resolveAnnotateBundleFiles(
  paths: readonly string[],
  options: { convertHtml?: boolean } = {},
): AnnotateBundleResolution {
  const files: AnnotateBundleFile[] = [];
  const identities = new Set<string>();
  for (const path of paths) {
    const identity = bundleIdentity(path);
    if (identities.has(identity)) continue;
    identities.add(identity);
    let size: number;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) return { ok: false, message: `Not a file: ${path}` };
      size = stat.size;
    } catch {
      return { ok: false, message: `File not found: ${path}` };
    }
    if (!isAnnotatableDocPath(path)) {
      const name = path.replace(/^.*[\\/]/, "");
      const dot = name.lastIndexOf(".");
      // ".env" is all extension; "Makefile" has none.
      const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "(no extension)";
      const refusedEnv = /^\.env(?:\.|$)/i.test(name) || /\.env$/i.test(name);
      return {
        ok: false,
        message:
          (refusedEnv
            ? `File refused: ${path} (.env files are never annotated: they commonly hold secrets)\n`
            : `File type not supported: ${ext} (${path})\n`) +
          `Every file in a review of several files must be one annotate opens. Supported types: ${getAnnotatableExtensionsHint()}`,
      };
    }
    if (size > MAX_ANNOTATABLE_FILE_BYTES) {
      return { ok: false, message: `File too large to annotate (max 2MB): ${path}` };
    }
    const isHtml = /\.html?$/i.test(path);
    files.push({
      path,
      renderAs: isHtml ? (options.convertHtml ? "markdown" : "html") : diagramRenderKindForPath(path) ?? "markdown",
    });
  }
  return { ok: true, files };
}

/**
 * Tier-3 message: nothing in the arguments names an existing target. Echoes
 * the words tried and, when `agentHandoff` is set (CLI surfaces whose output
 * lands in an agent's context), asks the reading agent to interpret the
 * request and re-run with a concrete target, preserving the given flags.
 */
export function buildUnresolvedAnnotateArgsMessage(options: {
  words: string[];
  flags?: string[];
  agentHandoff?: boolean;
}): string {
  const { words, flags = [], agentHandoff = false } = options;
  const flagSuffix = flags.length > 0 ? ` ${flags.join(" ")}` : "";
  const lines = [
    "Could not resolve the arguments below to a file, URL, or folder; nothing in them matches an existing path:",
    "",
    `  ${words.join(" ")}`,
    "",
    `The annotate command needs a concrete target: plannotator annotate ${ANNOTATE_USAGE_TARGET}${flagSuffix}`,
  ];
  if (agentHandoff) {
    lines.push(
      "",
      "If you are an agent reading this: the arguments look like a natural-language description of what to annotate. Work out from the conversation which file, URL, or folder the user means, then run the command yourself with that concrete target:",
      "",
      `  plannotator annotate <path-or-url>${flagSuffix}`,
    );
  }
  return lines.join("\n");
}
