import React, { useEffect, useRef, useState } from 'react';
import type { CallFlowAdvert, CallFlowInstallStage, CallFlowNode } from '@plannotator/shared/call-flow-types';
import { getCallFlowLanguage, type CallFlowLanguageId } from '@plannotator/shared/call-flow-languages';
import type { CallFlowInstallController } from '../../hooks/useCallFlowInstall';
import { Check, Copy, Info } from 'lucide-react';
import { Tooltip } from '@plannotator/ui/components/Tooltip';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { useReviewState } from '../ReviewStateContext';
import {
  annotationSelectionForCallFlowNode,
  CallFlowTreeView,
  selectionForCallFlowNode,
} from '../../components/CallFlowTreeView';

function errorMessage(error: Exclude<import('@plannotator/shared/call-flow-types').CallFlowResponse, { status: 'ok' }> | Error): string {
  return error.message || 'Call-flow analysis failed.';
}

const INSTALL_STAGES: ReadonlyArray<{ id: CallFlowInstallStage; label: string }> = [
  { id: 'downloading', label: 'Downloading pinned packages' },
  { id: 'verifying', label: 'Verifying package integrity' },
  { id: 'installing-deps', label: 'Installing pinned dependencies' },
  { id: 'building', label: 'Preparing native runtime' },
];

function isNodeInstallError(reason: string | undefined): boolean {
  return reason === 'node-unavailable' || reason === 'node-version';
}

function formatInstallSize(bytes: number): string {
  const megabytes = Math.ceil(bytes / (1024 * 1024));
  return `~${megabytes.toLocaleString()} MB`;
}

function installFailedForLanguage(
  status: CallFlowInstallController['status'],
  languageId: CallFlowLanguageId,
): status is Extract<CallFlowInstallController['status'], { state: 'error' }> {
  if (status.state !== 'error') return false;
  if (status.currentLanguageId) return status.currentLanguageId === languageId;
  return status.languageIds?.includes(languageId) === true;
}

/**
 * Opt-in install funnel shown only for the runtime-missing flavor of an
 * unavailable advert. Never rendered for unsupported views or while the
 * feature is disabled.
 */
