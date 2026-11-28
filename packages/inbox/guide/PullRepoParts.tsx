/**
 * The PR page's All files, drawn by the review app's own parts: its tree (`RepoTreeView`, fed by `useRepoFiles`, its
 * "Listing the repository…" and failure words through `RepoListingPlaceholder`) and its whole-file view
 * (`RepoFileView`, read-only here). Their reads go to the Inbox's routes for this PR (`pullRepoFetch`). In the reader's
 * chunk (re-exported by GuideReader.tsx), so the window's first load carries none of it; checked by
 * tsconfig.guide.json.
 */
import { useImperativeHandle, useMemo, useRef } from 'react';
import type { CodeAnnotation } from '@plannotator/ui/types';
import type { DiffFile } from '@plannotator/core/diff-files';
import { useCompactTouchLayout } from '@plannotator/ui/hooks/useIsMobile';
import { RepoTreeView, type RepoTreeHandle } from '@plannotator/review-editor/components/RepoTreeView';
import { RepoListingPlaceholder } from '@plannotator/review-editor/components/FileTree';
import { RepoFileView } from '@plannotator/review-editor/components/RepoFileView';
import { useRepoFiles } from '@plannotator/review-editor/hooks/useRepoFiles';
import { pullRepoFetch } from '../pulls/RailScope';
import { useRiskLead } from './PullChangesTree';
import type { PullAllFilesProps, PullRepoFileProps } from './pullRepoTypes';

const NO_COMMENTS: CodeAnnotation[] = [];
const noop = () => {};

export function PullAllFiles({ pullKey, sha, files, viewed, comments, activePath, openPath, head, onSelect, onOpen, handleRef, risk }: PullAllFilesProps) {
  const fetchImpl = useMemo(() => pullRepoFetch(pullKey), [pullKey]);
  const repo = useRepoFiles({ enabled: true, snapshotId: sha, fetchImpl });
  const list = files as DiffFile[];
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const comment of comments as CodeAnnotation[]) map.set(comment.filePath, (map.get(comment.filePath) ?? 0) + 1);
    return map;
  }, [comments]);
  const fileLead = useRiskLead(risk);
  const touch = useCompactTouchLayout();
  const inner = useRef<RepoTreeHandle>(null);
  useImperativeHandle(handleRef, () => ({ focus: () => inner.current?.focus() }), []);
  return (
    <div className="ib-prp-files ib-prp-tree ib-prp-pierre" data-pull-all-files="">
      {head}
      {repo.state.status === 'ready' ? (
        <RepoTreeView
          key={touch ? 'touch' : 'pointer'}
          touch={touch}
          repo={repo.state}
          loadDir={repo.loadDir}
          files={list}
          activePath={openPath ?? activePath ?? null}
          onSelectFile={(index) => {
            const file = list[index];
            if (file) onSelect(file.path);
          }}
          onOpenRepoFile={(path) => onOpen(path)}
          viewedFiles={viewed as Set<string>}
          showViewedControls
          annotationCounts={counts}
          fileLead={fileLead}
          handleRef={inner}
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
