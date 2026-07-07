import { useState, useCallback, useMemo, useRef } from 'react';

interface UseGitAddOptions {
  activeDiffBase: string;
  onFileViewed: (filePath: string) => void;
  /** Paths already staged per the server's sections sidecar (since-base).
   *  Folded into the effective staged set so files `git add`-ed BEFORE the
   *  review opened toggle correctly — the session alone can't know them. */
  sidecarStaged?: ReadonlySet<string>;
}

interface UseGitAddReturn {
  /** EFFECTIVE staged set: sidecar ∪ session stages − session unstages.
   *  The single truth every surface renders (sidebar dot, tree, all-files
   *  header, counts) — no consumer should OR in sidecar state itself. */
  stagedFiles: Set<string>;
  stagingFile: string | null;
  canStageFiles: boolean;
  stageFile: (filePath: string) => Promise<void>;
  resetStagedFiles: () => void;
  stageError: string | null;
}

const STAGEABLE_DIFF_TYPES = new Set(['since-base', 'uncommitted', 'unstaged', 'workspace-current', 'workspace-unstaged']);

export function useGitAdd({ activeDiffBase, onFileViewed, sidecarStaged }: UseGitAddOptions): UseGitAddReturn {
  // Session intent per path: true = staged this session, false = unstaged
  // this session. Tri-state (absent = defer to sidecar) — a plain "staged
  // set" can't represent unstaging a file that was staged before the review
  // opened, which left the first `a` press as a git-add no-op and the
  // staged dot stuck on after a real unstage.
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());
  const [stagingFile, setStagingFile] = useState<string | null>(null);
  const [stageError, setStageError] = useState<string | null>(null);
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const canStageFiles = STAGEABLE_DIFF_TYPES.has(activeDiffBase);

  const stagedFiles = useMemo(() => {
    const next = new Set<string>(sidecarStaged ?? []);
    for (const [path, staged] of overrides) {
      if (staged) next.add(path);
      else next.delete(path);
    }
    return next;
  }, [overrides, sidecarStaged]);

  // Ref so stageFile doesn't need stagedFiles in its dependency array
  const stagedFilesRef = useRef(stagedFiles);
  stagedFilesRef.current = stagedFiles;

  const stageFile = useCallback(async (filePath: string) => {
    const isUndo = stagedFilesRef.current.has(filePath);
    setStagingFile(filePath);
    setStageError(null);
    clearTimeout(errorTimeoutRef.current);

    try {
      const res = await fetch('/api/git-add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath, undo: isUndo }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed' }));
        throw new Error(data.error || 'Failed');
      }

      setOverrides(prev => new Map(prev).set(filePath, !isUndo));

      // Auto-mark as viewed on stage (not on unstage)
      if (!isUndo) {
        onFileViewed(filePath);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Git add failed';
      setStageError(message);
      errorTimeoutRef.current = setTimeout(() => setStageError(null), 3000);
    } finally {
      setStagingFile(null);
    }
  }, [onFileViewed]);

  // Clear session intent — call whenever a FRESH sidecar arrives (diff
  // switch / refresh): the new porcelain snapshot already reflects every
  // stage/unstage this session performed, so stale overrides would fight it.
  const resetStagedFiles = useCallback(() => {
    setOverrides(new Map());
    setStageError(null);
    clearTimeout(errorTimeoutRef.current);
  }, []);

  return { stagedFiles, stagingFile, canStageFiles, stageFile, resetStagedFiles, stageError };
}
