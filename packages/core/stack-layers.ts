/**
 * Which layer of a stack wrote each line. A stack is a list of layers, bottom
 * to top, each with its own diff against the layer below; the top's new-file
 * lines are the lines a whole-stack review shows. A layer id is opaque: this
 * module knows nothing about pull requests or forges.
 *
 * Browser-safe and dependency-free. The map it builds is plain data, so a
 * server can build it and send it as JSON.
 */

import { diffHunkLines, parseDiffToFiles, type DiffHunk, type DiffHunkLine } from "./diff-files";

/** One layer of a stack: its id and its own diff. */
export interface StackLayer {
  id: string;
  patch: string;
}

/** New-file lines `start..end` (inclusive) of one file in the whole-stack diff. */
export interface LineSpan {
  path: string;
  start: number;
  end: number;
}

export type LineOrigin = { kind: "layer"; id: string } | { kind: "several"; ids: string[] } | { kind: "unknown" };

/**
 * Per path, runs of consecutive lines with the same layers (indexes into
 * `ids`, bottom to top). The last layer wrote the text shown; the ones before
 * it wrote the lines it replaced.
 */
export type StackLineRuns = Record<string, [start: number, end: number, layers: number[]][]>;

/** Layer ids bottom to top, and the lines each one wrote. */
export interface StackLineMap {
  ids: readonly string[];
  runs: StackLineRuns;
}

/** The layers that wrote a line (bottom to top), and its text. */
interface Claim {
  layers: number[];
  text: string;
}

/** Path → line number → its claim, as the files stand at one layer's head. */
type Claims = Map<string, Map<number, Claim>>;

/** How one diff changes one file: its path before and after (null when added or deleted), and its hunks. */
interface FileStep {
  from: string | null;
  to: string | null;
  hunks: DiffHunk[];
}

/**
 * Maps each line at the top of the stack to the layers that wrote it. A line
 * a higher layer rewrote keeps the lower layer too, ahead of it, and the
 * higher layer's text is the one shown. Renames are followed; lines no layer
 * wrote get no run.
 *
 * With `check`, the result is tied to the review's own diff: only its `+`
 * lines keep their runs, and a file loses them all unless every `+` line was
 * written by a layer with the same text. A patch that cannot be read gives an
 * empty map, never a partial one.
 */
export function mapStackLines(layers: readonly StackLayer[], check?: { reviewPatch: string }): StackLineMap {
  const ids = layers.map((layer) => layer.id);
  const unknown: StackLineMap = { ids, runs: {} };
  let claims: Claims = new Map();
  for (const [index, layer] of layers.entries()) {
    const steps = fileSteps(layer.patch);
    if (!steps) return unknown;
    claims = applyLayer(claims, steps, index);
  }
  if (check) {
    const reviewed = keepReviewedLines(claims, check.reviewPatch);
    if (!reviewed) return unknown;
    claims = reviewed;
  }
  return { ids, runs: toRuns(claims) };
}

/** Every layer that wrote lines in a span: one, several (bottom to top), or none known. */
export function lineOrigin(map: StackLineMap, span: LineSpan): LineOrigin {
  const runs = Object.hasOwn(map.runs, span.path) ? map.runs[span.path] : [];
  const layers = new Set<number>();
  for (const [start, end, written] of runs) {
    if (start <= span.end && end >= span.start) for (const layer of written) layers.add(layer);
  }
  const ids = [...layers]
    .sort((a, b) => a - b)
    .map((layer) => map.ids[layer])
    .filter((id) => id !== undefined);
  if (ids.length === 0) return { kind: "unknown" };
  if (ids.length === 1) return { kind: "layer", id: ids[0] };
  return { kind: "several", ids };
}

/** A diff's per-file steps, or null when it cannot be read. */
function fileSteps(patch: string): FileStep[] | null {
  const files = parseDiffToFiles(patch);
  if (files.length === 0 && patch.trim() !== "") return null;
  const steps: FileStep[] = [];
  for (const file of files) {
    const hunks = diffHunkLines(file.patch);
    if (!hunks) return null;
    steps.push({
      from: file.status === "added" ? null : (file.oldPath ?? file.path),
      to: file.status === "deleted" ? null : file.path,
      hunks,
    });
  }
  return steps;
}

