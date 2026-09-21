/** DOM-gated coverage for the compact per-file Call Flow Lens. */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReviewState } from '../dock/ReviewStateContext';
import { ReviewStateProvider } from '../dock/ReviewStateContext';
import { CallFlowFileBadge } from './CallFlowFileBadge';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

function lensState(): ReviewState {
  return {
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
        raw: [
          'calldiff diff before → after',
          '',
          '  checkout()',
          '  ├─ nearbyContext()',
          '+ ├─ save()',
          '  └─ afterContext()',
          '',
          '+ submitOrder()',
        ].join('\n'),
        trees: [
          {
            entry: 'checkout()',
            raw: '  checkout()\n  ├─ nearbyContext()\n+ ├─ save()\n  └─ afterContext()',
            rawLineStart: 3,
            tree: {
              key: 'checkout',
              label: 'checkout()',
              status: 'same',
              children: [
                {
                  key: 'nearby',
                  label: 'nearbyContext()',
                  status: 'same',
                  children: [{
                    key: 'deep',
                    label: 'deepContext()',
                    status: 'same',
                    children: [],
                  }],
                },
                {
                  key: 'save',
                  label: 'save()',
                  status: 'added',
                  file: 'src/order.ts',
                  line: 12,
                  children: [],
                },
                {
                  key: 'after',
                  label: 'afterContext()',
                  status: 'same',
                  children: [],
                },
              ],
            },
          },
          {
            entry: 'submitOrder()',
            raw: '+ submitOrder()',
            rawLineStart: 8,
            tree: {
              key: 'submit',
              label: 'submitOrder()',
              status: 'added',
              file: 'src/order.ts',
              line: 40,
              children: [],
            },
          },
        ],
        fileImpacts: {
          'src/order.ts': [
            {
              entry: 'checkout()',
              entries: ['checkout()'],
              key: 'save',
              label: 'save()',
              status: 'added',
              file: 'src/order.ts',
              line: 12,
              depth: 1,
            },
            {
              entry: 'submitOrder()',
              entries: ['submitOrder()'],
              key: 'submit',
              label: 'submitOrder()',
              status: 'added',
              file: 'src/order.ts',
              line: 40,
              depth: 0,
            },
          ],
        },
        summary: { entries: 2, changedNodes: 2, added: 2, removed: 0, impactedFiles: 1, warnings: 0 },
        diagnostics: [],
        skippedLanguages: [],
      },
    },
    openCallFlowPanel: () => {},
    openDiffFile: () => {},
    onLineSelection: () => {},
    onAddCallFlowAnnotation: () => true,
    isCallFlowNodeInPatch: () => true,
  } as unknown as ReviewState;
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.querySelectorAll('.call-flow-popover, [data-comment-popover]').forEach((element) => element.remove());
});

