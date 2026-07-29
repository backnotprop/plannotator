import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  EslintCheckOkResponse,
  EslintCheckResponse,
  EslintDiagnostic,
} from '@plannotator/shared/eslint-check-types';
import { useReviewState } from '../ReviewStateContext';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; data: EslintCheckOkResponse }
  | { status: 'error'; message: string };

function DiagnosticRow({ diagnostic, onOpen }: { diagnostic: EslintDiagnostic; onOpen: () => void }) {
  const isError = diagnostic.severity === 2;
  const severityClass = isError
    ? 'bg-destructive/15 text-destructive'
    : 'bg-warning/15 text-warning';
  const severityLabel = isError ? 'Error' : 'Warning';

  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-md px-2 py-2 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <div className="flex items-start gap-2">
        <span className={`mt-0.5 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${severityClass}`}>
          {severityLabel}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-xs leading-5 text-foreground">{diagnostic.message}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-muted-foreground">
            <span>{diagnostic.line}:{diagnostic.column}</span>
            {diagnostic.ruleId && <span>{diagnostic.ruleId}</span>}
            {diagnostic.fixable && <span className="text-primary/70">fix available</span>}
            {!diagnostic.onChangedLine && <span>outside changed lines</span>}
          </div>
        </div>
      </div>
    </button>
  );
}

export function ReviewEslintCheckPanel() {
  const {
    snapshotId,
    eslintCheckAvailable,
    openDiffFile,
    onLineSelection,
  } = useReviewState();
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' });
  const [retryCount, setRetryCount] = useState(0);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!eslintCheckAvailable || !snapshotId) {
      setLoadState({ status: 'error', message: 'ESLint is unavailable for this review snapshot.' });
      return;
    }

    const controller = new AbortController();

    setLoadState({ status: 'loading' });

    fetch('/api/eslint-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotId }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json() as EslintCheckResponse;
        if (data.status === 'ok') return data;
        throw new Error(data.message);
      })
      .then((data) => {
        if (!controller.signal.aborted) setLoadState({ status: 'ready', data });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setLoadState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
      });

    return () => controller.abort();
  }, [eslintCheckAvailable, retryCount, snapshotId]);

  const visibleDiagnostics = useMemo(() => {
    if (loadState.status !== 'ready') return [];
    if (showAll) return loadState.data.diagnostics;
    return loadState.data.diagnostics.filter((diagnostic) => diagnostic.onChangedLine);
  }, [loadState, showAll]);

  const groupedDiagnostics = useMemo(() => {
    const groups = new Map<string, EslintDiagnostic[]>();

    for (const diagnostic of visibleDiagnostics) {
      const group = groups.get(diagnostic.filePath) ?? [];

      group.push(diagnostic);
      groups.set(diagnostic.filePath, group);
    }

    return [...groups.entries()];
  }, [visibleDiagnostics]);

  const openDiagnostic = useCallback((diagnostic: EslintDiagnostic) => {
    openDiffFile(diagnostic.filePath);

    onLineSelection({
      start: diagnostic.line,
      end: diagnostic.endLine && diagnostic.endLine >= diagnostic.line ? diagnostic.endLine : diagnostic.line,
      side: 'additions',
    });
  }, [onLineSelection, openDiffFile]);

  if (loadState.status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground" aria-live="polite">
        <span className="mr-2 h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted border-t-primary" />
        Running the project's ESLint…
      </div>
    );
  }

  if (loadState.status === 'error') {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md text-center">
          <div className="text-sm font-medium text-foreground">ESLint could not run</div>
          <div className="mt-2 text-xs leading-5 text-muted-foreground">{loadState.message}</div>
          <button
            type="button"
            onClick={() => setRetryCount((count) => count + 1)}
            className="mt-4 rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-muted"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const { summary, eslintVersions } = loadState.data;
  const changedCount = summary.changedLineErrors + summary.changedLineWarnings;
  const totalCount = summary.errors + summary.warnings;
  const noVisibleDiagnostics = visibleDiagnostics.length === 0;
  const toggleLabel = showAll ? 'Changed lines only' : 'Show all in changed files';
  const fileLabel = summary.files === 1 ? 'file' : 'files';
  const errorLabel = summary.changedLineErrors === 1 ? 'error' : 'errors';
  const warningLabel = summary.changedLineWarnings === 1 ? 'warning' : 'warnings';
  const hasHiddenDiagnostics = !showAll && totalCount > changedCount;
  const noFindingsTitle = showAll ? 'No ESLint findings' : 'No ESLint findings on changed lines';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/50 px-3 py-2 text-xs">
        <span className="font-medium text-foreground">
          {summary.changedLineErrors} {errorLabel} · {summary.changedLineWarnings} {warningLabel} on changed lines
        </span>
        <span className="text-muted-foreground">{totalCount} total</span>
        <button
          type="button"
          onClick={() => setShowAll((value) => !value)}
          className="ml-auto rounded-md border border-border px-2 py-1 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {toggleLabel}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {groupedDiagnostics.map(([filePath, diagnostics]) => (
          <section key={filePath} className="mb-3 overflow-hidden rounded-lg border border-border/50 bg-card/30">
            <header className="border-b border-border/40 px-3 py-2 font-mono text-[11px] text-muted-foreground">{filePath}</header>
            <div className="divide-y divide-border/30 px-1 py-1">
              {diagnostics.map((diagnostic, index) => (
                <DiagnosticRow
                  key={`${diagnostic.line}:${diagnostic.column}:${diagnostic.ruleId ?? 'parser'}:${index}`}
                  diagnostic={diagnostic}
                  onOpen={() => openDiagnostic(diagnostic)}
                />
              ))}
            </div>
          </section>
        ))}
        {noVisibleDiagnostics && (
          <div className="flex h-full min-h-48 items-center justify-center text-center">
            <div>
              <div className="text-sm font-medium text-success">{noFindingsTitle}</div>
              {hasHiddenDiagnostics && (
                <button type="button" onClick={() => setShowAll(true)} className="mt-2 text-xs text-primary hover:underline">
                  View {totalCount - changedCount} elsewhere in changed files
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-border/50 px-3 py-1.5 text-[10px] text-muted-foreground">
        ESLint {eslintVersions.join(', ')} · {summary.files} {fileLabel} with findings
      </div>
    </div>
  );
}
