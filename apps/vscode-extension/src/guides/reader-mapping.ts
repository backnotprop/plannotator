import { parseDiffToFiles } from "@plannotator/core/diff-files";

export interface TokenSpot {
  line: number;
  character: number;
  stale: boolean;
}

const SEARCH_LINES = 40;

function isWordChar(c: string | undefined): boolean {
  return !!c && /[\p{L}\p{N}_$]/u.test(c);
}

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

function diffBody(patch: string): string {
  return patch
    .split("\n")
    .filter((l) => !l.startsWith("index ") && !l.startsWith("similarity index") && !l.startsWith("diff --git"))
    .join("\n")
    .trim();
}

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
    } else if (raw.startsWith("diff --git")) {
      inHunk = false;
    }
  }
  return out;
}

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
