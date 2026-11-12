import { useCallback, useEffect, useRef } from 'react';
import { normalizeBrowserPath } from '../sourceDocumentPaths';

// Past the 100ms timeout on which useLinkedDoc re-applies restored highlights.
const SELECT_AFTER_COMMIT_MS = 160;
/** A navigation that never commits must not leave a selection pending forever. */
const COMMIT_TIMEOUT_MS = 5000;

/** Path equality across spellings: on Windows the panel and the host spell the same path differently. */
function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  return normalizeBrowserPath(a) === normalizeBrowserPath(b);
}

export interface AnnotationJumpOptions {
  currentPath: string | null;
  navigate: (path: string) => void | Promise<void>;
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
