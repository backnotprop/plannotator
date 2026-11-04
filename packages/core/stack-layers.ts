/**
 * Which layer of a stack wrote each line. A stack is a list of layers, bottom
 * to top, each with its own diff against the layer below; the top's new-file
 * lines are the lines a whole-stack review shows. A layer id is opaque: this
 * module knows nothing about pull requests or forges.
 *
 * Its one promise: it may say less, never something false. Diffs that do not
 * chain, or that it cannot read, give no labels at all.
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

/**
 * Layer ids bottom to top, and the lines each one wrote. `unavailable` means
 * a diff could not be read or the diffs do not chain into one stack, so
 * nothing is labelled; `ok` with no runs means there was nothing to label.
 */
export interface StackLineMap {
  status: "ok" | "unavailable";
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

/** Path → the blob id the file has at one layer's head, as the diffs' `index` lines name it. */
type Blobs = Map<string, string>;

/** How one diff changes one file. */
interface FileStep {
  /** Path before and after; null when the file is added or deleted. */
  from: string | null;
  to: string | null;
  /** Blob ids from the `index` line; null when there is none (a pure rename or mode change). */
  oldBlob: string | null;
  newBlob: string | null;
  /** Its lines cannot be followed: a binary diff, or a pairing git may make another way (see `unsurePairing`). */
  untraceable: boolean;
  hunks: DiffHunk[];
}

/**
 * Maps each line the review shows as added to the layers that wrote it. A
 * line a higher layer rewrote keeps the lower layer too, ahead of it; the
 * higher layer's text is the one shown. Renames are followed.
 *
 * `reviewPatch` is the whole-stack diff the person reads. Only its `+` lines
 * get runs, and a file loses them all unless every `+` line was written by a
 * layer with the same text, in a file whose content matches the top layer's.
 */
export function mapStackLines(layers: readonly StackLayer[], check: { reviewPatch: string }): StackLineMap {
  const ids = layers.map((layer) => layer.id);
  const unavailable: StackLineMap = { status: "unavailable", ids, runs: {} };
  let claims: Claims = new Map();
  let blobs: Blobs = new Map();
  for (const [index, layer] of layers.entries()) {
    const steps = fileSteps(layer.patch);
    if (!steps || !chainHolds(blobs, steps)) return unavailable;
    const next = applyLayer(claims, steps, index);
    if (!next) return unavailable;
    claims = next;
    blobs = nextBlobs(blobs, steps);
  }
  const review = fileSteps(check.reviewPatch);
  if (!review) return unavailable;
  return { status: "ok", ids, runs: toRuns(keepReviewedLines(claims, blobs, review)) };
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

const INDEX_LINE = /^index ([0-9a-f]{7,})\.\.([0-9a-f]{7,})/m;
const BINARY_LINE = /^(?:Binary files |GIT binary patch$)/m;

/** A diff's per-file steps, or null when it cannot be read or changes a path twice. */
function fileSteps(patch: string): FileStep[] | null {
  const files = parseDiffToFiles(patch);
  if (files.length === 0 && patch.trim() !== "") return null;
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
      untraceable: hunks.length === 0 && BINARY_LINE.test(file.patch),
      hunks,
    };
    if (!addOnce(froms, step.from) || !addOnce(tos, step.to)) return null;
    steps.push(step);
  }
  return steps.map((step) => (unsurePairing(step, steps) ? { ...step, untraceable: true } : step));
}

/**
 * True when git could pair a new path with a different old one than this diff
 * did. Rename detection is a heuristic: a whole diff pairs paths as a set, but
 * `git blame` looks for each file's source alone, and the two can disagree
 * once a layer offers a choice. A rename is unsure when the layer removes
 * another path it could come from; an added file is unsure when a rename in
 * the layer took a source it could have come from.
 */
function unsurePairing(step: FileStep, steps: readonly FileStep[]): boolean {
  const moved = (s: FileStep) => s.from !== null && s.to !== null && s.from !== s.to;
  const removedPaths = steps.filter((s) => s.from !== null && s.from !== s.to).length;
  if (moved(step)) return removedPaths > 1;
  return step.from === null && steps.some(moved);
}

