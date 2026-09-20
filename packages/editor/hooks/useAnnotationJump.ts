/**
 * Jump to an annotation that lives in another document.
 *
 * Navigation is asynchronous and the destination's annotations are re-applied
 * to the DOM a beat after it commits, so selecting the target id immediately
 * after requesting the navigation lands on the old document (or on a document
 * whose highlights are not painted yet, where the scroll-to-selected effect
 * finds nothing and gives up). This waits for the commit that makes the target
 * the open document — the same waiter shape `reveal { path }` uses in
 * packages/editor/webmcp — and only then selects.
 */

import { useCallback, useEffect, useRef } from 'react';
import { normalizeBrowserPath } from '../sourceDocumentPaths';

/** Grace for the destination's restored highlights to paint before we scroll
 *  to one. useLinkedDoc re-applies them on a 100ms timeout. */
const SELECT_AFTER_COMMIT_MS = 160;
/** A navigation that never commits must not leave a selection pending forever. */
const COMMIT_TIMEOUT_MS = 5000;

/** Path equality across spellings (Windows separators, doubled slashes). */
function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  return normalizeBrowserPath(a) === normalizeBrowserPath(b);
}

export interface AnnotationJumpOptions {
  /** Path of the document that is open right now. */
  currentPath: string | null;
  /** Ask the host to open `path` (the file browser's own selection path). */
  navigate: (path: string) => void | Promise<void>;
  /** Select an annotation in the document that is open. */
  select: (id: string) => void;
  selectAfterCommitMs?: number;
  commitTimeoutMs?: number;
}

/**
 * Returns `jump(path, id)`: selects in place when `path` is already open,
 * otherwise navigates and selects once the document commits.
 */
export function useAnnotationJump(options: AnnotationJumpOptions): (path: string, id: string) => void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const pendingRef = useRef<{ path: string; id: string } | null>(null);
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  const clearTimers = () => {
    for (const timer of timersRef.current) clearTimeout(timer);
    timersRef.current = [];
  };

  const jump = useCallback((path: string, id: string) => {
    const { currentPath, navigate, select } = optionsRef.current;
    // The panel addresses documents by their normalized path while the host
    // carries the raw server spelling; on Windows those differ, and comparing
    // them raw made every same-document jump navigate instead of selecting.
    if (samePath(path, currentPath)) {
      select(id);
      return;
    }
    clearTimers();
    pendingRef.current = { path, id };
    timersRef.current.push(setTimeout(() => {
      // Never committed — drop the request rather than selecting an id that
      // does not exist in whatever document is open now.
      if (samePath(pendingRef.current?.path, path)) pendingRef.current = null;
    }, optionsRef.current.commitTimeoutMs ?? COMMIT_TIMEOUT_MS));
    void Promise.resolve(navigate(path)).catch(() => {
      if (samePath(pendingRef.current?.path, path)) pendingRef.current = null;
    });
  }, []);

  // The commit that makes the requested document the open one.
  const currentPath = options.currentPath;
  useEffect(() => {
    const pending = pendingRef.current;
    if (!pending || !samePath(pending.path, currentPath)) return;
    pendingRef.current = null;
    clearTimers();
    const delay = optionsRef.current.selectAfterCommitMs ?? SELECT_AFTER_COMMIT_MS;
    const timer = setTimeout(() => optionsRef.current.select(pending.id), delay);
    timersRef.current.push(timer);
  }, [currentPath]);

  useEffect(() => () => {
    for (const timer of timersRef.current) clearTimeout(timer);
    timersRef.current = [];
    pendingRef.current = null;
  }, []);

  return jump;
}
