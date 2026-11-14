// A line diff that knows about declarations. Plain line diffs (Myers, as in
// git or jsdiff) maximise matched lines anywhere, so when a loop is extracted
// into a new function they keep the loop "in place" and report the caller's
// untouched tail as new. Here, declarations paired across versions (same kind
// and name, kept in order) anchor the diff: each pair is diffed on its own,
// recursively through class members, and only the gaps between anchors are
// diffed freely.
import { diffArrays } from 'diff';
import type { Node } from 'web-tree-sitter';
import type { LanguageConfig } from './parse.ts';
import { attachedAbove, endLine, keepWeights, longestInOrder, pairSameNamed, startLine, tokens } from './syntax.ts';

/** A run of changed lines; one side is null for a pure insertion or deletion. */
export interface ChangeBlock {
  old: { start: number; end: number } | null;
  new: { start: number; end: number } | null;
  /** Line before which the block sits on each side (for placement when one side is empty). */
  oldAt: number;
  newAt: number;
}

interface Region {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

function anchors(oldContainer: Node, newContainer: Node, cfg: LanguageConfig): Array<{ a: Node; b: Node; members?: [Node, Node] }> {
  const keyed = (container: Node) => {
    const seen = new Map<string, number>();
    return cfg.declarationsIn(container).map((d) => {
      const accessor = d.node.children.find((c) => c?.type === 'get' || c?.type === 'set')?.type ?? '';
      const base = `${d.kind}:${accessor}${d.name}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return { key: n ? `${base}#${n}` : base, d };
    });
  };
  // Same pairing as the move detector: repeated names pair by similarity.
  const base = (x: { key: string }) => x.key.replace(/#\d+$/, '');
  const pairs = pairSameNamed(keyed(oldContainer), keyed(newContainer), base, (x) => [...(attachedAbove(x.d.node, cfg.attachedTypes).match(/\S+/g) ?? []), ...tokens(x.d.node)])
    .map(([o, n]) => ({ a: o.d, b: n.d }))
    .sort((x, y) => x.a.node.startIndex - y.a.node.startIndex);
  // Keep the longest run whose order is the same on both sides (the same choice the move detector makes).
  const seq = pairs.map((p) => p.b.node.startIndex);
  const keep = [...longestInOrder(seq, keepWeights(seq, pairs.map((p) => endLine(p.a.node) - startLine(p.a.node) + 1)))].sort((x, y) => x - y);
  return keep.map((i) => {
    const { a, b } = pairs[i]!;
    return { a: a.node, b: b.node, ...(a.members && b.members ? { members: [a.members, b.members] as [Node, Node] } : {}) };
  });
}

/**
 * A file's lines for diffing: the real lines only (no empty entry after a final
 * newline), with a missing final newline marked on the last line, so that adding or
 * removing it is a change and the patch can say so.
 */
export const NO_FINAL_NEWLINE = '\u0000no-newline';
export function diffLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  else lines[lines.length - 1] += NO_FINAL_NEWLINE;
  return lines;
}

/** Lines as `diffLines` gives them (see there). */
export function alignedLineDiff(oldRoot: Node, newRoot: Node, cfg: LanguageConfig, oldLines: string[], newLines: string[]): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];

  /** Free diff of a region (1-based inclusive lines; may be empty). */
  const freeDiff = (r: Region) => {
    if (r.oldStart > r.oldEnd && r.newStart > r.newEnd) return;
    const a = oldLines.slice(r.oldStart - 1, Math.max(r.oldStart - 1, r.oldEnd));
    const b = newLines.slice(r.newStart - 1, Math.max(r.newStart - 1, r.newEnd));
    let o = r.oldStart;
    let n = r.newStart;
    let open: ChangeBlock | null = null;
    for (const part of diffArrays(a, b)) {
      const count = part.count ?? part.value.length;
      if (!part.added && !part.removed) {
        open = null;
        o += count;
        n += count;
        continue;
      }
      if (!open) {
        open = { old: null, new: null, oldAt: o, newAt: n };
        blocks.push(open);
      }
      if (part.removed) {
        open.old = { start: o, end: o + count - 1 };
        o += count;
      } else {
        open.new = { start: n, end: n + count - 1 };
        n += count;
      }
    }
  };

  /** Diff a region, anchoring on declarations paired inside `containers`. */
  const anchored = (r: Region, containers: [Node, Node] | null) => {
    const pairs = containers ? anchors(containers[0], containers[1], cfg) : [];
    let o = r.oldStart;
    let n = r.newStart;
    for (const p of pairs) {
      // Half-written code can end past the last line (the parser supplies a missing `}`).
      const ps: Region = {
        oldStart: startLine(p.a),
        oldEnd: Math.min(endLine(p.a), oldLines.length),
        newStart: startLine(p.b),
        newEnd: Math.min(endLine(p.b), newLines.length),
      };
      if (ps.oldStart > oldLines.length || ps.newStart > newLines.length) continue;
      if (ps.oldStart < o || ps.newStart < n) continue; // overlaps a previous anchor (e.g. two declarations on one line)
      freeDiff({ oldStart: o, oldEnd: ps.oldStart - 1, newStart: n, newEnd: ps.newStart - 1 });
      if (p.members) anchored(ps, p.members);
      else freeDiff(ps);
      o = ps.oldEnd + 1;
      n = ps.newEnd + 1;
    }
    freeDiff({ oldStart: o, oldEnd: r.oldEnd, newStart: n, newEnd: r.newEnd });
  };

  anchored({ oldStart: 1, oldEnd: oldLines.length, newStart: 1, newEnd: newLines.length }, [oldRoot, newRoot]);
  return blocks;
}