/** The claims after one layer: earlier lines carried through its hunks, then its own `+` lines. */
function applyLayer(before: Claims, steps: readonly FileStep[], layer: number): Claims {
  const after = new Map(before);
  for (const step of steps) if (step.from !== null) after.delete(step.from);
  for (const step of steps) {
    if (step.to === null) continue;
    const old = step.from === null ? undefined : before.get(step.from);
    const lines = carryClaims(old, step.hunks);
    for (const { line, replaced } of replacements(old, step.hunks)) {
      lines.set(line.newLine, { layers: [...replaced, layer], text: line.text });
    }
    after.set(step.to, lines);
  }
  return after;
}

/**
 * Each `+` line, with the layers that wrote the `-` lines it replaced: those
 * in the same change, between the nearest context lines.
 */
function replacements(claims: ReadonlyMap<number, Claim> | undefined, hunks: readonly DiffHunk[]) {
  const out: { line: AddedLine; replaced: number[] }[] = [];
  for (const hunk of hunks) {
    const replaced = new Set<number>();
    for (const line of hunk.lines) {
      if (line.kind === "context") replaced.clear();
      else if (line.kind === "del") for (const layer of claims?.get(line.oldLine)?.layers ?? []) replaced.add(layer);
      else out.push({ line, replaced: [...replaced].sort((a, b) => a - b) });
    }
  }
  return out;
}

/** A file's claims renumbered through a layer's hunks; lines it deleted are gone. */
function carryClaims(claims: ReadonlyMap<number, Claim> | undefined, hunks: readonly DiffHunk[]): Map<number, Claim> {
  const carried = new Map<number, Claim>();
  for (const [line, claim] of claims ?? []) {
    const moved = newLineOf(line, hunks);
    if (moved !== null) carried.set(moved, claim);
  }
  return carried;
}

/** Where an old line lands on the new side, or null when the hunks delete it. */
function newLineOf(oldLine: number, hunks: readonly DiffHunk[]): number | null {
  let shift = 0;
  for (const hunk of hunks) {
    if (oldLine < hunk.oldStart) break;
    if (oldLine < hunk.oldEnd) {
      const kept = hunk.lines.find((line) => line.kind === "context" && line.oldLine === oldLine);
      return kept?.kind === "context" ? kept.newLine : null;
    }
    shift = hunk.newEnd - hunk.oldEnd;
  }
  return oldLine + shift;
}

type AddedLine = Extract<DiffHunkLine, { kind: "add" }>;

function addedLines(hunks: readonly DiffHunk[]): AddedLine[] {
  return hunks.flatMap((hunk) => hunk.lines.filter((line): line is AddedLine => line.kind === "add"));
}

/** The claims on the review's `+` lines, file by file; null when the review cannot be read. */
function keepReviewedLines(claims: Claims, reviewPatch: string): Claims | null {
  const steps = fileSteps(reviewPatch);
  if (!steps) return null;
  const kept: Claims = new Map();
  for (const step of steps) {
    if (step.to === null) continue;
    const lines = reviewedClaims(claims.get(step.to), step.hunks);
    if (lines) kept.set(step.to, lines);
  }
  return kept;
}

/** A file's claims on its reviewed `+` lines, or null when one of them was not written by a layer with that text. */
function reviewedClaims(claims: ReadonlyMap<number, Claim> | undefined, hunks: readonly DiffHunk[]): Map<number, Claim> | null {
  const kept = new Map<number, Claim>();
  for (const line of addedLines(hunks)) {
    const claim = claims?.get(line.newLine);
    if (claim?.text !== line.text) return null;
    kept.set(line.newLine, claim);
  }
  return kept;
}

/** Claims as runs of consecutive lines from one layer, per path, as plain data. */
function toRuns(claims: Claims): StackLineRuns {
  const entries: [string, StackLineRuns[string]][] = [];
  for (const [path, lines] of claims) {
    const runs = linesToRuns(lines);
    if (runs.length > 0) entries.push([path, runs]);
  }
  // fromEntries defines own keys, so a path like `__proto__` stays a path.
  return Object.fromEntries(entries);
}

function linesToRuns(lines: ReadonlyMap<number, Claim>): StackLineRuns[string] {
  const runs: StackLineRuns[string] = [];
  for (const line of [...lines.keys()].sort((a, b) => a - b)) {
    const { layers } = lines.get(line)!;
    const last = runs.at(-1);
    if (last && last[1] === line - 1 && sameLayers(last[2], layers)) last[1] = line;
    else runs.push([line, line, layers]);
  }
  return runs;
}

function sameLayers(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((layer, i) => layer === b[i]);
}
