import React from 'react';
import { ArrowDownLeft, ArrowUpDown, ArrowUpRight, Minus, MoveRight, PenLine, Pilcrow, Plus, type LucideIcon } from 'lucide-react';
import type { SelectedLineRange } from '@plannotator/ui/types';
import type {
  SemanticDiffBinaryChange,
  SemanticDiffChange,
} from '@plannotator/shared/semantic-diff-types';
import { CodeSnippetPreview } from '@plannotator/ui/components/CodeSnippetPreview';
import { useHoverPreview } from '@plannotator/ui/hooks/useHoverPreview';
import type { ReviewFileSource, ReviewFileSourceLoader } from '../../hooks/useReviewFileSource';

const CHANGE_ICONS: Record<string, LucideIcon> = {
  added: Plus,
  deleted: Minus,
  moved: MoveRight,
  renamed: PenLine,
  modified: PenLine,
  reordered: ArrowUpDown,
  reformatted: Pilcrow,
  extracted: ArrowUpRight,
  inlined: ArrowDownLeft,
};

export function ChangeIcon({ changeType }: { changeType: string }) {
  const kind = changeType === 'extracted' || changeType === 'inlined' || changeType === 'reordered' ? changeType : getChangeClass(changeType);
  const Icon = CHANGE_ICONS[kind] ?? PenLine;
  return <Icon className={`semantic-diff-symbol semantic-diff-symbol-${getChangeClass(changeType)}`} size={14} strokeWidth={1.75} aria-hidden="true" />;
}

const SHORT_STATUS: Record<string, string> = { modified: 'edited', 'moved & edited': 'moved, edited' };

export function statusWord(changeType: string): string {
  return SHORT_STATUS[changeType] ?? changeType;
}

