import { diffHunkLines, parseDiffToFiles, stripPatchColor, type DiffHunk, type DiffHunkLine } from "./diff-files";

export interface StackLayer {
  id: string;
  patch: string;
}

export interface LineSpan {
  path: string;
  start: number;
  end: number;
}

export type LineOrigin = { kind: "layer"; id: string } | { kind: "several"; ids: string[] } | { kind: "unknown" };

export type StackLineRuns = Record<string, [start: number, end: number, layers: number[]][]>;

export type StackGap = "stale" | "unreadable";

export type StackLineMap = { ids: readonly string[]; runs: StackLineRuns } & (
  | { status: "ok" }
  | { status: "partial" | "unavailable"; reason: StackGap }
);

interface Claim {
  layers: number[];
  text: string;
}

type Claims = Map<string, Map<number, Claim>>;

type Blobs = Map<string, string>;

interface FileStep {
  from: string | null;
  to: string | null;
  oldBlob: string | null;
  newBlob: string | null;
  binary: boolean;
  hunks: DiffHunk[];
}

interface Walk {
  claims: Claims;
  blobs: Blobs;
  gaps: Set<StackGap>;
}

export function mapStackLines(layers: readonly StackLayer[], check: { reviewPatch: string }): StackLineMap {
  const ids = layers.map((layer) => layer.id);
  const unreadable: StackLineMap = { status: "unavailable", reason: "unreadable", ids, runs: {} };
  const walk: Walk = { claims: new Map(), blobs: new Map(), gaps: new Set() };
  for (const [index, layer] of layers.entries()) {
    const steps = fileSteps(layer.patch);
    if (!steps) return unreadable;
    applyLayer(walk, steps, index);
  }
  const review = fileSteps(check.reviewPatch);
  if (!review) return unreadable;
  const runs = toRuns(keepReviewedLines(walk, review));
  if (walk.gaps.size === 0) return { status: "ok", ids, runs };
  const reason = walk.gaps.has("unreadable") ? "unreadable" : "stale";
  return { status: Object.keys(runs).length > 0 ? "partial" : "unavailable", reason, ids, runs };
}

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

const FILE_HEADER = /^diff --git /gm;
const INDEX_LINE = /^index ([0-9a-f]{7,})\.\.([0-9a-f]{7,})/m;
const BINARY_LINE = /^(?:Binary files |GIT binary patch$)/m;

function fileSteps(patch: string): FileStep[] | null {
  const files = parseDiffToFiles(patch);
  const headers = stripPatchColor(patch).match(FILE_HEADER)?.length ?? 0;
  if (files.length !== headers || (headers === 0 && patch.trim() !== "")) return null;
  const steps: FileStep[] = [];
  const froms = new Set<string>();
  const tos = new Set<string>();
  for (const file of files) {
    const hunks = diffHunkLines(file.patch);
    if (!hunks) return null;
    const blobs = INDEX_LINE.exec(file.patch);
    const step: FileStep = {
      from: file.status === "added" ? null : (file.oldPath ?? file.path),
      to: file.status === "deleted" ? null : file.path,
      oldBlob: blobs?.[1] ?? null,
      newBlob: blobs?.[2] ?? null,
      binary: hunks.length === 0 && BINARY_LINE.test(file.patch),
      hunks,
    };
    if (!addOnce(froms, step.from) || !addOnce(tos, step.to)) return null;
    steps.push(step);
  }
  return steps;
}

function addOnce(paths: Set<string>, path: string | null): boolean {
  if (path === null) return true;
  if (paths.has(path)) return false;
  paths.add(path);
  return true;
}

const NO_BLOB = "0000000";
const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

function sameBlob(a: string, b: string): boolean {
  return a.length <= b.length ? b.startsWith(a) : a.startsWith(b);
}

function hasNoLines(blob: string): boolean {
  return sameBlob(blob, NO_BLOB) || sameBlob(blob, EMPTY_BLOB);
}

function changesLines(step: FileStep): boolean {
  return step.hunks.length > 0 || step.from === null || step.to === null || step.binary;
}

function traceStep(blobs: Blobs, vacated: ReadonlySet<string>, step: FileStep): "follow" | "forget" | StackGap {
  if (step.oldBlob === null || step.newBlob === null) return changesLines(step) ? "unreadable" : "follow";
  const below = step.from === null && vacated.has(step.to!) ? undefined : blobs.get((step.from ?? step.to)!);
  if (below !== undefined && !sameBlob(below, step.oldBlob)) return "stale";
  if (step.binary) return "forget";
  const changedUnseen = step.hunks.length === 0 && !sameBlob(step.oldBlob, step.newBlob);
  if (changedUnseen && !(hasNoLines(step.oldBlob) && hasNoLines(step.newBlob))) return "unreadable";
  return "follow";
}

function recordBlobs(walk: Walk, steps: readonly FileStep[]): void {
  const after = new Map(walk.blobs);
  for (const step of steps) if (step.from !== null && step.from !== step.to) after.set(step.from, NO_BLOB);
  for (const step of steps) {
    if (step.to === null) continue;
    const kept = step.from === null || changesLines(step) ? undefined : walk.blobs.get(step.from);
    const blob = step.newBlob ?? kept;
    if (blob === undefined) after.delete(step.to);
    else after.set(step.to, blob);
  }
  walk.blobs = after;
}

