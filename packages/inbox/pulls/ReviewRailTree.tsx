/**
 * The layer review's file rail: the code review app's Changes tree (FileTreeNode), the same builder and row atoms in
 * the same anatomy. Folders before files, a lone folder merged into its child, each row its Viewed circle, its change
 * letter, its name, its comment count and its +/- columns. Styles: `.ib-rrail` under "The flat PR view" in inbox.css.
 */

import { useMemo, type CSSProperties } from 'react';
import type { DiffFile } from '@plannotator/core/diff-files';
import { useDiffFileTreeExpansion } from '@plannotator/ui/hooks/useDiffFileTreeExpansion';
import type { DiffFileTreeNode } from '@plannotator/ui/utils/diffFileTree';
import {
  AnnotationBadge,
  ChangeTypeLetter,
  countColumnVars,
  CountColumns,
  ViewedControl,
} from '@plannotator/review-editor/components/FileRowBits';
import { Tip } from '../components/Tip';

/** The Changes tree's indent: 12 px a level from the row's 8 px, 4 px a level past what the 256 px rail can give. */
function indent(depth: number): number {
  const full = Math.min(depth, 4);
  return 8 + full * 12 + (depth - full) * 4;
}

/** A row's name: cut at its start, so names that share a long beginning still differ; its whole path on hover when cut. */
function RowName({ name, path }: { name: string; path: string }) {
  return (
    <Tip cut content={path}>
      <span className="truncate ib-rv-name">
        <bdi>{name}</bdi>
      </span>
    </Tip>
  );
}

export function ReviewRailTree({ tree, loose, files, viewed, commentCount, onSelect, onToggleViewed }: {
  tree: DiffFileTreeNode<DiffFile>[];
  /** Files the tree has no row for (reviewFiles.ts): drawn after it with their full path. */
  loose: readonly DiffFile[];
  files: readonly DiffFile[];
  viewed: ReadonlySet<string>;
  commentCount: (path: string) => number;
  onSelect: (path: string) => void;
  onToggleViewed: (path: string) => void;
}) {
  const { expandedFolders, toggleFolder } = useDiffFileTreeExpansion(tree, null);
  const columns = useMemo<CSSProperties>(() => {
    const add = files.reduce((sum, file) => sum + file.additions, 0);
    const del = files.reduce((sum, file) => sum + file.deletions, 0);
    return countColumnVars(add, del);
  }, [files]);

  // A path changed twice (a symlink turned into a file) has two rows: a screen reader tells them apart by the change.
  const doubled = useMemo(() => {
    const paths = new Set<string>();
    const twice = new Set<string>();
    for (const file of files) (paths.has(file.path) ? twice : paths).add(file.path);
    return twice;
  }, [files]);

  const fileRow = (file: DiffFile, name: string, depth: number, key: string) => {
    const seen = viewed.has(file.path);
    return (
      <li key={key}>
        <button type="button" className="file-tree-item ib-rv-file" style={{ paddingLeft: indent(depth) }} aria-label={`${file.path}${doubled.has(file.path) ? `, ${file.status}` : ''}${seen ? ', viewed' : ''}`} data-review-file={file.path} onClick={() => onSelect(file.path)}>
          <span className="ib-rv-file-main">
            <ViewedControl isViewed={seen} name={file.path} onToggle={() => onToggleViewed(file.path)} />
            <span className="ib-rv-letter">
              <ChangeTypeLetter status={file.status} oldPath={file.oldPath} />
            </span>
            <RowName name={name} path={file.path} />
            <AnnotationBadge count={commentCount(file.path)} />
          </span>
          <CountColumns additions={file.additions} deletions={file.deletions} />
        </button>
      </li>
    );
  };

  const rows = (nodes: DiffFileTreeNode<DiffFile>[]): React.ReactNode =>
    nodes.map((node) => {
      if (node.type === 'file') return fileRow(node.file!, node.name, node.depth, node.path);
      const open = expandedFolders.has(node.path);
      return (
        <li key={`dir:${node.path}`} data-review-folder={node.path}>
          <button type="button" className="ib-rv-tree-folder" style={{ paddingLeft: indent(node.depth) }} aria-expanded={open} aria-label={node.path} onClick={() => toggleFolder(node.path)}>
            <svg className={`w-3 h-3 flex-shrink-0 ${open ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            <RowName name={node.name} path={node.path} />
            <CountColumns additions={node.additions} deletions={node.deletions} tone="quiet" />
          </button>
          {open && node.children && <ul className="ib-rv-list">{rows(node.children)}</ul>}
        </li>
      );
    });

  return (
    <ul className="ib-rv-list" data-review-files="" style={columns}>
      {rows(tree)}
      {loose.map((file, index) => fileRow(file, file.path, 0, `loose:${index}:${file.path}`))}
    </ul>
  );
}
