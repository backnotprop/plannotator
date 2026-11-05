/**
 * The PR page's All files, drawn by the review app's own parts: its tree (`RepoFileTree`, fed by `useRepoFiles`, its
 * "Listing the repository…" and failure words through `RepoListingPlaceholder`) and its whole-file view
 * (`RepoFileView`, read-only here). Their reads go to the Inbox's routes for this PR (`pullRepoFetch`). In the reader's
 * chunk (re-exported by GuideReader.tsx), so the window's first load carries none of it; checked by
 * tsconfig.guide.json.
 */
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
  // The rail's list scrolls in this box, as Changes does; the tree draws the rows in view of it.
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
    <div ref={scroller} className="ib-prp-files ib-prp-all" data-pull-all-files="">
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

/** A file of the repository the PR does not change, whole and read-only, in place of the diff. */
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
