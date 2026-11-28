import { useImperativeHandle, useMemo, useRef } from 'react';
import type { DiffFile } from '@plannotator/core/diff-files';
import { useCompactTouchLayout } from '@plannotator/ui/hooks/useIsMobile';
import { ChangesTreeView, type ChangesTreeHandle } from '@plannotator/review-editor/components/ChangesTreeView';
import { RISK_BARS_PARTS } from '@plannotator/review-editor/components/treeRows';
import { buildFileTree, getVisualFileOrder } from '@plannotator/review-editor/utils/buildFileTree';
import type { PullChangesTreeProps, PullTreeRisk } from './pullRepoTypes';
import { RISK_TONE } from '../pulls/riskBarsTone';

type RowPart = (typeof RISK_BARS_PARTS)['high'];

/**
 * The trees' risk bars (approval "review-risk-bars"): review-editor's `RISK_BARS_PARTS` in the risk tone, before each
 * named file's icon, as the tree's `fileLead`; undefined (no lead at all) with no risk to show. Also All files'
 * (PullRepoParts.tsx).
 */
export function useRiskLead(risk: PullTreeRisk | null | undefined): ((path: string) => RowPart | null) | undefined {
  return useMemo(() => {
    if (!risk || risk.files.size === 0) return undefined;
    const part = { ...RISK_BARS_PARTS[risk.level], color: RISK_TONE };
    return (path: string) => (risk.files.has(path) ? part : null);
  }, [risk]);
}

const NO_PATHS: ReadonlySet<string> = new Set();

export function PullChangesTree({ files, viewed, showViewed, comments, threadCount, activePath, head, onSelect, handleRef, risk }: PullChangesTreeProps) {
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
  const fileLead = useRiskLead(risk);
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
        fileLead={fileLead}
        onSelectFile={(index, how) => {
          const file = list[index];
          if (file) onSelect(file.path, how);
        }}
      />
    </div>
  );
}
