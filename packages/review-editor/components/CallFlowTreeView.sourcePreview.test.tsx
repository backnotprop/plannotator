/**
 * DOM-gated: hovering a Call Flow step's file:line opens the source preview
 * (CodeSnippetPreview) with the step's line marked and context around it.
 * Guards: nothing is loaded before the pointer rests; a removed step shows the
 * OLD side of the file (the reviewed source, not the working tree); leaving
 * before the dwell loads nothing; a view without a loader offers no preview.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CallFlowTree } from '@plannotator/shared/call-flow-types';
import { CallFlowTreeView } from './CallFlowTreeView';
import { createCallFlowNodeSourceLoader } from '../hooks/useCallFlowNodeSource';

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
    line: 5,
    children: [{
      key: 'authorize',
      label: 'authorize()',
      status: 'removed',
      file: 'src/checkout.ts',
      line: 6,
      children: [],
    }],
  },
}];

const numbered = (side: string) => Array.from({ length: 12 }, (_, i) => `${side} line ${i + 1}`).join('\n');

function fakeFileContent(calls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ oldContent: numbered('old'), newContent: numbered('new') }), { status: 200 });
  }) as typeof fetch;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function mount(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(element));
}

function location(label: string): HTMLButtonElement {
  const row = [...host!.querySelectorAll('.call-flow-row')].find((r) => r.textContent?.includes(label));
  return row!.querySelector<HTMLButtonElement>('.call-flow-node-location')!;
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.innerHTML = '';
});

describe('CallFlowTreeView source preview', () => {
  test.skipIf(!hasDom)('a removed step previews the old side, its line marked, after the dwell', async () => {
    const calls: string[] = [];
    const loader = createCallFlowNodeSourceLoader({
      files: [{ path: 'src/checkout.ts' }],
      reviewBase: 'main',
      snapshotId: 'snap-1',
      fetchImpl: fakeFileContent(calls),
    });
    await mount(<CallFlowTreeView trees={trees} onOpenNode={() => {}} loadNodeSource={loader} />);

    await act(async () => {
      location('authorize()').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(calls).toHaveLength(0);

    await act(async () => { await wait(250); });
    const preview = document.querySelector('[data-code-snippet-preview="src/checkout.ts"]');
    expect(preview).not.toBeNull();
    const marked = preview!.querySelector('[data-target-line="true"]');
    expect(marked?.textContent).toContain('old line 6');
    expect(preview!.textContent).toContain('old line 3');
    expect(preview!.textContent).toContain('old line 9');
    expect(preview!.textContent).not.toContain('new line');
    expect(calls[0]).toContain('base=main');
    expect(calls[0]).toContain('snapshot=snap-1');
  });

  test.skipIf(!hasDom)('leaving before the dwell loads nothing', async () => {
    const calls: string[] = [];
    const loader = createCallFlowNodeSourceLoader({ files: [], fetchImpl: fakeFileContent(calls) });
    await mount(<CallFlowTreeView trees={trees} onOpenNode={() => {}} loadNodeSource={loader} />);

    const button = location('checkout()');
    await act(async () => {
      button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await wait(50);
      button.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
      await wait(250);
    });
    expect(calls).toHaveLength(0);
    expect(document.querySelector('[data-code-snippet-preview]')).toBeNull();
  });

  test.skipIf(!hasDom)('without a loader a hover opens nothing', async () => {
    await mount(<CallFlowTreeView trees={trees} onOpenNode={() => {}} />);
    await act(async () => {
      location('checkout()').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await wait(250);
    });
    expect(document.querySelector('[data-code-snippet-preview]')).toBeNull();
  });
});

describe('createCallFlowNodeSourceLoader', () => {
  test('rows in one file share one request; a failed request is asked again', async () => {
    const calls: string[] = [];
    let fail = true;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (fail) return new Response('stale', { status: 409 });
      return new Response(JSON.stringify({ oldContent: 'a', newContent: 'b' }), { status: 200 });
    }) as typeof fetch;
    const loader = createCallFlowNodeSourceLoader({ files: [{ path: 'src/x.ts' }], fetchImpl });
    const node = (line: number) => ({ key: `k${line}`, label: 'f()', status: 'added' as const, file: 'src/x.ts', line, children: [] });

    expect(await Promise.all([loader(node(1)), loader(node(2))])).toEqual([null, null]);
    expect(calls).toHaveLength(1);

    fail = false;
    expect(await loader(node(3))).toEqual({ contents: 'b', filepath: 'src/x.ts' });
    expect(await loader(node(4))).toEqual({ contents: 'b', filepath: 'src/x.ts' });
    expect(calls).toHaveLength(2);
  });

  test('a renamed file asks with its old path so a removed step reads the old name', async () => {
    const calls: string[] = [];
    const loader = createCallFlowNodeSourceLoader({
      files: [{ path: 'src/new.ts', oldPath: 'src/old.ts' }],
      fetchImpl: fakeFileContent(calls),
    });
    const result = await loader({ key: 'k', label: 'f()', status: 'removed', file: 'src/old.ts', line: 2, children: [] });
    expect(result?.contents).toContain('old line 2');
    const url = new URL(calls[0]!, 'http://localhost');
    expect(url.searchParams.get('path')).toBe('src/new.ts');
    expect(url.searchParams.get('oldPath')).toBe('src/old.ts');
  });
});
