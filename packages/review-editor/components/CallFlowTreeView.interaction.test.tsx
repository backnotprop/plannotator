/** DOM-gated behavior tests for Call Flow pinpoint-style annotation. */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CallFlowAnnotationTarget } from '@plannotator/ui/types';
import type { CallFlowTree } from '@plannotator/shared/call-flow-types';
import { CallFlowTreeView } from './CallFlowTreeView';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

const trees: CallFlowTree[] = [{
  entry: 'checkout()',
  raw: '+ checkout()',
  rawLineStart: 1,
  tree: {
    key: 'checkout',
    label: 'checkout()',
    status: 'added',
    file: 'src/checkout.ts',
    line: 10,
    children: [{
      key: 'authorize',
      label: 'authorize()',
      status: 'removed',
      file: 'src/auth.ts',
      line: 21,
      children: [],
    }],
  },
}];

const contextTrees: CallFlowTree[] = [{
  entry: 'checkout()',
  raw: '  checkout()\n+ └─ changedCall()',
  rawLineStart: 1,
  tree: {
    key: 'checkout',
    label: 'checkout()',
    status: 'same',
    children: [
      {
        key: 'unchanged',
        label: 'unchangedContext()',
        status: 'same',
        children: [],
      },
      {
        key: 'changed',
        label: 'changedCall()',
        status: 'added',
        file: 'src/checkout.ts',
        line: 10,
        children: [],
      },
    ],
  },
}];

