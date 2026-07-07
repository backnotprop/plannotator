/**
 * Change type derived from the diff's metadata lines. 'modified' is the
 * default and is deliberately NOT decorated in the UI (mirroring Pierre's
 * diffshub: most files are modifications, so only A/D/R stand out).
 */
export type DiffFileStatus = 'added' | 'deleted' | 'renamed' | 'modified';

export interface DiffFile {
  path: string;
  oldPath?: string;
  patch: string;
  additions: number;
  deletions: number;
  status: DiffFileStatus;
}

/**
 * A "scroll the diff to this comment" request, distinct from mere selection so
 * that clicking a comment in the diff (select/highlight) never moves the
 * viewport while a sidebar / findings-list click (navigate) does. The `token`
 * bumps on every navigate so re-selecting the same comment re-fires the scroll.
 */
export interface AnnotationScrollTarget {
  id: string;
  token: number;
}
