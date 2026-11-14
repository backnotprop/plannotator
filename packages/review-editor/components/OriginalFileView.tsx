import React, { useMemo } from 'react';
import { CodeFileView } from '@plannotator/ui/components/CodeFilePopout';
import { useOriginalFileText } from '../hooks/useOriginalFileText';
import { removedLinesCss, removedOldLines } from '../utils/wholeFileMarks';
import { FileTextState, type FileTokenHandlers } from './RepoFileView';

export const OriginalFileView: React.FC<{
  filePath: string;
  oldPath?: string;
  patch: string;
  base?: string;
  snapshotId?: string;
  tokens?: FileTokenHandlers;
}> = ({ filePath, oldPath, patch, base, snapshotId, tokens }) => {
  const text = useOriginalFileText(filePath, oldPath, base, snapshotId);
  const removed = useMemo(() => removedOldLines(patch), [patch]);
  const css = useMemo(() => removedLinesCss(removed), [removed]);
  if (text.status === 'loading') return <FileTextState>Reading the original…</FileTextState>;
  if (text.status !== 'ready') return <FileTextState>{text.message}</FileTextState>;
  return (
    <div className="flex-1 min-h-0 overflow-auto" data-original-file-view={filePath} data-change-lines={removed.join(',')}>
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
  );
};
