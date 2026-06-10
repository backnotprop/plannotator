import React from 'react';
import type { SelectedLineRange } from '@plannotator/ui/types';
import type {
  SemanticDiffBinaryChange,
  SemanticDiffChange,
} from '@plannotator/shared/semantic-diff-types';

// `renamed`/`moved` are handled by the early return in getChangeSymbol, so they
// intentionally have no entry here.
const changeSymbols: Record<string, string> = {
  added: '⊕',
  deleted: '⊖',
  modified: '∆',
  reordered: '↕',
};

export function getChangeSymbol(changeType: string): string {
  if (changeType.includes('renamed') || changeType.includes('moved')) return '↻';
  return changeSymbols[changeType] ?? '∆';
}

export function getChangeClass(changeType: string): string {
  if (changeType.includes('added')) return 'added';
  if (changeType.includes('deleted')) return 'deleted';
  if (changeType.includes('renamed')) return 'renamed';
  if (changeType.includes('moved')) return 'moved';
  if (changeType.includes('reordered')) return 'reordered';
  return 'modified';
}

export function getDisplayName(change: SemanticDiffChange): string {
  if (change.oldEntityName && change.oldEntityName !== change.entityName) {
    return `${change.oldEntityName} -> ${change.entityName}`;
  }
  return change.entityName;
}

export function getBinaryDisplayName(change: SemanticDiffBinaryChange): string {
  if (change.oldFilePath && change.oldFilePath !== change.filePath) {
    return `${change.oldFilePath} -> ${change.filePath}`;
  }
  return 'file';
}

export function getBinaryStatus(change: SemanticDiffBinaryChange): string {
  return change.fileStatus || change.changeType;
}

export function lineSelectionForChange(change: SemanticDiffChange): SelectedLineRange | null {
  const deleted = change.changeType === 'deleted';
  const start = deleted ? change.oldStartLine : change.startLine;
  const end = deleted ? change.oldEndLine : change.endLine;
  if (!start || start < 1) return null;

  return {
    start,
    end: end && end >= start ? end : start,
    side: deleted ? 'deletions' : 'additions',
  };
}

/**
 * Orphan = module-level change sem couldn't attach to a named entity. Sem hides
 * these by default (only the summary count surfaces them); we do the same.
 */
export function isOrphanChange(change: SemanticDiffChange): boolean {
  return change.entityType === 'orphan';
}

export interface SemanticDiffGroup {
  filePath: string;
  changes: SemanticDiffChange[];
  binaryChanges: SemanticDiffBinaryChange[];
}

/** Group changes by file, preserving order and dropping orphan (module-level) rows. */
export function groupSemanticChangesByFile(
  changes: SemanticDiffChange[],
  binaryChanges: SemanticDiffBinaryChange[],
): SemanticDiffGroup[] {
  const groups: SemanticDiffGroup[] = [];
  const byPath = new Map<string, SemanticDiffGroup>();
  const getGroup = (filePath: string) => {
    const existing = byPath.get(filePath);
    if (existing) return existing;

    const next: SemanticDiffGroup = { filePath, changes: [], binaryChanges: [] };
    byPath.set(filePath, next);
    groups.push(next);
    return next;
  };

  for (const change of changes) {
    if (isOrphanChange(change)) continue;
    getGroup(change.filePath).changes.push(change);
  }
  for (const change of binaryChanges) {
    getGroup(change.filePath).binaryChanges.push(change);
  }

  return groups;
}

/** The terminal-style entity rows, shared by the semantic panel and the file-header popover. */
export function SemanticDiffRows({
  changes,
  binaryChanges,
  onOpenChange,
  onOpenBinary,
}: {
  changes: SemanticDiffChange[];
  binaryChanges: SemanticDiffBinaryChange[];
  onOpenChange: (change: SemanticDiffChange) => void;
  onOpenBinary: (change: SemanticDiffBinaryChange) => void;
}) {
  return (
    <>
      {changes.map((change, index) => (
        <button
          type="button"
          className="semantic-diff-row"
          key={change.entityId ?? `${change.filePath}:${change.entityType}:${change.entityName}:${index}`}
          onClick={() => onOpenChange(change)}
          title={`${change.filePath}${change.startLine ? `:${change.startLine}` : ''}`}
        >
          <span className={`semantic-diff-symbol semantic-diff-symbol-${getChangeClass(change.changeType)}`}>
            {getChangeSymbol(change.changeType)}
          </span>
          <span className="semantic-diff-kind">{change.entityType}</span>
          <span className="semantic-diff-name">{getDisplayName(change)}</span>
          <span className="semantic-diff-status">{change.changeType}</span>
        </button>
      ))}
      {binaryChanges.map((change, index) => {
        const status = getBinaryStatus(change);
        return (
          <button
            type="button"
            className="semantic-diff-row"
            key={`${change.filePath}:binary:${index}`}
            onClick={() => onOpenBinary(change)}
            title={change.filePath}
          >
            <span className={`semantic-diff-symbol semantic-diff-symbol-${getChangeClass(status)}`}>
              {getChangeSymbol(status)}
            </span>
            <span className="semantic-diff-kind">binary</span>
            <span className="semantic-diff-name">{getBinaryDisplayName(change)}</span>
            <span className="semantic-diff-status">{status}</span>
          </button>
        );
      })}
    </>
  );
}
