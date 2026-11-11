/**
 * DOM-gated: the Call flow tab shows the Call tree beside the Paths cards.
 *
 * Regressions guarded:
 *  - the tab not opening on the Call tree (owner's decision, 2026-11-10, once
 *    the tree had search), or Paths and Raw not one click away;
 *  - search across the tab's trees: the count, the next match moving the
 *    current row into the tree holding it, Cmd/Ctrl+F reaching the field;
 *  - a hunk's "Call tree" entry not landing on its tree (with the caller
 *    trail), Close not returning to the tab's own trees, or Escape not going
 *    back to the hunk;
 *  - a tree row opening through a different path than the review's open.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { callTreeAt, findCallTreeRoot } from '@plannotator/shared/call-tree';
import type { CallFlowTree } from '@plannotator/shared/call-flow-types';
import type { CallTreeRequest, ReviewState } from '../ReviewStateContext';
import { ReviewStateProvider } from '../ReviewStateContext';
import { ReviewCallFlowPanel } from './ReviewCallFlowPanel';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

const trees: CallFlowTree[] = [{
  entry: 'main',
  tree: {
    key: 'main', label: 'main()', status: 'same', file: 'src/main.ts', line: 1,
    children: [{
      key: 'measure', label: 'note.measure()', status: 'same', file: 'src/main.ts', line: 3,
      children: [{ key: 'layout', label: 'parley.layout()', status: 'added', file: 'src/note.ts', line: 13, children: [] }],
    }],
  },
}];

function state(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    callFlowAdvert: { enabled: true, available: true, state: 'available', provider: 'calldiff', installable: true },
    callFlowAvailable: true,
    callFlowAnalysis: {
      status: 'ready',
      data: {
        status: 'ok', snapshotId: 's', provider: 'calldiff', version: '0.6.0', from: 'a', to: 'b', raw: '', trees, fileImpacts: {},
        summary: { entries: 1, changedNodes: 1, added: 1, removed: 0, impactedFiles: 1, warnings: 0 },
        diagnostics: [], skippedLanguages: [],
      },
    },
    retryCallFlowAnalysis: () => {},
    isCallFlowNodeInPatch: () => true,
    isCallFlowActive: true,
    openCallFlowPanel: () => {},
    callFlowInstall: { status: { state: 'idle' }, start: () => {} },
    openDiffFile: () => {},
    onLineSelection: () => {},
    onAddCallFlowAnnotation: () => true,
    ...overrides,
  } as unknown as ReviewState;
}

async function render(value: ReviewState) {
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => {
    root?.render(<ReviewStateProvider value={value}><ReviewCallFlowPanel /></ReviewStateProvider>);
  });
  return host;
}

function viewButton(name: string): HTMLButtonElement {
  return [...host!.querySelectorAll<HTMLButtonElement>('.call-flow-view-switch button')].find((b) => b.textContent === name)!;
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe('ReviewCallFlowPanel Call tree view', () => {
  test.skipIf(!hasDom)('the tab opens on the Call tree; Paths and Raw are one click away; rows open through the review', async () => {
    const opened: string[] = [];
    await render(state({ openCallTreeNode: (node) => opened.push(node.key) }));
    expect(viewButton('Call tree').getAttribute('aria-pressed')).toBe('true');
    expect(host!.querySelector('[role="tree"]')).not.toBeNull();
    const layout = [...host!.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((r) => r.textContent?.includes('parley.layout'))!;
    await act(async () => layout.click());
    expect(opened).toEqual(['layout']);

    await act(async () => viewButton('Paths').click());
    expect(host!.querySelector('.call-flow-trees')).not.toBeNull();
    await act(async () => viewButton('Raw').click());
    expect(host!.querySelector('[role="tree"]')).toBeNull();
    await act(async () => viewButton('Call tree').click());
    expect(host!.querySelector('[role="tree"]')).not.toBeNull();
  });

  test.skipIf(!hasDom)('one search across the tab\'s trees: Cmd/Ctrl+F, the count, next moves into the tree holding the match', async () => {
    const twoTrees: CallFlowTree[] = [
      trees[0]!,
      { entry: 'other', tree: { key: 'other', label: 'other()', status: 'same', file: 'src/other.ts', line: 1, children: [
        { key: 'layout2', label: 'parley.layout(x)', status: 'added', file: 'src/other.ts', line: 4, children: [] },
      ] } },
    ];
    const base = state();
    await render(state({
      callFlowAnalysis: { status: 'ready', data: { ...(base.callFlowAnalysis as { data: object }).data, trees: twoTrees } } as never,
    }));
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true }));
    });
    const input = host!.querySelector<HTMLInputElement>('input[placeholder="Find calls or files"]')!;
    expect(document.activeElement).toBe(input);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'layout');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host!.querySelector('.call-flow-search-count')?.textContent).toBe('1/2');
    const current = () => host!.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"].call-tree-row-match');
    const selected = () => [...host!.querySelectorAll<HTMLElement>('[role="treeitem"][aria-selected="true"]')].map((r) => r.textContent ?? '');
    expect(selected().some((text) => text.includes('parley.layout()'))).toBe(true);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(host!.querySelector('.call-flow-search-count')?.textContent).toBe('2/2');
    expect(selected().some((text) => text.includes('parley.layout(x)'))).toBe(true);
    expect(current()).not.toBeNull();
    // Escape clears the search: the trees come back as they were.
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(host!.querySelector('input[type="search"]')).toBeNull();
    expect(host!.querySelectorAll('.call-tree-row-match')).toHaveLength(0);
  });

  test.skipIf(!hasDom)('a hunk\'s request shows its tree with the trail; Escape goes back, Close shows the tab\'s trees', async () => {
    const location = findCallTreeRoot(trees, { file: 'src/note.ts', newStart: 10, newEnd: 16, oldStart: 10, oldEnd: 15 }, {
      name: 'measure', newStart: 11, newEnd: 20,
    })!;
    const request: CallTreeRequest = {
      doc: callTreeAt(trees, location, { title: 'measure' }),
      origin: { filePath: 'src/note.ts', line: 13, side: 'new' },
      token: 1,
    };
    let backs = 0;
    let cleared = 0;
    await render(state({
      callTreeRequest: request,
      returnFromCallTree: () => { backs += 1; },
      clearCallTreeRequest: () => { cleared += 1; },
    }));
    expect(viewButton('Call tree').getAttribute('aria-pressed')).toBe('true');
    expect(host!.querySelector('.call-tree-title')?.textContent).toBe('measure');
    expect(host!.querySelector('.call-tree-trail')?.textContent).toBe('from main');
    const treeElement = host!.querySelector<HTMLElement>('[role="tree"]')!;
    expect(document.activeElement).toBe(treeElement);

    await act(async () => {
      treeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(backs).toBe(1);

    await act(async () => host!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
    expect(cleared).toBe(1);
    await render(state({ callTreeRequest: null }));
    expect(host!.querySelector('.call-tree-title')?.textContent).toBe('main');
    expect(host!.querySelector('.call-tree-trail')).toBeNull();
  });
});
