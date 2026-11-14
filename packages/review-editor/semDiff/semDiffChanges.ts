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

export function shortName(line: string): string {
  return NAMED.exec(line)?.[1] ?? line;
}

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

export function semDiffChanges(
  filePath: string,
  operations: SemanticDiffOperation[],
  oldText: string,
  newText: string,
  oldFilePath: string | null = null,
  links: readonly SecondOpinionLink[] = [],
): SemanticDiffChange[] {
  return operations.map((op, index) => {
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
    return {
      entityId: null,
      changeType: CHANGE_TYPE[op.type] ?? 'modified',
      entityType: '',
      entityName: shortName(name),
      oldEntityName: op.type === 'renamed' && oldName && shortName(oldName) !== shortName(name) ? shortName(oldName) : null,
      filePath,
      oldFilePath,
      startLine: newRange?.start ?? null,
      endLine: newEnd,
      oldStartLine: oldRange?.start ?? null,
      oldEndLine: oldEnd,
      structuralChange: !SKIM_KINDS.includes(op.type),
      ...(link ? { origin: 'second-opinion' as const, band: link.band, model: link.model, candidateId: link.candidateId } : {}),
    };
  });
}
