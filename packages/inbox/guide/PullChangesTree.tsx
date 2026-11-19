import { useImperativeHandle, useMemo, useRef } from 'react';
import type { DiffFile } from '@plannotator/core/diff-files';
import { useCompactTouchLayout } from '@plannotator/ui/hooks/useIsMobile';
import { ChangesTreeView, type ChangesTreeHandle } from '@plannotator/review-editor/components/ChangesTreeView';
import { buildFileTree, getVisualFileOrder } from '@plannotator/review-editor/utils/buildFileTree';
import type { PullChangesTreeProps } from './pullRepoTypes';

const NO_PATHS: ReadonlySet<string> = new Set();

export function PullChangesTree({ files, viewed, showViewed, comments, threadCount, activePath, head, onSelect, handleRef }: PullChangesTreeProps) {
  const list = files as DiffFile[];
  const { tree, extra } = useMemo(() => {
    const built = buildFileTree(list);
    const placed = new Set(getVisualFileOrder(built));
    return { tree: built, extra: list.flatMap((file, index) => (placed.has(index) ? [] : [{ file, index }])) };
  }, [list]);
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const comment of comments) map.set(comment.filePath, (map.get(comment.filePath) ?? 0) + 1);
    return map;
  }, [comments]);
  const touch = useCompactTouchLayout();
  const inner = useRef<ChangesTreeHandle>(null);
  useImperativeHandle(handleRef, () => ({ focus: () => inner.current?.focus() }), []);
  return (
    <div className="ib-prp-files ib-prp-pierre" data-review-files="">
      {head}
      <ChangesTreeView
        key={touch ? 'touch' : 'pointer'}
        touch={touch}
        handleRef={inner}
        tree={tree}
        extraFiles={extra}
        groups={null}
        activePath={activePath}
        viewedFiles={viewed}
        hiddenFiles={NO_PATHS}
        hideViewedFiles={false}
        showViewedControls={showViewed}
        annotationCounts={counts}
        threadCount={threadCount}
        onSelectFile={(index, how) => {
          const file = list[index];
          if (file) onSelect(file.path, how);
        }}
      />
    </div>
  );
}