describe('CallFlowFileBadge Lens', () => {
  test.skipIf(!hasDom)('captures find for the active sticky Lens search', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <ReviewStateProvider value={lensState()}>
          <CallFlowFileBadge filePath="src/order.ts" />
        </ReviewStateProvider>,
      );
    });

    const trigger = host.querySelector<HTMLButtonElement>('.call-flow-file-badge');
    await act(async () => trigger?.click());
    const popup = document.querySelector<HTMLElement>('.call-flow-popover');
    expect(popup).not.toBeNull();

    let shortcutEscapedLens = false;
    const outsideShortcut = () => { shortcutEscapedLens = true; };
    window.addEventListener('keydown', outsideShortcut);
    await act(async () => {
      popup?.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'f',
        metaKey: true,
      }));
    });
    window.removeEventListener('keydown', outsideShortcut);

    const pathsInput = popup?.querySelector<HTMLInputElement>('input[placeholder="Find calls or files"]');
    expect(pathsInput).not.toBeNull();
    expect(document.activeElement).toBe(pathsInput);
    expect(shortcutEscapedLens).toBe(false);

    await act(async () => {
      if (!pathsInput) return;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(pathsInput), 'value')?.set;
      setter?.call(pathsInput, 'save');
      pathsInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    pathsInput?.setSelectionRange(4, 4);
    pathsInput?.blur();
    await act(async () => {
      popup?.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'f',
        metaKey: true,
      }));
    });
    expect(document.activeElement).toBe(pathsInput);
    expect(pathsInput?.selectionStart).toBe(0);
    expect(pathsInput?.selectionEnd).toBe(4);

    const rawTab = [...(popup?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      .find((button) => button.textContent === 'Raw');
    await act(async () => rawTab?.click());
    expect(popup?.querySelector('.call-flow-raw-compact')).not.toBeNull();
    await act(async () => {
      popup?.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'f',
        ctrlKey: true,
      }));
    });
    const rawInput = popup?.querySelector<HTMLInputElement>('input[placeholder="Find in raw output"]');
    expect(rawInput).not.toBeNull();
    expect(document.activeElement).toBe(rawInput);
  });

  test.skipIf(!hasDom)('opens complete nearby paths and canonical per-entry raw output', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <ReviewStateProvider value={lensState()}>
          <CallFlowFileBadge filePath="src/order.ts" />
        </ReviewStateProvider>,
      );
    });

    const trigger = host.querySelector<HTMLButtonElement>('.call-flow-file-badge');
    await act(async () => trigger?.click());
    const popup = document.querySelector<HTMLElement>('.call-flow-popover');
    expect(popup).not.toBeNull();
    expect(popup?.textContent).toContain('2 paths · 2 changed');
    expect(popup?.querySelectorAll('.call-flow-tree')).toHaveLength(2);
    expect(popup?.textContent).toContain('nearbyContext()');
    expect(popup?.textContent).toContain('afterContext()');
    expect(popup?.textContent).not.toContain('deepContext()');

    const rawTab = [...(popup?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      .find((button) => button.textContent === 'Raw');
    await act(async () => rawTab?.click());
    expect(popup?.querySelectorAll('.call-flow-raw-section')).toHaveLength(2);
    expect(popup?.textContent).toContain('checkout()');
    expect(popup?.querySelector('[aria-label^="Raw line 3"]')).not.toBeNull();
    expect(popup?.querySelector('[aria-label^="Raw line 8"]')).not.toBeNull();

    const rawLine = popup?.querySelector<HTMLButtonElement>('[aria-label^="Raw line 3"]');
    await act(async () => rawLine?.click());
    expect(document.querySelector('[data-comment-popover="true"]')).not.toBeNull();
  });

  // Guards the hover-intent delay: scrolling a diff drags file headers under a
  // stationary pointer, and instant open made every passing badge pop the Lens.
  test.skipIf(!hasDom)('hover opens only after the intent delay', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <ReviewStateProvider value={lensState()}>
          <CallFlowFileBadge filePath="src/order.ts" />
        </ReviewStateProvider>,
      );
    });

    const trigger = host.querySelector<HTMLButtonElement>('.call-flow-file-badge');
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    });
    expect(document.querySelector('.call-flow-popover')).toBeNull();

    // A pointer that leaves before the delay elapses must not open the Lens.
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
      await new Promise((resolve) => setTimeout(resolve, 180));
    });
    expect(document.querySelector('.call-flow-popover')).toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
      await new Promise((resolve) => setTimeout(resolve, 180));
    });
    expect(document.querySelector('.call-flow-popover')).not.toBeNull();
  });

  // Guards the Safari scroll-chaining regression: a page scroll slides the
  // anchored popup out from under a stationary pointer, fires mouseleave, and
  // used to close the Lens mid-scroll. In-flight scrolls must hold the close;
  // a pointer genuinely outside after the scroll settles still closes it.
  test.skipIf(!hasDom)('scroll holds a pending hover-close, then closes once settled', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <ReviewStateProvider value={lensState()}>
          <CallFlowFileBadge filePath="src/order.ts" />
        </ReviewStateProvider>,
      );
    });

    const trigger = host.querySelector<HTMLButtonElement>('.call-flow-file-badge');
    await act(async () => trigger?.click());
    const popup = document.querySelector<HTMLElement>('.call-flow-popover');
    expect(popup).not.toBeNull();

    // Pointer slides off the popup (schedules the close), then a scroll lands.
    await act(async () => {
      popup?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
      document.body.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 320));
    });
    expect(document.querySelector('.call-flow-popover')).not.toBeNull();

    // Scroll settled with the pointer outside: the Lens now closes gracefully.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(document.querySelector('.call-flow-popover')).toBeNull();
  });
});
