import React, { useState } from 'react';
import type { CallFlowAdvert, CallFlowInstallStage, CallFlowNode } from '@plannotator/shared/call-flow-types';
import { getCallFlowLanguage, type CallFlowLanguageId } from '@plannotator/shared/call-flow-languages';
import type { CallFlowInstallController } from '../../hooks/useCallFlowInstall';
import { Popover } from '@base-ui/react/popover';
import { Check, Info, Settings2 } from 'lucide-react';
import { Tooltip } from '@plannotator/ui/components/Tooltip';
import { useReviewState } from '../ReviewStateContext';
import {
  CallFlowTreeView,
  selectionForCallFlowNode,
} from '../../components/CallFlowTreeView';
import { CallFlowRawView } from '../../components/CallFlowRawView';
import { formatCallFlowInstallSize } from '../../utils/callFlowPresentation';

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

function installFailedForLanguage(
  status: CallFlowInstallController['status'],
  languageId: CallFlowLanguageId,
): status is Extract<CallFlowInstallController['status'], { state: 'error' }> {
  if (status.state !== 'error') return false;
  if (status.currentLanguageId) return status.currentLanguageId === languageId;
  return status.languageIds?.includes(languageId) === true;
}

function installIncludesLanguage(
  status: CallFlowInstallController['status'],
  languageId: CallFlowLanguageId,
): boolean {
  return status.state === 'running' && status.languageIds.includes(languageId);
}

