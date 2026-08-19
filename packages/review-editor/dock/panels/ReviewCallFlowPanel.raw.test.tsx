/** DOM-gated behavior tests for raw CallDiff search and toolbar chrome. */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CallFlowAnnotationTarget } from '@plannotator/ui/types';
import type { ReviewState } from '../ReviewStateContext';
import { ReviewStateProvider } from '../ReviewStateContext';
import { ReviewCallFlowPanel } from './ReviewCallFlowPanel';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

function readyState(
  onAddCallFlowAnnotation: ReviewState['onAddCallFlowAnnotation'] = () => true,
  isCallFlowActive = true,
): ReviewState {
  return {
    callFlowAdvert: {
      enabled: true,
      available: true,
      state: 'available',
      provider: 'calldiff',
      installable: true,
    },
    callFlowAvailable: true,
    callFlowAnalysis: {
      status: 'ready',
      data: {
        status: 'ok',
        snapshotId: 'snapshot',
        provider: 'calldiff',
        version: '0.4.1',
        from: 'before',
        to: 'after',
        raw: '+ CallFlowTreeView({})\n- callflowtreeview()\n  unrelated()',
        trees: [{
          entry: 'CallFlowTreeView',
          raw: '+ CallFlowTreeView({})\n- callflowtreeview()',
          rawLineStart: 1,
          tree: {
            key: 'CallFlowTreeView',
            label: 'CallFlowTreeView({})',
            status: 'added',
            file: 'src/CallFlowTreeView.tsx',
            line: 1,
            children: [],
          },
        }],
        fileImpacts: {
          'src/CallFlowTreeView.tsx': [{
            entry: 'CallFlowTreeView',
            entries: ['CallFlowTreeView'],
            key: 'CallFlowTreeView',
            label: 'CallFlowTreeView({})',
            status: 'added',
            file: 'src/CallFlowTreeView.tsx',
            line: 1,
            depth: 0,
          }],
        },
        summary: { entries: 1, changedNodes: 2, added: 1, removed: 1, impactedFiles: 1, warnings: 0 },
        diagnostics: [],
        skippedLanguages: [],
      },
    },
    retryCallFlowAnalysis: () => {},
    isCallFlowNodeInPatch: () => false,
    isCallFlowActive,
    openCallFlowPanel: () => {},
    callFlowInstall: { status: { state: 'idle' }, start: () => {} },
    openDiffFile: () => {},
    onLineSelection: () => {},
    onRequestLineAnnotation: () => {},
    onAddCallFlowAnnotation,
  } as unknown as ReviewState;
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe('ReviewCallFlowPanel raw search', () => {
  test.skipIf(!hasDom)('captures find only while the Dock panel owns the foreground', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <ReviewStateProvider value={readyState(() => true, false)}>
          <ReviewCallFlowPanel />
        </ReviewStateProvider>,
      );
    });

    let escapedShortcutCount = 0;
    const outsideShortcut = () => { escapedShortcutCount += 1; };
    window.addEventListener('keydown', outsideShortcut);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true }));
    });
    expect(host.querySelector('input[type="search"]')).toBeNull();
    expect(escapedShortcutCount).toBe(1);

    await act(async () => {
      root?.render(
        <ReviewStateProvider value={readyState(() => true, true)}>
          <ReviewCallFlowPanel />
        </ReviewStateProvider>,
      );
    });
    const lens = document.createElement('div');
    lens.dataset.callFlowLens = 'true';
    document.body.appendChild(lens);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true }));
    });
    expect(host.querySelector('input[type="search"]')).toBeNull();
    expect(escapedShortcutCount).toBe(2);

    lens.remove();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true }));
    });
    window.removeEventListener('keydown', outsideShortcut);
    const input = host.querySelector<HTMLInputElement>('input[placeholder="Find calls or files"]');
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(escapedShortcutCount).toBe(2);
  });

  test.skipIf(!hasDom)('uses a utility-only toolbar and navigates raw matches', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <ReviewStateProvider value={readyState()}>
          <ReviewCallFlowPanel />
        </ReviewStateProvider>,
      );
    });

    const rawTab = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Raw');
    await act(async () => rawTab?.click());
    expect(host.textContent).not.toContain('Canonical CallDiff output');

    const searchButton = host.querySelector<HTMLButtonElement>('[aria-label="Search raw call diff"]');
    expect(searchButton).not.toBeNull();
    await act(async () => searchButton?.click());
    const input = host.querySelector<HTMLInputElement>('input[type="search"]');
    expect(input).not.toBeNull();

    await act(async () => {
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
      setter?.call(input, 'CallFlowTreeView');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelectorAll('.call-flow-raw mark')).toHaveLength(2);
    expect(host.querySelector('[data-raw-match="0"]')?.classList.contains('call-flow-raw-match-current')).toBe(true);
    expect(host.textContent).toContain('1/2');

    const next = host.querySelector<HTMLButtonElement>('[aria-label="Next match"]');
    await act(async () => next?.click());
    expect(host.querySelector('[data-raw-match="1"]')?.classList.contains('call-flow-raw-match-current')).toBe(true);
    expect(host.textContent).toContain('2/2');

    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    });
    expect(host.querySelector('input[type="search"]')).toBeNull();

    let shortcutEscapedRawView = false;
    const otherSearchShortcut = () => { shortcutEscapedRawView = true; };
    window.addEventListener('keydown', otherSearchShortcut);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true }));
      await Promise.resolve();
    });
    window.removeEventListener('keydown', otherSearchShortcut);
    expect(host.querySelector('input[type="search"]')).not.toBeNull();
    expect(shortcutEscapedRawView).toBe(false);
  });

  test.skipIf(!hasDom)('comments context lines and Shift-selects any raw output lines', async () => {
    const submissions: Array<{ targets: readonly CallFlowAnnotationTarget[]; text: string }> = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <ReviewStateProvider value={readyState((targets, text) => {
          submissions.push({ targets: [...targets], text });
          return true;
        })}>
          <ReviewCallFlowPanel />
        </ReviewStateProvider>,
      );
    });

    const rawTab = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Raw');
    await act(async () => rawTab?.click());
    const rawLines = host.querySelectorAll<HTMLButtonElement>('[aria-label^="Raw line"]');
    expect(rawLines).toHaveLength(3);
    expect([...rawLines].filter((line) => line.tabIndex === 0)).toHaveLength(1);
    await act(async () => {
      rawLines[0]?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
    });
    expect(rawLines[1]?.tabIndex).toBe(0);

    await act(async () => rawLines[2]?.click());
    expect(rawLines[2]?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-comment-popover="true"]')).not.toBeNull();

    await act(async () => {
      rawLines[1]?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, shiftKey: true }));
      rawLines[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    });
    expect(document.querySelectorAll('[data-target-chip]')).toHaveLength(2);
    expect(rawLines[1]?.getAttribute('aria-pressed')).toBe('true');

    const textarea = document.querySelector<HTMLTextAreaElement>('[data-comment-popover="true"] textarea');
    await act(async () => {
      if (!textarea) return;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), 'value')?.set;
      setter?.call(textarea, 'This existing path is part of the problem.');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        key: 'Enter',
        metaKey: true,
      }));
    });

    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.text).toBe('This existing path is part of the problem.');
    expect(submissions[0]?.targets).toMatchObject([
      { rawLine: 3, label: '  unrelated()', side: 'new' },
      { rawLine: 2, label: '- callflowtreeview()', side: 'old' },
    ]);
    expect(document.querySelector('[data-comment-popover="true"]')).toBeNull();
  });
});