function applyLayer(walk: Walk, steps: readonly FileStep[], layer: number): void {
  const before = walk.claims;
  const after = new Map(before);
  for (const step of steps) if (step.from !== null) after.delete(step.from);
  const vacated = new Set(steps.flatMap((step) => (step.from !== null && step.from !== step.to ? [step.from] : [])));
  for (const step of steps) {
    const verdict = traceStep(walk.blobs, vacated, step);
    if (verdict === "stale" || verdict === "unreadable") walk.gaps.add(verdict);
    if (step.to === null) continue;
    const lines =
      verdict === "follow"
        ? followStep(step.from === null ? undefined : before.get(step.from), step, layer)
        : verdict === "stale" && !step.binary
          ? followStep(undefined, step, layer)
          : null;
    if (verdict === "follow" && !lines) walk.gaps.add("stale");
    after.set(step.to, lines ?? new Map());
  }
  walk.claims = after;
  recordBlobs(walk, steps);
}

function followStep(before: ReadonlyMap<number, Claim> | undefined, step: FileStep, layer: number): Map<number, Claim> | null {
  const claims = before ?? new Map<number, Claim>();
  const lines = carryClaims(claims, step.hunks);
  if (!lines) return null;
  for (const { line, replaced } of replacements(claims, step.hunks)) {
    lines.set(line.newLine, { layers: [...replaced, layer], text: line.text });
  }
  return lines;
}

function carryClaims(claims: ReadonlyMap<number, Claim>, hunks: readonly DiffHunk[]): Map<number, Claim> | null {
  const carried = new Map<number, Claim>();
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") continue;
      const claim = claims.get(line.oldLine);
      if (!claim) continue;
      if (claim.text !== line.text) return null;
      if (line.kind === "context") carried.set(line.newLine, claim);
    }
  }
  let next = 0;
  let shift = 0;
  for (const line of [...claims.keys()].sort((a, b) => a - b)) {
    while (next < hunks.length && hunks[next].oldEnd <= line) {
      shift = hunks[next].newEnd - hunks[next].oldEnd;
      next += 1;
    }
    const inHunk = next < hunks.length && line >= hunks[next].oldStart;
    if (!inHunk) carried.set(line + shift, claims.get(line)!);
  }
  return carried;
}

type AddedLine = Extract<DiffHunkLine, { kind: "add" }>;

function replacements(claims: ReadonlyMap<number, Claim>, hunks: readonly DiffHunk[]): { line: AddedLine; replaced: number[] }[] {
  const out: { line: AddedLine; replaced: number[] }[] = [];
  for (const block of changeBlocks(hunks)) {
    const replaced = sharedLayers(block.flatMap((line) => (line.kind === "del" ? [claims.get(line.oldLine)] : [])));
    for (const line of block) if (line.kind === "add") out.push({ line, replaced });
  }
  return out;
}

function changeBlocks(hunks: readonly DiffHunk[]): DiffHunkLine[][] {
  const blocks: DiffHunkLine[][] = [];
  for (const hunk of hunks) {
    let block: DiffHunkLine[] = [];
    for (const line of hunk.lines) {
      if (line.kind !== "context") block.push(line);
      else if (block.length > 0) {
        blocks.push(block);
        block = [];
      }
    }
    if (block.length > 0) blocks.push(block);
  }
  return blocks;
}

function sharedLayers(claims: readonly (Claim | undefined)[]): number[] {
  const first = claims[0];
  if (!first || claims.some((claim) => !claim || !sameLayers(claim.layers, first.layers))) return [];
  return first.layers;
}

function keepReviewedLines(walk: Walk, review: readonly FileStep[]): Claims {
  const kept: Claims = new Map();
  for (const step of review) {
    if (step.to === null) continue;
    const gap = reviewGap(walk, step);
    if (gap) {
      walk.gaps.add(gap);
      continue;
    }
    const lines = reviewedClaims(walk.claims.get(step.to), step.hunks);
    if (lines) kept.set(step.to, lines);
  }
  return kept;
}

function reviewGap(walk: Walk, step: FileStep): StackGap | null {
  if (step.newBlob === null) return step.hunks.length > 0 ? "unreadable" : null;
  const top = walk.blobs.get(step.to!);
  return top !== undefined && !sameBlob(top, step.newBlob) ? "stale" : null;
}

function reviewedClaims(claims: ReadonlyMap<number, Claim> | undefined, hunks: readonly DiffHunk[]): Map<number, Claim> | null {
  const kept = new Map<number, Claim>();
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind !== "add") continue;
      const claim = claims?.get(line.newLine);
      if (!claim) continue;
      if (claim.text !== line.text) return null;
      kept.set(line.newLine, claim);
    }
  }
  return kept;
}

function toRuns(claims: Claims): StackLineRuns {
  const entries: [string, StackLineRuns[string]][] = [];
  for (const [path, lines] of claims) {
    const runs = linesToRuns(lines);
    if (runs.length > 0) entries.push([path, runs]);
  }
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