const multipleEntryTrees: CallFlowTree[] = [
  trees[0]!,
  {
    entry: 'refund()',
    raw: '+ refund()',
    rawLineStart: 3,
    tree: {
      key: 'refund',
      label: 'refund()',
      status: 'added',
      file: 'src/refund.ts',
      line: 8,
      children: [],
    },
  },
];

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe('CallFlowTreeView annotation interaction', () => {
  test.skipIf(!hasDom)('mounts one entry path at a time until another entry is opened', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(<CallFlowTreeView trees={multipleEntryTrees} onOpenNode={() => {}} />);
    });

    expect(host.querySelectorAll('.call-flow-entry')).toHaveLength(2);
    expect(host.querySelectorAll('.call-flow-tree')).toHaveLength(1);
    const refundEntry = [...host.querySelectorAll<HTMLButtonElement>('.call-flow-entry-header')]
      .find((button) => button.textContent?.includes('refund()'));
    expect(refundEntry?.getAttribute('aria-expanded')).toBe('false');

    await act(async () => refundEntry?.click());
    expect(refundEntry?.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelectorAll('.call-flow-tree')).toHaveLength(2);
  });

  test.skipIf(!hasDom)('expands and collapses every entry path from one control', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(<CallFlowTreeView trees={multipleEntryTrees} onOpenNode={() => {}} />);
    });

    expect(host.querySelectorAll('.call-flow-tree')).toHaveLength(1);
    const expandAll = host.querySelector<HTMLButtonElement>('[aria-label="Expand all paths"]');
    expect(expandAll).not.toBeNull();
    await act(async () => expandAll?.click());
    expect(host.querySelectorAll('.call-flow-tree')).toHaveLength(2);

    const collapseAll = host.querySelector<HTMLButtonElement>('[aria-label="Collapse all paths"]');
    expect(collapseAll).not.toBeNull();
    await act(async () => collapseAll?.click());
    expect(host.querySelectorAll('.call-flow-tree')).toHaveLength(0);
  });

  test.skipIf(!hasDom)('searches complete structured paths and reveals hidden context matches', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(<CallFlowTreeView trees={contextTrees} onOpenNode={() => {}} />);
    });

    expect(host.textContent).not.toContain('unchangedContext()');
    const search = host.querySelector<HTMLButtonElement>('[aria-label="Search call paths"]');
    expect(search).not.toBeNull();
    await act(async () => search?.click());
    const input = host.querySelector<HTMLInputElement>('input[placeholder="Find calls or files"]');
    expect(input).not.toBeNull();

    await act(async () => {
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
      setter?.call(input, 'unchangedContext');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(host.textContent).toContain('unchangedContext()');
    expect(host.textContent).toContain('1/1');
    expect(host.querySelectorAll('.call-flow-tree-match')).toHaveLength(1);
    expect(host.querySelector('.call-flow-row-search-current')?.textContent).toContain('unchangedContext()');

    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    });
    expect(host.querySelector('input[placeholder="Find calls or files"]')).toBeNull();
    expect(host.textContent).not.toContain('unchangedContext()');
  });

  test.skipIf(!hasDom)('reveals the complete inferred context only when requested', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        <CallFlowTreeView
          trees={contextTrees}
          onOpenNode={() => {}}
          onAnnotateTargets={() => true}
          canInteractWithNode={() => false}
        />,
      );
    });

    expect(host.textContent).toContain('changedCall()');
    expect(host.textContent).not.toContain('unchangedContext()');
    const toggle = [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Show all context');
    expect(toggle).toBeDefined();

    await act(async () => toggle?.click());
    expect(host.textContent).toContain('unchangedContext()');
    expect(host.textContent).toContain('Show changed paths');

    const unchanged = [...host.querySelectorAll<HTMLButtonElement>('.call-flow-node-target')]
      .find((button) => button.textContent?.includes('unchangedContext()'));
    expect(unchanged?.disabled).toBe(false);
    await act(async () => unchanged?.click());
    expect(document.querySelector('[data-comment-popover="true"]')).not.toBeNull();
  });

  test.skipIf(!hasDom)('creates one native annotation from click plus Shift-click targets', async () => {
    const submissions: Array<{ targets: readonly CallFlowAnnotationTarget[]; text: string }> = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        <CallFlowTreeView
          trees={trees}
          onOpenNode={() => {}}
          onAnnotateTargets={(targets, text) => {
            submissions.push({ targets: [...targets], text });
            return true;
          }}
          canInteractWithNode={() => true}
        />,
      );
    });

    const rowTargets = host.querySelectorAll<HTMLButtonElement>('.call-flow-node-target');
    expect(rowTargets).toHaveLength(2);

    await act(async () => {
      rowTargets[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.querySelector('[data-comment-popover="true"]')).not.toBeNull();
    expect(rowTargets[0]?.getAttribute('aria-pressed')).toBe('true');

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
      window.dispatchEvent(new MouseEvent('mousemove', {
        clientX: 0,
        clientY: 0,
        shiftKey: true,
      }));
    });
    expect(document.querySelector('[data-comment-popover="true"]')?.className)
      .toContain('pn-composer-yield-over');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' }));
    });
    expect(document.querySelector('[data-comment-popover="true"]')?.className)
      .not.toContain('pn-composer-yield-over');

    await act(async () => {
      rowTargets[1]?.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        shiftKey: true,
      }));
    });
    expect(document.querySelector('[data-comment-popover="true"]')).not.toBeNull();

    await act(async () => {
      rowTargets[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    });
    expect(document.querySelectorAll('[data-target-chip]')).toHaveLength(2);
    expect(rowTargets[1]?.getAttribute('aria-pressed')).toBe('true');

    const textarea = document.querySelector<HTMLTextAreaElement>('[data-comment-popover="true"] textarea');
    expect(textarea).not.toBeNull();
    await act(async () => {
      if (!textarea) return;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), 'value')?.set;
      setter?.call(textarea, 'Keep these calls atomic.');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      if (!textarea) return;
      textarea.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        key: 'Enter',
        metaKey: true,
      }));
    });

    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.text).toBe('Keep these calls atomic.');
    expect(submissions[0]?.targets.map((target) => target.filePath)).toEqual([
      'src/checkout.ts',
      'src/auth.ts',
    ]);
    expect(document.querySelector('[data-comment-popover="true"]')).toBeNull();
  });
});

const cardTrees: CallFlowTree[] = [{
  entry: 'checkout()',
  raw: '  checkout()',
  rawLineStart: 1,
  tree: {
    key: 'checkout',
    label: 'Cart.checkout(order)',
    status: 'same',
    file: 'src/checkout.ts',
    line: 10,
    children: [
      {
        key: 'validate',
        label: 'validate(order)',
        status: 'removed',
        file: 'src/checkout.ts',
        line: 12,
        children: [],
      },
      {
        key: 'branch',
        label: 'if (order.paid)',
        status: 'added',
        kind: 'branch',
        children: [{
          key: 'save',
          label: 'save(order)',
          status: 'added',
          file: 'src/checkout.ts',
          line: 20,
          children: [],
        }],
      },
      {
        key: 'authorize',
        label: 'Auth.authorize(session, order)',
        status: 'added',
        file: 'src/auth.ts',
        line: 21,
        children: [],
      },
    ],
  },
}];

async function renderCards(props: Partial<React.ComponentProps<typeof CallFlowTreeView>> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<CallFlowTreeView trees={cardTrees} onOpenNode={() => {}} {...props} />);
  });
  return host;
}

