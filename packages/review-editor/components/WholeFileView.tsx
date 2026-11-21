import React, { useCallback, useMemo, useState } from 'react';
import { CodeFileView, type CodeFileAnnotationInput } from '@plannotator/ui/components/CodeFilePopout';
import type { CodeAnnotation } from '@plannotator/ui/types';
import { useRepoFileText, repoFileEmptyMessage } from '../hooks/useRepoFileText';
import { useScrollMemory } from '../hooks/useScrollMemory';
import { wholeFileMarks, wholeFileMarksCss } from '../utils/wholeFileMarks';
import { FileTextState, RevealMissedNote, useRevealedLine, wholeFileAnnotations, type FileTokenHandlers } from './RepoFileView';
import type { RevealTarget } from '../utils/explorerNavigation';
import { FileMinimap } from './minimap/FileMinimap';
import type { LineSide } from './minimap/layoutSource';

/**
 * A changed file's Whole file view: its new side, every line, read from
 * `/api/repo-file` (the same revision the diff's new side reads), with change
 * bars in the gutter from the patch (added, modified, a wedge where lines were
 * removed). Comments work on any line: inside a hunk they are ordinary diff
 * comments, outside one they are comments outside the diff.
 */
export const WholeFileView: React.FC<{
  filePath: string;
  patch: string;
  snapshotId?: string;
  annotations: readonly CodeAnnotation[];
  selectedAnnotationId: string | null;
  onAddAnnotation?: (input: CodeFileAnnotationInput) => void;
  onEditAnnotation: (id: string, text: string | undefined) => void;
  onDeleteAnnotation: (id: string) => void;
  onSelectAnnotation: (id: string | null) => void;
  revealTarget?: RevealTarget | null;
  tokens?: FileTokenHandlers;
  minimap?: boolean;
  minimapSide?: LineSide;
}> = ({ filePath, patch, snapshotId, annotations, selectedAnnotationId, onAddAnnotation, onEditAnnotation, onDeleteAnnotation, onSelectAnnotation, revealTarget, tokens, minimap = true, minimapSide = 'new' }) => {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const [minimapShown, setMinimapShown] = useState(false);
  const text = useRepoFileText(filePath, snapshotId);
  const marks = useMemo(() => wholeFileMarks(patch), [patch]);
  const marksCss = useMemo(() => wholeFileMarksCss(marks), [marks]);
  // Next / previous change walks these lines (`changeNavigation.ts`).
  const changeLines = useMemo(
    () => [...new Set([...marks.added, ...marks.modified, ...marks.removedBefore])].sort((a, b) => a - b).join(','),
    [marks],
  );
  const { revealLine, missed } = useRevealedLine(filePath, text.status === 'ready' ? text.content : null, revealTarget);
  const fileAnnotations = useMemo(() => wholeFileAnnotations(annotations, filePath), [annotations, filePath]);
  const scroll = useScrollMemory(`whole:${snapshotId ?? ''}:${filePath}`, text.status === 'ready' && !revealLine);
  const lineCount = useMemo(() => (text.status === 'ready' ? text.content.split('\n').length : 0), [text]);
  const scrollRef = scroll.ref;
  const attachScroller = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    setScroller(el);
  }, [scrollRef]);

  if (text.status === 'loading') return <FileTextState>Reading the file…</FileTextState>;
  if (text.status === 'error') return <FileTextState>{text.message}</FileTextState>;
  if (text.status === 'empty') return <FileTextState>{repoFileEmptyMessage(text.reason, text.size)}</FileTextState>;
  return (
    <>
    <div className={`flex-1 min-h-0 overflow-auto ${minimap && minimapShown ? 'mr-6' : ''}`} data-whole-file-view={filePath} data-change-lines={changeLines} ref={attachScroller} onScroll={scroll.onScroll}>
      {missed && <RevealMissedNote missed={missed} />}
      <div ref={setContent}>
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
        extraCss={marksCss}
        lang={text.content.length > 500_000 ? 'text' : undefined}
        revealLine={revealLine}
        onTokenTarget={tokens?.onTokenTarget}
        onTokenNavigate={tokens?.onTokenNavigate}
      />
      </div>
    </div>
    {minimap && (
      <FileMinimap
        viewport={scroller}
        content={content}
        filePath={filePath}
        patch={patch}
        viewed={false}
        annotations={annotations}
        split={false}
        expandUnchanged={false}
        wholeFile={{ side: minimapSide, lineCount }}
        onShownChange={setMinimapShown}
      />
    )}
    </>
  );
};
