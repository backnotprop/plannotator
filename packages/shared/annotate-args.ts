/**
 * Parse CLI-style args arriving as a single whitespace-delimited string.
 *
 * Extracts the `--gate`, `--json`, and `--hook` flags (issue #570)
 * from the remainder, which is treated as the target path. Leading `@` is
 * stripped via the shared at-reference helper — reference-mode is primary.
 * Scoped-package-style literal `@` paths are handled by a fallback that the
 * downstream resolver opts into (see at-reference.ts).
 *
 * Used by the OpenCode plugin and Pi extension, where the whole args string
 * arrives pre-joined from the harness slash-command dispatcher. The Claude
 * Code binary parses argv directly with indexOf/splice and does not use
 * this helper.
 *
 * Implementation: walks the raw string once, preserving whitespace runs and
 * non-whitespace tokens as separate segments. Only known flag tokens
 * (whole-word match) plus one adjacent whitespace run are removed.
 * This keeps double-spaces and tabs inside file paths intact — which
 * matches the pre-PR behavior on `main`, where OpenCode and Pi passed
 * the raw args string straight through to the filesystem resolver.
 *
 * Remaining edge: if a path literally contains a known flag as a standalone
 * whitespace-separated token (e.g. `"Feature --gate spec.md"`), that token
 * is stripped. Supporting this would need shell-style quoting, which isn't
 * worth the complexity for a vanishingly rare naming pattern.
 */

import { stripAtPrefix } from "./at-reference";
import { stripWrappingQuotes } from "./resolve-file";

export interface ParsedAnnotateArgs {
  /**
   * Primary resolution path with any leading `@` stripped (reference-mode
   * convention). Most call sites should use this directly.
   */
  filePath: string;
  /**
   * Raw path with the `@` prefix preserved (if the user supplied one).
   * Callers that want the literal-`@` fallback for scoped-package-style
   * paths pair this with `resolveAtReference` from at-reference.ts.
   */
  rawFilePath: string;
  gate: boolean;
  json: boolean;
  hook: boolean;
  renderHtml: boolean;
}

type Segment = { type: "ws" | "tok"; text: string };

const FLAG_MAP = {
  "--gate": "gate",
  "--json": "json",
  "--hook": "hook",
  "--render-html": "renderHtml",
} as const satisfies Record<string, keyof Omit<ParsedAnnotateArgs, "filePath" | "rawFilePath">>;

export function parseAnnotateArgs(raw: string): ParsedAnnotateArgs {
  const s = (raw ?? "").trim();
  const flags = { gate: false, json: false, hook: false, renderHtml: false };

  const segments: Segment[] = [];
  for (let i = 0; i < s.length;) {
    const isWs = /\s/.test(s[i]);
    const start = i;
    while (i < s.length && /\s/.test(s[i]) === isWs) i++;
    segments.push({ type: isWs ? "ws" : "tok", text: s.slice(start, i) });
  }

  const keep = segments.map(() => true);
  for (let j = 0; j < segments.length; j++) {
    const seg = segments[j];
    if (seg.type !== "tok") continue;
    const key = FLAG_MAP[seg.text as keyof typeof FLAG_MAP];
    if (!key) continue;

    flags[key] = true;
    keep[j] = false;

    // Drop one adjacent whitespace run so removed flags don't leave dangling
    // spaces. Prefer trailing whitespace; fall back to leading if at the end.
    if (j + 1 < segments.length && segments[j + 1].type === "ws") {
      keep[j + 1] = false;
    } else if (j > 0 && segments[j - 1].type === "ws") {
      keep[j - 1] = false;
    }
  }

  // Trim covers the case where two adjacent flags (`... --gate --json`)
  // both claim the single whitespace between them, leaving a trailing space
  // after the kept token. Wrapping quotes come from OpenCode/Pi users who
  // quote paths with spaces (shell muscle memory); strip them here so
  // downstream callers never see tokenization artifacts.
  const rawFilePath = stripWrappingQuotes(
    segments
      .filter((_, j) => keep[j])
      .map((seg) => seg.text)
      .join("")
      .trim(),
  );

  if (flags.hook) flags.gate = true;

  return { filePath: stripAtPrefix(rawFilePath), rawFilePath, ...flags };
}
