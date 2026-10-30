/**
 * DOM-gated: resting the pointer on a Semantic Changes row opens the entity's
 * source (CodeSnippetPreview). Guards: nothing is loaded before the dwell; a
 * deleted entity shows its OLD line range from the old side of the file; a
 * modified entity shows its new range; without a loader (the file-header
 * popover) a hover opens nothing.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SemanticDiffChange } from '@plannotator/shared/semantic-diff-types';
import { SemanticDiffRows } from './semanticDiffShared';
import { createReviewFileSourceLoader } from '../../hooks/useReviewFileSource';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

const change = (overrides: Partial<SemanticDiffChange>): SemanticDiffChange => ({
  entityId: null,
  changeType: 'modified',
  entityType: 'function',
  entityName: 'checkout',
  oldEntityName: null,
  filePath: 'src/checkout.ts',
  oldFilePath: null,
  startLine: 4,
  endLine: 6,
  oldStartLine: 2,
  oldEndLine: 3,
  structuralChange: null,
  ...overrides,
});

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

async function hoverRow(name: string) {
  const row = [...host!.querySelectorAll<HTMLButtonElement>('.semantic-diff-row')].find((r) => r.textContent?.includes(name))!;
  await act(async () => {
    row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.innerHTML = '';
});

describe('Semantic Changes source preview', () => {
  test.skipIf(!hasDom)('a deleted entity previews its old range from the old side, after the dwell', async () => {
    const calls: string[] = [];
    const loadSource = createReviewFileSourceLoader({ files: [{ path: 'src/checkout.ts' }], fetchImpl: fakeFileContent(calls) });
    await mount(
      <SemanticDiffRows
        changes={[change({ changeType: 'deleted', entityName: 'legacyCheckout', startLine: null, endLine: null, oldStartLine: 7, oldEndLine: 9 })]}
        binaryChanges={[]}
        onOpenChange={() => {}}
        onOpenBinary={() => {}}
        loadSource={loadSource}
      />,
    );

    await hoverRow('legacyCheckout');
    expect(calls).toHaveLength(0);
    await act(async () => { await wait(250); });

    const preview = document.querySelector('[data-code-snippet-preview="src/checkout.ts"]');
    expect(preview).not.toBeNull();
    expect(preview!.textContent).toContain('old line 7');
    expect(preview!.textContent).toContain('old line 9');
    expect(preview!.textContent).not.toContain('old line 10');
    expect(preview!.textContent).not.toContain('new line');
  });

  test.skipIf(!hasDom)('a modified entity previews its new range', async () => {
    const loadSource = createReviewFileSourceLoader({ files: [{ path: 'src/checkout.ts' }], fetchImpl: fakeFileContent([]) });
    await mount(
      <SemanticDiffRows changes={[change({})]} binaryChanges={[]} onOpenChange={() => {}} onOpenBinary={() => {}} loadSource={loadSource} />,
    );
    await hoverRow('checkout');
    await act(async () => { await wait(250); });

    const preview = document.querySelector('[data-code-snippet-preview]');
    expect(preview?.textContent).toContain('new line 4');
    expect(preview?.textContent).toContain('new line 6');
    expect(preview?.textContent).not.toContain('new line 7');
  });

  test.skipIf(!hasDom)('without a loader a hover opens nothing', async () => {
    await mount(<SemanticDiffRows changes={[change({})]} binaryChanges={[]} onOpenChange={() => {}} onOpenBinary={() => {}} />);
    await hoverRow('checkout');
    await act(async () => { await wait(250); });
    expect(document.querySelector('[data-code-snippet-preview]')).toBeNull();
  });
});
