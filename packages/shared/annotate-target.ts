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
 * Selection and message building are pure; the token probe touches the
 * filesystem via the same primitives the host pipelines use, so a token that
 * probes true resolves on the re-run.
 */

import { existsSync, statSync } from "node:fs";
import { resolveAtReference, stripAtPrefix } from "./at-reference";
import { resolveMarkdownFile, resolveUserPath } from "./resolve-file";

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
): AnnotateTokenSelection {
  const tokens = (Array.isArray(rawInput)
    ? rawInput.map((token) => token.trim())
    : (rawInput ?? "").trim().split(/\s+/)
  ).filter(Boolean);

  const flagTokens = tokens.filter((token) => token.startsWith("-"));
  if (flagTokens.length > 0) {
    return { kind: "flagged", flagTokens };
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
): string {
  return [
    `Ambiguous annotate arguments: ${candidates.length} of them each resolve to an existing target.`,
    ...candidates.map((candidate) => `  ${candidate.token} -> ${candidate.value}`),
    `Re-run with exactly one target: plannotator annotate ${ANNOTATE_USAGE_TARGET}`,
  ].join("\n");
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