function CallFlowLanguagesMenu({
  languages,
  installable,
  install,
}: {
  readonly languages: NonNullable<CallFlowAdvert['languages']>;
  readonly installable: boolean;
  readonly install: CallFlowInstallController;
}) {
  const installed = languages.filter((language) => language.installed);
  const installedSize = installed.reduce((total, language) => total + language.installSizeBytes, 0);
  return (
    <Popover.Root>
      <Popover.Trigger render={
        <button
          type="button"
          className="call-flow-languages-trigger"
          aria-label={`Manage Call Flow languages. ${installed.length} of ${languages.length} installed.`}
          aria-busy={install.status.state === 'running'}
        />
      }>
        <Settings2 aria-hidden="true" size={14} strokeWidth={1.75} />
        <span>Languages</span>
        <span className="call-flow-languages-trigger-count">{installed.length}/{languages.length}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="end" side="bottom" sideOffset={6} className="z-[110]">
          <Popover.Popup
            className="call-flow-languages-popover shadow-lg popover-enter"
            aria-label="Call Flow language support"
          >
            <header className="call-flow-languages-popover-header">
              <div>
                <strong>Language support</strong>
                <span>Install parsers ahead of the next review.</span>
              </div>
              <span>{formatCallFlowInstallSize(installedSize)} installed</span>
            </header>
            <ul aria-live="polite">
              {languages.map((language) => {
                const languageInstallError = installFailedForLanguage(install.status, language.id)
                  ? install.status
                  : undefined;
                const languageInstalling = installIncludesLanguage(install.status, language.id);
                const requirement = language.required
                  ? `Needed for ${language.changedFiles} changed ${language.changedFiles === 1 ? 'file' : 'files'}`
                  : 'Available';
                return (
                  <li key={language.id}>
                    <span>
                      <strong>{language.label}</strong>
                      <small>
                        {language.installed
                          ? `Installed · ${formatCallFlowInstallSize(language.installSizeBytes)}`
                          : `${requirement} · ${formatCallFlowInstallSize(language.installSizeBytes)}`}
                      </small>
                      {languageInstalling && <small className="call-flow-language-progress">Installing…</small>}
                      {languageInstallError && (
                        <small className="call-flow-language-error">Install failed: {languageInstallError.error}</small>
                      )}
                    </span>
                    {!language.installed
                      && language.kind === 'pack'
                      && installable
                      && !languageInstalling
                      && (
                      <button
                        type="button"
                        onClick={() => install.start([language.id])}
                        disabled={install.status.state === 'running'}
                      >
                        {languageInstallError ? 'Retry' : 'Install'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * Background setup progress shown only for the runtime-missing flavor of an
 * unavailable advert. Never rendered for unsupported views or while the
 * feature is disabled. The toggle already captured consent, so the idle state
 * informs rather than asking for a second confirmation.
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
          <div className="call-flow-install-action">
            <button
              type="button"
              className="call-flow-install-cta"
              onClick={() => install.start(status.languageIds)}
            >
              Retry install
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="call-flow-panel">
      <div className="call-flow-shell call-flow-install call-flow-empty">
        <span className="call-flow-empty-kicker">Preparing analysis</span>
        <strong>Call flow is setting up in the background.</strong>
        <p>
          You can keep reviewing while Plannotator prepares the local runtime and the
          language support this review needs.
        </p>
        {advert.message && advert.reason !== 'runtime-unavailable' && (
          <p className="call-flow-install-detail">{advert.message}</p>
        )}
        {advert.installPlan && (
          <p className="call-flow-install-disclosure">
            Installing <strong>{advert.installPlan.labels.join(', ')}</strong>,{' '}
            <strong>{formatCallFlowInstallSize(advert.installPlan.installSizeBytes)}</strong> on disk.
            {' '}Requires Node.js 22 or newer. Other languages install automatically, only
            when a review needs them.
          </p>
        )}
      </div>
    </div>
  );
}

export function ReviewCallFlowPanel() {
  const state = useReviewState();
  const analysis = state.callFlowAnalysis;
  const [view, setView] = useState<'paths' | 'raw'>('paths');

  const openNode = (node: CallFlowNode) => {
    if (!node.file) return;
    state.openDiffFile(node.file);
    state.onLineSelection(selectionForCallFlowNode(node));
  };
  if (!state.callFlowAdvert.available) {
    // The runtime-missing flavor of unavailable is the setup progress surface.
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
  const skippedLanguageIds = data.skippedLanguages.map((language) => language.id);
  const skippedInstallRunning = skippedLanguageIds.some((languageId) => (
    installIncludesLanguage(state.callFlowInstall.status, languageId)
  ));
  const retrySkipped = () => state.callFlowInstall.start(skippedLanguageIds);
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
            {state.callFlowAdvert.languages && (
              <CallFlowLanguagesMenu
                languages={state.callFlowAdvert.languages}
                installable={state.callFlowAdvert.installable}
                install={state.callFlowInstall}
              />
            )}
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
            <span className="call-flow-legend-hint">Click any row to comment. Shift-click adds steps. Select a file path to open source.</span>
          </div>
        )}

        {data.skippedLanguages.length > 0 && (
          <div className="call-flow-language-notice" role="status">
            <span>
              {skippedFileCount} {skippedFileCount === 1 ? 'file' : 'files'} skipped:{' '}
              {data.skippedLanguages.map((language) => language.label).join(', ')} support not installed
              {' '}({formatCallFlowInstallSize(data.skippedLanguages.reduce((total, language) => total + language.installSizeBytes, 0))}).
              {skippedInstallRunning && (
                <small className="call-flow-language-progress">Installing support in the background…</small>
              )}
              {skippedInstallError && (
                <small className="call-flow-language-error">Install failed: {skippedInstallError.error}</small>
              )}
              {!state.callFlowAdvert.installable && (
                <small className="call-flow-language-progress">
                  Add this language grammar to PLANNOTATOR_CALLDIFF_PATH to include these files.
                </small>
              )}
            </span>
            {state.callFlowAdvert.installable && skippedInstallError && (
              <button
                type="button"
                onClick={retrySkipped}
              >
                Retry
              </button>
            )}
          </div>
        )}

        {view === 'raw' ? (
          <CallFlowRawView
            sections={[{ key: 'complete', raw: data.raw, rawLineStart: 1 }]}
            onAnnotateTargets={state.onAddCallFlowAnnotation}
            findShortcutActive={state.isCallFlowActive}
          />
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
            onAnnotateTargets={state.onAddCallFlowAnnotation}
            canInteractWithNode={state.isCallFlowNodeInPatch}
            findShortcutActive={state.isCallFlowActive}
          />
        )}

        {data.diagnostics.length > 0 && (
          <details className="call-flow-diagnostics">
            <summary>{data.diagnostics.length} parser {data.diagnostics.length === 1 ? 'notice' : 'notices'}</summary>
            <ul>{data.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.message}:${index}`}>{diagnostic.message}</li>)}</ul>
          </details>
        )}

      </div>
    </div>
  );
}
