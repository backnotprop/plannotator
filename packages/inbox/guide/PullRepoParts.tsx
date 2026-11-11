import { useCallback, useMemo, useRef, useState } from 'react';
import type { CodeAnnotation } from '@plannotator/ui/types';
import type { DiffFile } from '@plannotator/core/diff-files';
import { RepoFileTree } from '@plannotator/review-editor/components/RepoFileTree';
import { RepoListingPlaceholder } from '@plannotator/review-editor/components/FileTree';
import { RepoFileView } from '@plannotator/review-editor/components/RepoFileView';
import { useRepoFiles } from '@plannotator/review-editor/hooks/useRepoFiles';
import { pullRepoFetch } from '../pulls/RailScope';
import type { PullAllFilesProps, PullRepoFileProps } from './pullRepoTypes';

const NONE = new Set<string>();
const NO_COMMENTS: CodeAnnotation[] = [];
const noop = () => {};

export function PullAllFiles({ pullKey, sha, files, viewed, comments, activePath, openPath, head, onSelect, onOpen, onToggleViewed }: PullAllFilesProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const getScrollElement = useCallback(() => scroller.current, []);
  const fetchImpl = useMemo(() => pullRepoFetch(pullKey), [pullKey]);
  const repo = useRepoFiles({ enabled: true, snapshotId: sha, fetchImpl });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggle = useCallback((path: string) => {
    setExpanded((was) => {
      const next = new Set(was);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  const list = files as DiffFile[];
  const active = activePath ? list.findIndex((file) => file.path === activePath) : -1;
  return (
    <div ref={scroller} className="ib-prp-files ib-prp-tree" data-pull-all-files="">
      {head}
      {repo.state.status === 'ready' ? (
        <RepoFileTree
          repo={repo.state}
          loadDir={repo.loadDir}
          files={list}
          activeFileIndex={active}
          activeRepoPath={openPath}
          expanded={expanded}
          onToggleFolder={toggle}
          onSelectFile={(index) => {
            const file = list[index];
            if (file) onSelect(file.path);
          }}
          onOpenRepoFile={(path) => onOpen(path)}
          viewedFiles={viewed as Set<string>}
          onToggleViewed={onToggleViewed}
          annotations={comments as CodeAnnotation[]}
          stagedFiles={NONE}
          showStageControls={false}
          getScrollElement={getScrollElement}
        />
      ) : (
        <RepoListingPlaceholder state={repo.state} onRetry={repo.reload} />
      )}
    </div>
  );
}

export function PullRepoFile({ pullKey, sha, path }: PullRepoFileProps) {
  const fetchImpl = useMemo(() => pullRepoFetch(pullKey), [pullKey]);
  return (
    <div className="ib-prp-repofile" data-pull-repo-file={path}>
      <RepoFileView
        filePath={path}
        snapshotId={sha}
        preview={false}
        annotations={NO_COMMENTS}
        selectedAnnotationId={null}
        onEditAnnotation={noop}
        onDeleteAnnotation={noop}
        onSelectAnnotation={noop}
        fetchImpl={fetchImpl}
      />
    </div>
  );
}
