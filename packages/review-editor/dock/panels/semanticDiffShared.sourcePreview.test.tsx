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
import { semanticDiffFile } from '@plannotator/sem-diff';
import { semDiffChanges } from '../../semDiff/semDiffChanges';

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
  test.skipIf(!hasDom)('an entry from the built-in engine previews where the moved code went', async () => {
    const before = `export function load(id: string) {\n  return db.find(id);\n}\n\nexport function save(user: User) {\n  db.put(user.id, user);\n  return user;\n}\n`;
    const after = `export function save(user: User) {\n  db.put(user.id, user);\n  return user;\n}\n\nexport function load(id: string) {\n  return db.find(id);\n}\n`;
    const result = await semanticDiffFile('typescript', before, after, 'src/users.ts');
    const changes = semDiffChanges('src/users.ts', result.semanticOperations, before, after);
    const moved = changes.find((c) => c.changeType === 'moved')!;
    expect(moved).toBeDefined();
    const fetchImpl = (async () => new Response(JSON.stringify({ oldContent: before, newContent: after }), { status: 200 })) as unknown as typeof fetch;
    const loadSource = createReviewFileSourceLoader({ files: [{ path: 'src/users.ts' }], fetchImpl });
    await mount(<SemanticDiffRows changes={[moved]} binaryChanges={[]} onOpenChange={() => {}} onOpenBinary={() => {}} loadSource={loadSource} />);
    await hoverRow(moved.entityName);
    await act(async () => { await wait(250); });
    const preview = document.querySelector('[data-code-snippet-preview="src/users.ts"]');
    expect(preview).not.toBeNull();
    const shown = after.split('\n')[(moved.startLine ?? 1) - 1]!;
    expect(preview!.textContent).toContain(shown.trim());
  });
  test.skipIf(!hasDom)('a click on a preview line shows that line in the diff; Open file opens the whole file there', async () => {
    const loadSource = createReviewFileSourceLoader({ files: [{ path: 'src/checkout.ts' }], fetchImpl: fakeFileContent([]) });
    const lines: Array<[string, number, string]> = [];
    const files: Array<[string, number]> = [];
    await mount(
      <SemanticDiffRows
        changes={[change({})]}
        binaryChanges={[]}
        onOpenChange={() => {}}
        onOpenBinary={() => {}}
        loadSource={loadSource}
        onOpenLine={(path, line, side) => lines.push([path, line, side])}
        onOpenFile={(path, line) => files.push([path, line])}
      />,
    );
    await hoverRow('checkout');
    await act(async () => { await wait(250); });
    const row = document.querySelector<HTMLTableRowElement>('[data-snippet-line="5"]')!;
    await act(async () => row.click());
    expect(lines).toEqual([['src/checkout.ts', 5, 'additions']]);
    await hoverRow('checkout');
    await act(async () => { await wait(250); });
    await act(async () => document.querySelector<HTMLButtonElement>('[data-snippet-open-file]')!.click());
    expect(files).toEqual([['src/checkout.ts', 4]]);
  });
});
