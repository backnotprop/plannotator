/**
 * Which layer of a stack wrote each line. A stack is a list of layers, bottom
 * to top, each with its own diff against the layer below; the top's new-file
 * lines are the lines a whole-stack review shows. A layer id is opaque: this
 * module knows nothing about pull requests or forges.
 *
 * What a label means: the layer whose own diff shows the line as added, and
 * no layer above it changed the line. For pull requests that is the PR whose
 * own "Files changed" shows the line: `git blame` with each PR squashed to one
 * commit, as the forge's diffs place the lines. (Commit-level blame is out of
 * reach from one diff per layer.) The module may say less than that, never
 * something false: lines it cannot follow are left unlabelled.
 *
 * What the diffs must be:
 * - Each layer's diff is what its PR shows: three-dot, from the merge base
 *   with the layer below to the layer's head (`git diff below...head`).
 * - Rename detection on, as git and the forges have it by default.
 * - `index <old>..<new>` lines kept: they prove each layer starts where the
 *   one below ended. A file changed without them gets no labels, so a patch
 *   rebuilt from GitHub's files API (`reconstructGhPatch`, which has no old
 *   blob ids) gives no labels.
 * - Refused safely (fewer labels, never wrong ones): copy detection (`-C`) is
 *   read as a rename, so a copy's source loses its labels, and a copy plus an
 *   edit to its source names the path twice, which makes the whole diff
 *   unreadable (the forges never show copies). Blob ids shorter than seven
 *   characters (`core.abbrev` below 7) do not count as `index` lines.
 *
 * Browser-safe and dependency-free. The map it builds is plain data, so a
 * server can build it and send it as JSON.
 */

import { diffHunkLines, parseDiffToFiles, stripPatchColor, type DiffHunk, type DiffHunkLine } from "./diff-files";

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
 * it wrote every line it replaced.
 */
export type StackLineRuns = Record<string, [start: number, end: number, layers: number[]][]>;

/**
 * Why lines go unlabelled beyond the usual: `stale` when some layers do not
 * start where the one below ended (update the stack to see them), and
 * `unreadable` when a diff cannot be read or lacks its `index` lines. When
 * both happen the reason is `unreadable`, since updating the stack cannot fix it.
 * A stale layer's own `+` lines keep its label; the lines below it lose theirs.
 */
export type StackGap = "stale" | "unreadable";

/**
 * Layer ids bottom to top, and the lines each one wrote. `ok`: every file was
 * followed. `partial`: some files were not (see `reason`), the rest are
 * labelled. `unavailable`: nothing is labelled, and `reason` says why.
 */
export type StackLineMap = { ids: readonly string[]; runs: StackLineRuns } & (
  | { status: "ok" }
  | { status: "partial" | "unavailable"; reason: StackGap }
);

/** The layers that wrote a line (bottom to top), and its text. */
interface Claim {
  layers: number[];
  text: string;
}

/** Path → line number → its claim, as the files stand at one layer's head. */
type Claims = Map<string, Map<number, Claim>>;

/** Path → a blob id, as the diffs' `index` lines name it. */
type Blobs = Map<string, string>;

/** How one diff changes one file. */
interface FileStep {
  /** Path before and after; null when the file is added or deleted. */
  from: string | null;
  to: string | null;
  /** Blob ids from the `index` line; null when there is none. */
  oldBlob: string | null;
  newBlob: string | null;
  binary: boolean;
  hunks: DiffHunk[];
}

/** The stack as the walk up it has seen it so far. */
interface Walk {
  claims: Claims;
  /** Each path's blob at the current layer's head, for the paths the layers changed. */
  blobs: Blobs;
  gaps: Set<StackGap>;
}

/**
 * Maps each line the review shows as added to the layers that wrote it. A
 * line a higher layer rewrote keeps the lower layer too, ahead of it, when the
 * lines it replaced were all that layer's. Renames are followed as each
 * layer's diff pairs them.
 *
 * `reviewPatch` is the whole-stack diff the person reads (or only the top
 * layer's). Only its `+` lines get runs, and a file loses them all unless its
 * content is the top layer's (by blob id) and each labelled line's text is the
 * text its layer wrote.
 */
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
  // `unreadable` first: updating the stack does not fix it.
  const reason = walk.gaps.has("unreadable") ? "unreadable" : "stale";
  return { status: Object.keys(runs).length > 0 ? "partial" : "unavailable", reason, ids, runs };
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

// ── Reading a diff ──────────────────────────────────────────────────────────

const FILE_HEADER = /^diff --git /gm;
const INDEX_LINE = /^index ([0-9a-f]{7,})\.\.([0-9a-f]{7,})/m;
const BINARY_LINE = /^(?:Binary files |GIT binary patch$)/m;

/**
 * A diff's per-file steps. Null when any of it cannot be read: a file whose
 * header or hunks do not parse, or a path changed twice.
 */
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

/** Adds a path to a set; false when it was already there. */
function addOnce(paths: Set<string>, path: string | null): boolean {
  if (path === null) return true;
  if (paths.has(path)) return false;
  paths.add(path);
  return true;
}

// ── Blob ids: each layer must start where the one below ended ───────────────

const NO_BLOB = "0000000";
const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

/** Abbreviated ids of one blob: the shorter is a prefix of the longer. */
function sameBlob(a: string, b: string): boolean {
  return a.length <= b.length ? b.startsWith(a) : a.startsWith(b);
}

