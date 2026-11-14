// Output rules every result must keep, whatever the input. Used by the tests and
// by bench scripts. Returns a list of broken rules (empty when all hold).
import { applyPatch } from 'diff';
import type { SemanticFileDiff } from '../src/index.ts';

export function brokenRules(oldText: string, newText: string, r: SemanticFileDiff): string[] {
  const out: string[] = [];
  if (applyPatch(oldText, r.patch) !== newText) out.push('patch does not rebuild the new file');
  // Real lines: an empty file has none, and a final newline does not start another.
  const lines = (t: string) => (t === '' ? 0 : t.split('\n').length - (t.endsWith('\n') ? 1 : 0));
  const count = { old: lines(oldText), new: lines(newText) };
  const owner = { old: new Map<number, number>(), new: new Map<number, number>() };
  r.semanticOperations.forEach((op, i) => {
    if (!op.lines.old.length && !op.lines.new.length) out.push(`op ${i} (${op.type}) owns no lines`);
    for (const side of ['old', 'new'] as const) {
      for (const l of op.lines[side]) {
        if (l.start > l.end) out.push(`op ${i} (${op.type}) ${side} range ${l.start}-${l.end} runs backwards`);
        if (l.start < 1 || l.end > count[side]) out.push(`op ${i} (${op.type}) ${side} range ${l.start}-${l.end} outside the file (${count[side]} lines)`);
        if (l.spanIndex < 0 || l.spanIndex >= op.spans.length) out.push(`op ${i} (${op.type}) points at span ${l.spanIndex} of ${op.spans.length}`);
        for (let n = l.start; n <= l.end; n++) {
          const prev = owner[side].get(n);
          if (prev !== undefined && prev !== i) out.push(`${side} line ${n} owned by op ${prev} and op ${i}`);
          owner[side].set(n, i);
        }
      }
    }
    for (const [k, span] of op.spans.entries()) {
      for (const side of ['old', 'new'] as const) {
        for (const rg of (span as { old?: Array<{ start: { line: number; character: number }; end: { line: number; character: number } }>; new?: Array<{ start: { line: number; character: number }; end: { line: number; character: number } }> })[side] ?? []) {
          const backwards = rg.start.line > rg.end.line || (rg.start.line === rg.end.line && rg.start.character > rg.end.character);
          if (backwards) out.push(`op ${i} span ${k} ${side} range runs backwards`);
          if (rg.start.line < 1 || rg.end.line > Math.max(1, count[side] + 1)) out.push(`op ${i} span ${k} ${side} range outside the file`);
        }
      }
    }
  });
  return [...new Set(out)];
}
