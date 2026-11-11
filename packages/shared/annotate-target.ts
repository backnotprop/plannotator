/**
 * Tolerant annotate target selection: slash-command hosts forward raw user arguments, so trailing prose must not die with `File not found`.
 * One token naming an existing target proceeds; several are an ambiguity error; none is a handoff message. Several arguments that are all existing files open as a bundle first.
 * Selection and messages are pure; the token probe uses the same filesystem primitives as the host pipelines.
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
import { documentRenderKindForPath } from "@plannotator/core/annotatable";
import type { AnnotateBundleFile } from "./annotate-bundle";
import { looksLikeFilePath } from "./plannotator-tool";

export interface AnnotateTokenCandidate {
  token: string;
  /** Absolute path for folders, HTML files and document matches; the token itself for URLs and ambiguous document names. */
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
  /** Multi-token selection passes false so a stray word matching a directory name (or `.`) cannot hijack the fast path; defaults to true for a sole argument. */
  bareDirectories?: boolean;
}

/**
 * Would `plannotator annotate <token>` reach a specific verdict: open it, or fail with a target-specific error? Mirrors the CLI resolution branch order.
 * Existing-but-unsupported targets are left to the pipeline so its errors surface verbatim; an ambiguous document name returns the stripped token.
 */
export function probeAnnotateToken(
  token: string,
  projectRoot: string,
  options?: ProbeAnnotateTokenOptions,
): string | null {
  if (!token) return null;

  // Unwrap `@` and wrapping quotes before the URL check, as the pipeline does.
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

  // Bare existence is file-only: directories are candidates only via the folder branch above.
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

export function annotateInputNamesExistingTarget(
  input: string,
  projectRoot: string,
): boolean {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return false;
  return probeAnnotateToken(trimmed, projectRoot) !== null;
}

/**
 * The regular file `token` names by its path, absolute, or null. A bare name found only by searching does NOT count: a bundle opens exactly what was named.
 * The file's type is checked by `resolveAnnotateBundleFiles`.
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
  bundlePath?: (token: string) => string | null;
  pathExists?: (token: string) => boolean;
}

export function annotatePathExists(token: string, projectRoot: string): boolean {
  return resolveAtReference(token, (value) => existsSync(resolveUserPath(value, projectRoot))) !== null;
}

function bundleIdentity(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Any dash-prefixed token makes the selection `flagged`: known flags are stripped by the caller, so what remains is an unrecognized flag that must error, not be skipped. */
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
    // Every word reads as a file path yet some name nothing: a list with a typo. Opening the rest would review fewer files than named, so it fails naming the missing ones. Existing paths (a stray `.`) are never missing.
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

/** Its absence is how a host tells an older CLI's refusal of several paths from the current one's (`isOlderCliBundleRefusal` keeps its own copy of this text). */
export const ANNOTATE_BUNDLE_HINT =
  "To review several files together, pass only their paths: plannotator annotate a.md b.html";

export function buildMissingAnnotateFilesMessage(missing: readonly string[]): string {
  return [
    `${missing.length === 1 ? "File" : "Files"} not found: ${missing.join(", ")}`,
    "Every file of a review of several files must exist; nothing was opened. Fix the path and run the command again.",
  ].join("\n");
}

export type AnnotateBundleResolution =
  | { ok: true; files: AnnotateBundleFile[] }
  | { ok: false; message: string };

/** Every file must be one annotate opens and within the 2MB cap; the first that is not fails the whole bundle. Duplicates (the same real file) are dropped, keeping the first. */
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
      renderAs: isHtml ? (options.convertHtml ? "markdown" : "html") : documentRenderKindForPath(path) ?? "markdown",
    });
  }
  return { ok: true, files };
}

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