/** Unified diff text for the blocks, the format Pierre's `processFile` reads. */
export function toPatch(name: string, blocks: ChangeBlock[], oldLines: string[], newLines: string[], context = 3): string {
  const oldCount = oldLines.length;
  // git's header form, so readers strip the a/ and b/ prefixes and see one file.
  const out = [`diff --git a/${name} b/${name}`, `--- a/${name}`, `+++ b/${name}`];
  // Merge blocks whose context would touch into hunks.
  let i = 0;
  while (i < blocks.length) {
    let j = i;
    const startO = (b: ChangeBlock) => b.old?.start ?? b.oldAt;
    const endO = (b: ChangeBlock) => (b.old ? b.old.end : b.oldAt - 1);
    while (j + 1 < blocks.length && startO(blocks[j + 1]!) - endO(blocks[j]!) - 1 <= 2 * context) j++;
    const first = blocks[i]!;
    const hunkOldStart = Math.max(1, startO(first) - context);
    const lead = startO(first) - hunkOldStart;
    const hunkNewStart = (first.new?.start ?? first.newAt) - lead;
    const lines: string[] = [];
    let o = hunkOldStart;
    let n = hunkNewStart;
    for (let k = i; k <= j; k++) {
      const b = blocks[k]!;
      while (o < startO(b)) {
        lines.push(' ' + (oldLines[o - 1] ?? ''));
        o++;
        n++;
      }
      if (b.old) for (let l = b.old.start; l <= b.old.end; l++, o++) lines.push('-' + (oldLines[l - 1] ?? ''));
      if (b.new) for (let l = b.new.start; l <= b.new.end; l++, n++) lines.push('+' + (newLines[l - 1] ?? ''));
    }
    const trailEnd = Math.min(oldCount, o - 1 + context);
    while (o <= trailEnd) {
      lines.push(' ' + (oldLines[o - 1] ?? ''));
      o++;
      n++;
    }
    const oldLen = lines.filter((l) => l[0] !== '+').length;
    const newLen = lines.filter((l) => l[0] !== '-').length;
    out.push(`@@ -${oldLen ? hunkOldStart : hunkOldStart - 1},${oldLen} +${newLen ? hunkNewStart : hunkNewStart - 1},${newLen} @@`, ...lines);
    i = j + 1;
  }
  // git's marker for a last line without a newline, right after that line.
  return out.flatMap((l) => (l.endsWith(NO_FINAL_NEWLINE) ? [l.slice(0, -NO_FINAL_NEWLINE.length), '\\ No newline at end of file'] : [l])).join('\n') + '\n';
}
