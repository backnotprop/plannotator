import { useState, useCallback, useMemo, useRef } from 'react';

interface UseGitAddOptions {
  activeDiffBase: string;
  onFileViewed: (filePath: string) => void;
  sidecarStaged?: ReadonlySet<string>;
}

interface UseGitAddReturn {
  stagedFiles: Set<string>;
  stagingFile: string | null;
  canStageFiles: boolean;
  stageFile: (filePath: string) => Promise<void>;
  resetStagedFiles: () => void;
  stageError: string | null;
}

const STAGEABLE_DIFF_TYPES = new Set(['since-base', 'local-vs-remote', 'uncommitted', 'unstaged', 'workspace-current', 'workspace-unstaged']);

export function useGitAdd({ activeDiffBase, onFileViewed, sidecarStaged }: UseGitAddOptions): UseGitAddReturn {
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

  const resetStagedFiles = useCallback(() => {
    setOverrides(new Map());
    setStageError(null);
    clearTimeout(errorTimeoutRef.current);
  }, []);

  return { stagedFiles, stagingFile, canStageFiles, stageFile, resetStagedFiles, stageError };
}