/** Adds a path to a set; false when it was already there. */
function addOnce(paths: Set<string>, path: string | null): boolean {
  if (path === null) return true;
  if (paths.has(path)) return false;
  paths.add(path);
  return true;
}

// ── The blob chain: each layer must start where the one below ended ─────────

/** Abbreviated ids of one blob: the shorter is a prefix of the longer. */
function sameBlob(a: string, b: string): boolean {
  return a.length <= b.length ? b.startsWith(a) : a.startsWith(b);
}

/** True when every file a layer changes starts from the blob the layers below left it at. */
function chainHolds(blobs: Blobs, steps: readonly FileStep[]): boolean {
  return steps.every((step) => {
    const known = blobs.get((step.from ?? step.to)!);
    return known === undefined || step.oldBlob === null || sameBlob(known, step.oldBlob);
  });
}

const NO_BLOB = "0000000";

/** The blobs after one layer: a path it moved or deleted is gone, a path it wrote has its new blob. */
function nextBlobs(blobs: Blobs, steps: readonly FileStep[]): Blobs {
  const after = new Map(blobs);
  for (const step of steps) if (step.from !== null && step.from !== step.to) after.set(step.from, NO_BLOB);
  for (const step of steps) {
    if (step.to === null) continue;
    const blob = step.newBlob ?? (step.from === null ? undefined : blobs.get(step.from));
    if (blob === undefined) after.delete(step.to);
    else after.set(step.to, blob);
  }
  return after;
}

// ── Following lines up the stack ────────────────────────────────────────────

/**
 * The claims after one layer: earlier lines carried through its hunks, then
 * its own `+` lines. Null when a line the layer deletes or keeps does not have
 * the text a lower layer wrote there: the layer is not based on the one below.
 */
function applyLayer(before: Claims, steps: readonly FileStep[], layer: number): Claims | null {
  const after = new Map(before);
  for (const step of steps) if (step.from !== null) after.delete(step.from);
  for (const step of steps) {
    if (step.to === null) continue;
    if (step.untraceable) {
      after.set(step.to, new Map());
      continue;
    }
    const old = (step.from === null ? undefined : before.get(step.from)) ?? new Map<number, Claim>();
    const lines = carryClaims(old, step.hunks);
    if (!lines) return null;
    for (const { line, replaced } of replacements(old, step.hunks)) {
      lines.set(line.newLine, { layers: [...replaced, layer], text: line.text });
    }
    after.set(step.to, lines);
  }
  return after;
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
 * Each `+` line, with the layers that wrote the `-` lines it replaced: those
 * in the same change, between the nearest context lines.
 */
function replacements(claims: ReadonlyMap<number, Claim>, hunks: readonly DiffHunk[]): { line: AddedLine; replaced: number[] }[] {
  const out: { line: AddedLine; replaced: number[] }[] = [];
  for (const hunk of hunks) {
    const replaced = new Set<number>();
    for (const line of hunk.lines) {
      if (line.kind === "context") replaced.clear();
      else if (line.kind === "del") for (const layer of claims.get(line.oldLine)?.layers ?? []) replaced.add(layer);
      else out.push({ line, replaced: [...replaced].sort((a, b) => a - b) });
    }
  }
  return out;
}

// ── Tying the map to the review ─────────────────────────────────────────────

/** The claims on the review's `+` lines, for each file that passes the check. */
function keepReviewedLines(claims: Claims, blobs: Blobs, review: readonly FileStep[]): Claims {
  const kept: Claims = new Map();
  for (const step of review) {
    if (step.to === null) continue;
    const top = blobs.get(step.to);
    if (top !== undefined && step.newBlob !== null && !sameBlob(top, step.newBlob)) continue;
    const lines = reviewedClaims(claims.get(step.to), step.hunks);
    if (lines) kept.set(step.to, lines);
  }
  return kept;
}

/** A file's claims on its reviewed `+` lines, or null when one of them was not written by a layer with that text. */
function reviewedClaims(claims: ReadonlyMap<number, Claim> | undefined, hunks: readonly DiffHunk[]): Map<number, Claim> | null {
  const kept = new Map<number, Claim>();
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind !== "add") continue;
      const claim = claims?.get(line.newLine);
      if (claim?.text !== line.text) return null;
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
