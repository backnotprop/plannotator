export type { DiffFile, DiffFileStatus } from '@plannotator/guide-viewer/types';

/**
 * A "scroll the diff to this comment" request, distinct from mere selection so that clicking a
 * comment in the diff (select/highlight) never moves the viewport while a sidebar / findings-list
 * click (navigate) does.
 */
export interface AnnotationScrollTarget {
  id: string;
  token: number;
}
