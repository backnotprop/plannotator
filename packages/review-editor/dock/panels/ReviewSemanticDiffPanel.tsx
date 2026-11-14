import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  SemanticDiffBinaryChange,
  SemanticDiffChange,
  SemanticDiffResponse,
} from '@plannotator/shared/semantic-diff-types';
import { useReviewState } from '../ReviewStateContext';
import { loadReviewSemanticDiff } from '../../semDiff/semanticDiffSource';
import { useReviewFileSource } from '../../hooks/useReviewFileSource';
import {
  SemanticDiffRows,
  groupSemanticChangesByFile,
  lineSelectionForChange,
  type SemanticOpenLine,
} from './semanticDiffShared';

type SemanticDiffOkResponse = Extract<SemanticDiffResponse, { status: 'ok' }>;
type SemanticDiffErrorResponse = Extract<SemanticDiffResponse, { status: 'error' }>;

type LoadState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; data: SemanticDiffOkResponse }
  | { status: 'empty'; data: SemanticDiffOkResponse }
  | { status: 'error'; error: SemanticDiffErrorResponse | Error };

const UNREAD_REASON: Record<string, string> = {
  generated: 'generated file, skipped',
  'too-large': 'too large to read',
  unreadable: 'could not be loaded',
  'timed-out': 'took too long',
};

function unreadLine(data: SemanticDiffOkResponse): { text: string; detail: string } | null {
  const unread = data.unreadFiles ?? [];
  if (unread.length === 0) return null;
  return {
    text: `Couldn't read ${unread.length} ${unread.length === 1 ? 'file' : 'files'}`,
    detail: unread.map((file) => `${file.path}: ${UNREAD_REASON[file.reason] ?? file.reason}`).join('\n'),
  };
}

const SUMMARY_ORDER = ['moved', 'moved & edited', 'renamed', 'reformatted', 'extracted', 'inlined', 'reordered', 'modified', 'added', 'deleted'];
const SUMMARY_WORD: Record<string, string> = { modified: 'edited' };

function formatSummary(data: SemanticDiffOkResponse): string {
  const counts = new Map<string, number>();
  for (const change of data.changes) counts.set(change.changeType, (counts.get(change.changeType) ?? 0) + 1);
  const kinds = [...SUMMARY_ORDER.filter((kind) => counts.has(kind)), ...[...counts.keys()].filter((kind) => !SUMMARY_ORDER.includes(kind))];
  const parts = kinds.map((kind) => `${counts.get(kind)} ${SUMMARY_WORD[kind] ?? kind}`);
  if (data.summary.binary > 0) parts.push(`${data.summary.binary} binary`);
  if (data.summary.orphan > 0) parts.push(`${data.summary.orphan} orphans`);
  return `Summary: ${parts.join(', ') || 'nothing'} across ${data.summary.fileCount} files`;
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
  const loadSource = useReviewFileSource(state);
  const {
    rawPatch,
    semanticDiffAvailable,
    onSemanticDiffUnavailable,
    onSemanticDiffLoadError,
    onSemanticDiffLoadSuccess,
    openDiffFile,
    onLineSelection,
    revealInAllChanges,
    openRepoFileAt,
    powerUp,
    rejectPowerUpLink,
  } = state;
  const [loadState, setLoadState] = useState<LoadState>({ status: 'idle' });
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (!semanticDiffAvailable) return;

    const controller = new AbortController();
    setLoadState({ status: 'loading' });

    loadReviewSemanticDiff(controller.signal)
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
    powerUp,
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
    const range = lineSelectionForChange(change);
    if (revealInAllChanges && range) {
      revealInAllChanges(change.filePath, range);
      return;
    }
    openDiffFile(change.filePath);
    onLineSelection(range);
  }, [openDiffFile, onLineSelection, revealInAllChanges]);
  const openLine = useMemo<SemanticOpenLine | undefined>(
    () => (revealInAllChanges ? (path, line, side) => revealInAllChanges(path, { start: line, end: line, side }) : undefined),
    [revealInAllChanges],
  );

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

  if (loadState.status !== 'ready' && loadState.status !== 'empty') return null;
  const { data } = loadState;
  const unread = unreadLine(data);

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
                loadSource={loadSource}
                onOpenLine={openLine}
                onOpenFile={openRepoFileAt}
                onReject={rejectPowerUpLink}
              />
            </div>
          </section>
        ))}

        {loadState.status === 'empty' && (
          <div className="semantic-diff-empty">
            {data.unreadFiles?.length ? 'No semantic changes found in the files that could be read.' : 'No semantic changes found.'}
          </div>
        )}
        {unread && (
          <div className="semantic-diff-unread" title={unread.detail} data-semantic-unread={data.unreadFiles!.length}>
            {unread.text}
          </div>
        )}
        <div className="semantic-diff-summary">{formatSummary(data)}</div>
      </div>
    </div>
  );
}
