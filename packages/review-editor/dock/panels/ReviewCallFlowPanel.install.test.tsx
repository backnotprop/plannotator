/**
 * DOM-gated (DOM_TESTS=1) tests for the Call flow Dock's opt-in install
 * funnel. Registered in .github/workflows/test.yml's UI seam-contract +
 * DOM step. The funnel must render ONLY for the runtime-missing flavor of
 * an unavailable advert, never for unsupported views.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReviewCallFlowPanel } from './ReviewCallFlowPanel';
import { ReviewStateProvider, type ReviewState } from '../ReviewStateContext';
import type { CallFlowAdvert, CallFlowInstallStatus } from '@plannotator/shared/call-flow-types';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

function advert(overrides: Partial<CallFlowAdvert>): CallFlowAdvert {
  return {
    enabled: true,
    available: false,
    state: 'unavailable',
    provider: 'calldiff',
    installable: true,
    installPlan: {
      languageIds: ['javascript-typescript'],
      labels: ['JavaScript and TypeScript'],
      changedFiles: 1,
      installSizeBytes: 32 * 1024 * 1024,
    },
    ...overrides,
  };
}

function stateWith(
  callFlowAdvert: CallFlowAdvert,
  installStatus: CallFlowInstallStatus,
  startInstall: () => void = () => {},
): ReviewState {
  // The panel's pre-analysis branches only touch these fields; the partial
  // cast keeps the harness honest about what the funnel depends on.
  return {
    callFlowAdvert,
    callFlowAvailable: callFlowAdvert.available,
    callFlowAnalysis: { status: 'idle' },
    retryCallFlowAnalysis: () => {},
    isCallFlowNodeInPatch: () => false,
    isCallFlowActive: true,
    openCallFlowPanel: () => {},
    callFlowInstall: { status: installStatus, start: startInstall },
    openDiffFile: () => {},
    onLineSelection: () => {},
    onRequestLineAnnotation: () => {},
  } as unknown as ReviewState;
}

async function render(state: ReviewState) {
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => {
    root!.render(
      <ReviewStateProvider value={state}>
        <ReviewCallFlowPanel />
      </ReviewStateProvider>,
    );
    await Promise.resolve();
  });
}

function installButton(): HTMLButtonElement | null {
  return [...(host?.querySelectorAll('button') ?? [])]
    .find((button) => /install runtime|retry install/i.test(button.textContent ?? '')) ?? null;
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe('ReviewCallFlowPanel install funnel', () => {
  test.skipIf(!hasDom)('renders the funnel with disclosure for the runtime-missing advert', async () => {
    await render(stateWith(
      advert({ reason: 'runtime-unavailable', message: 'Call flow runtime is not installed.' }),
      { state: 'idle' },
    ));
    expect(installButton()?.textContent).toContain('Install runtime');
    const text = host?.textContent ?? '';
    expect(text).toContain('~32 MB');
    expect(text).toContain('JavaScript and TypeScript');
    expect(text).toContain('Node.js 22 or newer');
    expect(text).toContain('One-time install');
  });

  test.skipIf(!hasDom)('never offers the install for unsupported views or demo mode', async () => {
    await render(stateWith(
      advert({ state: 'unsupported', reason: 'view-unsupported', message: 'Call flow is not available for this review view.' }),
      { state: 'idle' },
    ));
    expect(installButton()).toBeNull();
    expect(host?.textContent).toContain('Not supported in this view');

    await render(stateWith(
      advert({ state: 'unsupported', reason: 'demo-mode', message: 'Call flow requires a live Git review session.' }),
      { state: 'idle' },
    ));
    expect(installButton()).toBeNull();
    expect(host?.textContent).not.toContain('Install runtime');

    await render(stateWith(
      advert({
        state: 'unavailable',
        reason: 'override-relative',
        message: 'PLANNOTATOR_CALLDIFF_PATH must be absolute.',
        installable: false,
        installPlan: undefined,
      }),
      { state: 'idle' },
    ));
    expect(installButton()).toBeNull();
    expect(host?.textContent).toContain('PLANNOTATOR_CALLDIFF_PATH must be absolute.');
  });

  test.skipIf(!hasDom)('clicking Install starts the install and running renders staged progress', async () => {
    let starts = 0;
    await render(stateWith(
      advert({ reason: 'runtime-unavailable' }),
      { state: 'idle' },
      () => starts++,
    ));
    await act(async () => {
      installButton()?.click();
      await Promise.resolve();
    });
    expect(starts).toBe(1);

    await render(stateWith(
      advert({ reason: 'runtime-unavailable' }),
      { state: 'running', stage: 'installing-deps', languageIds: ['javascript-typescript'] },
    ));
    const stages = [...(host?.querySelectorAll('.call-flow-install-stages li') ?? [])];
    expect(stages).toHaveLength(4);
    expect(stages.map((stage) => stage.getAttribute('data-stage-state'))).toEqual([
      'complete',
      'complete',
      'active',
      'pending',
    ]);
    expect(installButton()).toBeNull();
  });

  test.skipIf(!hasDom)('an install error shows the distinct no-node hint and a retry control', async () => {
    let starts = 0;
    await render(stateWith(
      advert({ reason: 'runtime-unavailable' }),
      {
        state: 'error',
        error: 'Call flow requires Node.js 22 or newer, which was not found on PATH.',
        reason: 'node-unavailable',
      },
      () => starts++,
    ));
    const text = host?.textContent ?? '';
    expect(text).toContain('Install failed');
    expect(text).toContain('Node.js 22 or newer');
    expect(text).toContain('Install Node.js 22 or newer, make sure it is on PATH, then retry.');
    const retry = installButton();
    expect(retry?.textContent).toContain('Retry install');
    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });
    expect(starts).toBe(1);
  });

  test.skipIf(!hasDom)('surfaces optional-pack failures and hides installs for an unmanaged override', async () => {
    let starts = 0;
    const callFlowAdvert = advert({
      available: true,
      state: 'available',
      installPlan: undefined,
      languages: [{
        id: 'python',
        label: 'Python',
        kind: 'pack',
        installed: false,
        required: true,
        changedFiles: 1,
        installSizeBytes: 1024 * 1024,
      }],
    });
    const readyState = {
      ...stateWith(callFlowAdvert, {
        state: 'error',
        error: 'Pinned Python package failed integrity verification.',
        languageIds: ['python'],
        currentLanguageId: 'python',
      }, () => starts++),
      callFlowAnalysis: {
        status: 'ready',
        data: {
          status: 'ok',
          snapshotId: 'snapshot',
          provider: 'calldiff',
          version: '0.4.1',
          from: 'before',
          to: 'after',
          raw: '',
          trees: [],
          fileImpacts: {},
          summary: { entries: 0, changedNodes: 0, added: 0, removed: 0, impactedFiles: 0, warnings: 0 },
          diagnostics: [],
          skippedLanguages: [{ id: 'python', label: 'Python', files: ['tool.py'], installSizeBytes: 1024 * 1024 }],
        },
      },
    } as unknown as ReviewState;

    await render(readyState);
    const text = host?.textContent ?? '';
    expect(text).toContain('Install failed: Pinned Python package failed integrity verification.');
    const retry = [...(host?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent?.trim() === 'Retry');
    expect(retry).toBeDefined();
    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });
    expect(starts).toBe(1);

    await render({
      ...readyState,
      callFlowAdvert: { ...callFlowAdvert, installable: false },
      callFlowInstall: { status: { state: 'idle' }, start: () => starts++ },
    });
    expect(host?.textContent).toContain('1 file skipped: Python support not installed');
    const unavailableInstall = [...(host?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent?.trim() === 'Install');
    expect(unavailableInstall).toBeUndefined();
    expect(starts).toBe(1);
  });
});
