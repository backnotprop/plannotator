/**
 * The shapes of the PR page's rail parts (`guide/PullRepoParts.tsx`, `guide/PullChangesTree.tsx`, in the reader's chunk), for the window's
 * strict typecheck (`guide/reader-module.d.ts`) and the parts alike.
 */
import type { ReactNode, Ref } from 'react';
import type { DiffFile } from '@plannotator/core/diff-files';
import type { CodeAnnotation } from '@plannotator/ui/types';

export interface PullAllFilesProps {
  /** The PR's key in the list. */
  pullKey: string;
  /** The head commit the patch on screen was read at (or the list's): what All files lists. */
  sha: string;
  /** The PR's changed files: they keep their rows, letters and counts, dimmed once viewed. */
  files: readonly DiffFile[];
  viewed: ReadonlySet<string>;
  comments: readonly CodeAnnotation[];
  /** The changed file last picked, highlighted. */
  activePath: string | null;
  /** The file of the repository open in place of the diff, highlighted. */
  openPath: string | null;
  /** The rail's head row: the switch, and the viewed count. */
  head: ReactNode;
  /** A changed file: the diff, on it. */
  onSelect: (path: string) => void;
  /** A file the PR does not change: shown whole in place of the diff. */
  onOpen: (path: string) => void;
  handleRef?: Ref<PullChangesTreeHandle>;
  /** The risk bars' files (pulls/riskBars.ts): each one's row has the mark before its icon. Absent: none. */
  risk?: PullTreeRisk | null;
}

/** The files a High or Medium judgment names, for the tree's risk bars. */
export interface PullTreeRisk {
  level: 'high' | 'medium';
  files: ReadonlySet<string>;
}

export interface PullRepoFileProps {
  pullKey: string;
  sha: string;
  path: string;
}

export interface PullChangesTreeHandle {
  focus: () => void;
}

export interface PullChangesTreeProps {
  files: readonly DiffFile[];
  viewed: ReadonlySet<string>;
  showViewed: boolean;
  comments: readonly { filePath: string }[];
  threadCount?: (path: string) => number;
  activePath: string | null;
  head: ReactNode;
  onSelect: (path: string, how?: { via: 'focus' }) => void;
  handleRef?: Ref<PullChangesTreeHandle>;
  /** The risk bars' files: each one's row has the mark before its icon. Absent: none. */
  risk?: PullTreeRisk | null;
}
