import type { SecondOpinionLink, SemanticDiffOperation } from '@plannotator/sem-diff';
import { SKIM_KINDS } from '@plannotator/sem-diff/summary';
import type { SemanticDiffChange } from '@plannotator/shared/semantic-diff-types';

const CHANGE_TYPE: Record<SemanticDiffOperation['type'], string> = {
  moved: 'moved',
  movedWithEdit: 'moved & edited',
  edited: 'modified',
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  reordered: 'reordered',
  reformatted: 'reformatted',
  extractedFunction: 'extracted',
  inlinedFunction: 'inlined',
};

const MAX_NAME = 80;
const NAMED = /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|def|fn|func|class|interface|type|enum|const|let|var|struct|trait|impl)\s+([A-Za-z_$][\w$]*)/;

const GO_METHOD = /\bfunc\s+\([^)]*\)\s*([A-Za-z_]\w*)/;
const METHOD = /^(?:(?:public|private|protected|static|async|readonly|override|get|set)\s+)*\*?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)?[^;]*\{\s*$/;
const NOT_A_NAME = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'try', 'with', 'match', 'loop']);

function declaredName(line: string): string | null {
  const named = NAMED.exec(line)?.[1] ?? GO_METHOD.exec(line)?.[1];
  if (named) return named;
  const method = METHOD.exec(line.trim())?.[1];
  return method && !NOT_A_NAME.has(method) ? method : null;
}

export function shortName(line: string): string {
  return declaredName(line) ?? line;
}

const indentOf = (line: string) => /^\s*/.exec(line)![0].length;
const LOCAL = /^\s+(?:const|let|var)\b|^\s*for\b/;
const ownerName = (line: string) => (LOCAL.test(line) ? null : declaredName(line));

function enclosingName(text: string, line: number | undefined): string | null {
  if (line == null) return null;
  const lines = text.split('\n');
  const own = lines[line - 1] ?? '';
  if (ownerName(own)) return null;
  let indent = own.trim() === '' ? Infinity : indentOf(own);
  for (let at = line - 2; at >= 0; at--) {
    const value = lines[at]!;
    if (value.trim() === '') continue;
    const here = indentOf(value);
    if (here >= indent) continue;
    indent = here;
    const name = ownerName(value);
    if (name) return name;
    if (here === 0) return null;
  }
  return null;
}

const MEANINGLESS = /^[^\p{L}\p{N}_$]*$/u;

function lineText(text: string, line: number | undefined): string {
  if (line == null) return '';
  const value = text.split('\n')[line - 1]?.trim() ?? '';
  return value.length > MAX_NAME ? `${value.slice(0, MAX_NAME - 1)}…` : value;
}

function firstLine(text: string, line: number | undefined): string {
  return lineText(text, line);
}

function declarationLine(text: string, ranges: readonly { start: number; end: number }[]): string {
  for (const range of ranges) {
    for (let line = range.start; line <= range.end && line < range.start + 40; line++) {
      const value = lineText(text, line);
      if (/\b(function|def|fn|func|class)\b/.test(value)) return value;
    }
  }
  return '';
}

type Folded = SemanticDiffChange & { folded: boolean };

function mergeInto(target: Folded, change: Folded): void {
  if (target.changeType !== change.changeType) target.changeType = 'modified';
  const low = (x: number | null, y: number | null) => (x == null ? y : y == null ? x : Math.min(x, y));
  const high = (x: number | null, y: number | null) => (x == null ? y : y == null ? x : Math.max(x, y));
  target.startLine = low(target.startLine, change.startLine);
  target.endLine = high(target.endLine, change.endLine);
  target.oldStartLine = low(target.oldStartLine, change.oldStartLine);
  target.oldEndLine = high(target.oldEndLine, change.oldEndLine);
  target.structuralChange = target.structuralChange || change.structuralChange;
}

export function semDiffChanges(
  filePath: string,
  operations: SemanticDiffOperation[],
  oldText: string,
  newText: string,
  oldFilePath: string | null = null,
  links: readonly SecondOpinionLink[] = [],
): SemanticDiffChange[] {
  const rows: Folded[] = operations.map((op, index) => {
    const link = links.find((candidate) => candidate.operationIndex === index);
    const oldRange = op.lines.old[0];
    const newRange = op.lines.new[0];
    const oldEnd = op.lines.old.at(-1)?.end ?? null;
    const newEnd = op.lines.new.at(-1)?.end ?? null;
    const helper = op.type === 'extractedFunction'
      ? declarationLine(newText, op.lines.new)
      : op.type === 'inlinedFunction'
        ? declarationLine(oldText, op.lines.old)
        : '';
    const name = helper || firstLine(newText, newRange?.start) || firstLine(oldText, oldRange?.start);
    const oldName = firstLine(oldText, oldRange?.start);
    const owner = helper || op.type === 'renamed' ? null : newRange ? enclosingName(newText, newRange.start) : enclosingName(oldText, oldRange?.start);
    return {
      entityId: null,
      changeType: CHANGE_TYPE[op.type] ?? 'modified',
      entityType: '',
      entityName: owner ?? shortName(name),
      oldEntityName: !owner && op.type === 'renamed' && oldName && shortName(oldName) !== shortName(name) ? shortName(oldName) : null,
      filePath,
      oldFilePath,
      startLine: newRange?.start ?? null,
      endLine: newEnd,
      oldStartLine: oldRange?.start ?? null,
      oldEndLine: oldEnd,
      structuralChange: !SKIM_KINDS.includes(op.type),
      ...(link ? { origin: 'second-opinion' as const, band: link.band, model: link.model, candidateId: link.candidateId } : {}),
      folded: owner !== null && !link,
    };
  });
  const out: Folded[] = [];
  const byName = new Map<string, Folded>();
  for (const row of rows) {
    if (MEANINGLESS.test(row.entityName.trim())) continue;
    const kept = row.candidateId ? undefined : byName.get(row.entityName);
    if (kept && !kept.candidateId && (kept.folded || row.folded)) {
      mergeInto(kept, row);
      kept.folded = true;
      continue;
    }
    const pair = kept && !kept.candidateId && kept.changeType !== row.changeType && [kept.changeType, row.changeType].every((type) => type === 'added' || type === 'deleted');
    if (kept && pair) {
      mergeInto(kept, row);
      kept.changeType = 'modified';
      continue;
    }
    if (!kept && !row.candidateId) byName.set(row.entityName, row);
    out.push(row);
  }
  return out.map(({ folded: _folded, ...change }) => change);
}
