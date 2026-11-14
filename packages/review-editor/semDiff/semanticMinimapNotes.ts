import type { SemanticDiffOperation } from '@plannotator/sem-diff';

export type SemanticMinimapKind = 'moved' | 'renamed' | 'reformatted';

export interface SemanticMinimapNote {
  filePath: string;
  side: 'old' | 'new';
  lineStart: number;
  lineEnd: number;
  kind: SemanticMinimapKind;
}

const KIND_OF: Partial<Record<SemanticDiffOperation['type'], SemanticMinimapKind>> = {
  moved: 'moved',
  movedWithEdit: 'moved',
  extractedFunction: 'moved',
  inlinedFunction: 'moved',
  renamed: 'renamed',
  reformatted: 'reformatted',
};

export function semanticMinimapNotes(filePath: string, operations: readonly SemanticDiffOperation[]): SemanticMinimapNote[] {
  const notes: SemanticMinimapNote[] = [];
  for (const op of operations) {
    const kind = KIND_OF[op.type];
    if (!kind) continue;
    for (const range of op.lines.old) notes.push({ filePath, side: 'old', lineStart: range.start, lineEnd: range.end, kind });
    for (const range of op.lines.new) notes.push({ filePath, side: 'new', lineStart: range.start, lineEnd: range.end, kind });
  }
  return notes;
}