export function getChangeClass(changeType: string): string {
  if (changeType.includes('added')) return 'added';
  if (changeType.includes('deleted')) return 'deleted';
  if (changeType.includes('renamed')) return 'renamed';
  if (changeType === 'moved & edited') return 'modified';
  if (changeType.includes('moved')) return 'moved';
  if (changeType.includes('reordered')) return 'reordered';
  if (changeType === 'reformatted') return 'reformatted';
  if (changeType === 'extracted' || changeType === 'inlined') return 'moved';
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

/**
 * One entity row. With a `loadSource`, resting the pointer on (or focusing)
 * the row opens the entity's source: its line range on the side it lives on
 * (the old file for a deletion), through the shared code hover preview.
 */
function SemanticDiffChangeRow({
  change,
  onOpenChange,
  loadSource,
  onOpenLine,
  onOpenFile,
  onReject,
}: {
  change: SemanticDiffChange;
  onOpenChange: (change: SemanticDiffChange) => void;
  loadSource?: ReviewFileSourceLoader;
  onOpenLine?: SemanticOpenLine;
  onOpenFile?: SemanticOpenFile;
  onReject?: (candidateId: string) => void;
}) {
  const range = lineSelectionForChange(change);
  const linked = change.origin === 'second-opinion';
  const band = change.band === 'very-likely' ? 'Very likely' : change.band === 'likely' ? 'Likely' : '';
  const model = change.model?.split(' ')[0]?.replace(/^jev.*/, 'Jev').replace(/^clef.*/, 'Clef') ?? 'the model';
  const sourcePath = change.changeType === 'deleted' ? change.oldFilePath ?? change.filePath : change.filePath;
  const sourcePreview = useHoverPreview<ReviewFileSource>(
    () => (loadSource && range ? loadSource(sourcePath, range.side === 'deletions' ? 'old' : 'new') : Promise.resolve(null)),
    Boolean(loadSource && range),
  );
  return (
    <>
      <button
        type="button"
        className="semantic-diff-row"
        ref={(element) => { sourcePreview.anchorRef.current = element; }}
        onMouseEnter={sourcePreview.onEnter}
        onMouseLeave={sourcePreview.onLeave}
        onFocus={sourcePreview.onEnter}
        onBlur={sourcePreview.onLeave}
        onClick={() => {
          sourcePreview.dismiss();
          onOpenChange(change);
        }}
        title={`${change.filePath}${change.startLine ? `:${change.startLine}` : ''}`}
      >
        <ChangeIcon changeType={change.changeType} />
        <span className="semantic-diff-kind">{change.entityType}</span>
        <span className="semantic-diff-name">{getDisplayName(change)}</span>
        <span className="semantic-diff-status" data-semantic-origin={linked ? 'second-opinion' : undefined}>
          {statusWord(change.changeType)}
          {linked && band ? ` · ${band}` : ''}
        </span>
      </button>
      {sourcePreview.preview && range && (
        <CodeSnippetPreview
          anchorEl={sourcePreview.anchorRef.current}
          contents={sourcePreview.preview.contents}
          filepath={sourcePreview.preview.filepath}
          title={sourcePreview.preview.filepath}
          line={range.start}
          lineEnd={range.end > range.start ? range.end : undefined}
          onDismiss={sourcePreview.dismiss}
          {...sourcePreview.previewHandlers}
          onLineClick={onOpenLine ? (line) => {
            sourcePreview.dismiss();
            onOpenLine(sourcePath, line, range.side);
          } : undefined}
          actions={onOpenFile || (linked && onReject && change.candidateId) ? (
            <>
            {linked && (
              <span className="text-[10px]" data-power-up-linked="" title={`Linked by ${model}. The engine alone wasn't sure.`}>
                Linked by {model}{band ? ` · ${band}` : ''}
              </span>
            )}
            {linked && onReject && change.candidateId && (
              <button
                type="button"
                className="text-[10px] px-1.5 py-0.5 rounded hover:bg-muted hover:text-foreground"
                data-power-up-reject=""
                onClick={() => {
                  sourcePreview.dismiss();
                  onReject(change.candidateId!);
                }}
              >
                Not moved
              </button>
            )}
            {onOpenFile && (<button
              type="button"
              className="text-[10px] px-1.5 py-0.5 rounded hover:bg-muted hover:text-foreground"
              data-snippet-open-file=""
              onClick={() => {
                sourcePreview.dismiss();
                onOpenFile(sourcePath, range.start);
              }}
            >
              Open file
            </button>)}
            </>
          ) : undefined}
        />
      )}
    </>
  );
}

/** The terminal-style entity rows, shared by the semantic panel and the file-header popover. */
export type SemanticOpenLine = (path: string, line: number, side: 'deletions' | 'additions') => void;
export type SemanticOpenFile = (path: string, line: number) => void;

export function SemanticDiffRows({
  changes,
  binaryChanges,
  onOpenChange,
  onOpenBinary,
  loadSource,
  onOpenLine,
  onOpenFile,
  onReject,
}: {
  changes: SemanticDiffChange[];
  binaryChanges: SemanticDiffBinaryChange[];
  onOpenChange: (change: SemanticDiffChange) => void;
  onOpenBinary: (change: SemanticDiffBinaryChange) => void;
  /** Loads an entity's source for its hover preview; absent, rows have no preview (the file-header popover). */
  loadSource?: ReviewFileSourceLoader;
  /** Clicking a line of the hover preview: show it in the diff. */
  onOpenLine?: SemanticOpenLine;
  /** The hover preview's "Open file": the whole file at that line. */
  onOpenFile?: SemanticOpenFile;
  /** "Not moved" on a link the model made: retracts it and remembers. */
  onReject?: (candidateId: string) => void;
}) {
  return (
    <>
      {changes.map((change, index) => (
        <SemanticDiffChangeRow
          key={change.entityId ?? `${change.filePath}:${change.entityType}:${change.entityName}:${index}`}
          change={change}
          onOpenChange={onOpenChange}
          loadSource={loadSource}
          onOpenLine={onOpenLine}
          onOpenFile={onOpenFile}
          onReject={onReject}
        />
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
            <ChangeIcon changeType={status} />
            <span className="semantic-diff-kind">binary</span>
            <span className="semantic-diff-name">{getBinaryDisplayName(change)}</span>
            <span className="semantic-diff-status">{status}</span>
          </button>
        );
      })}
    </>
  );
}
