/**
 * Where a token the reader's diff reports is in the file on disk. The diff
 * is the guide's patch; the head side's file is the real one, which may have
 * moved on since (local changes edited after the guide was written). No
 * `vscode`: the caller passes the lines it read.
 */

import { parseDiffToFiles } from "@plannotator/core/diff-files";

export interface TokenSpot {
  /** 1-based. */
  line: number;
  /** 0-based. */
  character: number;
  /** The token was not exactly where the diff said: the file changed since. */
  stale: boolean;
}

/** How far up and down a moved token is looked for. */
const SEARCH_LINES = 40;

function isWordChar(c: string | undefined): boolean {
  return !!c && /[\p{L}\p{N}_$]/u.test(c);
}

/** Every column of `token` on `text` as a whole word (when the token is a word). */
function occurrences(text: string, token: string): number[] {
  const out: number[] = [];
  const word = isWordChar(token[0]) && isWordChar(token[token.length - 1]);
  let i = text.indexOf(token);
  while (i >= 0) {
    if (!word || (!isWordChar(text[i - 1]) && !isWordChar(text[i + token.length]))) out.push(i);
    i = text.indexOf(token, i + 1);
  }
  return out;
}

/**
 * The token's spot in the file: exactly where the diff says when it is still
 * there; else the nearest occurrence on the same line; else the nearest
 * occurrence within SEARCH_LINES lines (marked stale). Null when the file has
 * no such token near there, or when the token is empty.
 */
export function locateToken(lineAt: (line: number) => string | undefined, line: number, character: number, token: string): TokenSpot | null {
  if (!token || line < 1) return null;
  const text = lineAt(line);
  if (text !== undefined) {
    if (occurrences(text, token).includes(character)) return { line, character, stale: false };
    const same = occurrences(text, token);
    if (same.length) {
      const nearest = same.reduce((a, b) => (Math.abs(b - character) < Math.abs(a - character) ? b : a));
      return { line, character: nearest, stale: true };
    }
  }
  for (let d = 1; d <= SEARCH_LINES; d++) {
    for (const l of [line - d, line + d]) {
      if (l < 1) continue;
      const t = lineAt(l);
      if (t === undefined) continue;
      const hits = occurrences(t, token);
      if (hits.length) {
        const nearest = hits.reduce((a, b) => (Math.abs(b - character) < Math.abs(a - character) ? b : a));
        return { line: l, character: nearest, stale: true };
      }
    }
  }
  return null;
}

/**
 * The `git diff` runs that give the guide's files' diff now, to compare with
 * the guide's (`changedPatchFiles`; their outputs are joined). Rename
 * detection is the user's (`diff.renames`), as it was when the guide's own
 * patch was made, so a pure `git mv` comes out the same way both times; a
 * renamed file's old path is in the pathspec too (in the same run), or git
 * would show the rename as a new file and it would read as changed. At most
 * `max` paths per run, so a large guide is batched rather than skipped.
 */
export function changedSinceDiffArgs(baseRev: string, files: Iterable<{ path: string; oldPath?: string }>, max = 500): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  for (const f of files) {
    const paths = f.oldPath && f.oldPath !== f.path ? [f.path, f.oldPath] : [f.path];
    if (batch.length && batch.length + paths.length > max) {
      batches.push(batch);
      batch = [];
    }
    batch.push(...paths);
  }
  if (batch.length) batches.push(batch);
  return batches.map((paths) => ["--no-pager", "-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", baseRev, "--", ...paths]);
}

/** A file's diff text without the lines that name blobs (`index …`), which differ for the same change. */
function diffBody(patch: string): string {
  return patch
    .split("\n")
    .filter((l) => !l.startsWith("index ") && !l.startsWith("similarity index") && !l.startsWith("diff --git"))
    .join("\n")
    .trim();
}

/**
 * The files whose diff now (`current`, a fresh `git diff <base>` of the
 * guide's tracked files) is not the guide's (`guidePatch`). A file the
 * current diff does not list (an untracked file the guide added) is left out:
 * nothing says it changed.
 */
export function changedPatchFiles(guidePatch: string, current: string): string[] {
  const now = new Map(parseDiffToFiles(current).map((f) => [f.path, diffBody(f.patch)]));
  const out: string[] = [];
  for (const f of parseDiffToFiles(guidePatch)) {
    const body = now.get(f.path);
    if (body !== undefined && body !== diffBody(f.patch)) out.push(f.path);
  }
  return out;
}

export type HoverBlock = { kind: "code"; language: string; text: string } | { kind: "markdown"; text: string };

/**
 * A language server's hover markdown split into code blocks (signatures) and
 * prose, in order. Prose is kept as markdown; the reader renders it through
 * its sanitizing markdown renderer. Command links (`command:`) are dropped:
 * the reader cannot run them.
 */
export function splitHoverMarkdown(markdown: string): HoverBlock[] {
  const blocks: HoverBlock[] = [];
  const fence = /```([\w+-]*)[^\n]*\n([\s\S]*?)```/g;
  let last = 0;
  const pushProse = (text: string) => {
    const cleaned = text
      .replace(/\[([^\]]*)\]\(command:[^)]*\)/g, "$1")
      .replace(/^\s*---\s*$/gm, "")
      .trim();
    if (cleaned) blocks.push({ kind: "markdown", text: cleaned });
  };
  for (let m = fence.exec(markdown); m; m = fence.exec(markdown)) {
    pushProse(markdown.slice(last, m.index));
    const text = m[2].replace(/\n$/, "");
    if (text.trim()) blocks.push({ kind: "code", language: m[1] || "text", text });
    last = m.index + m[0].length;
  }
  pushProse(markdown.slice(last));
  return blocks;
}

/**
 * One side's lines of a file's diff, as the reader drew them: line number on
 * that side → text, for every line the patch shows (context and the side's
 * own changes). `new` is the head side (context and `+`), `old` the base side
 * (context and `-`). Nothing is read from disk: an ask carries exactly what
 * the reviewer saw.
 */
export function patchSideLines(filePatch: string, side: "old" | "new"): Map<number, string> {
  const out = new Map<number, string>();
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of filePatch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    const mark = raw[0];
    const text = raw.slice(1).replace(/\r$/, "");
    if (mark === " ") {
      out.set(side === "old" ? oldLine : newLine, text);
      oldLine++;
      newLine++;
    } else if (mark === "-") {
      if (side === "old") out.set(oldLine, text);
      oldLine++;
    } else if (mark === "+") {
      if (side === "new") out.set(newLine, text);
      newLine++;
    } else if (mark === "\\") {
      // "\ No newline at end of file"
    } else if (raw.startsWith("diff --git")) {
      inHunk = false;
    }
  }
  return out;
}

/**
 * The selected lines' code from the guide's patch (`start`..`end` on `side`
 * of `path`), or null when the patch does not show every one of them.
 */
export function patchExcerpt(guidePatch: string, path: string, side: "old" | "new", start: number, end: number): string | null {
  const file = parseDiffToFiles(guidePatch).find((f) => f.path === path);
  if (!file || end < start) return null;
  const lines = patchSideLines(file.patch, side);
  const out: string[] = [];
  for (let l = start; l <= end; l++) {
    const text = lines.get(l);
    if (text === undefined) return null;
    out.push(text);
  }
  return out.join("\n");
}
