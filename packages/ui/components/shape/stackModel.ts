import { parseDiffToFiles } from '@plannotator/core/diff-files';
import type { ShapeStack, ShapeStackChange, ShapeStackFile, ShapeStackPull } from '@plannotator/core/shape';

let parsed: { patch: string; files: ReturnType<typeof parseDiffToFiles> } | null = null;
function patchFiles(patch: string): ReturnType<typeof parseDiffToFiles> {
  if (parsed?.patch !== patch) parsed = { patch, files: parseDiffToFiles(patch) };
  return parsed.files;
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * One file's lines from a review's whole patch: the hunks that touch `lines` (new-side,
 * inclusive), or every hunk when none is given or none touches them.
 */
export function stackFilePatch(patch: string, path: string, lines?: readonly (readonly [number, number])[]): string | null {
  const file = patchFiles(patch).find((f) => f.path === path || f.oldPath === path);
  if (!file) return null;
  if (!lines?.length) return file.patch;
  const rows = file.patch.split('\n');
  const head: string[] = [];
  const hunks: { from: number; to: number; rows: string[] }[] = [];
  for (const row of rows) {
    const m = HUNK.exec(row);
    if (m) {
      const from = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      hunks.push({ from, to: from + Math.max(count, 1) - 1, rows: [row] });
    } else if (hunks.length) hunks[hunks.length - 1]!.rows.push(row);
    else head.push(row);
  }
  const kept = hunks.filter((h) => lines.some(([a, b]) => a <= h.to && h.from <= b));
  if (!kept.length) return file.patch;
  const body = kept.flatMap((h) => h.rows).filter((row, i, all) => !(row === '' && i === all.length - 1));
  return [...head, ...body, ''].join('\n');
}

export function stackFileCounts(file: ShapeStackFile, filePatch: string | null): { additions: number; deletions: number } | null {
  if (file.additions !== undefined || file.deletions !== undefined) return { additions: file.additions ?? 0, deletions: file.deletions ?? 0 };
  if (!filePatch) return null;
  let additions = 0;
  let deletions = 0;
  for (const row of filePatch.split('\n')) {
    if (row.startsWith('+') && !row.startsWith('+++')) additions++;
    else if (row.startsWith('-') && !row.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

export function stackCard(stack: ShapeStack, part: string, pr: number): { pull: ShapeStackPull; change: ShapeStackChange; others: ShapeStackPull[] } | null {
  const pull = stack.pulls.find((p) => p.n === pr);
  const change = stack.changes.find((c) => c.part === part && c.pr === pr);
  if (!pull || !change) return null;
  const others = stack.pulls.filter((p) => p.n !== pr && stack.changes.some((c) => c.part === part && c.pr === p.n));
  return { pull, change, others };
}

/** A part's name for the card ("In The dialog"): its first heading or bold words, else its first line of words. */
export function stackPartName(el: Element): string {
  const named = el.querySelector('h1, h2, h3, h4, h5, h6, b, strong, .tt, .title, text');
  let words = (named?.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (!words) {
    const first = [...el.childNodes].map((n) => (n.textContent ?? '').replace(/\s+/g, ' ').trim()).find(Boolean);
    words = first ?? (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  }
  const chars = Array.from(words);
  return chars.length > 48 ? `${chars.slice(0, 47).join('').trimEnd()}…` : words;
}

export function stackFileName(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf('/');
  return i < 0 ? { name: path, dir: '' } : { name: path.slice(i + 1), dir: path.slice(0, i) };
}
