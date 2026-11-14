// Safety net. Pierre's semantic view draws only lines that operations own.
// Any line our line diff (the one handed to Pierre as the patch) marks as
// changed but no operation owns would look unchanged, so it gets a plain
// added/deleted operation here. This runs last and guarantees full coverage.
import type { SemanticDiffLineRange, SemanticDiffOperation } from './pierre-types.ts';
import type { ChangeBlock } from './linediff.ts';
import { range } from './syntax.ts';

/** `inString`: blank lines inside multi-line strings, which are content, not spacing. */
export function uncoveredChanges(
  blocks: ChangeBlock[],
  oldText: string,
  newText: string,
  ops: SemanticDiffOperation[],
  inString: { old: Set<number>; new: Set<number> } = { old: new Set(), new: new Set() }
): SemanticDiffOperation[] {
  const owned = { old: new Set<number>(), new: new Set<number>() };
  for (const op of ops) for (const side of ['old', 'new'] as const) for (const l of op.lines[side]) for (let n = l.start; n <= l.end; n++) owned[side].add(n);
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const missing: Array<{ side: 'old' | 'new'; line: number; other: number }> = [];
  for (const b of blocks) {
    if (b.old) for (let l = b.old.start; l <= b.old.end; l++) if (((oldLines[l - 1] ?? '').trim() || inString.old.has(l)) && !owned.old.has(l)) missing.push({ side: 'old', line: l, other: b.new?.start ?? b.newAt });
    if (b.new) for (let l = b.new.start; l <= b.new.end; l++) if (((newLines[l - 1] ?? '').trim() || inString.new.has(l)) && !owned.new.has(l)) missing.push({ side: 'new', line: l, other: b.old?.start ?? b.oldAt });
  }
  // Consecutive lines on one side become one operation.
  const out: SemanticDiffOperation[] = [];
  const newCount = Math.max(1, newText.split('\n').length - (newText.endsWith('\n') ? 1 : 0));
  const oldCount = Math.max(1, oldText.split('\n').length - (oldText.endsWith('\n') ? 1 : 0));
  for (let i = 0; i < missing.length; ) {
    const first = missing[i]!;
    let j = i;
    while (j + 1 < missing.length && missing[j + 1]!.side === first.side && missing[j + 1]!.line === missing[j]!.line + 1) j++;
    const last = missing[j]!;
    const lines = { start: first.line, end: last.line };
    const otherCount = first.side === 'old' ? newCount : oldCount;
    const attach: SemanticDiffLineRange['attachment'] =
      first.other <= otherCount ? { line: first.other, edge: 'before' } : { line: otherCount, edge: 'after' };
    const r = range({ line: lines.start, character: 0 }, { line: lines.end + 1, character: 0 });
    out.push(
      first.side === 'old'
        ? { type: 'deleted', spans: [{ role: 'root', relation: 'removed', old: [r] }], lines: { old: [{ ...lines, spanIndex: 0, attachment: attach }], new: [] } }
        : { type: 'added', spans: [{ role: 'root', relation: 'introduced', new: [r] }], lines: { old: [], new: [{ ...lines, spanIndex: 0, attachment: attach }] } }
    );
    i = j + 1;
  }
  return out;
}
