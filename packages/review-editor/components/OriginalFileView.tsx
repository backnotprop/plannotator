import React, { useMemo, useState } from 'react';
import { CodeFileView } from '@plannotator/ui/components/CodeFilePopout';
import { useOriginalFileText } from '../hooks/useOriginalFileText';
import { removedLinesCss, removedOldLines } from '../utils/wholeFileMarks';
import { FileTextState, type FileTokenHandlers } from './RepoFileView';
import { FileMinimap } from './minimap/FileMinimap';

export const OriginalFileView: React.FC<{
  filePath: string;
  oldPath?: string;
  patch: string;
  base?: string;
  snapshotId?: string;
  tokens?: FileTokenHandlers;
  minimap?: boolean;
}> = ({ filePath, oldPath, patch, base, snapshotId, tokens, minimap = true }) => {
  const text = useOriginalFileText(filePath, oldPath, base, snapshotId);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const [minimapShown, setMinimapShown] = useState(false);
  const lineCount = useMemo(() => (text.status === 'ready' ? text.content.split('\n').length : 0), [text]);
  const removed = useMemo(() => removedOldLines(patch), [patch]);
  const css = useMemo(() => removedLinesCss(removed), [removed]);
  if (text.status === 'loading') return <FileTextState>Reading the original…</FileTextState>;
  if (text.status !== 'ready') return <FileTextState>{text.message}</FileTextState>;
  return (
    <>
    <div className={`flex-1 min-h-0 overflow-auto ${minimap && minimapShown ? 'mr-6' : ''}`} data-original-file-view={filePath} data-change-lines={removed.join(',')} ref={setScroller}>
      <div ref={setContent}>
      <CodeFileView
        filepath={oldPath ?? filePath}
        contents={text.content}
        annotations={[]}
        selectedAnnotationId={null}
        onEditAnnotation={() => {}}
        onDeleteAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        className="min-h-full"
        extraCss={css}
        lang={text.content.length > 500_000 ? 'text' : undefined}
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
        annotations={[]}
        split={false}
        expandUnchanged={false}
        wholeFile={{ side: 'old', lineCount }}
        onShownChange={setMinimapShown}
      />
    )}
    </>
  );
};
