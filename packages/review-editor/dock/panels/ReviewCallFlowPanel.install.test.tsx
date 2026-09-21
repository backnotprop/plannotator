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
import type { CallFlowLanguageId } from '@plannotator/shared/call-flow-languages';

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
  startInstall: (languageIds?: readonly CallFlowLanguageId[]) => void = () => {},
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
    onAddCallFlowAnnotation: () => true,
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
    .find((button) => /retry install/i.test(button.textContent ?? '')) ?? null;
}

async function openLanguagesMenu(): Promise<HTMLElement> {
  const trigger = host?.querySelector<HTMLButtonElement>('.call-flow-languages-trigger');
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger?.click();
    await Promise.resolve();
  });
  const popup = document.querySelector<HTMLElement>('.call-flow-languages-popover');
  expect(popup).not.toBeNull();
  return popup!;
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe('ReviewCallFlowPanel install funnel', () => {
  test.skipIf(!hasDom)('renders automatic setup disclosure without a second consent button', async () => {
    await render(stateWith(
      advert({ reason: 'runtime-unavailable', message: 'Call flow runtime is not installed.' }),
      { state: 'idle' },
    ));
    expect(installButton()).toBeNull();
    const text = host?.textContent ?? '';
    expect(text).toContain('~32 MB');
    expect(text).toContain('JavaScript and TypeScript');
    expect(text).toContain('Node.js 22 or newer');
    expect(text).toContain('setting up in the background');
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

  test.skipIf(!hasDom)('running renders staged progress without another install control', async () => {
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
    expect(host?.textContent).toContain('Add this language grammar to PLANNOTATOR_CALLDIFF_PATH');
    const unavailableInstall = [...(host?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent?.trim() === 'Install');
    expect(unavailableInstall).toBeUndefined();
    expect(starts).toBe(1);
  });

  test.skipIf(!hasDom)('keeps manual controls for every missing required pack after an unrelated failure', async () => {
    const starts: CallFlowLanguageId[][] = [];
    const callFlowAdvert = advert({
      available: true,
      state: 'available',
      installPlan: {
        languageIds: ['python', 'go'],
        labels: ['Python', 'Go'],
        changedFiles: 2,
        installSizeBytes: 2 * 1024 * 1024,
      },
      languages: [
        {
          id: 'python',
          label: 'Python',
          kind: 'pack',
          installed: false,
          required: true,
          changedFiles: 1,
          installSizeBytes: 1024 * 1024,
        },
        {
          id: 'go',
          label: 'Go',
          kind: 'pack',
          installed: false,
          required: true,
          changedFiles: 1,
          installSizeBytes: 1024 * 1024,
        },
      ],
    });
    const installStatus: CallFlowInstallStatus = {
      state: 'error',
      error: 'Python install failed.',
      languageIds: ['python'],
      currentLanguageId: 'python',
    };
    await render({
      ...stateWith(callFlowAdvert, installStatus, (languageIds) => {
        starts.push([...(languageIds ?? [])]);
      }),
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
          skippedLanguages: [
            { id: 'python', label: 'Python', files: ['tool.py'], installSizeBytes: 1024 * 1024 },
            { id: 'go', label: 'Go', files: ['tool.go'], installSizeBytes: 1024 * 1024 },
          ],
        },
      },
    } as unknown as ReviewState);

    const languageMenu = await openLanguagesMenu();
    const languageRows = [...languageMenu.querySelectorAll('li')];
    expect(languageRows).toHaveLength(2);
    expect(languageRows[0]?.querySelector('button')?.textContent).toBe('Retry');
    expect(languageRows[1]?.querySelector('button')?.textContent).toBe('Install');
    await act(async () => {
      languageRows[1]?.querySelector<HTMLButtonElement>('button')?.click();
      await Promise.resolve();
    });
    expect(starts).toEqual([['go']]);
  });

  test.skipIf(!hasDom)('shows automatic pack progress and cumulative installed size without a prompt', async () => {
    const callFlowAdvert = advert({
      available: true,
      state: 'available',
      installPlan: {
        languageIds: ['python'],
        labels: ['Python'],
        changedFiles: 1,
        installSizeBytes: 1024 * 1024,
      },
      languages: [
        {
          id: 'javascript-typescript',
          label: 'JavaScript and TypeScript',
          kind: 'core',
          installed: true,
          required: false,
          changedFiles: 0,
          installSizeBytes: 5 * 1024 * 1024,
        },
        {
          id: 'python',
          label: 'Python',
          kind: 'pack',
          installed: false,
          required: true,
          changedFiles: 1,
          installSizeBytes: 1024 * 1024,
        },
      ],
    });
    await render({
      ...stateWith(callFlowAdvert, {
        state: 'running',
        stage: 'installing-deps',
        languageIds: ['python'],
        currentLanguageId: 'python',
      }),
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
    } as unknown as ReviewState);

    expect(host?.textContent).toContain('Installing support in the background…');
    const trigger = host?.querySelector('.call-flow-header-actions .call-flow-languages-trigger');
    expect(trigger?.textContent).toContain('Languages');
    expect(trigger?.textContent).toContain('1/2');
    expect(host?.querySelector('details.call-flow-languages')).toBeNull();

    const languageMenu = await openLanguagesMenu();
    expect(languageMenu.textContent).toContain('~5 MB installed');
    const install = [...languageMenu.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Install');
    expect(install).toBeUndefined();
  });
});