export function CallFlowInstallFunnel({
  advert,
  install,
}: {
  readonly advert: CallFlowAdvert;
  readonly install: CallFlowInstallController;
}) {
  const { status } = install;
  if (status.state === 'running' || status.state === 'done') {
    const activeIndex = status.state === 'done'
      ? INSTALL_STAGES.length
      : INSTALL_STAGES.findIndex((stage) => stage.id === status.stage);
    return (
      <div className="call-flow-panel" aria-live="polite">
        <div className="call-flow-shell call-flow-install call-flow-empty" role="status">
          <span className="call-flow-empty-kicker">Installing runtime</span>
          <strong>
            {status.state === 'done'
              ? 'Install complete. Starting call-flow analysis.'
              : 'Setting up the call-flow runtime.'}
          </strong>
          {status.state === 'running' && status.currentLanguageId && (
            <p>{getCallFlowLanguage(status.currentLanguageId).label}</p>
          )}
          <ol className="call-flow-install-stages">
            {INSTALL_STAGES.map((stage, index) => {
              const stageState = index < activeIndex ? 'complete' : index === activeIndex ? 'active' : 'pending';
              return (
                <li key={stage.id} data-stage={stage.id} data-stage-state={stageState}>
                  {stageState === 'complete' ? (
                    <Check aria-hidden="true" size={13} strokeWidth={2} />
                  ) : stageState === 'active' ? (
                    <span className="call-flow-spinner call-flow-spinner-small" aria-hidden="true" />
                  ) : (
                    <span className="call-flow-install-stage-dot" aria-hidden="true" />
                  )}
                  <span>{stage.label}</span>
                  {stageState === 'active' && <span className="sr-only"> (in progress)</span>}
                </li>
              );
            })}
          </ol>
          <p>This can take a few minutes. The review stays fully usable while it runs.</p>
        </div>
      </div>
    );
  }
  if (status.state === 'error') {
    return (
      <div className="call-flow-panel">
        <div className="call-flow-shell call-flow-install call-flow-empty" role="alert">
          <span className="call-flow-empty-kicker">Install failed</span>
          <strong>{status.error}</strong>
          <p>
            {isNodeInstallError(status.reason)
              ? 'Install Node.js 22 or newer, make sure it is on PATH, then retry.'
              : 'Nothing was changed. You can retry the install at any time.'}
          </p>
          <button type="button" className="call-flow-retry" onClick={() => install.start()}>
            Retry install
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="call-flow-panel">
      <div className="call-flow-shell call-flow-install call-flow-empty">
        <span className="call-flow-empty-kicker">Optional runtime not installed</span>
        <strong>Trace how changed calls reach the rest of the codebase.</strong>
        <p>
          Call flow reconstructs the complete inferred entry paths that contain added or
          removed calls, so a change can be reviewed in the context of everything that
          reaches it. It runs locally against the review&apos;s exact Git snapshots.
        </p>
        {advert.installPlan && (
          <p className="call-flow-install-disclosure">
            One-time install: {advert.installPlan.labels.join(', ')} · {formatInstallSize(advert.installPlan.installSizeBytes)} on disk.
            {' '}Requires Node.js 22 or newer.
          </p>
        )}
        {advert.message && advert.reason !== 'runtime-unavailable' && (
          <p className="call-flow-install-detail">{advert.message}</p>
        )}
        <button type="button" className="call-flow-retry" onClick={() => install.start()}>
          Install runtime
        </button>
      </div>
    </div>
  );
}

export function ReviewCallFlowPanel() {
  const state = useReviewState();
  const analysis = state.callFlowAnalysis;
  const [view, setView] = useState<'paths' | 'raw'>('paths');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
  }, []);

  const openNode = (node: CallFlowNode) => {
    if (!node.file) return;
    state.openDiffFile(node.file);
    state.onLineSelection(selectionForCallFlowNode(node));
  };
  const commentOnNode = (node: CallFlowNode) => {
    if (!node.file) return;
    const range = annotationSelectionForCallFlowNode(node);
    if (!range) return;
    state.onRequestLineAnnotation(node.file, range);
  };

  if (!state.callFlowAdvert.available) {
    // The runtime-missing flavor of unavailable is the opt-in install funnel.
    // Unsupported views and the disabled state never offer the install.
    if (state.callFlowAdvert.state === 'unavailable' && state.callFlowAdvert.installable && state.callFlowAdvert.installPlan) {
      return <CallFlowInstallFunnel advert={state.callFlowAdvert} install={state.callFlowInstall} />;
    }
    const recovery = state.callFlowAdvert.state === 'unsupported'
      ? state.callFlowAdvert.reason === 'demo-mode'
        ? 'Launch a review through Plannotator to analyze its Git snapshots.'
        : 'Choose a supported local Git review view to run this analysis.'
      : 'The ordinary code diff remains available.';
    return (
      <div className="call-flow-panel">
        <div className="call-flow-shell call-flow-empty" role="status">
          <span className="call-flow-empty-kicker">
            {state.callFlowAdvert.state === 'unsupported' ? 'Not supported in this view' : 'Call flow unavailable'}
          </span>
          <strong>{state.callFlowAdvert.message ?? 'Call flow is not available.'}</strong>
          <p>{recovery}</p>
        </div>
      </div>
    );
  }
  if (analysis.status === 'idle' || analysis.status === 'loading') {
    return (
      <div className="call-flow-panel" aria-live="polite">
        <div className="call-flow-shell">
          <div className="call-flow-loading">
            <span className="call-flow-spinner" aria-hidden="true" />
            <div>
              <strong>Tracing changed calls…</strong>
              <span>Comparing complete Git snapshots in an isolated worker.</span>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (analysis.status === 'error') {
    return (
      <div className="call-flow-panel">
        <div className="call-flow-shell call-flow-empty" role="alert">
          <span className="call-flow-empty-kicker">Call flow unavailable</span>
          <strong>{errorMessage(analysis.error)}</strong>
          <p>The code diff remains available and no repository files were changed. Wait a moment if the analysis timed out, then retry.</p>
          <button type="button" className="call-flow-retry" onClick={state.retryCallFlowAnalysis}>
            Retry analysis
          </button>
        </div>
      </div>
    );
  }

  const { data } = analysis;
  const skippedFileCount = data.skippedLanguages.reduce((total, language) => total + language.files.length, 0);
  const skippedInstallError = state.callFlowInstall.status.state === 'error'
    && data.skippedLanguages.some((language) => installFailedForLanguage(state.callFlowInstall.status, language.id))
      ? state.callFlowInstall.status
      : undefined;
  const installSkipped = () => state.callFlowInstall.start(data.skippedLanguages.map((language) => language.id));
  const copyRaw = async () => {
    const copied = await copyTextToClipboard(data.raw);
    setCopyState(copied ? 'copied' : 'error');
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    copyResetTimer.current = window.setTimeout(() => setCopyState('idle'), 1500);
  };
  return (
    <div className="call-flow-panel">
      <div className="call-flow-shell">
        <header className="call-flow-header">
          <div>
            <div className="call-flow-eyebrow">Inferred call paths</div>
            <h2>{data.summary.changedNodes === 0 ? 'No changed call paths' : `${data.summary.changedNodes} changed path ${data.summary.changedNodes === 1 ? 'step' : 'steps'}`}</h2>
            <p>{data.summary.entries} entr{data.summary.entries === 1 ? 'y' : 'ies'} · {data.summary.impactedFiles} impacted {data.summary.impactedFiles === 1 ? 'file' : 'files'}</p>
          </div>
          <div className="call-flow-header-actions">
            <div className="call-flow-view-switch" aria-label="Call flow view">
              <button type="button" aria-pressed={view === 'paths'} onClick={() => setView('paths')}>Paths</button>
              <button type="button" aria-pressed={view === 'raw'} onClick={() => setView('raw')}>Raw</button>
            </div>
            <Tooltip
              content={`Generated by CallDiff ${data.version}. Syntactic analysis of ${data.from} to ${data.to}; not a runtime trace.`}
              side="bottom"
              align="end"
              delayDuration={250}
              wide
            >
              <button type="button" className="call-flow-info" aria-label="Call flow analysis details">
                <Info aria-hidden="true" size={15} strokeWidth={1.75} />
              </button>
            </Tooltip>
          </div>
        </header>

        {view === 'paths' && (
          <div className="call-flow-legend" aria-label="Call-flow legend">
            <span><b className="call-flow-status-added">+</b> added</span>
            <span><b className="call-flow-status-removed">−</b> removed</span>
            <span><b>·</b> unchanged context</span>
            <span className="call-flow-legend-hint">Open a row or comment on a changed call.</span>
          </div>
        )}

        {data.skippedLanguages.length > 0 && (
          <div className="call-flow-language-notice" role="status">
            <span>
              {skippedFileCount} {skippedFileCount === 1 ? 'file' : 'files'} skipped:{' '}
              {data.skippedLanguages.map((language) => language.label).join(', ')} support not installed
              {' '}({formatInstallSize(data.skippedLanguages.reduce((total, language) => total + language.installSizeBytes, 0))}).
              {skippedInstallError && (
                <small className="call-flow-language-error">Install failed: {skippedInstallError.error}</small>
              )}
            </span>
            {state.callFlowAdvert.installable && (
              <button
                type="button"
                onClick={installSkipped}
                disabled={state.callFlowInstall.status.state === 'running'}
              >
                {state.callFlowInstall.status.state === 'running' ? 'Installing…' : skippedInstallError ? 'Retry' : 'Install'}
              </button>
            )}
          </div>
        )}

        {view === 'raw' ? (
          <section className="call-flow-raw" aria-label="Raw call diff">
            <div className="call-flow-raw-toolbar">
              <span>Canonical CallDiff output</span>
              <button type="button" onClick={() => void copyRaw()} aria-label="Copy raw call diff">
                {copyState === 'copied' ? <Check aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />}
                {copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Copy failed' : 'Copy'}
              </button>
            </div>
            <pre tabIndex={0}>{data.raw}</pre>
          </section>
        ) : data.trees.length === 0 ? (
          <div className="call-flow-empty">
            <span className="call-flow-empty-kicker">Snapshots match structurally</span>
            <strong>{data.message ?? 'CallDiff found no changed call paths.'}</strong>
            <p>This is syntactic call analysis; the ordinary and semantic diffs may still contain changes.</p>
          </div>
        ) : (
          <CallFlowTreeView
            trees={data.trees}
            onOpenNode={openNode}
            onCommentNode={commentOnNode}
            canInteractWithNode={state.isCallFlowNodeInPatch}
          />
        )}

        {data.diagnostics.length > 0 && (
          <details className="call-flow-diagnostics">
            <summary>{data.diagnostics.length} parser {data.diagnostics.length === 1 ? 'notice' : 'notices'}</summary>
            <ul>{data.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.message}:${index}`}>{diagnostic.message}</li>)}</ul>
          </details>
        )}

        {state.callFlowAdvert.languages && (
          <details className="call-flow-languages">
            <summary>Languages</summary>
            <ul>
              {state.callFlowAdvert.languages.map((language) => {
                const languageInstallError = installFailedForLanguage(state.callFlowInstall.status, language.id)
                  ? state.callFlowInstall.status
                  : undefined;
                return (
                  <li key={language.id}>
                    <span>
                      <strong>{language.label}</strong>
                      <small>{language.installed ? `Installed · ${formatInstallSize(language.installSizeBytes)}` : formatInstallSize(language.installSizeBytes)}</small>
                      {languageInstallError && (
                        <small className="call-flow-language-error">Install failed: {languageInstallError.error}</small>
                      )}
                    </span>
                    {!language.installed && language.kind === 'pack' && state.callFlowAdvert.installable && (
                      <button
                        type="button"
                        onClick={() => state.callFlowInstall.start([language.id])}
                        disabled={state.callFlowInstall.status.state === 'running'}
                      >
                        {languageInstallError ? 'Retry' : 'Install'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
