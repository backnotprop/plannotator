/**
 * The shapes of the PR page's All files parts (`guide/PullRepoParts.tsx`, in the reader's chunk), for the window's
 * strict typecheck (`guide/reader-module.d.ts`) and the parts alike.
 */
import type { ReactNode } from 'react';
import type { DiffFile } from '@plannotator/core/diff-files';
import type { CodeAnnotation } from '@plannotator/ui/types';

export interface PullAllFilesProps {
  /** The PR's key in the list. */
  pullKey: string;
  /** The head commit the patch on screen was read at (or the list's): what All files lists. */
  sha: string;
  /** The PR's changed files: they keep their rows, letters, counts and Viewed circles. */
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
  onToggleViewed: (path: string) => void;
}

export interface PullRepoFileProps {
  pullKey: string;
  sha: string;
  path: string;
}
