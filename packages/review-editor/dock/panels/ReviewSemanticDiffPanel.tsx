import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  SemanticDiffBinaryChange,
  SemanticDiffChange,
  SemanticDiffResponse,
} from '@plannotator/shared/semantic-diff-types';
import { useReviewState } from '../ReviewStateContext';
import {
  SemanticDiffRows,
  groupSemanticChangesByFile,
  lineSelectionForChange,
} from './semanticDiffShared';

type SemanticDiffOkResponse = Extract<SemanticDiffResponse, { status: 'ok' }>;
type SemanticDiffErrorResponse = Extract<SemanticDiffResponse, { status: 'error' }>;

type LoadState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; data: SemanticDiffOkResponse }
  | { status: 'empty'; data: SemanticDiffOkResponse }
  | { status: 'error'; error: SemanticDiffErrorResponse | Error };

function formatSummary(data: SemanticDiffOkResponse): string {
  const summary = data.summary;
  const parts = [
    `${summary.added} added`,
    `${summary.modified} modified`,
    `${summary.deleted} deleted`,
  ];
  if (summary.renamed > 0) parts.push(`${summary.renamed} renamed`);
  if (summary.moved > 0) parts.push(`${summary.moved} moved`);
  if (summary.reordered > 0) parts.push(`${summary.reordered} reordered`);
  if (summary.binary > 0) parts.push(`${summary.binary} binary`);
  if (summary.orphan > 0) parts.push(`${summary.orphan} orphans`);
  return `Summary: ${parts.join(', ')} across ${summary.fileCount} files`;
}

function formatLoadError(error: SemanticDiffErrorResponse | Error): string {
  return error.message || 'Semantic diff failed.';
}

function splitFilePath(filePath: string): { dir: string; name: string } {
  const lastSlash = filePath.lastIndexOf('/');
  if (lastSlash === -1) return { dir: '', name: filePath };
  return { dir: filePath.slice(0, lastSlash + 1), name: filePath.slice(lastSlash + 1) };
}

export function ReviewSemanticDiffPanel() {
  const state = useReviewState();
  const {
    rawPatch,
    semanticDiffAvailable,
    onSemanticDiffUnavailable,
    onSemanticDiffLoadError,
    onSemanticDiffLoadSuccess,
    openDiffFile,
    onLineSelection,
  } = state;
  const [loadState, setLoadState] = useState<LoadState>({ status: 'idle' });
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (!semanticDiffAvailable) return;

    const controller = new AbortController();
    setLoadState({ status: 'loading' });

    fetch('/api/semantic-diff', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error('Semantic diff failed');
        return res.json() as Promise<SemanticDiffResponse>;
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        if (data.status === 'unavailable') {
          onSemanticDiffUnavailable();
          return;
        }
        if (data.status === 'error') {
          if (onSemanticDiffLoadError()) return;
          setLoadState({ status: 'error', error: data });
          return;
        }
        onSemanticDiffLoadSuccess();
        setLoadState(data.changes.length === 0 && data.binaryChanges.length === 0
          ? { status: 'empty', data }
          : { status: 'ready', data });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        console.error('Failed to load semantic diff:', error);
        if (onSemanticDiffLoadError()) return;
        setLoadState({ status: 'error', error: error instanceof Error ? error : new Error(String(error)) });
      });

    return () => controller.abort();
  }, [
    rawPatch,
    retryCount,
    semanticDiffAvailable,
    onSemanticDiffUnavailable,
    onSemanticDiffLoadError,
    onSemanticDiffLoadSuccess,
  ]);

  const groupedChanges = useMemo(() => {
    if (loadState.status !== 'ready' && loadState.status !== 'empty') return [];
    return groupSemanticChangesByFile(loadState.data.changes, loadState.data.binaryChanges);
  }, [loadState]);

  const openChange = useCallback((change: SemanticDiffChange) => {
    openDiffFile(change.filePath);
    onLineSelection(lineSelectionForChange(change));
  }, [openDiffFile, onLineSelection]);

  const openBinaryChange = useCallback((change: SemanticDiffBinaryChange) => {
    openDiffFile(change.filePath);
    onLineSelection(null);
  }, [openDiffFile, onLineSelection]);

  if (!semanticDiffAvailable) return null;

  if (loadState.status === 'idle' || loadState.status === 'loading') {
    return (
      <div className="semantic-diff-panel">
        <div className="semantic-diff-terminal" aria-live="polite">
          <div className="semantic-diff-loading">Running semantic diff...</div>
        </div>
      </div>
    );
  }

  if (loadState.status === 'error') {
    return (
      <div className="semantic-diff-panel">
        <div className="semantic-diff-terminal" aria-live="polite">
          <div className="semantic-diff-error" role="alert">
            Semantic diff failed: {formatLoadError(loadState.error)}
          </div>
          <button
            type="button"
            className="semantic-diff-retry"
            onClick={() => setRetryCount((count) => count + 1)}
          >
            ↻ retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="semantic-diff-panel">
      <div className="semantic-diff-terminal" aria-label="Semantic diff">
        {groupedChanges.map((group) => (
          <section className="semantic-diff-file" key={group.filePath}>
            <header className="semantic-diff-file-header">
              <span className="semantic-diff-path" title={group.filePath}>
                {(() => {
                  const { dir, name } = splitFilePath(group.filePath);
                  return (
                    <>
                      {dir && <span className="semantic-diff-path-dir">{dir}</span>}
                      <span className="semantic-diff-path-name">{name}</span>
                    </>
                  );
                })()}
              </span>
            </header>
            <div className="semantic-diff-rows">
              <SemanticDiffRows
                changes={group.changes}
                binaryChanges={group.binaryChanges}
                onOpenChange={openChange}
                onOpenBinary={openBinaryChange}
              />
            </div>
          </section>
        ))}

        {loadState.status === 'empty' && (
          <div className="semantic-diff-empty">No semantic changes found.</div>
        )}
        <div className="semantic-diff-summary">{formatSummary(loadState.data)}</div>
      </div>
    </div>
  );
}