function hasNoLines(blob: string): boolean {
  return sameBlob(blob, NO_BLOB) || sameBlob(blob, EMPTY_BLOB);
}

/** True when a step may change the file's lines (a pure rename or mode change does not). */
function changesLines(step: FileStep): boolean {
  return step.hunks.length > 0 || step.from === null || step.to === null || step.binary;
}

/**
 * Whether a layer's change to one file can be followed: `follow`, `forget`
 * (a binary file: no lines to follow), or the gap that stops it. `vacated`
 * holds the paths the same diff deletes or renames away: a file added at one
 * of them (a file turned symlink is a delete and an add) starts from nothing.
 */
function traceStep(blobs: Blobs, vacated: ReadonlySet<string>, step: FileStep): "follow" | "forget" | StackGap {
  if (step.oldBlob === null || step.newBlob === null) return changesLines(step) ? "unreadable" : "follow";
  const below = step.from === null && vacated.has(step.to!) ? undefined : blobs.get((step.from ?? step.to)!);
  if (below !== undefined && !sameBlob(below, step.oldBlob)) return "stale";
  if (step.binary) return "forget";
  const changedUnseen = step.hunks.length === 0 && !sameBlob(step.oldBlob, step.newBlob);
  if (changedUnseen && !(hasNoLines(step.oldBlob) && hasNoLines(step.newBlob))) return "unreadable";
  return "follow";
}

/**
 * Records each path's blob at a layer's head: a path it moved or deleted is
 * gone, a path it wrote has its new blob, unknown when the diff did not say.
 */
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

// ── Following lines up the stack ────────────────────────────────────────────

/**
 * Moves the walk up one layer: each file it changes is followed, or forgotten
 * (its lines get no labels, here or from the layers below) when it cannot be.
 */
function applyLayer(walk: Walk, steps: readonly FileStep[], layer: number): void {
  const before = walk.claims;
  const after = new Map(before);
  for (const step of steps) if (step.from !== null) after.delete(step.from);
  const vacated = new Set(steps.flatMap((step) => (step.from !== null && step.from !== step.to ? [step.from] : [])));
  for (const step of steps) {
    const verdict = traceStep(walk.blobs, vacated, step);
    if (verdict === "stale" || verdict === "unreadable") walk.gaps.add(verdict);
    if (step.to === null) continue;
    // A stale layer still wrote its own `+` lines: they are labelled, and
    // nothing from below the break is carried up or inherited.
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

/**
 * A file's claims after one layer: earlier lines carried through its hunks,
 * then its own `+` lines. Null when a line it deletes or keeps does not have
 * the text a lower layer wrote there: it is not based on the layer below.
 */
function followStep(before: ReadonlyMap<number, Claim> | undefined, step: FileStep, layer: number): Map<number, Claim> | null {
  const claims = before ?? new Map<number, Claim>();
  const lines = carryClaims(claims, step.hunks);
  if (!lines) return null;
  for (const { line, replaced } of replacements(claims, step.hunks)) {
    lines.set(line.newLine, { layers: [...replaced, layer], text: line.text });
  }
  return lines;
}

/**
 * A file's claims renumbered through a layer's hunks, in one pass over each:
 * kept lines move to their new number, deleted lines are gone. Null when a
 * kept or deleted line's text differs from its claim's.
 */
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

/**
 * Each `+` line, with the earlier layers it inherits: those of the `-` lines
 * it replaced (the same change, between context lines), and only when every
 * one of them was written by the same layers. A block rewrite or re-indent
 * over mixed lines inherits nothing.
 */
function replacements(claims: ReadonlyMap<number, Claim>, hunks: readonly DiffHunk[]): { line: AddedLine; replaced: number[] }[] {
  const out: { line: AddedLine; replaced: number[] }[] = [];
  for (const block of changeBlocks(hunks)) {
    const replaced = sharedLayers(block.flatMap((line) => (line.kind === "del" ? [claims.get(line.oldLine)] : [])));
    for (const line of block) if (line.kind === "add") out.push({ line, replaced });
  }
  return out;
}

/** The runs of `-` and `+` lines between context lines. */
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

/** The layers every claim has in common, when all of them exist and are the same; otherwise none. */
function sharedLayers(claims: readonly (Claim | undefined)[]): number[] {
  const first = claims[0];
  if (!first || claims.some((claim) => !claim || !sameLayers(claim.layers, first.layers))) return [];
  return first.layers;
}

// ── Tying the map to the review ─────────────────────────────────────────────

/** The claims on the review's `+` lines, for each file whose content is the top layer's. */
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

/**
 * Why a reviewed file cannot be tied to the stack, if it cannot: its diff has
 * no blob id, or its content is not the top layer's. A file the layers never
 * changed has no claims to tie.
 */
function reviewGap(walk: Walk, step: FileStep): StackGap | null {
  if (step.newBlob === null) return step.hunks.length > 0 ? "unreadable" : null;
  const top = walk.blobs.get(step.to!);
  return top !== undefined && !sameBlob(top, step.newBlob) ? "stale" : null;
}

/**
 * A file's claims on its reviewed `+` lines. Lines no layer wrote (base code
 * a rename carried) have none. Null when a claim's text differs from the
 * line's: the review and the stack do not line up, so nothing is kept.
 */
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

/** Claims as runs of consecutive lines with the same layers, per path, as plain data. */
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
