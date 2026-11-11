import type { ReactNode } from 'react';
import type { DiffFile } from '@plannotator/core/diff-files';
import type { CodeAnnotation } from '@plannotator/ui/types';

export interface PullAllFilesProps {
  pullKey: string;
  sha: string;
  files: readonly DiffFile[];
  viewed: ReadonlySet<string>;
  comments: readonly CodeAnnotation[];
  activePath: string | null;
  openPath: string | null;
  head: ReactNode;
  onSelect: (path: string) => void;
  onOpen: (path: string) => void;
  onToggleViewed: (path: string) => void;
}

export interface PullRepoFileProps {
  pullKey: string;
  sha: string;
  path: string;
}