function rowFor(container: HTMLElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('.call-flow-row')]
    .find((candidate) => candidate.querySelector('.call-flow-node-target')?.textContent?.includes(name));
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

describe('CallFlowTreeView cards', () => {
  test.skipIf(!hasDom)('the file chip is strong where a call moves into another file and faint where it stays', async () => {
    const container = await renderCards();
    const chip = (location: string) => container.querySelector<HTMLButtonElement>(`[aria-label="Open ${location}"]`);
    const crossFile = (location: string) => chip(location)?.classList.contains('call-flow-node-location-cross-file');

    // Into another file: strong.
    expect(crossFile('src/auth.ts:21')).toBe(true);
    // Same file as the caller: faint, also through a step with no file of its own.
    expect(crossFile('src/checkout.ts:12')).toBe(false);
    expect(crossFile('src/checkout.ts:20')).toBe(false);
    // An entry's first step names the file the path starts in.
    expect(crossFile('src/checkout.ts:10')).toBe(true);
    expect(chip('src/auth.ts:21')?.textContent).toBe('auth.ts:21');
  });

  test.skipIf(!hasDom)('a removed step is marked and announced, a new one is announced, context is not', async () => {
    const container = await renderCards();
    const removed = rowFor(container, 'validate(order)');
    expect(removed.classList.contains('call-flow-row-removed')).toBe(true);
    expect(removed.querySelector('.call-flow-marker-removed')).not.toBeNull();
    expect(removed.querySelector('.call-flow-node-target')?.textContent).toBe('Removed: validate(order)');
    expect(removed.querySelector('.call-flow-node-target .sr-only')?.textContent).toBe('Removed: ');

    const added = rowFor(container, 'Auth.authorize(session, order)');
    expect(added.querySelector('.call-flow-marker-added')).not.toBeNull();
    expect(added.querySelector('.call-flow-node-target')?.textContent).toBe('New: Auth.authorize(session, order)');
    // The called name is its own element, so it can lead the row.
    expect(added.querySelector('.call-flow-signature-name')?.textContent).toBe('authorize');

    const context = rowFor(container, 'Cart.checkout(order)');
    expect(context.querySelector('.call-flow-marker-same')).not.toBeNull();
    expect(context.querySelector('.call-flow-node-target .sr-only')).toBeNull();
    expect(context.querySelector('.call-flow-node-target')?.textContent).toBe('Cart.checkout(order)');
  });

  test.skipIf(!hasDom)('search marks a match that spans the receiver and the called name', async () => {
    const container = await renderCards();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Search call paths"]')?.click());
    const input = container.querySelector<HTMLInputElement>('input[placeholder="Find calls or files"]');
    await act(async () => {
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
      setter?.call(input, 'auth.auth');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const marks = [...rowFor(container, 'Auth.authorize').querySelectorAll('.call-flow-tree-match')];
    expect(marks.map((mark) => mark.textContent).join('')).toBe('Auth.auth');
  });

  test.skipIf(!hasDom)('a location opens its file at the line, and a step outside the patch does not', async () => {
    const opened: string[] = [];
    const container = await renderCards({
      onOpenNode: (node) => opened.push(`${node.file}:${node.line}`),
      canInteractWithNode: (node) => node.file !== 'src/auth.ts',
    });

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open src/checkout.ts:12"]')?.click());
    expect(opened).toEqual(['src/checkout.ts:12']);

    const outside = container.querySelector<HTMLButtonElement>('[aria-label="Source src/auth.ts:21 is outside the reviewed patch"]');
    expect(outside?.disabled).toBe(true);

    // Without a comment handler, the row itself jumps to the source.
    await act(async () => rowFor(container, 'save(order)').querySelector<HTMLButtonElement>('.call-flow-node-target')?.click());
    expect(opened).toEqual(['src/checkout.ts:12', 'src/checkout.ts:20']);
  });

  test.skipIf(!hasDom)('clicking a row opens a comment on that step, named by its file and line', async () => {
    const opened: string[] = [];
    const container = await renderCards({
      onOpenNode: (node) => opened.push(`${node.file}:${node.line}`),
      onAnnotateTargets: () => true,
    });
    const target = rowFor(container, 'validate(order)').querySelector<HTMLButtonElement>('.call-flow-node-target');
    await act(async () => target?.click());

    expect(target?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-comment-popover="true"]')).not.toBeNull();
    expect(document.querySelector('[data-target-chip]')?.textContent).toContain('checkout.ts:12');
    expect(opened).toEqual([]);
  });
});
