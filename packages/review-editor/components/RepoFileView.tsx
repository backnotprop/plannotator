import React, { useMemo } from 'react';
import { CodeFileView, type CodeFileAnnotationInput, type CodeFileTokenTarget } from '@plannotator/ui/components/CodeFilePopout';
import type { CodeAnnotation } from '@plannotator/ui/types';
import type { RepoRevisionInfo } from '@plannotator/shared/repo-files';
import { useRepoFileText, repoFileEmptyMessage } from '../hooks/useRepoFileText';
import { useScrollMemory } from '../hooks/useScrollMemory';
import { findSymbolLine, type JumpCrumb as JumpCrumbData, type RevealTarget } from '../utils/explorerNavigation';
import { JumpCrumb } from './JumpCrumb';

/** Code navigation's tokens in a whole-file view (where F12 looks, Cmd+click). */
export interface FileTokenHandlers {
  onTokenTarget?: (kind: 'enter' | 'leave' | 'click', target: CodeFileTokenTarget) => void;
  onTokenNavigate?: (target: CodeFileTokenTarget) => void;
}

/**
 * The line a jump lands on in the text shown: code navigation's line, moved
 * to where the symbol is in this revision (`findSymbolLine`), else the top
 * with `missed` set.
 */
export function useRevealedLine(
  filePath: string,
  content: string | null,
  target: RevealTarget | null | undefined,
): { revealLine?: { line: number; token: number }; missed?: { symbol: string; line: number } } {
  return useMemo(() => {
    if (!target || target.path !== filePath || content == null) return {};
    const line = findSymbolLine(content, target.symbol, target.line);
    if (line == null) {
      return {
        revealLine: { line: 1, token: target.token },
        missed: target.symbol ? { symbol: target.symbol, line: target.line } : undefined,
      };
    }
    return { revealLine: { line, token: target.token } };
  }, [content, filePath, target]);
}

export const RevealMissedNote: React.FC<{ missed: { symbol: string; line: number } }> = ({ missed }) => (
  <div className="flex-none px-3 py-1 text-xs text-muted-foreground border-b border-border/40" data-reveal-missed>
    <code className="font-mono">{missed.symbol}</code> is not near line {missed.line} in this revision; showing the top.
  </div>
);

/** "at working tree", "at index", "at a1b2c3d". */
export function revisionPhrase(revision: RepoRevisionInfo | undefined): string | null {
  if (!revision) return null;
  return `at ${revision.label}`;
}

/** The lines a comment is drawn under in a whole-file view: new side, line scope, not outdated. */
export function wholeFileAnnotations(annotations: readonly CodeAnnotation[], filePath: string): CodeAnnotation[] {
  return annotations.filter(
    (a) => a.filePath === filePath && (a.scope ?? 'line') === 'line' && a.side === 'new' && !a.outdated,
  );
}

export const FileTextState: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="h-full flex items-center justify-center px-6 text-sm text-muted-foreground text-center" data-repo-file-state>
    {children}
  </div>
);

export interface RepoFileViewProps {
  filePath: string;
  snapshotId?: string;
  /** The preview tab (italic, replaced by the next single click). */
  preview: boolean;
  annotations: readonly CodeAnnotation[];
  selectedAnnotationId: string | null;
  onAddAnnotation?: (input: CodeFileAnnotationInput) => void;
  onEditAnnotation: (id: string, text: string | undefined) => void;
  onDeleteAnnotation: (id: string) => void;
  onSelectAnnotation: (id: string | null) => void;
  /** A jump to a line of this file. */
  revealTarget?: RevealTarget | null;
  /** The jump that opened this file, shown with the way back. */
  crumb?: JumpCrumbData | null;
  onNavigateBack?: () => void;
  tokens?: FileTokenHandlers;
}

/**
 * A file the review does not change, whole and read-only (approved design
 * record "review-explorer", step 2): its path, "Not in this review" and the
 * revision it was read at, then the file with line and range comments.
 * Comments here are on lines outside the diff (`outsideDiff`).
 */
export const RepoFileView: React.FC<RepoFileViewProps> = ({
  filePath,
  snapshotId,
  preview,
  annotations,
  selectedAnnotationId,
  onAddAnnotation,
  onEditAnnotation,
  onDeleteAnnotation,
  onSelectAnnotation,
  revealTarget,
  crumb,
  onNavigateBack,
  tokens,
}) => {
  const text = useRepoFileText(filePath, snapshotId);
  const { revealLine, missed } = useRevealedLine(filePath, text.status === 'ready' ? text.content : null, revealTarget);
  const fileAnnotations = useMemo(() => wholeFileAnnotations(annotations, filePath), [annotations, filePath]);
  const slash = filePath.lastIndexOf('/');
  const dir = slash === -1 ? '' : filePath.slice(0, slash + 1);
  const name = slash === -1 ? filePath : filePath.slice(slash + 1);
  const revision = text.status === 'ready' || text.status === 'empty' ? text.revision : undefined;
  // A jump's line wins over where the tab was left.
  const scroll = useScrollMemory(`${snapshotId ?? ''}:${filePath}`, text.status === 'ready' && !revealLine);

  return (
    <div className="h-full flex flex-col" data-repo-file-view={filePath}>
      <div className="flex-none flex items-center gap-2 px-3 border-b border-border/50 min-w-0" style={{ height: 'var(--panel-header-h, 36px)' }}>
        <span className="truncate text-sm min-w-0" title={filePath}>
          <span className="text-muted-foreground">{dir}</span>
          <span className="font-medium text-foreground">{name}</span>
        </span>
        <span
          className="flex-none text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
          data-not-in-review
          title="This file is not part of the diff under review"
        >
          Not in this review
        </span>
        {revisionPhrase(revision) && (
          <span className="flex-none text-xs text-muted-foreground" data-repo-file-revision>
            {revisionPhrase(revision)}
          </span>
        )}
        <span className="ml-auto flex-none text-[11px] text-muted-foreground/80">
          {onAddAnnotation ? 'Select lines to comment' : null}
          {preview && !crumb && <span className="ml-3" data-preview-hint>Double-click the tab to keep it</span>}
        </span>
      </div>
      {crumb && crumb.targetPath === filePath && (
        <JumpCrumb
          crumb={crumb}
          onBack={onNavigateBack}
          right={preview ? <span data-preview-hint>Double-click the tab to keep it</span> : undefined}
        />
      )}
      {missed && <RevealMissedNote missed={missed} />}
      <div className="flex-1 min-h-0 overflow-auto" ref={scroll.ref} onScroll={scroll.onScroll}>
        {text.status === 'loading' ? (
          <FileTextState>Reading the file…</FileTextState>
        ) : text.status === 'error' ? (
          <FileTextState>{text.message}</FileTextState>
        ) : text.status === 'empty' ? (
          <FileTextState>{repoFileEmptyMessage(text.reason, text.size)}</FileTextState>
        ) : (
          <CodeFileView
            filepath={filePath}
            contents={text.content}
            annotations={fileAnnotations}
            selectedAnnotationId={selectedAnnotationId}
            onAddAnnotation={onAddAnnotation}
            onEditAnnotation={(id, updates) => onEditAnnotation(id, updates.text)}
            onDeleteAnnotation={onDeleteAnnotation}
            onSelectAnnotation={onSelectAnnotation}
            className="min-h-full"
            lang={text.content.length > 500_000 ? 'text' : undefined}
            revealLine={revealLine}
            onTokenTarget={tokens?.onTokenTarget}
            onTokenNavigate={tokens?.onTokenNavigate}
          />
        )}
      </div>
    </div>
  );
};
