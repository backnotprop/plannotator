import type { SemanticDiffOperation } from '@plannotator/sem-diff';
import { SKIM_KINDS } from '@plannotator/sem-diff/summary';
import type { SemanticDiffChange } from '@plannotator/shared/semantic-diff-types';

const CHANGE_TYPE: Record<SemanticDiffOperation['type'], string> = {
  moved: 'moved',
  movedWithEdit: 'moved',
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

function firstLine(text: string, line: number | undefined): string {
  if (line == null) return '';
  const value = text.split('\n')[line - 1]?.trim() ?? '';
  return value.length > MAX_NAME ? `${value.slice(0, MAX_NAME - 1)}…` : value;
}

export function semDiffChanges(
  filePath: string,
  operations: SemanticDiffOperation[],
  oldText: string,
  newText: string,
  oldFilePath: string | null = null,
): SemanticDiffChange[] {
  return operations.map((op) => {
    const oldRange = op.lines.old[0];
    const newRange = op.lines.new[0];
    const oldEnd = op.lines.old.at(-1)?.end ?? null;
    const newEnd = op.lines.new.at(-1)?.end ?? null;
    const name = firstLine(newText, newRange?.start) || firstLine(oldText, oldRange?.start);
    const oldName = firstLine(oldText, oldRange?.start);
    return {
      entityId: null,
      changeType: CHANGE_TYPE[op.type] ?? 'modified',
      entityType: 'code',
      entityName: name,
      oldEntityName: oldName && oldName !== name ? oldName : null,
      filePath,
      oldFilePath,
      startLine: newRange?.start ?? null,
      endLine: newEnd,
      oldStartLine: oldRange?.start ?? null,
      oldEndLine: oldEnd,
      structuralChange: !SKIM_KINDS.includes(op.type),
    };
  });
}
