import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReviewState } from '../ReviewStateContext';
import { ReviewStateProvider } from '../ReviewStateContext';
import { ReviewCallFlowPanel } from './ReviewCallFlowPanel';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

function stateWith(analysis: ReviewState['callFlowAnalysis'], retry: () => void = () => {}): ReviewState {
  return {
    callFlowAdvert: { enabled: true, available: true, state: 'available', provider: 'calldiff', installable: true },
    callFlowAvailable: true,
    callFlowAnalysis: analysis,
    retryCallFlowAnalysis: retry,
    isCallFlowNodeInPatch: () => true,
    isCallFlowActive: true,
    openCallFlowPanel: () => {},
    callFlowInstall: { status: { state: 'idle' }, start: () => {} },
    openDiffFile: () => {},
    onLineSelection: () => {},
    onAddCallFlowAnnotation: () => true,
  } as unknown as ReviewState;
}

async function render(state: ReviewState) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<ReviewStateProvider value={state}><ReviewCallFlowPanel /></ReviewStateProvider>);
  });
  return host;
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe('ReviewCallFlowPanel states', () => {
  test.skipIf(!hasDom)('loading shows progress and no tree or error', async () => {
    const container = await render(stateWith({ status: 'loading' }));
    expect(container.querySelector('.call-flow-loading')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('.call-flow-trees, [role="tree"]')).toBeNull();
  });

  test.skipIf(!hasDom)('an analysis error offers a retry that re-runs the analysis', async () => {
    let retries = 0;
    const container = await render(stateWith(
      { status: 'error', error: { status: 'error', reason: 'analysis-failed', message: 'boom' } as never },
      () => { retries += 1; },
    ));
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('boom');
    const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Retry analysis');
    expect(retry).toBeDefined();
    await act(async () => retry?.click());
    expect(retries).toBe(1);
  });

  test.skipIf(!hasDom)('a result with no trees shows the structural-match notice, not an empty tree', async () => {
    const container = await render(stateWith({
      status: 'ready',
      data: {
        status: 'ok', snapshotId: 's', provider: 'calldiff', version: '0.6.0', from: 'a', to: 'b',
        raw: '', trees: [], fileImpacts: {},
        summary: { entries: 0, changedNodes: 0, added: 0, removed: 0, impactedFiles: 0, warnings: 0 },
        diagnostics: [], skippedLanguages: [],
      },
    }));
    expect(container.querySelector('.call-flow-empty')).not.toBeNull();
    expect(container.querySelector('.call-flow-trees, [role="tree"]')).toBeNull();
  });
});
